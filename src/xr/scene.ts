// The three.js side of the pipeline: tap a surface, grass grows there, and it stays put
// while the phone moves around it (6DoF).
//
// Responsibilities are split so no one file owns two questions:
//   placement.ts       where a tap lands in the world (plan A / plan B / AUTO)
//   grass.ts           what grows there and how it is drawn (MYAA-17)
//   ui/tracking-ux.js  the start gate, coaching, and the answer to a tap that arrives
//                      before tracking is usable (MYAA-15)
// This file is the wiring.
//
// No ground reticle and no centre crosshair: placement happens at the tap point, and
// MYAA-15 rules both out. Guidance is tracking-ux's job, not the scene's.
import * as THREE from 'three'
import type {XrCameraPipelineModule} from '../types/8thwall'
import type {TrackingUx} from '../ui/tracking-ux-types'
import {Mode, PlacementResolver, type PlacementMode} from './placement'
import {GrassField} from './grass'
import {PlacementPanel} from '../ui/placement-panel'
import '../ui/placement-panel.css'
import {setStatus} from '../ui/hud'

export interface SceneDiagnostics {
  ready: boolean
  frames: number
  placed: number
  /** Taps refused because tracking was not usable yet. */
  rejected: number
  /** Taps where tracking was fine but the ray found nothing. */
  missed: number
  hitTypes: Record<string, number>
  /**
   * Milestones, not a full log. Must stay empty until the engine actually starts:
   * scripts/verify-tracking-ux.mjs asserts on that to prove the gate holds XR8.run()
   * back until the user taps.
   */
  events: string[]
  errors: string[]
}

/** Test seam: a synthetic camera feed never reaches NORMAL, so the headless harness
 *  needs to drive both sides of the readiness gate deliberately. */
declare global {
  // eslint-disable-next-line no-var
  var __forceTrackingReady: boolean | undefined
}

