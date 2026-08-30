// FlowerField -- the flowers that open by themselves in a patch of planted grass.
//
// The ask (MYAA-22) is an effect, not a second placement feature: the user taps to grow
// grass, and every so often one of the tufts they already grew puts out a flower. So
// nothing here reads a tap. It asks the grass field for a tuft at random and blooms
// there, which keeps two useful properties for free:
//
//   flowers can only appear on a surface the placement logic already accepted, so a
//   bad hitTest reading cannot put a flower in mid-air on its own, and
//
//   the count follows the grass. `density` is flowers per live tuft, so a patch that
//   grows gets more flowers and a patch that is cleared loses them -- a flower is never
//   left standing on its own where the grass used to be.
//
// Cost: one extra draw call and one extra texture bind. The instance count is a fraction
// of the grass (density x live tufts, capped), and the card is 2 crossed quads, so the
// fill this adds is small next to the field it sits in -- see docs/grass-rendering.md
// for what the budget is actually spent on.
import * as THREE from 'three'
import atlasUrl from '../assets/flower-atlas.png'
import {buildTuftGeometry} from './tuft-geometry'
import {ATLAS_CELL_UV, LIFE_COMMON, LIFE_SCALE_BODY} from './life-shader'

/** Seconds a retiring flower takes to shrink away before its slot is reused. */
const RETIRE_SEC = 0.5
/** "Not retiring" sentinel. Finite so it survives a float32 attribute. */
const NOT_RETIRING = 1e9

/**
 * A plain crossed quad, built from the same card builder the grass uses so the UVs land
 * inside the atlas gutter by the same rule. The grass card is trimmed to its silhouette
 * because 900 tufts of alpha-tested fill is the scene's budget; a hundred-odd flowers is
 * not, so a full cell (cols: 1, one column spanning the whole card) is the right trade.
 */
const CARD = {cols: 1, cards: 2, inset: 8, cell: 256, ext: [[0, 1] as [number, number]]}

/** What FlowerField needs from the grass. GrassField satisfies this structurally. */
export interface Garden {
  readonly liveCount: number
  /** Fills `position`/`normal` from a random live tuft; false when nothing is planted. */
  sampleLive(position: THREE.Vector3, normal: THREE.Vector3): boolean
}

export interface FlowerOptions {
  scene: THREE.Scene
  renderer?: THREE.WebGLRenderer
  /** Max flowers alive at once. */
  capacity?: number
  /** Flowers per live tuft. The count is derived from the grass, never set directly. */
  density?: number
  /** Mean seconds between blooms... */
  bloomEverySec?: number
  /** ...jittered by +/- this fraction, so the rhythm is not metronomic. */
  bloomJitter?: number
  /** Metres; flower height before per-instance jitter. Taller than a tuft on purpose. */
  height?: number
  heightJitter?: number
  /** Metres; how far from its host tuft a flower may sit. */
  scatter?: number
  /** Seconds the bloom takes. Slower than the grass: this one is meant to be watched. */
  growSec?: number
  wind?: number
  windSpeed?: number
  cullNear?: number
  cullFar?: number
}

type ResolvedOptions = Required<Omit<FlowerOptions, 'renderer'>> & {renderer?: THREE.WebGLRenderer}

const DEFAULTS: Omit<ResolvedOptions, 'scene' | 'renderer'> = {
  capacity: 160,
  density: 0.12,
  bloomEverySec: 3.0,
  bloomJitter: 0.55,
  height: 0.17,
  heightJitter: 0.22,
  scatter: 0.05,
  growSec: 1.1,
  wind: 0.05,
  windSpeed: 1.1,
  cullNear: 3.0,
  cullFar: 4.0,
}

/**
 * The opening. Growth comes from the shared life curve (an easeOutBack pop); what makes
 * it read as a flower rather than as a tuft is the untwist -- the card is spun about its
 * own stem and unwinds as it scales up, so the petals sweep into view instead of simply
 * getting bigger. The card is then swayed like the grass around it, on a slower clock,
 * so a flower does not look pinned while the field moves.
 */
const injectFlower = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${LIFE_COMMON}`)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      ${LIFE_SCALE_BODY}

      float age  = uTime - aLife.x;
      float open = clamp(age / uGrow, 0.0, 1.0);

      // Untwist about the stem. aRand.z picks the direction, so neighbouring flowers do
      // not all unwind the same way.
      float twist = (1.0 - open) * 2.4 * sign(aRand.z);
      float ct = cos(twist), st = sin(twist);
      transformed.xz = mat2(ct, -st, st, ct) * transformed.xz;

      // Sway the head, not the stem: position.y is 0..1 up the card.
      float h = clamp(position.y, 0.0, 1.0);
      float phase = uTime * uWindSpeed + aRand.x + iPos.x * 1.7 + iPos.z * 1.7;
      float sway = sin(phase) * uWind * h * h;
      // A nod that settles out over the first couple of seconds after opening.
      sway *= 1.0 + exp(-age * 1.6) * 1.4;

      // Before the scale, for the same reason as the grass: a culled instance has to
      // collapse to a degenerate triangle, not to a sliver that still costs fill.
      transformed.x += sway;
      transformed.z += sway * 0.4;
      transformed *= scale;
    `)
    .replace('#include <uv_vertex>', /* glsl */`
      #include <uv_vertex>
      ${ATLAS_CELL_UV}
    `)
}

