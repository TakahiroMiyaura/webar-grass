// The three.js side of the pipeline.
//
// Scope for this task is only "camera feed + 3D drawing works on both platforms", so the
// placed object is a plain cube. MYAA-16/17 replace placeAt() with the real grass;
// everything else here (lighting, tap wiring, tracking gate) stays.
//
// No ground reticle and no centre crosshair: placement happens at the tap point, and
// MYAA-15 rules both out. Guidance is tracking-ux's job, not the scene's.
import * as THREE from 'three'
import type {XrCameraPipelineModule} from '../types/8thwall'
import type {TrackingUx} from '../ui/tracking-ux-types'
import {hitTestEvent} from './placement'
import {setStatus} from '../ui/hud'

/** Placed objects are capped so a long session cannot grow the scene without bound. */
const MAX_OBJECTS = 60

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

export const createScenePipelineModule = (
  diagnostics: SceneDiagnostics,
  ux: TrackingUx,
): XrCameraPipelineModule => {
  let scene: THREE.Scene
  const placed: THREE.Object3D[] = []

  const geometry = new THREE.BoxGeometry(0.12, 0.12, 0.12)
  const material = new THREE.MeshStandardMaterial({color: 0x66dd88, roughness: 0.6})

  const onTap = (event: MouseEvent | TouchEvent): void => {
    // Without this, a touch also fires a synthetic click and places two objects.
    event.preventDefault()

    // A tap before tracking is up must not look like a dead button.
    if (!ux.isReady()) {
      diagnostics.rejected++
      ux.rejectTap()
      return
    }

    const hit = hitTestEvent(event)
    if (!hit) {
      // Tracking is fine, but this particular ray found nothing: also not a dead tap.
      diagnostics.missed++
      ux.notifyMiss()
      return
    }

    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(hit.position.x, hit.position.y + 0.06, hit.position.z)
    mesh.rotation.y = Math.random() * Math.PI * 2
    scene.add(mesh)
    placed.push(mesh)

    if (placed.length > MAX_OBJECTS) scene.remove(placed.shift()!)

    diagnostics.placed++
    diagnostics.hitTypes[hit.type] = (diagnostics.hitTypes[hit.type] ?? 0) + 1
    setStatus(`${diagnostics.placed} 個`, hit.type)
  }

  return {
    name: 'grass-scene',

    onStart: ({canvas}) => {
      let camera: THREE.PerspectiveCamera
      ;({scene, camera} = XR8.Threejs.xrScene())

      scene.add(new THREE.AmbientLight(0xffffff, 1.2))
      const key = new THREE.DirectionalLight(0xffffff, 1.6)
      key.position.set(1, 4.3, 2.5)
      scene.add(key)

      // touchend rather than touchstart: a tap that turns into a drag should not place.
      canvas.addEventListener('touchend', onTap, {passive: false})
      canvas.addEventListener('click', onTap)

      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })

      diagnostics.ready = true
    },

    onUpdate: () => {
      diagnostics.frames++
    },

    onException: (error) => {
      diagnostics.errors.push(String(error?.message ?? error))
    },
  }
}
