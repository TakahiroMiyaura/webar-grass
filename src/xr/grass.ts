// GrassField -- an instanced grass field sized for a phone that is also running SLAM.
//
// Design, and why:
//
//   One draw call. Every tuft lives in a single InstancedMesh. The four visual
//   variants come from the 2x2 atlas, picked per instance in the vertex shader, so
//   variety costs nothing at the draw-call level.
//
//   Nothing animates on the CPU. Growth, wind and the retire shrink are all functions
//   of (uTime - plantTime) evaluated in the vertex shader. instanceMatrix is written
//   once when a tuft is planted and never touched again. The naive version --
//   recomputing matrices each frame and setting needsUpdate -- re-uploads 64 bytes x N
//   every frame and shows up immediately on a mobile bus.
//
//   Writes are ranged. Planting a clump uploads only the slots it touched via
//   addUpdateRange(), not the whole buffer.
//
//   Fill is the budget, not triangles. Alpha-tested foliage cannot use early-Z on a
//   tile-based mobile GPU, so every texel of a grass card costs a fragment shader run
//   even where it is discarded. That is why the card geometry is trimmed to the blades
//   (36 triangles per tuft instead of 6, ~47% less rasterised area), why the material
//   is unlit, and why there is a shader-side distance cull.
//
// Measured cost, and the tuning order it implies: see docs/grass-rendering.md.
//
// Two ways in, same geometry either way:
//   GrassField.createProcedural()  rebuilds the card from tuft-card.json. Default.
//   GrassField.create()            loads grass.glb -- use when an artist needs to be
//                                  able to replace the asset. Pulls GLTFLoader, which
//                                  Vite splits into its own chunk (~35 KB gzipped, more
//                                  than the asset it exists to load).
import * as THREE from 'three'
import atlasUrl from '../assets/grass-atlas.png'
import shadowUrl from '../assets/shadow.png'
import grassGlbUrl from '../assets/grass.glb?url'
import tuftCard from '../assets/tuft-card.json'
import {buildTuftGeometry, type TuftCard} from './tuft-geometry'
import {ATLAS_CELL_UV, LIFE_COMMON, LIFE_SCALE_BODY} from './life-shader'

/** Seconds a retiring tuft takes to shrink away before its slot is reused. */
const RETIRE_SEC = 0.45
/** "Not retiring" sentinel. Finite so it survives a float32 attribute. */
const NOT_RETIRING = 1e9

export interface GrassOptions {
  scene: THREE.Scene
  renderer?: THREE.WebGLRenderer
  /** Max tufts alive at once. */
  capacity?: number
  /** Tufts planted per tap. */
  perTap?: number
  /** Metres; clump spread around the hit point. */
  tapRadius?: number
  /** Metres; tuft height before per-instance jitter. */
  height?: number
  heightJitter?: number
  growSec?: number
  /** Lateral sway at the blade tips, in tuft-heights. */
  wind?: number
  windSpeed?: number
  /** Metres; tufts start shrinking out here... */
  cullNear?: number
  /** ...and are gone by here. */
  cullFar?: number
  shadows?: boolean
  /** Relative to tuft footprint. Area is a squared term, so this is a real fill lever. */
  shadowScale?: number
}

type ResolvedOptions = Required<Omit<GrassOptions, 'renderer'>> & {renderer?: THREE.WebGLRenderer}

const DEFAULTS: Omit<ResolvedOptions, 'scene' | 'renderer'> = {
  capacity: 900,
  perTap: 7,
  tapRadius: 0.075,
  height: 0.13,
  heightJitter: 0.35,
  growSec: 0.55,
  wind: 0.055,
  windSpeed: 1.6,
  cullNear: 3.0,
  cullFar: 4.0,
  shadows: true,
  shadowScale: 1.3,
}

// ---------------------------------------------------------------------------
// Shader injection, shared by the grass material and the shadow material. Both need
// the same growth/retire/cull curve so a shadow appears and leaves with its tuft --
// and so does flowers.ts, which is why the curve itself lives in life-shader.ts.