const markRange = (attr: THREE.BufferAttribute | null, slot: number, itemSize: number): void => {
  attr?.addUpdateRange(slot * itemSize, itemSize)
}

export class FlowerField {
  readonly opts: ResolvedOptions
  readonly mesh: THREE.InstancedMesh

  private readonly scene: THREE.Scene
  private readonly capacity: number
  private readonly aLife: THREE.InstancedBufferAttribute
  private readonly aRand: THREE.InstancedBufferAttribute
  private readonly uniforms: Record<string, THREE.IUniform>

  private time = 0
  private highWater = 0
  private free: number[]
  private live: number[] = []
  private retiring: {slot: number; freeAt: number}[] = []
  /** Time of the next spontaneous bloom. Negative until the first update. */
  private nextBloomAt = -1

  private readonly _m = new THREE.Matrix4()
  private readonly _q = new THREE.Quaternion()
  private readonly _spin = new THREE.Quaternion()
  private readonly _align = new THREE.Quaternion()
  private readonly _up = new THREE.Vector3(0, 1, 0)
  private readonly _normal = new THREE.Vector3()
  private readonly _offset = new THREE.Vector3()
  private readonly _pos = new THREE.Vector3()
  private readonly _scale = new THREE.Vector3()
  private readonly _colour = new THREE.Color()
  private readonly _spot = new THREE.Vector3()
  private readonly _spotUp = new THREE.Vector3()

  static async create(opts: FlowerOptions): Promise<FlowerField> {
    const atlas = await new THREE.TextureLoader().loadAsync(atlasUrl)
    return new FlowerField(atlas, opts)
  }

