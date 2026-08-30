// Engine bootstrap: wait for the globals, assemble the pipeline, start the session.
import type {XrCameraPipelineModule} from '../types/8thwall'
import type {SceneDiagnostics} from './scene'
import {createScenePipelineModule} from './scene'
import {inspectEngine} from './capability'
import {fitCanvas, watchCanvasSize} from './canvas'
import {hasBlockingEnvironment, openDiagnostics, setStatus} from '../ui/hud'
import {showStartGate} from '../ui/start-gate'

export interface StartOptions {
  canvas: HTMLCanvasElement
  diagnostics: SceneDiagnostics
}

const configureOverlays = (): void => {
  // Shown while world tracking is still converging, hidden automatically once it is.
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

const buildPipeline = (diagnostics: SceneDiagnostics): XrCameraPipelineModule[] => [
  // Two XRExtras modules are deliberately absent because they break on the iOS path:
  // FullWindowCanvas (see src/xr/canvas.ts) and Loading (see src/ui/start-gate.ts).
  XRExtras.RuntimeError.pipelineModule(),

  XR8.GlTextureRenderer.pipelineModule(),  // draws the camera feed
  XR8.Threejs.pipelineModule(),            // creates scene/camera/renderer
  XR8.XrController.pipelineModule(),       // SLAM / world tracking

  LandingPage.pipelineModule(),
  CoachingOverlay.pipelineModule(),

  {
    name: 'status-reporter',
    onCameraStatusChange: ({status, reason}) => {
      switch (status) {
        case 'requesting':
          setStatus('カメラを準備しています', 'カメラの使用を許可してください')
          break
        case 'hasVideo':
          setStatus('スキャン中…', 'ゆっくり動かして面を検出します')
          break
        case 'failed':
          setStatus('カメラを開けませんでした', String(reason ?? ''))
          diagnostics.errors.push(`camera failed: ${reason ?? 'unknown'}`)
          openDiagnostics()
          break
      }
    },
    onException: (error) => {
      diagnostics.errors.push(String(error?.message ?? error))
    },
  },

  createScenePipelineModule(diagnostics),
]

const onXrLoaded = ({canvas, diagnostics}: StartOptions): void => {
  const report = inspectEngine()
  if (report && !report.compatible) {
    // LandingPage takes the screen from here; the panel adds the specific reason.
    setStatus('この端末では実行できません', report.reasons.join(', '))
    openDiagnostics()
  }

  configureOverlays()
  XR8.addCameraPipelineModules(buildPipeline(diagnostics))
  XR8.XrController.configure({disableWorldTracking: false})

  fitCanvas(canvas)
  watchCanvasSize(canvas)
  XR8.run({canvas})
}

/**
 * Entry point. The three helper libraries are synchronous script tags so they are already
 * on window by the time this module runs; xr.js is async, hence the wait on `xrloaded`.
 * The session only starts from the gate's tap, because iOS needs a user gesture.
 */
export const startEngine = (options: StartOptions): void => {
  if (!window.XRExtras) {
    setStatus('読み込みに失敗しました', 'external/xrextras/xrextras.js を配置してください')
    openDiagnostics()
    return
  }

  const whenLoaded = (): void => {
    // Offering "はじめる" on a device that cannot possibly start is worse than saying so:
    // initHud() has already put the reason on screen, so leave it there.
    if (hasBlockingEnvironment()) return

    setStatus('準備できました', '「はじめる」をタップしてください')
    showStartGate({onStart: () => onXrLoaded(options)})
  }
  if (window.XR8) whenLoaded()
  else window.addEventListener('xrloaded', whenLoaded, {once: true})
}