const injectGrass = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${LIFE_COMMON}`)
    .replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      ${LIFE_SCALE_BODY}

      // Sway only the upper part of the blade, quadratically, so the base stays
      // planted. position.y is 0..1 in the authored tuft.
      float h = clamp(position.y, 0.0, 1.0);
      float phase = uTime * uWindSpeed + aRand.x + iPos.x * 1.7 + iPos.z * 1.7;
      float sway = sin(phase) * uWind * h * h;
      // A short extra wobble right after planting, so a new tuft reads as "sprouted"
      // rather than "appeared".
      float settle = exp(-(uTime - aLife.x) * 3.5) * 2.2;
      sway *= 1.0 + settle;

      // Sway is applied before the scale, not after. Adding it afterwards leaves a
      // culled or retired instance (scale 0) as a thin sliver instead of a fully
      // degenerate triangle, which is exactly the fill the cull exists to avoid.
      transformed.x += sway;
      transformed.z += sway * 0.35;
      transformed *= scale;
    `)
    .replace('#include <uv_vertex>', /* glsl */`
      #include <uv_vertex>
      ${ATLAS_CELL_UV}
    `)
}

const injectShadow = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${LIFE_COMMON}`)
    .replace('#include <begin_vertex>', `
      #include <begin_vertex>
      ${LIFE_SCALE_BODY}
      transformed *= scale;
    `)
}

/**
 * Marks just the slot that changed. three uploads the whole buffer when updateRanges is
 * empty -- for a 900-instance matrix buffer that is 57 KB per tap -- and merges adjacent
 * ranges itself, so one call per slot is fine.
 */
const markRange = (attr: THREE.BufferAttribute | null, slot: number, itemSize: number): void => {
  attr?.addUpdateRange(slot * itemSize, itemSize)
}

export class GrassField {
  readonly opts: ResolvedOptions
  readonly mesh: THREE.InstancedMesh
  readonly shadow: THREE.InstancedMesh | null = null

  private readonly scene: THREE.Scene
  private readonly capacity: number
  private readonly softCap: number
  private readonly aLife: THREE.InstancedBufferAttribute
  private readonly aRand: THREE.InstancedBufferAttribute
  private readonly uniforms: Record<string, THREE.IUniform>

  private time = 0
  private highWater = 0
  private free: number[]
  private live: number[] = []
  private retiring: {slot: number; freeAt: number}[] = []

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

  /** Loads assets/grass.glb. Pulls GLTFLoader; prefer createProcedural(). */
  static async create(opts: GrassOptions & {url?: string}): Promise<GrassField> {
    const {GLTFLoader} = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const gltf = await new GLTFLoader().loadAsync(opts.url ?? grassGlbUrl)
    let tuft: THREE.Mesh | null = null
    gltf.scene.traverse((n) => { if (!tuft && (n as THREE.Mesh).isMesh) tuft = n as THREE.Mesh })
    if (!tuft) throw new Error('grass.glb contains no mesh')
    const mesh = tuft as THREE.Mesh
    const map = (mesh.material as THREE.MeshStandardMaterial).map
    if (!map) throw new Error('grass.glb has no base colour texture')
    return new GrassField(mesh.geometry, map, opts)
  }

  /** Same field, no GLTFLoader. This is the path the app ships with. */
  static async createProcedural(opts: GrassOptions): Promise<GrassField> {
    const atlas = await new THREE.TextureLoader().loadAsync(atlasUrl)
    return new GrassField(buildTuftGeometry(tuftCard as TuftCard), atlas, opts)
  }

  constructor(geometry: THREE.BufferGeometry, atlas: THREE.Texture, opts: GrassOptions) {
    const o = this.opts = {...DEFAULTS, ...opts}
    this.scene = o.scene
    this.capacity = o.capacity
    // Retire proactively rather than at the moment of eviction, so there is always a
    // free slot and a tuft never vanishes mid-frame to make room.
    this.softCap = Math.max(1, o.capacity - o.perTap * 2)
    this.free = Array.from({length: o.capacity}, (_, i) => o.capacity - 1 - i)

    // The UVs are authored in glTF convention (v = 0 at the TOP of the image).
    // GLTFLoader already sets flipY = false; TextureLoader defaults to true, which would
    // render the atlas upside down on the createProcedural() path. Forcing it here is
    // what keeps the two entry points interchangeable.
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

    // MeshBasicMaterial on purpose. The vertical shading is baked into the atlas, and AR
    // light estimation is not reliable enough to be worth a per-fragment lighting model
    // on a GPU that is already spending its budget on SLAM.
    const material = new THREE.MeshBasicMaterial({
      map: atlas,
      transparent: false,   // alpha TEST, not blend: no per-frame depth sorting
      alphaTest: 0.35,      // under 0.5 to offset how mips thin the silhouette
      side: THREE.DoubleSide,
      depthWrite: true,
      toneMapped: false,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      injectGrass(shader)
    }
    // Distinguishes this program from a plain MeshBasicMaterial in three's cache.
    material.customProgramCacheKey = () => 'grass-instanced-v1'

    const geo = geometry.clone()
    this.aLife = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 2), 2)
    this.aRand = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 3), 3)
    this.aLife.setUsage(THREE.DynamicDrawUsage)
    this.aRand.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aLife', this.aLife)
    geo.setAttribute('aRand', this.aRand)

    this.mesh = new THREE.InstancedMesh(geo, material, o.capacity)
    this.mesh.name = 'grassField'
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.renderOrder = 0
    this.scene.add(this.mesh)

    if (o.shadows) this.shadow = this.buildShadows()
  }

  private buildShadows(): THREE.InstancedMesh {
    const texture = new THREE.TextureLoader().load(shadowUrl)
    texture.colorSpace = THREE.SRGBColorSpace

    // A 10-gon rather than a quad: the blob is round, and a quad's corners are ~27%
    // extra rasterised area for pixels that multiply by white anyway.
    const geo = new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2)
    geo.setAttribute('aLife', this.aLife)
    geo.setAttribute('aRand', this.aRand)

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // Multiply darkens the camera feed underneath instead of painting a grey disc
      // over it, so the contact shadow reads on a white desk and on a dark one. three's
      // premultiplied path gives dst*src + dst*(1-srcAlpha); the texture is opaque, so
      // that reduces to a plain multiply.
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      depthWrite: false,
      toneMapped: false,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      injectShadow(shader)
    }
    material.customProgramCacheKey = () => 'grass-shadow-v1'

    const mesh = new THREE.InstancedMesh(geo, material, this.capacity)
    mesh.name = 'grassShadows'
    mesh.count = 0
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // After the grass, which has already written depth. The disc sits slightly below the
    // contact point so the tuft base occludes it correctly.
    mesh.renderOrder = 1
    this.scene.add(mesh)
    return mesh
  }

  /** Tufts currently alive (excludes ones shrinking away). */
  get liveCount(): number { return this.live.length }

  /**
   * Reads back one random live tuft: where it sits and which way it points. This is how
   * flowers.ts finds somewhere to bloom without either field knowing about the other --
   * a flower belongs in the grass, not at an arbitrary point in the room.
   *
   * The matrix is the source of truth rather than a parallel list of positions, so this
   * cannot drift out of step with what is actually drawn. The per-tuft spin is about the
   * surface normal, so decomposing it still gives that normal back.
   *
   * @returns false when nothing is planted; `position` and `normal` are then untouched.
   */
  sampleLive(position: THREE.Vector3, normal: THREE.Vector3): boolean {
    if (!this.live.length) return false
    const slot = this.live[Math.floor(Math.random() * this.live.length)]
    this.mesh.getMatrixAt(slot, this._m)
    this._m.decompose(position, this._q, this._scale)
    normal.set(0, 1, 0).applyQuaternion(this._q).normalize()
    return true
  }

  /**
   * Plants a clump around `position`, oriented to `normal`.
   * @returns how many tufts were actually planted.
   */
  plant(
    position: THREE.Vector3 | {x: number; y: number; z: number},
    normal: THREE.Vector3 | {x: number; y: number; z: number} | null = null,
    {count = this.opts.perTap, radius = this.opts.tapRadius}: {count?: number; radius?: number} = {},
  ): number {
    const now = this.time
    this.reclaim(now)
    this.makeRoom(count, now)
    const n = Math.min(count, this.free.length)
    if (n === 0) return 0

    // hitTest does not return a surface normal, so up is the honest fallback: grass on a
    // table wants to point at the ceiling.
    const up = normal ? this._normal.set(normal.x, normal.y, normal.z) : this._normal.set(0, 1, 0)
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0)
    up.normalize()
    const align = this._align.setFromUnitVectors(this._up, up)

    for (let k = 0; k < n; k++) {
      const slot = this.free.pop()!
      this.live.push(slot)

      // Scatter over a disc, sqrt-weighted so the clump is not centre-heavy. Offsets are
      // laid out in the surface plane, not world XZ, so a clump on a tilted surface still
      // hugs it.
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * radius
      this._offset.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(align)

      const scale = this.opts.height * (1 + (Math.random() * 2 - 1) * this.opts.heightJitter)
      this._spin.setFromAxisAngle(this._up, Math.random() * Math.PI * 2)
      this._q.copy(align).multiply(this._spin)
      this._pos.set(position.x, position.y, position.z).add(this._offset)

      this._m.compose(this._pos, this._q, this._scale.setScalar(scale))
      this.mesh.setMatrixAt(slot, this._m)
      markRange(this.mesh.instanceMatrix, slot, 16)

      // instanceColor is a built-in three multiply on the diffuse, so per-instance tint
      // needs no extra shader code.
      const t = 0.85 + Math.random() * 0.3
      this._colour.setRGB(t * (0.94 + Math.random() * 0.12), t, t * (0.9 + Math.random() * 0.1))
      this.mesh.setColorAt(slot, this._colour)
      markRange(this.mesh.instanceColor, slot, 3)

      this.aLife.array[slot * 2] = now
      this.aLife.array[slot * 2 + 1] = NOT_RETIRING
      markRange(this.aLife, slot, 2)

      this.aRand.array[slot * 3] = Math.random() * Math.PI * 2
      this.aRand.array[slot * 3 + 1] = Math.floor(Math.random() * 4)
      this.aRand.array[slot * 3 + 2] = 0
      markRange(this.aRand, slot, 3)

      if (this.shadow) {
        // Sunk just below the contact point, so the tuft's own base wins the depth test
        // and the disc does not multiply over the grass drawn above it.
        const s = scale * this.opts.shadowScale
        this._pos.addScaledVector(up, -0.004)
        this._m.compose(this._pos, align, this._scale.setScalar(s))
        this.shadow.setMatrixAt(slot, this._m)
        markRange(this.shadow.instanceMatrix, slot, 16)
      }

      if (slot >= this.highWater) this.highWater = slot + 1
    }

    this.mesh.count = this.highWater
    // Frustum culling stays on and the bounds are refreshed here. A user who turns away
    // from the patch then costs nothing at all, which is worth the O(count) sphere
    // recompute -- it runs on tap, never per frame.
    this.mesh.computeBoundingSphere()
    if (this.shadow) {
      this.shadow.count = this.highWater
      this.shadow.computeBoundingSphere()
    }
    this.flush()

    // Trim proactively so eviction never has to happen inside a plant() call.
    while (this.live.length > this.softCap) this.retireOldest(now)
    return n
  }

  /** Call once per frame. `elapsed` is monotonic seconds since start. */
  update(elapsed: number, camera?: THREE.Camera): void {
    this.time = elapsed
    this.uniforms.uTime.value = elapsed
    if (camera) camera.getWorldPosition(this.uniforms.uEye.value as THREE.Vector3)
    this.reclaim(elapsed)
  }

  /** Removes everything, with the normal shrink-out. */
  clear(): void {
    while (this.live.length) this.retireOldest(this.time)
  }

  /** Removes everything immediately, no shrink. For benchmarks and scene resets. */
  reset(): void {
    this.free = Array.from({length: this.capacity}, (_, i) => this.capacity - 1 - i)
    this.live.length = 0
    this.retiring.length = 0
    this.highWater = 0
    this.mesh.count = 0
    this.mesh.boundingSphere?.makeEmpty()
    if (this.shadow) {
      this.shadow.count = 0
      this.shadow.boundingSphere?.makeEmpty()
    }
  }

  dispose(): void {
    for (const m of [this.mesh, this.shadow]) {
      if (!m) continue
      this.scene.remove(m)
      m.geometry.dispose()
      const mat = m.material as THREE.MeshBasicMaterial
      mat.map?.dispose()
      mat.dispose()
      m.dispose()
    }
  }

  // -- slot lifecycle -------------------------------------------------------

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

  private makeRoom(count: number, now: number): void {
    const need = count - this.free.length
    for (let i = 0; i < need && this.live.length; i++) this.retireOldest(now)
    // Only reached if tufts are planted faster than RETIRE_SEC can free them; the shrink
    // is cut short rather than dropping the tap.
    while (this.free.length < count && this.retiring.length) {
      this.free.push(this.retiring.shift()!.slot)
    }
  }

  private flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.aLife.needsUpdate = true
    this.aRand.needsUpdate = true
    if (this.shadow) this.shadow.instanceMatrix.needsUpdate = true
  }
}