  constructor(atlas: THREE.Texture, opts: FlowerOptions) {
    const o = this.opts = {...DEFAULTS, ...opts}
    this.scene = o.scene
    this.capacity = o.capacity
    this.free = Array.from({length: o.capacity}, (_, i) => o.capacity - 1 - i)

    // The card builder authors UVs in glTF convention (v = 0 at the TOP of the image),
    // which is what GLTFLoader assumes; TextureLoader defaults to flipY = true and would
    // render the atlas upside down.
    atlas.flipY = false
    atlas.colorSpace = THREE.SRGBColorSpace
    atlas.generateMipmaps = true
    atlas.minFilter = THREE.LinearMipmapLinearFilter
    atlas.magFilter = THREE.LinearFilter
    atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping
    atlas.anisotropy = Math.min(4, o.renderer?.capabilities.getMaxAnisotropy() ?? 1)
    atlas.needsUpdate = true

    this.uniforms = {
      uTime: {value: 0},
      uGrow: {value: o.growSec},
      uRetire: {value: RETIRE_SEC},
      uWind: {value: o.wind},
      uWindSpeed: {value: o.windSpeed},
      uCull: {value: new THREE.Vector2(o.cullNear, o.cullFar)},
      uEye: {value: new THREE.Vector3()},
    }

    const material = new THREE.MeshBasicMaterial({
      map: atlas,
      transparent: false,   // alpha TEST, not blend: no per-frame depth sorting
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      depthWrite: true,
      toneMapped: false,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      injectFlower(shader)
    }
    material.customProgramCacheKey = () => 'flower-instanced-v1'

    const geo = buildTuftGeometry(CARD)
    this.aLife = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 2), 2)
    this.aRand = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 3), 3)
    this.aLife.setUsage(THREE.DynamicDrawUsage)
    this.aRand.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aLife', this.aLife)
    geo.setAttribute('aRand', this.aRand)

    this.mesh = new THREE.InstancedMesh(geo, material, o.capacity)
    this.mesh.name = 'flowerField'
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // After the grass, which has already written depth.
    this.mesh.renderOrder = 2
    this.scene.add(this.mesh)
  }

  /** Flowers currently open (excludes ones shrinking away). */
  get liveCount(): number { return this.live.length }

  /** How many flowers this much grass is allowed to carry. */
  private cap(tufts: number): number {
    return Math.min(this.capacity, Math.round(tufts * this.opts.density))
  }

  /**
   * Opens one flower at `position`, standing along `normal`.
   * @returns whether there was room for it.
   */
  bloom(
    position: THREE.Vector3 | {x: number; y: number; z: number},
    normal: THREE.Vector3 | {x: number; y: number; z: number} | null = null,
  ): boolean {
    const now = this.time
    this.reclaim(now)
    if (!this.free.length) this.retireOldest(now)
    // Only reached when flowers are opening faster than RETIRE_SEC frees a slot; cutting
    // one shrink short beats dropping the bloom.
    if (!this.free.length && this.retiring.length) this.free.push(this.retiring.shift()!.slot)
    const slot = this.free.pop()
    if (slot === undefined) return false
    this.live.push(slot)

    const up = normal ? this._normal.set(normal.x, normal.y, normal.z) : this._normal.set(0, 1, 0)
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0)
    up.normalize()
    const align = this._align.setFromUnitVectors(this._up, up)

    // Scattered in the surface plane rather than in world XZ, so a flower on a tilted
    // surface stays on it instead of sinking into it.
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * this.opts.scatter
    this._offset.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(align)

    const scale = this.opts.height * (1 + (Math.random() * 2 - 1) * this.opts.heightJitter)
    this._spin.setFromAxisAngle(this._up, Math.random() * Math.PI * 2)
    this._q.copy(align).multiply(this._spin)
    this._pos.set(position.x, position.y, position.z).add(this._offset)

    this._m.compose(this._pos, this._q, this._scale.setScalar(scale))
    this.mesh.setMatrixAt(slot, this._m)
    markRange(this.mesh.instanceMatrix, slot, 16)

    // A gentle tint only. instanceColor multiplies the atlas, so this can shade a petal
    // but never brighten it, and a heavy hand here just turns every flower muddy.
    const t = 0.9 + Math.random() * 0.1
    this._colour.setRGB(t, t * (0.92 + Math.random() * 0.16), t * (0.92 + Math.random() * 0.16))
    this.mesh.setColorAt(slot, this._colour)
    markRange(this.mesh.instanceColor, slot, 3)

    this.aLife.array[slot * 2] = now
    this.aLife.array[slot * 2 + 1] = NOT_RETIRING
    markRange(this.aLife, slot, 2)

    this.aRand.array[slot * 3] = Math.random() * Math.PI * 2
    this.aRand.array[slot * 3 + 1] = Math.floor(Math.random() * 4)
    this.aRand.array[slot * 3 + 2] = Math.random() < 0.5 ? -1 : 1
    markRange(this.aRand, slot, 3)

    if (slot >= this.highWater) this.highWater = slot + 1
    this.mesh.count = this.highWater
    // Recomputed on bloom, never per frame, so turning away from the patch still costs
    // nothing thanks to frustum culling.
    this.mesh.computeBoundingSphere()
    this.flush()
    return true
  }

  /**
   * Call once per frame. Passing the grass in is what makes flowers appear on their own:
   * every so often one live tuft is picked at random and asked to carry a flower, and
   * the population is trimmed back when the grass it is riding on goes away.
   */
  update(elapsed: number, camera?: THREE.Camera, garden?: Garden | null): void {
    this.time = elapsed
    this.uniforms.uTime.value = elapsed
    if (camera) camera.getWorldPosition(this.uniforms.uEye.value as THREE.Vector3)
    this.reclaim(elapsed)
    if (garden) this.tick(elapsed, garden)
  }

  private tick(now: number, garden: Garden): void {
    const cap = this.cap(garden.liveCount)
    while (this.live.length > cap) this.retireOldest(now)

    if (this.nextBloomAt < 0) { this.scheduleBloom(now); return }
    if (now < this.nextBloomAt) return
    this.scheduleBloom(now)
    if (this.live.length >= cap) return
    if (garden.sampleLive(this._spot, this._spotUp)) this.bloom(this._spot, this._spotUp)
  }

  private scheduleBloom(now: number): void {
    const j = this.opts.bloomJitter
    this.nextBloomAt = now + this.opts.bloomEverySec * (1 + (Math.random() * 2 - 1) * j)
  }

  /** Closes everything, with the normal shrink-out. */
  clear(): void {
    while (this.live.length) this.retireOldest(this.time)
  }

  /** Removes everything immediately, no shrink. For scene resets. */
  reset(): void {
    this.free = Array.from({length: this.capacity}, (_, i) => this.capacity - 1 - i)
    this.live.length = 0
    this.retiring.length = 0
    this.highWater = 0
    this.nextBloomAt = -1
    this.mesh.count = 0
    this.mesh.boundingSphere?.makeEmpty()
  }

  dispose(): void {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    const mat = this.mesh.material as THREE.MeshBasicMaterial
    mat.map?.dispose()
    mat.dispose()
    this.mesh.dispose()
  }

  private retireOldest(now: number): void {
    const slot = this.live.shift()
    if (slot === undefined) return
    this.aLife.array[slot * 2 + 1] = now
    markRange(this.aLife, slot, 2)
    this.aLife.needsUpdate = true
    this.retiring.push({slot, freeAt: now + RETIRE_SEC})
  }

  private reclaim(now: number): void {
    while (this.retiring.length && this.retiring[0].freeAt <= now) {
      this.free.push(this.retiring.shift()!.slot)
    }
  }

  private flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.aLife.needsUpdate = true
    this.aRand.needsUpdate = true
  }
}
