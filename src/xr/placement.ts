// Screen-space tap -> world position.
//
// This is the one place that knows hitTest() is an 8th Wall call. Keeping it isolated
// matters here for a specific reason: the engine binary is closed-source and its support
// window has already lapsed, so the project needs to be able to swap the tracking
// backend without rewriting the scene.
//
// MYAA-16 asks which of two ways of choosing the surface meets the requirement, and that
// cannot be settled without a phone. So both are implemented and the app can switch
// between them at runtime:
//
//   PLANE   (plan A) three.js Raycaster against one invisible horizontal plane.
//           Rock steady, but a single height for the whole scene: aim at a table
//           and the object still lands on the floor.
//   HITTEST (plan B) XR8.XrController.hitTest(), feature-point based, so it picks
//           up per-surface heights -- at the cost of a noisy, occasionally absent y.
//
// AUTO is the shipped default and is "A as the base, B filling the gaps": the plane
// supplies the reference height and acts as the sanity check, and a hitTest result is
// only believed when it survives that check. Every rejection is recorded so the
// on-device measurement panel can show which of A/B carried a given tap.
import * as THREE from 'three'
import type {XrHitTestResult, XrHitTestType} from '../types/8thwall'

/**
 * Ordered by how much we trust the height. DETECTED_SURFACE is a real surface the engine
 * committed to; FEATURE_POINT is a raw point and is the only type that showed up in
 * headless testing. Which of these actually appears on hardware is what MYAA-16 has to
 * settle - hence returning the type alongside the position rather than hiding it.
 */
const HIT_TEST_TYPES: XrHitTestType[] = [
  'DETECTED_SURFACE',
  'ESTIMATED_SURFACE',
  'FEATURE_POINT',
  'UNSPECIFIED',
]

const TYPE_RANK: Record<string, number> = {
  DETECTED_SURFACE: 0,
  ESTIMATED_SURFACE: 1,
  FEATURE_POINT: 2,
  UNSPECIFIED: 3,
}

/**
 * Types the engine reports as actual surfaces rather than as bare feature points. A lone
 * uncorroborated reading is only trusted when it is one of these.
 */
const SURFACE_TYPES = new Set(['DETECTED_SURFACE', 'ESTIMATED_SURFACE'])

export const Mode = {AUTO: 'AUTO', PLANE: 'PLANE', HITTEST: 'HITTEST'} as const
export type PlacementMode = typeof Mode[keyof typeof Mode]

export const LIMITS = {
  // Closer than this is inside the user's own hand; further is a ray that has gone
  // near-horizontal and would drop an object across the room.
  minDistance: 0.2,
  maxDistance: 8,
  // A real surface is never below the floor. Tables top out around 1.2m; 2m of
  // headroom covers a kitchen counter without accepting a hit on the ceiling.
  belowPlaneTolerance: 0.12,
  abovePlaneMax: 2.0,
  // Samples within this much of the tapped point's height count as the same surface.
  // Well under the ~0.7m that separates a table from the floor, well over SLAM noise.
  clusterTolerance: 0.1,
  // How far the samples that survive clustering may still disagree.
  spreadMax: 0.25,
  samples: 5,
  jitterPx: 10,
}

export interface SurfaceHit {
  type: string
  position: {x: number; y: number; z: number}
  rotation: {x: number; y: number; z: number; w: number}
}

const UP = new THREE.Vector3(0, 1, 0)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const isUsable = (hit: XrHitTestResult | undefined): hit is XrHitTestResult =>
  Boolean(hit?.position) && finite(hit!.position.x) && finite(hit!.position.y) &&
  finite(hit!.position.z)

/**
 * hitTest hands back {x,y,z,w} that is all zeros on every result observed so far (both
 * Chromium and WebKit, synthetic camera). A zero-norm quaternion is not a rotation:
 * feeding it to three.js yields NaN and the object vanishes. Anything that fails to
 * normalise is discarded in favour of world up. If the engine ever starts returning a
 * real orientation this picks it up automatically.
 */
export const normalFromRotation = (
  rot: {x: number; y: number; z: number; w: number} | null | undefined,
): THREE.Vector3 | null => {
  if (!rot || !finite(rot.x) || !finite(rot.y) || !finite(rot.z) || !finite(rot.w)) return null
  const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)
  if (q.length() < 1e-6) return null
  q.normalize()
  const n = UP.clone().applyQuaternion(q)
  if (n.lengthSq() < 1e-6) return null
  return n.normalize()
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Component-wise median, plus how far the worst sample sits from it. The spread is the
 * outlier signal: five samples 10px apart on a real surface land within a few cm, while
 * a feature point straddling a depth discontinuity scatters.
 */
export const medianPoint = (points: THREE.Vector3[]): {point: THREE.Vector3; spread: number} => {
  const c = new THREE.Vector3(
    median(points.map((p) => p.x)),
    median(points.map((p) => p.y)),
    median(points.map((p) => p.z)),
  )
  let spread = 0
  for (const p of points) spread = Math.max(spread, c.distanceTo(p))
  return {point: c, spread}
}

export type HitTestFn = (x: number, y: number, types: XrHitTestType[]) => XrHitTestResult[]

