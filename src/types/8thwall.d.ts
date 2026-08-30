// Minimal ambient types for the 8th Wall script-tag globals.
//
// The published packages ship no .d.ts, so this covers only what this project calls.
// Widen it as more of the API gets used rather than reaching for `any` at call sites -
// this file is the single place where the untyped boundary lives.

export {}

/** One result from XR8.XrController.hitTest(). */
export interface XrHitTestResult {
  type: XrHitTestType
  /** null on every axis when the engine has no estimate yet. */
  position: {x: number; y: number; z: number}
  rotation: {x: number; y: number; z: number; w: number}
  distance: number
}

export type XrHitTestType =
  | 'FEATURE_POINT'
  | 'ESTIMATED_SURFACE'
  | 'DETECTED_SURFACE'
  | 'UNSPECIFIED'

export type CameraStatus =
  | 'requesting' | 'hasStream' | 'hasVideo' | 'failed' | 'initializing' | 'ready'

/** What XR8.XrDevice.compatibilities() reports about the current browser. */
export interface XrCompatibilities {
  os: string
  inAppBrowser: string
  hasDevice: boolean
  hasBrowser: boolean
  hasUserMedia: boolean
  hasWebAssembly: boolean
  hasDeviceOrientation: boolean
}

export interface XrDeviceEstimate {
  os: string
  osVersion: string
  manufacturer: string
  model: string
  /** An object, not a string - it carries `inAppBrowser` among other fields. */
  browser: Record<string, unknown>
}

export interface XrCameraPipelineModule {
  name: string
  onStart?: (args: {canvas: HTMLCanvasElement; GLctx: WebGLRenderingContext}) => void
  onBeforeRun?: (args: unknown) => void
  onUpdate?: (args: {processCpuResult: Record<string, unknown>}) => void
  onCameraStatusChange?: (args: {status: CameraStatus; reason?: string}) => void
  onException?: (error: Error) => void
  onDeviceOrientationChange?: () => void
  onCanvasSizeChange?: (args: {canvasWidth: number; canvasHeight: number}) => void
  onDetach?: () => void
}

declare global {
  interface Window {
    XR8?: typeof XR8
    XRExtras?: typeof XRExtras
    CoachingOverlay?: typeof CoachingOverlay
    LandingPage?: typeof LandingPage
    /** XR8.Threejs builds its scene from the global THREE; main.ts assigns it. */
    THREE?: unknown
  }

  const XR8: {
    version(): string
    run(args: {canvas: HTMLCanvasElement; allowedDevices?: string}): void
    stop(): void
    pause(): void
    resume(): void
    reconfigureSession(): void
    addCameraPipelineModule(module: XrCameraPipelineModule): void
    addCameraPipelineModules(modules: XrCameraPipelineModule[]): void
    GlTextureRenderer: {pipelineModule(): XrCameraPipelineModule}
    Threejs: {
      pipelineModule(): XrCameraPipelineModule
      xrScene(): {
        scene: import('three').Scene
        camera: import('three').PerspectiveCamera
        renderer: import('three').WebGLRenderer
      }
    }
    XrController: {
      pipelineModule(): XrCameraPipelineModule
      configure(args: {disableWorldTracking?: boolean; scale?: 'responsive' | 'absolute'}): void
      /** x and y are 0..1 in screen space, origin top-left. */
      hitTest(x: number, y: number, includedTypes: XrHitTestType[]): XrHitTestResult[]
      updateCameraProjectionMatrix(args: {
        origin?: {x: number; y: number; z: number}
        facing?: {x: number; y: number; z: number; w: number}
        cam?: {pixelRectWidth: number; pixelRectHeight: number; nearClipPlane: number; farClipPlane: number}
      }): void
      recenter(): void
    }
    XrDevice: {
      isDeviceBrowserCompatible(config?: {allowedDevices?: string}): boolean
      incompatibleReasons(config?: {allowedDevices?: string}): string[]
      incompatibleReasonDetails(config?: {allowedDevices?: string}): Record<string, unknown>
      compatibilities(): XrCompatibilities
      deviceEstimate(): XrDeviceEstimate
      IncompatibilityReasons: Record<string, string>
    }
    XrConfig: {device(): {ANY: string; MOBILE: string; MOBILE_AND_HEADSETS: string}}
  }

  const XRExtras: {
    AlmostThere: {pipelineModule(): XrCameraPipelineModule; configure(args: {url?: string}): void}
    FullWindowCanvas: {pipelineModule(): XrCameraPipelineModule}
    Loading: {
      pipelineModule(): XrCameraPipelineModule
      showLoading(args: {onxrloaded: () => void}): void
    }
    RuntimeError: {pipelineModule(): XrCameraPipelineModule}
    PauseOnBlur: {pipelineModule(): XrCameraPipelineModule}
    PauseOnHidden: {pipelineModule(): XrCameraPipelineModule}
    Stats: {pipelineModule(): XrCameraPipelineModule}
  }

  const CoachingOverlay: {
    pipelineModule(): XrCameraPipelineModule
    configure(args: {
      promptText?: string
      promptColor?: string
      animationColor?: string
      disablePrompt?: boolean
    }): void
  }

  const LandingPage: {
    pipelineModule(): XrCameraPipelineModule
    configure(args: {
      url?: string
      promptPrefix?: string
      promptSuffix?: string
      backgroundColor?: string
      textColor?: string
      font?: string
      logoSrc?: string
      mediaSrc?: string
    }): void
  }
}
