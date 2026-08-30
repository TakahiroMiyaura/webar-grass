// On-device benchmark for the grass field.
//
// This is the honest route to "100+ tufts at 30fps on a mid-range phone": that number
// cannot be established on a CI box, so the check ships as a page you open on the
// device. It renders the same InstancedMesh the AR app uses, at an AR-like viewing
// distance, with an optional full-screen blit standing in for the camera feed.
//
// It does NOT run SLAM, so it is an upper bound. Real numbers inside the AR app will be
// lower; treat the gap as the SLAM budget.
import * as THREE from 'three'
import {GrassField} from './xr/grass'
import {FrameMeter, type FrameStats} from './xr/perf'

const qs = new URLSearchParams(location.search)
const num = (k: string, d: number): number => (qs.has(k) ? Number(qs.get(k)) : d)

interface BenchState {
  /** Which load path to exercise. Defaults to the one the app ships with. */
  src: string
  n: number
  dpr: number
  shadows: boolean
  feed: boolean
}

const state: BenchState = {
  src: qs.get('src') ?? 'procedural',
  n: num('n', 100),
  dpr: num('dpr', 1.5),
  shadows: num('shadows', 1) !== 0,
  feed: num('feed', 1) !== 0,
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const canvas = el<HTMLCanvasElement>('c')
const renderer = new THREE.WebGLRenderer({canvas, antialias: false, alpha: false})
renderer.setClearColor(0x101418, 1)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 40)

// Stand-in for the camera feed: one full-screen textured blit per frame, which is
// roughly what XR8.GlTextureRenderer costs in fill terms.
const feedScene = new THREE.Scene()
const feedCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
{
  const d = document.createElement('canvas')
  d.width = d.height = 256
  const g = d.getContext('2d')!
  for (let i = 0; i < 2048; i++) {
    g.fillStyle = `hsl(${(i * 7) % 360},35%,${30 + (i % 40)}%)`
    g.fillRect(Math.random() * 256, Math.random() * 256, 9, 9)
  }
  const tex = new THREE.CanvasTexture(d)
  tex.colorSpace = THREE.SRGBColorSpace
  feedScene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({map: tex, depthTest: false, depthWrite: false, toneMapped: false}),
  ))
}

const meter = new FrameMeter(180)
// THREE.Clock is deprecated in r183; performance.now() is all this needs.
const t0 = performance.now()
const elapsed = (): number => (performance.now() - t0) / 1000

let grass: GrassField

const makeField = (shadows: boolean): Promise<GrassField> => {
  const opts = {
    scene, renderer, capacity: 900, shadows,
    // The bench measures the full cost, so nothing is culled by distance.
    cullNear: 100, cullFar: 101,
  }
  return state.src === 'glb' ? GrassField.create(opts) : GrassField.createProcedural(opts)
}

const resize = (): void => {
  const w = Math.round(window.innerWidth * state.dpr)
  const h = Math.round(window.innerHeight * state.dpr)
  renderer.setPixelRatio(1)      // the DPR is folded into the size below
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)

/** Plants `n` tufts over a table-sized patch, in clumps, the way a tap would. */
const populate = (n: number): void => {
  grass.reset()
  const per = grass.opts.perTap
  for (let i = 0; i < Math.ceil(n / per); i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * 0.55
    grass.plant(
      new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      new THREE.Vector3(0, 1, 0),
      {count: Math.min(per, n - i * per)},
    )
  }
  meter.reset()
}

const hud = {n: el('n'), dpr: el('dpr'), live: el('live'), result: el('result')}

const syncButtons = (): void => {
  document.querySelectorAll<HTMLElement>('[data-n]')
    .forEach(b => b.classList.toggle('on', Number(b.dataset.n) === state.n))
  document.querySelectorAll<HTMLElement>('[data-dpr]')
    .forEach(b => b.classList.toggle('on', Number(b.dataset.dpr) === state.dpr))
  el('shadowBtn').classList.toggle('on', state.shadows)
  el('feedBtn').classList.toggle('on', state.feed)
  hud.n.textContent = String(state.n)
  hud.dpr.textContent = state.dpr.toFixed(1)
}