/** A single query, best result only. Screen coords are 0..1, origin top-left. */
export const hitTestScreen = (x: number, y: number): SurfaceHit | null => {
  if (!window.XR8) return null
  try {
    const hits = XR8.XrController.hitTest(x, y, HIT_TEST_TYPES)
    const hit = hits?.[0]
    if (!isUsable(hit)) return null
    return {type: hit.type, position: hit.position, rotation: hit.rotation}
  } catch {
    // hitTest throws while the session is still coming up; a miss is the right answer.
    return null
  }
}

export interface Placement {
  source: PlacementMode
  point: THREE.Vector3
  normal: THREE.Vector3
  type: string
  distance: number | null
  /** Plan B only. */
  spread?: number
  samples?: number
  agreeing?: number
  anchored?: boolean
  normalFromEngine?: boolean
}

export interface ResolveRecord {
  chosen: Placement | null
  why: string
  mode: PlacementMode
  groundY: number
  a: {y: number; distance: number | null} | null
  b: {
    y: number; type: string; spread: number; samples: number
    agreeing: number; anchored: boolean; distance: number | null
  } | null
  at: number
}

export class PlacementResolver {
  camera?: THREE.Camera
  hitTestFn: HitTestFn
  mode: PlacementMode = Mode.AUTO
  groundY = 0
  lastResolve: ResolveRecord | null = null

  private raycaster = new THREE.Raycaster()
  private plane = new THREE.Plane(UP.clone(), 0)

  // hitTestFn is injected so the resolver can be exercised without the engine.
  constructor({camera, hitTestFn}: {camera?: THREE.Camera; hitTestFn?: HitTestFn} = {}) {
    this.camera = camera
    this.hitTestFn = hitTestFn ?? ((x, y, types) => XR8.XrController.hitTest(x, y, types))
  }

  setMode(mode: PlacementMode): void { this.mode = mode }

  /**
   * The reference height is user-adjustable: standing at a table and pressing
   * "align to this surface" is what makes plan A usable on anything but the floor.
   */
  setGroundY(y: number): void { if (finite(y)) this.groundY = y }

  /** Plan A. Screen pixels -> NDC -> ray -> the one horizontal plane. */
  planeHit(sx: number, sy: number, width: number, height: number):
  (Placement & {rejected?: string}) | {rejected: string; distance: number} | null {
    if (!this.camera || !width || !height) return null
    const ndc = new THREE.Vector2((sx / width) * 2 - 1, -((sy / height) * 2 - 1))
    this.raycaster.setFromCamera(ndc, this.camera)
    this.plane.constant = -this.groundY
    const point = new THREE.Vector3()
    // Returns null when the ray is parallel to the plane or points away from it, which
    // is exactly the "user aimed at the sky" case.
    if (!this.raycaster.ray.intersectPlane(this.plane, point)) return null
    const distance = this.raycaster.ray.origin.distanceTo(point)
    if (distance < LIMITS.minDistance || distance > LIMITS.maxDistance) {
      return {rejected: 'distance', distance}
    }
    return {source: Mode.PLANE, point, normal: UP.clone(), distance, type: 'REFERENCE_PLANE'}
  }

  /** One hitTest query, best result only: sorted by declared trust, then by proximity. */
  queryOnce(nx: number, ny: number): XrHitTestResult | {error: string} | null {
    let hits: XrHitTestResult[]
    try {
      hits = this.hitTestFn(nx, ny, HIT_TEST_TYPES)
    } catch (e) {
      return {error: e instanceof Error ? e.message : String(e)}
    }
    if (!hits?.length) return null
    const usable = hits.filter((h) => isUsable(h))
    if (!usable.length) return null
    usable.sort((a, b) => {
      const r = (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)
      return r !== 0 ? r : (a.distance ?? Infinity) - (b.distance ?? Infinity)
    })
    return usable[0]
  }

  /**
   * Plan B. hitTest is queried several times around the tap rather than once, and the
   * samples are reduced to a consensus. A single query is what makes B feel like it
   * jitters; more importantly, the agreement between samples tells us when not to trust
   * the reading at all.
   *
   * The consensus is anchored on the tapped point rather than taken as a plain median of
   * everything. Tap near the far edge of a table and the neighbouring samples fall past
   * it onto the floor half a metre below; a plain median then either lands between two
   * real surfaces or is thrown out as noise, and either way the grass misses the table
   * the user was aiming at. Anchoring keeps the surface under the finger and discards the
   * samples that belong to a different one.
   */
  hitTestHit(sx: number, sy: number, width: number, height: number):
  (Placement & {spread: number; samples: number; agreeing: number; anchored: boolean})
  | {rejected: string; error?: string} | null {
    if (!width || !height) return null
    const j = LIMITS.jitterPx
    // Centre first, then a diamond around it.
    const offsets = [[0, 0], [-j, 0], [j, 0], [0, -j], [0, j]].slice(0, Math.max(1, LIMITS.samples))
    const samples: {point: THREE.Vector3; hit: XrHitTestResult; centre: boolean}[] = []
    let error: string | null = null
    for (const [dx, dy] of offsets) {
      const nx = Math.min(1, Math.max(0, (sx + dx) / width))
      const ny = Math.min(1, Math.max(0, (sy + dy) / height))
      const hit = this.queryOnce(nx, ny)
      if (!hit) continue
      if ('error' in hit) { error = hit.error; continue }
      samples.push({
        point: new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z),
        hit,
        centre: dx === 0 && dy === 0,
      })
    }
    if (!samples.length) return error ? {rejected: 'error', error} : null

