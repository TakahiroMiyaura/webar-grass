import * as THREE from 'three'
import './style.css'
import {initHud} from './ui/hud'
import {startEngine} from './xr/engine'
import type {SceneDiagnostics} from './xr/scene'

// XR8.Threejs builds the scene from the global THREE, so the bundled copy has to be
// published there before any pipeline module is constructed.
window.THREE = THREE

// Kept on window so the headless check in scripts/verify.mjs can read the same numbers
// the on-screen panel shows, instead of scraping the DOM.
const diagnostics: SceneDiagnostics = {
  ready: false,
  frames: 0,
  placed: 0,
  hitTypes: {},
  errors: [],
}
;(window as unknown as {__diagnostics: SceneDiagnostics}).__diagnostics = diagnostics

const canvas = document.getElementById('camerafeed') as HTMLCanvasElement | null
if (!canvas) throw new Error('missing #camerafeed in index.html')

initHud()
startEngine({canvas, diagnostics})
