import * as THREE from 'three'
import './style.css'
import './ui/tracking-ux.css'
import {createTrackingUx} from './ui/tracking-ux.js'
import type {TrackingUx} from './ui/tracking-ux-types'
import {initHud} from './ui/hud'
import {initDebugMode} from './ui/debug-mode'
import {startEngine} from './xr/engine'
import type {SceneDiagnostics} from './xr/scene'

// XR8.Threejs builds the scene from the global THREE, so the bundled copy has to be
// published there before any pipeline module is constructed.
window.THREE = THREE

// Published as window.__diag: the headless checks read these counters rather than
// scraping the DOM. The name and the shape are the contract that
// scripts/verify-tracking-ux.mjs asserts against, so do not rename them casually.
const diagnostics: SceneDiagnostics = {
  ready: false,
  frames: 0,
  placed: 0,
  rejected: 0,
  missed: 0,
  hitTypes: {},
  events: [],
  errors: [],
}
;(window as unknown as {__diag: SceneDiagnostics}).__diag = diagnostics

const canvas = document.getElementById('camerafeed') as HTMLCanvasElement | null
if (!canvas) throw new Error('missing #camerafeed in index.html')

// Owns the start gate, coaching, loss recovery and the answer to an early tap.
//
// coaching stays on 'auto' because CoachingOverlay *is* in the pipeline, so it should
// own the initialisation prompt. permissionUi is forced to 'builtin': XRExtras is on
// window, which would make 'auto' resolve to 'external', but XRExtras.Loading is
// deliberately not in our pipeline (it breaks rendering on the iOS path), so nothing
// upstream would ever draw the permission error screen.
const ux: TrackingUx = createTrackingUx({coaching: 'auto', permissionUi: 'builtin'}).mount()

// Before initHud(), which needs the debug class already on <body> to decide whether the
// environment button has to stay visible on a device that cannot run the engine.
initDebugMode()
initHud()
startEngine({canvas, diagnostics, ux})