    const centre = samples.find((s) => s.centre)
    // If the tapped point itself returned nothing, there is no aim to anchor on and the
    // median of the neighbours is the best available guess.
    const anchor = centre ? centre.point : medianPoint(samples.map((s) => s.point)).point
    const cluster = samples.filter((s) => Math.abs(s.point.y - anchor.y) <= LIMITS.clusterTolerance)

    const {point, spread} = medianPoint(cluster.map((s) => s.point))
    let best = cluster[0].hit
    for (const s of cluster) {
      if ((TYPE_RANK[s.hit.type] ?? 9) < (TYPE_RANK[best.type] ?? 9)) best = s.hit
    }
    const engineNormal = normalFromRotation(best.rotation)
    return {
      source: Mode.HITTEST,
      point,
      normal: engineNormal ?? UP.clone(),
      normalFromEngine: Boolean(engineNormal),
      type: best.type || 'UNSPECIFIED',
      distance: this.camera ? this.camera.position.distanceTo(point) : (best.distance ?? null),
      spread,
      samples: samples.length,
      agreeing: cluster.length,
      anchored: Boolean(centre),
    }
  }

  /** Is this hitTest reading believable, judged against the reference plane? */
  validateAgainstPlane(b: Placement & {spread: number; agreeing: number}): string | null {
    const dy = b.point.y - this.groundY
    // A single sample with nothing corroborating it is only believable when the engine
    // called it a surface. A lone feature point is the reading that puts grass in mid-air.
    if (b.agreeing < 2 && !SURFACE_TYPES.has(b.type)) return 'lone-feature-point'
    if (b.spread > LIMITS.spreadMax) return 'spread'
    if (dy < -LIMITS.belowPlaneTolerance) return 'below-plane'
    if (dy > LIMITS.abovePlaneMax) return 'above-plane'
    if (b.distance != null && (b.distance < LIMITS.minDistance || b.distance > LIMITS.maxDistance)) {
      return 'distance'
    }
    return null
  }

  /** sx/sy are CSS pixels within the canvas -- the tap point, never the screen centre. */
  resolve(sx: number, sy: number, width: number, height: number): ResolveRecord {
    const rawA = this.planeHit(sx, sy, width, height)
    const a = rawA && 'point' in rawA ? rawA as Placement : null
    const rawB = this.mode === Mode.PLANE ? null : this.hitTestHit(sx, sy, width, height)
    const b = rawB && 'point' in rawB
      ? rawB as Placement & {spread: number; samples: number; agreeing: number; anchored: boolean}
      : null

    let chosen: Placement | null = null
    let why = ''
    if (this.mode === Mode.PLANE) {
      chosen = a
      why = a ? 'plane-only mode'
        : (rawA && 'rejected' in rawA ? 'plane rejected: ' + rawA.rejected : 'no plane intersection')
    } else if (this.mode === Mode.HITTEST) {
      chosen = b
      why = b ? 'hitTest-only mode' : 'hitTest returned nothing usable'
    } else if (!b) {
      chosen = a
      why = a ? 'no hitTest result, fell back to the reference plane'
        : 'neither method produced a point'
    } else if (!a) {
      // No plane intersection means no sanity check is available, but a hit is still
      // better than refusing the tap.
      chosen = b
      why = 'hitTest accepted unchecked (ray missed the reference plane)'
    } else {
      const reject = this.validateAgainstPlane(b)
      chosen = reject ? a : b
      why = reject
        ? `hitTest rejected (${reject}), fell back to the reference plane`
        : 'hitTest accepted'
    }

    const record: ResolveRecord = {
      chosen,
      why,
      mode: this.mode,
      groundY: this.groundY,
      a: a ? {y: a.point.y, distance: a.distance} : null,
      b: b ? {
        y: b.point.y, type: b.type, spread: b.spread, samples: b.samples,
        agreeing: b.agreeing, anchored: b.anchored, distance: b.distance,
      } : null,
      at: Date.now(),
    }
    this.lastResolve = record
    return record
  }

  /**
   * "Treat the surface I am looking at as the reference height." The reference is reused
   * by every later tap, so this is held to a stricter bar than a placement: a majority of
   * the samples must agree before the world is moved, not just one corroborating
   * neighbour.
   */
  calibrateGroundFrom(sx: number, sy: number, width: number, height: number): number | null {
    const b = this.hitTestHit(sx, sy, width, height)
    if (!b || !('point' in b)) return null
    const majority = Math.ceil(LIMITS.samples / 2)
    if (b.spread > LIMITS.spreadMax || b.agreeing < majority) return null
    this.setGroundY(b.point.y)
    return b.point.y
  }
}
