// Minimal self-hosted 8th Wall check:
//   plane/ground estimation via SLAM -> tap -> hitTest -> place a cube.
// Deliberately free of any runtime CDN dependency so the "does self-hosting work
// with no account and no app key" question is answered by running this page.
import * as THREE from './vendor/three.module.js'
import {createTrackingUx} from './tracking-ux.js'

// XR8.Threejs.pipelineModule() builds its scene from the global THREE.
window.THREE = THREE

// Owns the start gate, the coaching/recovery guidance and the answer to a tap that
// arrives before tracking is usable. See tracking-ux.js.
const ux = createTrackingUx().mount()
const hudEl = document.getElementById('hud')

// Diagnostics kept on window so a headless probe can read them.
const diag = window.__diag = {events: [], errors: [], hitTests: [], placed: 0,
  rejected: 0, missed: 0}
const log = (m) => { diag.events.push(String(m)); console.log('[8W] ' + m) }

let scene, cubes = 0
const HIT_TYPES = ['FEATURE_POINT', 'ESTIMATED_SURFACE', 'DETECTED_SURFACE', 'UNSPECIFIED']

const scenePipelineModule = () => ({
  name: 'grassdemo',
  onStart: ({canvas}) => {
    let camera
    ;({scene, camera} = XR8.Threejs.xrScene())
    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(1, 4.3, 2.5)
    scene.add(dir)

    // No ground reticle and no centre crosshair: placement happens at the tap point,
    // and MYAA-15 rules both out. Guidance comes from tracking-ux instead.
    canvas.addEventListener('touchend', onTap, {passive: false})
    canvas.addEventListener('click', onTap)
    XR8.XrController.updateCameraProjectionMatrix({origin: camera.position, facing: camera.quaternion})
    log('scene ready')
  },
  onUpdate: () => {
    hudEl.textContent =
      `${ux.state.phase} | ${ux.state.status}/${ux.state.reason} | placed=${cubes} ` +
      `rejected=${diag.rejected} missed=${diag.missed}`
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

  // A tap before tracking is up must not look like a dead button.
  if (!ux.isReady()) { diag.rejected++; return ux.rejectTap() }

  const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || e
  const x = (t.clientX ?? window.innerWidth / 2) / window.innerWidth
  const y = (t.clientY ?? window.innerHeight / 2) / window.innerHeight
  const hit = hitTestAt(x, y)
  // Tracking is fine, but this particular ray found nothing: also not a dead tap.
  if (!hit || !hit.position || hit.position.x === null) { diag.missed++; return ux.notifyMiss() }
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.15),
    new THREE.MeshStandardMaterial({color: 0x66dd88})
  )
  cube.position.set(hit.position.x, hit.position.y + 0.075, hit.position.z)
  scene.add(cube)
  cubes++
  diag.placed = cubes
  log('placed cube #' + cubes + ' type=' + hit.type)
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
    ux.pipelineModule(),
    {
      name: 'diag',
      onCameraStatusChange: ({status, reason}) => {
        log('camera=' + status + (reason ? ' (' + reason + ')' : ''))
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

// Three things have to line up before the engine may start, and they can arrive in
// any order:
//
//   1. xr.js is loaded (it is an async script tag).
//   2. openin.js is not holding us: it sets __inAppBlocked inside an app's embedded
//      webview (LINE, Instagram, ...), where starting would fire the camera prompt in
//      a context that never produces frames, leaving a black screen. It clears the flag
//      and emits 'inapp-dismissed' when the user escapes or opts to try anyway.
//   3. the user tapped the start gate. On iOS that tap is what makes the permission
//      prompts legal at all: XR8.run() calls DeviceMotionEvent.requestPermission(), and
//      outside a user gesture iOS refuses it and the engine drops to its own English
//      "AR requires access to device motion sensors" modal.
//
// The in-app guard sits above the start gate (z-index 99999 vs 100), so in a webview the
// user answers the guard first and only then sees the gate.
let xrReady = false
let started = false
const startWhenReady = () => {
  if (started || !xrReady || window.__inAppBlocked || !ux.isStarted()) return
  started = true
  onxrloaded()
}
window.addEventListener('inapp-dismissed', startWhenReady)
ux.onStart(startWhenReady)
const onXrAvailable = () => { xrReady = true; startWhenReady() }

window.XR8 ? onXrAvailable() : window.addEventListener('xrloaded', onXrAvailable, {once: true})
