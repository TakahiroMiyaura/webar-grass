// Engine bootstrap: wait for the preconditions, assemble the pipeline, start the session.
import type {XrCameraPipelineModule} from '../types/8thwall'
import type {TrackingUx} from '../ui/tracking-ux-types'
import type {SceneDiagnostics} from './scene'
import {createScenePipelineModule} from './scene'
import {inspectEngine} from './capability'
import {createCameraFovModule} from './camera-fov'
import {fitCanvas, watchCanvasSize} from './canvas'
import {hasBlockingEnvironment, openDiagnostics, setStatus} from '../ui/hud'

export interface StartOptions {
  canvas: HTMLCanvasElement
  diagnostics: SceneDiagnostics
  ux: TrackingUx
}

const configureOverlays = (): void => {
  // Shown while world tracking is still converging, hidden automatically once it is.
  // tracking-ux detects this package on window and stands down for that one state,
  // keeping the loss-recovery banner (which this package never shows) to itself.
  CoachingOverlay.configure({
    promptText: 'スマホをゆっくり動かしてください',
    promptColor: '#ffffff',
    animationColor: '#66dd88',
  })

  // The fallback for devices the engine cannot run on. It renders a QR code of `url`,
  // so pointing it at the current address lets someone on a desktop or an unsupported
  // browser move to a phone without retyping anything.
  LandingPage.configure({
    url: location.href,
    promptPrefix: 'QR を読み取るか',
    promptSuffix: 'をスマホで開いてください',
    backgroundColor: 'linear-gradient(#1c2b22, #0d1410)',
  })
}

const buildPipeline = (
  diagnostics: SceneDiagnostics,
  ux: TrackingUx,
): XrCameraPipelineModule[] => [
  // Two XRExtras modules are deliberately absent because they break on the iOS path:
  // FullWindowCanvas (see src/xr/canvas.ts) and Loading (see the note in main.ts).
  XRExtras.RuntimeError.pipelineModule(),

  XR8.GlTextureRenderer.pipelineModule(),  // draws the camera feed
  XR8.Threejs.pipelineModule(),            // creates scene/camera/renderer
  XR8.XrController.pipelineModule(),       // SLAM / world tracking

  LandingPage.pipelineModule(),
  CoachingOverlay.pipelineModule(),

  // Ahead of the tracking UX so the renegotiation starts on the same frame the feed
  // arrives, before world tracking has had anything to converge on (MYAA-23).
  createCameraFovModule(diagnostics.events),

  // Owns coaching, loss recovery, the permission error screen and the answer to a
  // tap that lands before tracking is usable.
  ux.pipelineModule(),

  {
    name: 'diagnostics-reporter',
    onCameraStatusChange: ({status, reason}) => {
      if (status === 'failed') {
        // tracking-ux puts the user-facing screen up; this only records the reason
        // and surfaces the environment panel behind it.
        diagnostics.errors.push(`camera failed: ${reason ?? 'unknown'}`)
        openDiagnostics()
      }
    },
    onException: (error) => {
      diagnostics.errors.push(String(error?.message ?? error))
    },
  },

  createScenePipelineModule(diagnostics, ux),
]

const run = ({canvas, diagnostics, ux}: StartOptions): void => {
  const report = inspectEngine()
  if (report && !report.compatible) {
    // LandingPage takes the screen from here; the panel adds the specific reason.
    setStatus('この端末では実行できません', report.reasons.join(', '))
    openDiagnostics()
  }

  diagnostics.events.push(`XR8 loaded, version=${XR8.version()}`)

  configureOverlays()
  XR8.addCameraPipelineModules(buildPipeline(diagnostics, ux))
  XR8.XrController.configure({disableWorldTracking: false})

  fitCanvas(canvas)
  watchCanvasSize(canvas)
  XR8.run({canvas})
}

/**
 * Three things must line up before the engine may start, and they arrive in any order:
 *
 *   1. xr.js has loaded - it is an async script tag.
 *   2. public/openin.js is not holding us. Inside an app's embedded webview (LINE,
 *      Instagram, ...) it sets `__inAppBlocked`, because starting there fires the
 *      camera prompt in a context that never produces frames - a black screen with no
 *      explanation. It clears the flag and emits 'inapp-dismissed' on escape or
 *      "try anyway".
 *   3. the user tapped the start gate. On iOS that tap is what makes the permission
 *      prompts legal at all: XR8.run() calls DeviceMotionEvent.requestPermission(),
 *      and outside a user gesture iOS refuses it and the engine falls back to its own
 *      English "AR requires access to device motion sensors" modal.
 *
 * So every arrival re-checks all three rather than assuming an order.
 */
export const startEngine = (options: StartOptions): void => {
  if (!window.XRExtras) {
    setStatus('読み込みに失敗しました', 'external/xrextras/xrextras.js を配置してください')
    openDiagnostics()
    return
  }

  let xrLoaded = false
  let started = false

  const startWhenReady = (): void => {
    if (started || !xrLoaded || window.__inAppBlocked || !options.ux.isStarted()) return
    // Nothing below can succeed on a device that fails the basic checks, and the panel
    // is already showing why.
    if (hasBlockingEnvironment()) return
    started = true
    run(options)
  }

  window.addEventListener('inapp-dismissed', startWhenReady)
  options.ux.onStart(startWhenReady)

  const onXrAvailable = (): void => { xrLoaded = true; startWhenReady() }
  if (window.XR8) onXrAvailable()
  else window.addEventListener('xrloaded', onXrAvailable, {once: true})
}
