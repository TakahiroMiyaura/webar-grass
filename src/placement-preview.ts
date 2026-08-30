// Placement checked against geometry we know exactly.
//
// A phone was not available where MYAA-16 was written, so "does the grass land on the
// table rather than the floor" had to be settled some other way. This page builds a
// scene with a floor at y=0 and a table top at y=0.75 and substitutes a raycast against
// those real meshes for XR8's hitTest -- i.e. it models a SLAM that reports surfaces
// perfectly. What that proves is the placement logic: given correct surface readings, a
// tap on the table resolves to the table's height and the grass stands on it.
//
// What it cannot prove is that a real phone's SLAM returns those readings. That is the
// part still waiting on hardware.
import * as THREE from 'three'
import {PlacementResolver} from './xr/placement'
import {GrassField} from './xr/grass'
import type {XrHitTestResult} from './types/8thwall'

const W = 900
const H = 600
const TABLE_TOP = 0.75

const renderer = new THREE.WebGLRenderer({antialias: true})
renderer.setPixelRatio(1)
renderer.setSize(W, H)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x11150f)
scene.fog = new THREE.Fog(0x11150f, 4, 9)

const camera = new THREE.PerspectiveCamera(55, W / H, 0.01, 100)
camera.position.set(0, 1.35, 1.45)
camera.lookAt(new THREE.Vector3(0, 0.35, -0.7))
camera.updateMatrixWorld(true)

scene.add(new THREE.AmbientLight(0xffffff, 0.9))
const key = new THREE.DirectionalLight(0xffffff, 1.4)
key.position.set(2, 5, 3)
scene.add(key)

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({color: 0x3b3f38}))
scene.add(floor)
scene.add(new THREE.GridHelper(14, 28, 0x555a4f, 0x2c302a))

const table = new THREE.Mesh(
  new THREE.BoxGeometry(1.1, 0.06, 0.75),
  new THREE.MeshLambertMaterial({color: 0x6b533c}))
table.position.set(0, TABLE_TOP - 0.03, -0.75)
scene.add(table)
for (const [lx, lz] of [[-0.48, -0.3], [0.48, -0.3], [-0.48, 0.3], [0.48, 0.3]]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, TABLE_TOP - 0.06, 0.06),
    new THREE.MeshLambertMaterial({color: 0x5a462f}))
  leg.position.set(lx, (TABLE_TOP - 0.06) / 2, -0.75 + lz)
  scene.add(leg)
}

// Raycasting reads matrixWorld, which the renderer only refreshes on its first render.
// Without this the table is still at the origin and every "table" tap resolves to 0.03m
// -- its half-height -- instead of 0.75m.
scene.updateMatrixWorld(true)

// The stand-in for SLAM: an exact raycast against the real surfaces.
const rc = new THREE.Raycaster()
const targets = [floor, table]
const hitTestFn = (nx: number, ny: number): XrHitTestResult[] => {
  rc.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), camera)
  const hits = rc.intersectObjects(targets, false)
  if (!hits.length) return []
  const h = hits[0]
  return [{
    type: h.object === table ? 'DETECTED_SURFACE' : 'ESTIMATED_SURFACE',
    position: {x: h.point.x, y: h.point.y, z: h.point.z},
    // Deliberately the zero quaternion the real engine hands back.
    rotation: {x: 0, y: 0, z: 0, w: 0},
    distance: h.distance,
  } as XrHitTestResult]
}

interface TapResult {
  expect: 'table' | 'floor'
  sx: number
  sy: number
  placed: boolean
  aimedY?: number
  y?: number
  source?: string
  type?: string | null
  why: string
  spread?: number | null
}

const boot = async (): Promise<void> => {
  const resolver = new PlacementResolver({camera, hitTestFn})
  const grass = await GrassField.createProcedural({scene, perTap: 4, capacity: 400})

  // Aim taps at points whose world position we already know, projected to the screen. A
  // blind screen grid mostly misses the table and turns the interesting case into a
  // rounding accident; this way the assertions say exactly what was aimed at.
  const screenOf = (p: THREE.Vector3): [number, number] => {
    const v = p.clone().project(camera)
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H]
  }

  const onTable: THREE.Vector3[] = []
  for (let ix = 0; ix < 5; ix++) {
    for (let iz = 0; iz < 3; iz++) {
      // Inset from the edges so the +/-10px jitter samples stay on the table top.
      onTable.push(new THREE.Vector3(-0.36 + ix * 0.18, TABLE_TOP, -1.0 + iz * 0.25))
    }
  }
  // Floor points nearer the camera than the table, and out to either side, so nothing
  // here is occluded by the table itself.
  const onFloor: THREE.Vector3[] = []
  for (let ix = 0; ix < 7; ix++) {
    for (let iz = 0; iz < 3; iz++) {
      const x = -1.8 + ix * 0.6
      const z = 0.55 - iz * 0.3
      if (Math.abs(x) < 0.7 && z < -0.3) continue
      onFloor.push(new THREE.Vector3(x, 0, z))
    }
  }

  const results: TapResult[] = []
  const tap = (world: THREE.Vector3, expect: 'table' | 'floor'): void => {
    const [sx, sy] = screenOf(world)
    if (sx < 0 || sx > W || sy < 0 || sy > H) return
    const r = resolver.resolve(sx, sy, W, H)
    if (!r.chosen) { results.push({expect, sx, sy, placed: false, why: r.why}); return }
    grass.plant(r.chosen.point, r.chosen.normal)
    results.push({
      expect, sx, sy, placed: true, aimedY: world.y,
      y: Number(r.chosen.point.y.toFixed(4)), source: r.chosen.source,
      type: r.b?.type ?? null, why: r.why, spread: r.b ? Number(r.b.spread.toFixed(4)) : null,
    })
  }
  onTable.forEach((p) => tap(p, 'table'))
  onFloor.forEach((p) => tap(p, 'floor'))

  const tablePlaced = results.filter((r) => r.expect === 'table' && r.placed)
  const floorPlaced = results.filter((r) => r.expect === 'floor' && r.placed)

  // Read the orientation back out of the instanced matrices: whatever the resolver said,
  // what matters is the transform the renderer will actually draw.
  const tilts: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const m = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  for (let i = 0; i < grass.mesh.count; i++) {
    grass.mesh.getMatrixAt(i, m)
    m.decompose(pos, quat, scl)
    if (scl.lengthSq() < 1e-12) continue
    tilts.push(up.clone().applyQuaternion(quat).angleTo(up))
  }

  ;(window as unknown as {__preview: unknown}).__preview = {
    results,
    onTable: tablePlaced.length,
    onFloor: floorPlaced.length,
    aimedAtTable: results.filter((r) => r.expect === 'table').length,
    aimedAtFloor: results.filter((r) => r.expect === 'floor').length,
    usedHitTestOnTable: tablePlaced.filter((r) => r.source === 'HITTEST').length,
    tableHeights: tablePlaced.map((r) => r.y as number),
    floorHeights: floorPlaced.map((r) => r.y as number),
    tilts,
    instances: grass.mesh.count,
  }

  let t0: number | null = null
  const animate = (now: number): void => {
    if (t0 === null) t0 = now
    grass.update((now - t0) / 1000, camera)
    renderer.render(scene, camera)
    ;(window as unknown as {__frames: number}).__frames =
      ((window as unknown as {__frames?: number}).__frames ?? 0) + 1
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)
}

void boot()
