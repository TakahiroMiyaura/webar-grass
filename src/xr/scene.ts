// The three.js side of the pipeline.
//
// Scope for this task is only "camera feed + 3D drawing works on both platforms", so the
// placed object is a plain cube. MYAA-16/17 replace placeAt() and the reticle with the
// real grass; everything else here (lighting, tap wiring, tracking gate) stays.
import * as THREE from 'three'
import type {XrCameraPipelineModule} from '../types/8thwall'
import {hitTestEvent, hitTestScreen, type SurfaceHit} from './placement'
import {setStatus} from '../ui/hud'

/** Placed objects are capped so a long session cannot grow the scene without bound. */
const MAX_OBJECTS = 60

export interface SceneDiagnostics {
  ready: boolean
  frames: number
  placed: number
  hitTypes: Record<string, number>
  errors: string[]
}

export const createScenePipelineModule = (
  diagnostics: SceneDiagnostics,
): XrCameraPipelineModule => {
  let scene: THREE.Scene
  let reticle: THREE.Mesh
  const placed: THREE.Object3D[] = []

  const geometry = new THREE.BoxGeometry(0.12, 0.12, 0.12)
  const material = new THREE.MeshStandardMaterial({color: 0x66dd88, roughness: 0.6})

  const placeAt = (hit: SurfaceHit): void => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(hit.position.x, hit.position.y + 0.06, hit.position.z)
    mesh.rotation.y = Math.random() * Math.PI * 2
    scene.add(mesh)
    placed.push(mesh)

    if (placed.length > MAX_OBJECTS) scene.remove(placed.shift()!)

    diagnostics.placed++
    diagnostics.hitTypes[hit.type] = (diagnostics.hitTypes[hit.type] ?? 0) + 1
  }

  const onTap = (event: MouseEvent | TouchEvent): void => {
    // Without this, a touch also fires a synthetic click and places two objects.
    event.preventDefault()

    const hit = hitTestEvent(event)
    if (!hit) {
      // A tap that lands on nothing has to feel like a miss, not a broken app.
      setStatus('まだ面が取れていません', 'スマホをゆっくり動かしてください')
      navigator.vibrate?.(20)
      return
    }
    placeAt(hit)
    setStatus('設置しました', `${hit.type} / ${diagnostics.placed} 個`)
  }

  return {
    name: 'grass-scene',

    onStart: ({canvas}) => {
      ;({scene} = XR8.Threejs.xrScene())

      scene.add(new THREE.AmbientLight(0xffffff, 1.2))
      const key = new THREE.DirectionalLight(0xffffff, 1.6)
      key.position.set(1, 4.3, 2.5)
      scene.add(key)

      // A ring on the surface under the screen centre: the cheapest possible signal
      // that tracking has something to place on before the user commits to a tap.
      reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({color: 0x44ff88, transparent: true, opacity: 0.85}),
      )
      reticle.visible = false
      scene.add(reticle)

      canvas.addEventListener('touchstart', onTap, {passive: false})
      canvas.addEventListener('click', onTap)

      diagnostics.ready = true
    },

    onUpdate: () => {
      diagnostics.frames++
      const hit = hitTestScreen(0.5, 0.5)
      if (hit) {
        reticle.visible = true
        reticle.position.set(hit.position.x, hit.position.y, hit.position.z)
      } else {
        reticle.visible = false
      }
    },

    onException: (error) => {
      diagnostics.errors.push(String(error?.message ?? error))
    },
  }
}
