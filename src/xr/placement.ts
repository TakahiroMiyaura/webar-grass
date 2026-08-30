// Screen-space tap -> world position.
//
// This is the seam the grass feature (MYAA-16) builds on, and the one place that knows
// hitTest() is an 8th Wall call. Keeping it isolated matters here for a specific reason:
// the engine binary is closed-source and its support window has already lapsed, so the
// project needs to be able to swap the tracking backend without rewriting the scene.
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

export interface SurfaceHit {
  type: string
  position: {x: number; y: number; z: number}
  rotation: {x: number; y: number; z: number; w: number}
}

const isUsable = (hit: XrHitTestResult | undefined): hit is XrHitTestResult =>
  Boolean(hit?.position) && hit!.position.x !== null && Number.isFinite(hit!.position.x)

/**
 * @param x screen x in 0..1, origin top-left
 * @param y screen y in 0..1, origin top-left
 */
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

export const hitTestEvent = (event: MouseEvent | TouchEvent): SurfaceHit | null => {
  const point = 'touches' in event && event.touches.length > 0
    ? event.touches[0]
    : (event as MouseEvent)
  const x = (point.clientX ?? window.innerWidth / 2) / window.innerWidth
  const y = (point.clientY ?? window.innerHeight / 2) / window.innerHeight
  return hitTestScreen(x, y)
}
