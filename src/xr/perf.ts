// Frame-budget helpers.
//
// Separate from grass.ts because these apply to the whole AR page, not just the grass.
// The static pixel-ratio cap lives in canvas.ts (MAX_PIXEL_RATIO) and stays there; this
// module adds measurement, and an adaptive scaler for when a fixed cap is not enough.
import type * as THREE from 'three'

export interface FrameStats {
  /** Frames per second implied by the mean frame time. */
  fps: number
  msMean: number
  msP50: number
  msP95: number
  /** Frames per second of the SLOW frames. This is the number that matters. */
  fpsP95: number
}

/**
 * Rolling frame-time statistics.
 *
 * p95 is reported alongside the mean because a stutter every twentieth frame is plainly
 * visible to a person but almost invisible in an average.
 */
export class FrameMeter {
  private readonly samples: number[] = []
  private last = 0

  constructor(private readonly window = 120) {}

  tick(nowMs: number = performance.now()): void {
    if (this.last) {
      this.samples.push(nowMs - this.last)
      if (this.samples.length > this.window) this.samples.shift()
    }
    this.last = nowMs
  }

  stats(): FrameStats | null {
    if (this.samples.length < 4) return null
    const sorted = [...this.samples].sort((a, b) => a - b)
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
    return {
      fps: 1000 / mean,
      msMean: mean,
      msP50: at(0.5),
      msP95: at(0.95),
      fpsP95: 1000 / at(0.95),
    }
  }

  reset(): void {
    this.samples.length = 0
    this.last = 0
  }
}

/**
 * Adaptive canvas resolution.
 *
 * Measured on this scene, frame time tracks pixel count and barely notices tuft count
 * (docs/grass-rendering.md), which makes resolution the largest available lever by a
 * wide margin. Under 8th Wall the renderer belongs to the engine, so setPixelRatio() is
 * not the control -- the canvas backing store is, and changing it needs
 * XR8.reconfigureSession(). That call is not cheap, hence the hysteresis and cooldown:
 * this should step once or twice after launch and then sit still.
 */
export class AdaptiveCanvasScaler {
  private readonly meter = new FrameMeter(60)
  private lastChange: number
  scale: number

  constructor(private readonly opts: {
    canvas: HTMLCanvasElement
    onResize?: (w: number, h: number, scale: number) => void
    targetFps?: number
    min?: number
    max?: number
    cooldownMs?: number
  }) {
    this.scale = Math.min(opts.max ?? 1.5, window.devicePixelRatio || 1)
    // Starts the cooldown now, not at zero: the first frames after launch include shader
    // compilation and the first texture uploads, and stepping the resolution down on
    // that spike would be reacting to noise.
    this.lastChange = performance.now()
    this.apply()
  }

  apply(): boolean {
    const {canvas, onResize} = this.opts
    const w = Math.round(window.innerWidth * this.scale)
    const h = Math.round(window.innerHeight * this.scale)
    if (canvas.width === w && canvas.height === h) return false
    canvas.width = w
    canvas.height = h
    onResize?.(w, h, this.scale)
    return true
  }

  tick(nowMs: number = performance.now()): void {
    this.meter.tick(nowMs)
    const s = this.meter.stats()
    const cooldown = this.opts.cooldownMs ?? 2500
    if (!s || nowMs - this.lastChange < cooldown) return

    const target = this.opts.targetFps ?? 32
    const min = this.opts.min ?? 0.75
    const max = this.opts.max ?? 1.5

    // Step down on the p95, up only on a comfortable mean, so it does not oscillate.
    let next = this.scale
    if (s.fpsP95 < target) next = Math.max(min, this.scale - 0.25)
    else if (s.fps > target * 1.7) next = Math.min(max, this.scale + 0.25)

    if (next !== this.scale) {
      this.scale = next
      this.lastChange = nowMs
      this.meter.reset()
      this.apply()
    }
  }
}

/**
 * Small on-screen fps/draw-call readout. Returns the per-frame update function; it only
 * touches the DOM every tenth frame, because a text write per frame is itself a cost.
 */
export const attachFpsReadout = (
  meter: FrameMeter,
  renderer: THREE.WebGLRenderer,
  extra: () => string = () => '',
): (() => void) => {
  const el = document.createElement('div')
  el.style.cssText = 'position:absolute;top:env(safe-area-inset-top,6px);left:6px;z-index:9;' +
    'font:11px/1.45 ui-monospace,Menlo,monospace;color:#9f6;background:rgba(0,0,0,.55);' +
    'padding:5px 8px;border-radius:5px;white-space:pre;pointer-events:none'
  document.body.appendChild(el)

  let n = 0
  return () => {
    if (++n % 10) return
    const s = meter.stats()
    if (!s) return
    const r = renderer.info.render
    el.textContent =
      `${s.fps.toFixed(1)} fps  (p95 ${s.fpsP95.toFixed(1)})\n` +
      `${s.msMean.toFixed(1)} ms  p95 ${s.msP95.toFixed(1)} ms\n` +
      `calls ${r.calls}  tris ${r.triangles}\n${extra()}`
  }
}