export const createScenePipelineModule = (
  diagnostics: SceneDiagnostics,
  ux: TrackingUx,
): XrCameraPipelineModule => {
  let scene: THREE.Scene
  let camera: THREE.PerspectiveCamera
  let resolver: PlacementResolver
  let grass: GrassField | null = null
  let panel: PlacementPanel
  let startedAt = 0

  const isReady = (): boolean =>
    (typeof globalThis.__forceTrackingReady === 'boolean'
      ? globalThis.__forceTrackingReady
      : ux.isReady())

  /**
   * The ray must follow the finger, never the screen centre, so this is the tap point in
   * canvas-relative CSS pixels rather than anything pre-normalised.
   */
  const tapPoint = (event: MouseEvent | TouchEvent | PointerEvent, canvas: HTMLCanvasElement) => {
    const touch = 'changedTouches' in event && event.changedTouches.length > 0
      ? event.changedTouches[0]
      : 'touches' in event && event.touches.length > 0
        ? event.touches[0]
        : (event as MouseEvent)
    const rect = canvas.getBoundingClientRect()
    return {
      x: (touch.clientX ?? rect.width / 2) - rect.left,
      y: (touch.clientY ?? rect.height / 2) - rect.top,
      w: rect.width || window.innerWidth,
      h: rect.height || window.innerHeight,
    }
  }

  const onTap = (event: MouseEvent | TouchEvent | PointerEvent): void => {
    // Pointer events already collapse mouse and touch into one event per tap; the only
    // thing to reject is the second finger of a multi-touch gesture.
    if (event.type === 'pointerdown' && (event as PointerEvent).isPrimary === false) return
    if (event.cancelable) event.preventDefault()

    // A tap before tracking is up must not look like a dead button.
    if (!isReady()) {
      diagnostics.rejected++
      ux.rejectTap()
      return
    }

    const canvas = event.currentTarget as HTMLCanvasElement
    const {x, y, w, h} = tapPoint(event, canvas)
    const result = resolver.resolve(x, y, w, h)
    panel.record(result)

    if (!result.chosen) {
      // Tracking is fine, but this particular ray found nothing: also not a dead tap.
      diagnostics.missed++
      ux.notifyMiss()
      return
    }

    grass?.plant(result.chosen.point, result.chosen.normal)
    diagnostics.placed++
    diagnostics.hitTypes[result.chosen.type] = (diagnostics.hitTypes[result.chosen.type] ?? 0) + 1
    if (navigator.vibrate) { try { navigator.vibrate(8) } catch { /* blocked by the browser */ } }
    setStatus(`${grass?.liveCount ?? 0} 本`, `${result.chosen.source} / ${result.chosen.type}`)
  }

  return {
    name: 'grass-scene',

    onStart: ({canvas}) => {
      ;({scene, camera} = XR8.Threejs.xrScene())

      scene.add(new THREE.AmbientLight(0xffffff, 1.2))
      const key = new THREE.DirectionalLight(0xffffff, 1.6)
      key.position.set(1, 4.3, 2.5)
      scene.add(key)

      resolver = new PlacementResolver({camera})
      startedAt = performance.now()

      // The field is the shipped renderer (MYAA-17): one InstancedMesh, all growth and
      // wind evaluated in the vertex shader. Loading its atlas is async, so taps before
      // it resolves are answered as misses rather than crashing.
      void GrassField.createProcedural({scene}).then((field) => {
        grass = field
      }).catch((error: unknown) => {
        diagnostics.errors.push('grass: ' + String((error as Error)?.message ?? error))
      })

      panel = new PlacementPanel({
        toast: (message) => ux.notifyMiss(message),
        onMode: (mode: PlacementMode) => {
          resolver.setMode(mode)
          ux.notifyMiss(mode === Mode.AUTO ? '自動（A を基準に B を採用）'
            : mode === Mode.PLANE ? 'A のみ：基準面に固定'
              : 'B のみ：hitTest の結果をそのまま使用')
        },
        onCalibrate: () => {
          // Aim at the surface you want as the reference and press. This is what lets
          // plan A work on a table instead of only on the floor.
          const rect = canvas.getBoundingClientRect()
          const y = resolver.calibrateGroundFrom(rect.width / 2, rect.height / 2,
            rect.width || window.innerWidth, rect.height || window.innerHeight)
          ux.notifyMiss(y == null ? '面を読み取れませんでした。少し近づいてから再度'
            : `基準面を ${y.toFixed(2)}m に設定しました`)
        },
        onRecenter: () => {
          // recenter() moves the origin, so anything already planted no longer lines up
          // with what the user is looking at. Clearing is the honest outcome.
          try { XR8.XrController.recenter() } catch (error) {
            diagnostics.errors.push('recenter: ' + String((error as Error)?.message ?? error))
          }
          resolver.setGroundY(0)
          grass?.reset()
          ux.notifyMiss('基準をリセットしました')
        },
        onClear: () => { grass?.clear(); ux.notifyMiss('草を消しました') },
      })

      // One tap must plant exactly one clump. Listening on touchend plus click needs the
      // compatibility click suppressed, and a timer when preventDefault does not reach
      // it; that timer is not reliable, because the SLAM loop stalls timers well past any
      // threshold worth using (measured: roughly half of taps planted twice). Pointer
      // events remove the problem instead of masking it.
      if (window.PointerEvent) {
        canvas.addEventListener('pointerdown', onTap, {passive: false})
      } else {
        // touchend rather than touchstart: a tap that turns into a drag should not place.
        canvas.addEventListener('touchend', onTap, {passive: false})
        canvas.addEventListener('click', onTap)
      }

      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })

      // Exposed for the headless placement checks, which need to pose a known camera and
      // read back where a tap actually resolved.
      ;(window as unknown as {__placement: unknown}).__placement =
        {resolver, panel, get grass() { return grass }, scene, camera}

      diagnostics.ready = true
    },

    onUpdate: () => {
      diagnostics.frames++
      grass?.update((performance.now() - startedAt) / 1000, camera)
    },

    onException: (error) => {
      diagnostics.errors.push(String(error?.message ?? error))
    },
  }
}
