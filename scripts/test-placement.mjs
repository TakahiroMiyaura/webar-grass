// Unit tests for the tap -> world-point math. These need neither the engine nor a
// phone: the camera is a real three.js camera and hitTest is a stub, so every branch
// of the A / B / AUTO decision is checked against known geometry.
import * as THREE from 'three'
import {PlacementResolver, Mode, DEFAULT_MODE, LIMITS, medianPoint, normalFromRotation} from '../src/xr/placement.ts'

let pass = 0
const failures = []
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL ' + name + ' -- ' + e.message) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed') }
const near = (a, b, tol, msg) =>
  assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`)

// A phone held at eye height, tilted down towards the floor a couple of metres ahead.
const makeCamera = (pos = [0, 1.6, 0], lookAt = [0, 0, -2]) => {
  const cam = new THREE.PerspectiveCamera(60, 412 / 915, 0.01, 100)
  cam.position.set(...pos)
  cam.lookAt(new THREE.Vector3(...lookAt))
  cam.updateMatrixWorld(true)
  return cam
}
const W = 412, H = 915
const stub = (results) => () => (typeof results === 'function' ? results() : results)
const hit = (x, y, z, type = 'FEATURE_POINT', rotation = {x: 0, y: 0, z: 0, w: 0}) =>
  ({type, position: {x, y, z}, rotation, distance: 1})

console.log('\n-- plan A: reference-plane raycast')

check('centre tap lands on the reference plane', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub(null)})
  const a = r.planeHit(W / 2, H / 2, W, H)
  assert(a && a.point, 'expected an intersection')
  near(a.point.y, 0, 1e-6, 'y should sit exactly on the plane')
  near(a.point.x, 0, 1e-6, 'centre tap should not drift sideways')
  assert(a.point.z < 0, 'should land in front of the camera')
  near(a.distance, Math.hypot(1.6, 2), 1e-3, 'distance')
})

check('the tap position drives the ray, not the screen centre', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub(null)})
  const left = r.planeHit(W * 0.2, H / 2, W, H)
  const right = r.planeHit(W * 0.8, H / 2, W, H)
  const low = r.planeHit(W / 2, H * 0.8, W, H)
  assert(left.point.x < -0.2, 'left tap should land to the left, got x=' + left.point.x)
  assert(right.point.x > 0.2, 'right tap should land to the right, got x=' + right.point.x)
  near(left.point.x, -right.point.x, 1e-6, 'left/right should mirror')
  assert(low.point.z > left.point.z || low.point.distanceTo(left.point) > 0.2,
    'a tap lower on screen should land closer to the user')
})

check('a tap above the horizon yields no placement', () => {
  // Phone tilted up at the ceiling: the ray never meets the floor plane.
  const r = new PlacementResolver({camera: makeCamera([0, 1.6, 0], [0, 3, -2]), hitTestFn: stub(null)})
  const a = r.planeHit(W / 2, H * 0.1, W, H)
  assert(a === null, 'expected null, got ' + JSON.stringify(a))
})

check('a near-horizontal ray is rejected instead of placing across the room', () => {
  const r = new PlacementResolver({camera: makeCamera([0, 1.6, 0], [0, 1.55, -20]), hitTestFn: stub(null)})
  const a = r.planeHit(W / 2, H / 2, W, H)
  assert(a && a.rejected === 'distance', 'expected a distance rejection, got ' + JSON.stringify(a))
  assert(a.distance > LIMITS.maxDistance, 'the rejected hit should be beyond the limit')
})

check('raising the reference plane raises the placement', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub(null)})
  const floor = r.planeHit(W / 2, H / 2, W, H)
  r.setGroundY(0.75)
  const table = r.planeHit(W / 2, H / 2, W, H)
  near(table.point.y, 0.75, 1e-6, 'plane height')
  assert(table.distance < floor.distance, 'a higher plane is met sooner along the ray')
})

console.log('\n-- plan B: hitTest sampling')

check('component-wise median discards a single wild sample', () => {
  const pts = [[0, 0.75, -1], [0.01, 0.76, -1], [0, 0.74, -1.01], [0, 12, -1], [0, 0.75, -1]]
    .map(([x, y, z]) => new THREE.Vector3(x, y, z))
  const {point} = medianPoint(pts)
  near(point.y, 0.75, 0.02, 'median y should ignore the 12m outlier')
})

check('spread reports sample disagreement', () => {
  const tight = medianPoint([[0, 1, 0], [0.01, 1.01, 0], [0, 0.99, 0.01]].map((p) => new THREE.Vector3(...p)))
  const loose = medianPoint([[0, 1, 0], [0, 2.5, 0], [0, 0.2, 0]].map((p) => new THREE.Vector3(...p)))
  assert(tight.spread < 0.05, 'tight cluster spread=' + tight.spread)
  assert(loose.spread > LIMITS.spreadMax, 'scattered cluster spread=' + loose.spread)
})

check('the zero quaternion the engine returns is not used as a rotation', () => {
  // Every hitTest result observed so far carries {0,0,0,0}. Normalising it gives NaN.
  assert(normalFromRotation({x: 0, y: 0, z: 0, w: 0}) === null, 'zero quaternion must be rejected')
  assert(normalFromRotation(undefined) === null, 'missing rotation must be rejected')
  assert(normalFromRotation({x: 0, y: 0, z: 0, w: NaN}) === null, 'NaN must be rejected')
  const up = normalFromRotation({x: 0, y: 0, z: 0, w: 1})
  near(up.y, 1, 1e-6, 'identity should give world up')
  // 90 degrees about X takes +Y to +Z.
  const tilted = normalFromRotation({x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2})
  near(tilted.z, 1, 1e-6, 'rotated normal')
})

check('a placement always ends up with a finite, unit-length normal', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([hit(0, 0.75, -1)])})
  const b = r.hitTestHit(W / 2, H / 2, W, H)
  assert(b.normalFromEngine === false, 'the zero quaternion should not count as an engine normal')
  near(b.normal.length(), 1, 1e-6, 'normal length')
  assert(Number.isFinite(b.normal.x + b.normal.y + b.normal.z), 'normal must be finite')
})

check('surface types outrank feature points', () => {
  const r = new PlacementResolver({
    camera: makeCamera(),
    hitTestFn: stub([hit(0, 0.1, -1, 'FEATURE_POINT'), hit(0, 0.75, -1, 'DETECTED_SURFACE')]),
  })
  const b = r.hitTestHit(W / 2, H / 2, W, H)
  assert(b.type === 'DETECTED_SURFACE', 'got ' + b.type)
})

check('null and non-finite positions are filtered out', () => {
  const r = new PlacementResolver({
    camera: makeCamera(),
    hitTestFn: stub([hit(null, null, null), hit(0, NaN, -1), hit(0, 0.75, -1)]),
  })
  const b = r.hitTestHit(W / 2, H / 2, W, H)
  near(b.point.y, 0.75, 1e-6, 'only the usable result should survive')
})

check('an all-null response is treated as no hit, not as the origin', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([hit(null, null, null)])})
  assert(r.hitTestHit(W / 2, H / 2, W, H) === null, 'expected null')
})

check('a throwing hitTest does not take the app down', () => {
  const r = new PlacementResolver({
    camera: makeCamera(),
    hitTestFn: () => { throw new Error('engine not running') },
  })
  const out = r.hitTestHit(W / 2, H / 2, W, H)
  assert(out && out.rejected === 'error', 'expected a recorded error, got ' + JSON.stringify(out))
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen && res.chosen.source === Mode.PLANE, 'AUTO should still place via the plane')
})

check('hitTest is queried around the tap, in normalised top-left coords', () => {
  const seen = []
  const r = new PlacementResolver({
    camera: makeCamera(),
    hitTestFn: (x, y) => { seen.push([x, y]); return [hit(0, 0.75, -1)] },
  })
  r.hitTestHit(W / 2, H / 2, W, H)
  assert(seen.length === LIMITS.samples, 'expected ' + LIMITS.samples + ' samples, got ' + seen.length)
  for (const [x, y] of seen) assert(x >= 0 && x <= 1 && y >= 0 && y <= 1, 'coords out of 0..1: ' + [x, y])
  near(seen[0][0], 0.5, 1e-6, 'first sample should be the tap itself (x)')
  near(seen[0][1], 0.5, 1e-6, 'first sample should be the tap itself (y)')
  assert(new Set(seen.map(String)).size === LIMITS.samples, 'samples should be spread, not repeated')
})

check('samples near a screen edge stay inside 0..1', () => {
  const seen = []
  const r = new PlacementResolver({
    camera: makeCamera(),
    hitTestFn: (x, y) => { seen.push([x, y]); return [hit(0, 0, -1)] },
  })
  r.hitTestHit(1, 1, W, H)
  for (const [x, y] of seen) assert(x >= 0 && x <= 1 && y >= 0 && y <= 1, 'clamping failed: ' + [x, y])
})

console.log('\n-- AUTO: B when it is believable, A otherwise')

// AUTO is no longer what a resolver starts in (MYAA-22 ships B), so these ask for it.
const auto = (hits, groundY = 0) => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub(hits)})
  r.setMode(Mode.AUTO)
  r.setGroundY(groundY)
  return r.resolve(W / 2, H / 2, W, H)
}

check('a table-height hit is accepted (the case the feature exists for)', () => {
  const res = auto([hit(0, 0.75, -1, 'ESTIMATED_SURFACE')])
  assert(res.chosen.source === Mode.HITTEST, 'expected the hitTest result, got ' + res.chosen.source)
  near(res.chosen.point.y, 0.75, 1e-6, 'should sit at table height, not on the floor')
})

check('a hit below the floor is rejected', () => {
  const res = auto([hit(0, -0.5, -1)])
  assert(res.chosen.source === Mode.PLANE, 'got ' + res.chosen.source)
  assert(res.why.includes('below-plane'), res.why)
})

check('a hit near the ceiling is rejected', () => {
  const res = auto([hit(0, 2.6, -1)])
  assert(res.chosen.source === Mode.PLANE, 'got ' + res.chosen.source)
  assert(res.why.includes('above-plane'), res.why)
})

check('a lone reading amid scattered samples is not trusted', () => {
  let n = 0
  const scatter = () => [hit(0, [0.7, 2.4, 0.1, 1.9, 0.4][n++ % 5], -1)]
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: scatter})
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.b.agreeing === 1, 'nothing should corroborate the tapped point, got ' + res.b.agreeing)
  assert(res.chosen.source === Mode.PLANE, 'got ' + res.chosen.source)
  assert(res.why.includes('lone-feature-point'), res.why)
})

check('a lone reading IS trusted when the engine calls it a surface', () => {
  let n = 0
  const scatter = () => [hit(0, [0.75, 2.4, 0.1, 1.9, 0.4][n++ % 5], -1,
    n === 1 ? 'DETECTED_SURFACE' : 'FEATURE_POINT')]
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: scatter})
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen.source === Mode.HITTEST, 'got ' + res.chosen.source + ' -- ' + res.why)
  near(res.chosen.point.y, 0.75, 1e-6)
})

check('samples that agree on height but not on position are rejected as noise', () => {
  // Same surface height, wildly different world positions: a grazing ray, not a surface.
  let n = 0
  const smear = () => [hit([0, 1.2, -0.9, 0.6, -1.4][n++ % 5], 0.75, -1)]
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: smear})
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.b.spread > LIMITS.spreadMax, 'spread=' + res.b.spread)
  assert(res.chosen.source === Mode.PLANE, 'got ' + res.chosen.source)
  assert(res.why.includes('spread'), res.why)
})

check('a tap near a table edge keeps the table, not the floor behind it', () => {
  // The case that motivated anchoring: the tapped point is on the table, three of the
  // four neighbours fall past the far edge onto the floor 75cm below.
  let n = 0
  const edge = () => {
    const y = [0.75, 0.75, 0, 0, 0][n++ % 5]
    return [hit(0, y, -1, y > 0.5 ? 'DETECTED_SURFACE' : 'ESTIMATED_SURFACE')]
  }
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: edge})
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen.source === Mode.HITTEST, 'got ' + res.chosen.source + ' -- ' + res.why)
  near(res.chosen.point.y, 0.75, 1e-6, 'a plain median would have said 0 here')
  assert(res.b.agreeing === 2, 'agreeing=' + res.b.agreeing)
})

check('with no reading at the tapped point, the neighbours still decide', () => {
  let n = 0
  // The centre query comes back empty; the four neighbours agree on a surface.
  const patchy = () => (n++ === 0 ? [] : [hit(0, 0.75, -1, 'ESTIMATED_SURFACE')])
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: patchy})
  r.setMode(Mode.AUTO)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.b.anchored === false, 'should be flagged as unanchored')
  assert(res.chosen.source === Mode.HITTEST, 'got ' + res.chosen.source + ' -- ' + res.why)
  near(res.chosen.point.y, 0.75, 1e-6)
})

check('tolerance just below the plane is allowed (SLAM noise, not a bad reading)', () => {
  const res = auto([hit(0, -0.05, -1)])
  assert(res.chosen.source === Mode.HITTEST, 'a 5cm dip should still be accepted')
})

check('with no hitTest result, the plane carries the tap', () => {
  const res = auto([])
  assert(res.chosen.source === Mode.PLANE, 'got ' + JSON.stringify(res.chosen))
  near(res.chosen.point.y, 0, 1e-6, 'plane height')
})

check('validation is relative to the reference plane, not to absolute zero', () => {
  // Reference raised to a desk: a hit at desk height is now normal, and one at floor
  // height is 75cm below the reference and correctly distrusted.
  const onDesk = auto([hit(0, 0.78, -1)], 0.75)
  assert(onDesk.chosen.source === Mode.HITTEST, 'desk-height hit should pass')
  const onFloor = auto([hit(0, 0.0, -1)], 0.75)
  assert(onFloor.chosen.source === Mode.PLANE, 'floor hit should be rejected once the desk is the reference')
})

check('every tap is recorded for the on-device A/B comparison', () => {
  const res = auto([hit(0, 0.75, -1, 'ESTIMATED_SURFACE')])
  assert(res.a && typeof res.a.y === 'number', 'plan A height must be recorded even when unused')
  assert(res.b && res.b.type === 'ESTIMATED_SURFACE', 'plan B type must be recorded')
  assert(typeof res.why === 'string' && res.why.length, 'the decision must be explained')
})

console.log('\n-- the shipped default')

check('a resolver starts in B, not AUTO (MYAA-22)', () => {
  assert(DEFAULT_MODE === Mode.HITTEST, 'DEFAULT_MODE is ' + DEFAULT_MODE)
  assert(new PlacementResolver().mode === DEFAULT_MODE, 'the resolver ignored DEFAULT_MODE')
})

check('by default a table-height hit is taken as-is, with no plane check', () => {
  // The same reading AUTO would have thrown out: far enough below the reference plane
  // that validateAgainstPlane() rejects it. B on its own must not second-guess it.
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([hit(0, -0.5, -1)])})
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen.source === Mode.HITTEST, 'got ' + res.chosen.source + ' -- ' + res.why)
  near(res.chosen.point.y, -0.5, 1e-6)
})

check('by default a tap hitTest cannot answer is a miss, not a floor placement', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([])})
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen === null, 'expected a miss, got ' + JSON.stringify(res.chosen))
  // The plane is still measured, so the measurement panel can show what A would have said.
  assert(res.a && typeof res.a.y === 'number', 'plan A must still be recorded')
})

console.log('\n-- forced modes and calibration')

check('PLANE mode never calls hitTest', () => {
  let called = 0
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: () => { called++; return [hit(0, 0.75, -1)] }})
  r.setMode(Mode.PLANE)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(called === 0, 'hitTest was called ' + called + ' times')
  assert(res.chosen.source === Mode.PLANE)
})

check('HITTEST mode keeps a reading the AUTO check would have thrown away', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([hit(0, -0.5, -1)])})
  r.setMode(Mode.HITTEST)
  const res = r.resolve(W / 2, H / 2, W, H)
  assert(res.chosen.source === Mode.HITTEST, 'forced mode must not fall back')
  near(res.chosen.point.y, -0.5, 1e-6)
})

check('HITTEST mode reports a miss rather than silently using the plane', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([])})
  r.setMode(Mode.HITTEST)
  assert(r.resolve(W / 2, H / 2, W, H).chosen === null, 'expected no placement')
})

check('calibration moves the reference plane onto the surface being aimed at', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub([hit(0, 0.72, -1)])})
  const y = r.calibrateGroundFrom(W / 2, H / 2, W, H)
  near(y, 0.72, 1e-6, 'returned height')
  near(r.groundY, 0.72, 1e-6, 'stored height')
  near(r.planeHit(W / 2, H / 2, W, H).point.y, 0.72, 1e-6, 'later taps use it')
})

check('calibration needs a majority to agree before it moves the world', () => {
  // Only two of five samples land on the same surface. Enough to place one tuft, not
  // enough to redefine the reference height every later tap depends on.
  let n = 0
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: () => [hit(0, [0.1, 3.0, 0.4, 2.2, 0.2][n++ % 5], -1)]})
  assert(r.calibrateGroundFrom(W / 2, H / 2, W, H) === null, 'should refuse')
  near(r.groundY, 0, 1e-6, 'reference must be left alone')
})

check('setGroundY ignores garbage', () => {
  const r = new PlacementResolver({camera: makeCamera(), hitTestFn: stub(null)})
  r.setGroundY(0.5); r.setGroundY(NaN); r.setGroundY(undefined)
  near(r.groundY, 0.5, 1e-6, 'a bad value must not corrupt the reference')
})

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
