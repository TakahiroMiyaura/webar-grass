// Minimal self-hosted 8th Wall check:
//   plane/ground estimation via SLAM -> tap -> hitTest -> place a cube.
// Deliberately free of any runtime CDN dependency so the "does self-hosting work
// with no account and no app key" question is answered by running this page.
import * as THREE from './vendor/three.module.js'

// XR8.Threejs.pipelineModule() builds its scene from the global THREE.
window.THREE = THREE

const statusEl = document.getElementById('status')
const detailEl = document.getElementById('detail')
const setStatus = (s, d) => { statusEl.textContent = s; if (d !== undefined) detailEl.textContent = d }

// Diagnostics kept on window so a headless probe can read them.
const diag = window.__diag = {events: [], errors: [], hitTests: [], placed: 0}
const log = (m) => { diag.events.push(String(m)); console.log('[8W] ' + m) }

let scene, camera, cubes = 0
const HIT_TYPES = ['FEATURE_POINT', 'ESTIMATED_SURFACE', 'DETECTED_SURFACE', 'UNSPECIFIED']

const scenePipelineModule = () => ({
  name: 'grassdemo',
  onStart: ({canvas}) => {
    ;({scene, camera} = XR8.Threejs.xrScene())
    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(1, 4.3, 2.5)
    scene.add(dir)

    // A ground-plane reticle so it is obvious when tracking has a surface.
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({color: 0x44ff88, transparent: true, opacity: 0.9})
    )
    reticle.visible = false
    scene.add(reticle)
    window.__reticle = reticle

    canvas.addEventListener('touchstart', onTap, {passive: false})
    canvas.addEventListener('click', onTap)
    XR8.XrController.updateCameraProjectionMatrix({origin: camera.position, facing: camera.quaternion})
    log('scene ready')
  },
  onUpdate: () => {
    // Keep a reticle on whatever the center of the screen is pointing at.
    const hit = hitTestAt(0.5, 0.5)
    const r = window.__reticle
    if (hit && hit.position && hit.position.x !== null) {
      r.visible = true
      r.position.set(hit.position.x, hit.position.y, hit.position.z)
      setStatus('タップでキューブを設置', `hit=${hit.type} placed=${cubes}`)
    } else {
      r.visible = false
    }
  },
})

const hitTestAt = (x, y) => {
  try {
    const hits = XR8.XrController.hitTest(x, y, HIT_TYPES)
    if (hits && hits.length) {
      if (diag.hitTests.length < 20) diag.hitTests.push(hits[0])
      return hits[0]
    }
  } catch (e) { diag.errors.push('hitTest: ' + e.message) }
  return null
}

function onTap(e) {
  e.preventDefault && e.preventDefault()
  const t = (e.touches && e.touches[0]) || e
  const x = (t.clientX ?? window.innerWidth / 2) / window.innerWidth
  const y = (t.clientY ?? window.innerHeight / 2) / window.innerHeight
  const hit = hitTestAt(x, y)
  if (!hit || !hit.position || hit.position.x === null) {
    setStatus('平面がまだ取れていません', 'スマホをゆっくり左右に動かしてください')
    return
  }
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.15),
    new THREE.MeshStandardMaterial({color: 0x66dd88})
  )
  cube.position.set(hit.position.x, hit.position.y + 0.075, hit.position.z)
  scene.add(cube)
  cubes++
  diag.placed = cubes
  log('placed cube #' + cubes + ' type=' + hit.type)
  setStatus('設置しました', `hit=${hit.type} placed=${cubes}`)
}

// Without XRExtras.FullWindowCanvas we size the drawing buffer ourselves. This has to
// happen before XR8.run(), because the engine picks up the canvas size when it starts.
const fitCanvas = (canvas, reconfigure) => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  if (reconfigure) XR8.reconfigureSession()
}

const onxrloaded = () => {
  log('XR8 loaded, version=' + XR8.version())
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    {
      name: 'diag',
      onCameraStatusChange: ({status, reason}) => {
        log('camera=' + status + (reason ? ' (' + reason + ')' : ''))
        if (status === 'failed') setStatus('カメラを開けませんでした', String(reason))
        if (status === 'hasVideo') setStatus('スキャン中…', 'ゆっくり動かして平面を検出します')
      },
      onException: (err) => { diag.errors.push('onException: ' + (err && (err.message || err))) },
    },
    scenePipelineModule(),
  ])
  XR8.XrController.configure({disableWorldTracking: false})
  const canvas = document.getElementById('camerafeed')
  fitCanvas(canvas, false)
  window.addEventListener('resize', () => fitCanvas(canvas, true))
  window.addEventListener('orientationchange', () => setTimeout(() => fitCanvas(canvas, true), 200))
  XR8.run({canvas})
}

// openin.js sets __inAppBlocked when the page is running inside an app's embedded
// webview (LINE, Instagram, ...). Hold the engine there: starting it would fire the
// camera prompt in a context where the stream never produces frames, leaving a black
// screen. Start once the user either escapes to a real browser or opts to try anyway.
let xrReady = false
let started = false
const startWhenReady = () => {
  if (started || !xrReady || window.__inAppBlocked) return
  started = true
  onxrloaded()
}
window.addEventListener('inapp-dismissed', startWhenReady)
const onXrAvailable = () => { xrReady = true; startWhenReady() }

window.XR8 ? onXrAvailable() : window.addEventListener('xrloaded', onXrAvailable, {once: true})
