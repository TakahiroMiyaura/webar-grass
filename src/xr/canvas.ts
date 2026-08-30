// Canvas sizing.
//
// This replaces XRExtras.FullWindowCanvas, which throws inside its own onStart on the
// iOS code path (appendChild receives undefined) and takes the whole render loop down
// with it - reproducible in WebKit, see README "既知の問題". We only ever needed the
// drawing-buffer sizing from it: the element is already in the DOM and pinned by CSS.
//
// The size has to be set before XR8.run(), because the engine reads the canvas
// dimensions when the session starts.

/** Capped: SLAM already competes for the GPU, and 3x DPR buys nothing here. */
const MAX_PIXEL_RATIO = 2

export const fitCanvas = (canvas: HTMLCanvasElement): void => {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
}

export const watchCanvasSize = (canvas: HTMLCanvasElement): void => {
  const refit = (): void => {
    fitCanvas(canvas)
    // Tells the engine to rebuild its render targets at the new size.
    if (window.XR8) XR8.reconfigureSession()
  }
  window.addEventListener('resize', refit)
  // iOS reports the old dimensions if read immediately after the orientation event.
  window.addEventListener('orientationchange', () => setTimeout(refit, 200))
}