let frames = 0

const loop = (): void => {
  requestAnimationFrame(loop)
  const t = elapsed()

  // Orbit at ~0.75 m, eye ~0.35 m above the surface: a phone held over a desk.
  const a = t * 0.35
  camera.position.set(Math.cos(a) * 0.75, 0.35, Math.sin(a) * 0.75)
  camera.lookAt(0, 0.06, 0)

  grass.update(t, camera)

  // renderer.info resets at the start of every render(); with two render() calls per
  // frame the counter would otherwise only ever show the second one.
  renderer.info.autoReset = false
  renderer.info.reset()
  renderer.autoClear = true
  if (state.feed) {
    renderer.render(feedScene, feedCamera)
    renderer.autoClear = false
  }
  renderer.render(scene, camera)

  meter.tick()
  if (++frames % 15 === 0) {
    const s = meter.stats()
    const r = renderer.info.render
    hud.live.textContent = s
      ? `${s.fps.toFixed(1)} fps (p95 ${s.fpsP95.toFixed(1)}) / calls ${r.calls} / tris ${r.triangles}`
      : '計測中…'
    window.__bench = {
      ...(s ?? {}), calls: r.calls, triangles: r.triangles,
      live: grass.liveCount, n: state.n, dpr: state.dpr, shadows: state.shadows, feed: state.feed,
    }
  }
}

/**
 * Measures a fixed number of FRAMES rather than a fixed time, so a slow device is not
 * penalised by ending up with fewer samples.
 */
const measure = (frameCount = 240): Promise<FrameStats | null> => new Promise((resolve) => {
  meter.reset()
  let c = 0
  const step = (): void => {
    if (++c < frameCount) { requestAnimationFrame(step); return }
    resolve(meter.stats())
  }
  requestAnimationFrame(step)
})

const setState = async (patch: Partial<BenchState>): Promise<void> => {
  const rebuild = 'shadows' in patch && patch.shadows !== state.shadows
  Object.assign(state, patch)
  if (rebuild) {
    grass.dispose()
    grass = await makeField(state.shadows)
  }
  resize()
  populate(state.n)
  syncButtons()
}

document.querySelectorAll<HTMLElement>('[data-n]').forEach(b => {
  b.onclick = () => { void setState({n: Number(b.dataset.n)}) }
})
document.querySelectorAll<HTMLElement>('[data-dpr]').forEach(b => {
  b.onclick = () => { void setState({dpr: Number(b.dataset.dpr)}) }
})
el('shadowBtn').onclick = () => { void setState({shadows: !state.shadows}) }
el('feedBtn').onclick = () => { void setState({feed: !state.feed}) }

el('sweepBtn').onclick = async () => {
  const out: string[] = []
  hud.result.textContent = '計測中… 端末を触らないでください'
  for (const n of [100, 300, 600, 900]) {
    for (const dpr of [1, 1.5, 2]) {
      await setState({n, dpr})
      await measure(90)                    // warm-up, discarded
      const s = await measure(240)
      if (!s) continue
      out.push(`草 ${String(n).padStart(3)} / DPR ${dpr.toFixed(1)}  ` +
        `${s.fps.toFixed(1).padStart(5)} fps   p95 ${s.fpsP95.toFixed(1).padStart(5)} fps`)
      hud.result.textContent = out.join('\n')
    }
  }
  hud.result.textContent = out.join('\n') + '\n\n完了。p95 が 30fps を超えていれば合格。'
}

const boot = async (): Promise<void> => {
  try {
    grass = await makeField(state.shadows)
  } catch (e) {
    hud.result.textContent = String((e as Error)?.message ?? e)
    throw e
  }
  resize()
  populate(state.n)
  syncButtons()
  window.__ready = true
  loop()
}

// Exposed so tools/bench.mjs can drive the same page headlessly.
window.__measure = measure
window.__setState = setState

void boot()
