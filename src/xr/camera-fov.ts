// Widening the camera feed back out on Android (MYAA-23, plan A).
//
// Symptom: the camera image looks zoomed in on Android but not on iPhone.
//
// Cause, from reading the engine binary and measuring both browsers: the engine asks
// getUserMedia for a different SHAPE of constraint per OS. iOS gets a lower bound
// (`{width:{min:960},height:{min:720}}`) and Safari answers with a native capture
// format. Android gets an exact size (`{width:{exact:960},height:{exact:720}}`), and
// Chrome is allowed to satisfy an exact size by cropping the nearest native format
// - it reports that as `resizeMode: 'crop-and-scale'`. Cropping a 16:9 native frame
// down to 4:3 throws away a quarter of the landscape-width field of view, and that
// axis is the one the engine maps onto the screen's long side, so the whole image
// comes out magnified by up to 1.33x.
//
// Note what does NOT matter: the aspect ratio itself. The engine fills the canvas with
// XR8.GlTextureRenderer's aspect-fill (centre crop, height-bound on a tall phone), so a
// 4:3 and a 16:9 feed from the same sensor end up showing exactly the same field of
// view. Only whether the frame was CROPPED out of its native format matters. That is
// why the ladder below is ordered by how likely a size is to be native and how much it
// costs to process, not by aspect ratio.
//
// So the fix is to take the track the engine opened and ask for a native format again.
// `min`-style constraints cannot do it after the fact (960x720 already satisfies them),
// so the ladder uses `ideal` and keeps the first answer that comes back uncropped.
//
// This runs only where the symptom is: a track that reports `crop-and-scale`. WebKit
// does not report resizeMode at all, so iOS is never touched.
import type {CameraStatus, XrCameraPipelineModule} from '../types/8thwall'

/** `resizeMode` is not in every lib.dom yet, and WebKit omits it entirely. */
export interface TrackSettings extends MediaTrackSettings {
  resizeMode?: string
}

export interface SizeConstraints extends MediaTrackConstraints {
  // Sent as a plain hint rather than `{exact:'none'}`. Measured: Chrome ignores it
  // either way (w3c/mediacapture-main#584), and demanding it exactly would throw on
  // every device that cannot honour it, which would take the ladder's own fallback
  // away. It stays because it says what is being asked for, and a UA that does
  // implement it gets the answer right on the first rung.
  resizeMode?: ConstrainDOMString
}

export interface TrackReport {
  width: number | undefined
  height: number | undefined
  aspect: number | null
  resizeMode: string | undefined
  deviceId: string | undefined
  frameRate: number | undefined
}

export interface Attempt {
  request: string
  got: string
  ok: boolean
}

export interface CameraFovReport {
  /** 'off' when the switch is down, 'skipped' when the feed was never cropped. */
  state: 'idle' | 'off' | 'skipped' | 'widened' | 'failed'
  why: string
  baseline: TrackReport | null
  current: TrackReport | null
  attempts: Attempt[]
}

/**
 * Sizes to try, cheapest-and-most-universal first.
 *
 * The first three sit around the engine's own 960x720 budget, so accepting one of them
 * does not hand the SLAM a much bigger frame to chew on. 1920x1080 is the near-universal
 * ceiling, and 640x480 is the last resort every camera has - lower resolution than the
 * engine wanted, but with the full field of view back, which is the point.
 */
const LADDER: ReadonlyArray<{width: number; height: number}> = [
  {width: 1280, height: 720},
  {width: 1280, height: 960},
  {width: 1440, height: 1080},
  {width: 1920, height: 1080},
  {width: 640, height: 480},
]

const read = (track: MediaStreamTrack): TrackReport => {
  const s = track.getSettings() as TrackSettings
  return {
    width: s.width,
    height: s.height,
    aspect: s.width && s.height ? Number((s.width / s.height).toFixed(3)) : null,
    resizeMode: s.resizeMode,
    deviceId: s.deviceId,
    frameRate: s.frameRate ? Math.round(s.frameRate) : undefined,
  }
}

const label = (r: TrackReport | null): string =>
  r ? `${r.width}x${r.height} ${r.resizeMode ?? '(no resizeMode)'}` : '(none)'

/** The one signal Chrome gives us that the frame was cut down, not just scaled. */
const isCropped = (r: TrackReport | null): boolean => r?.resizeMode === 'crop-and-scale'

export interface CameraFov {
  readonly report: CameraFovReport
  /** Re-runs the ladder. Safe to call again; used by the diagnostics panel. */
  widen(): Promise<CameraFovReport>
  /** Puts the engine's original request back, for an A/B against the same scene. */
  restore(): Promise<CameraFovReport>
}

let active: CameraFov | null = null

/** The live controller, or null before the camera has produced a frame. */
export const getCameraFov = (): CameraFov | null => active

declare global {
  interface Window {
    /**
     * The live report, published like `__diag`: scripts/verify-camera-fov.mjs reads it,
     * and it is the fastest way to see what the camera did from a remote-debugging
     * console. The object is mutated in place, so the reference stays valid.
     */
    __camera?: CameraFovReport
  }
}

const enabledByUrl = (): boolean | null => {
  const v = new URLSearchParams(location.search).get('fov')
  if (v === null) return null
  return v !== 'off' && v !== '0' && v !== 'false'
}

class Controller implements CameraFov {
  readonly report: CameraFovReport = {
    state: 'idle', why: '', baseline: null, current: null, attempts: [],
  }

  constructor(private readonly track: MediaStreamTrack) {
    this.report.baseline = read(track)
    this.report.current = this.report.baseline
  }

  private async apply(constraints: SizeConstraints): Promise<TrackReport | null> {
    try {
      await this.track.applyConstraints(constraints)
      this.report.current = read(this.track)
      return this.report.current
    } catch {
      // OverconstrainedError and friends: this size is simply not on offer. The track
      // keeps running at whatever it had, so the ladder can just move on.
      return null
    }
  }

  async widen(): Promise<CameraFovReport> {
    const base = this.report.baseline
    this.report.attempts = []

    if (!isCropped(read(this.track))) {
      this.report.state = 'skipped'
      this.report.why = `feed is not cropped (${label(read(this.track))})`
      this.report.current = read(this.track)
      return this.report
    }

    for (const size of LADDER) {
      // `ideal` rather than `exact`: an exact request is what got the feed cropped in
      // the first place, and a miss here should fall through to the next rung rather
      // than throw.
      const got = await this.apply({
        width: {ideal: size.width},
        height: {ideal: size.height},
        resizeMode: 'none',
      })
      this.report.attempts.push({
        request: `${size.width}x${size.height}`,
        got: label(got),
        ok: Boolean(got) && !isCropped(got),
      })
      if (got && !isCropped(got)) {
        this.report.state = 'widened'
        this.report.why = `${label(base)} -> ${label(got)}`
        return this.report
      }
    }

    // Nothing came back uncropped. Leaving the feed at the last rung would be a change
    // with no upside, so put the engine's own request back.
    await this.restore()
    this.report.state = 'failed'
    this.report.why = 'no uncropped format on offer; restored the engine default'
    return this.report
  }

  async restore(): Promise<CameraFovReport> {
    const base = this.report.baseline
    if (base?.width && base.height) {
      await this.apply({width: {exact: base.width}, height: {exact: base.height}})
    }
    this.report.state = 'off'
    this.report.why = `restored to ${label(this.report.current)}`
    return this.report
  }
}

/**
 * Records what the camera actually handed over, and - unless switched off - asks for an
 * uncropped format when Chrome reports it cropped one.
 *
 * `?fov=off` keeps the engine's feed untouched, which is the other half of the on-device
 * comparison this was written for. The diagnostics panel drives the same two calls
 * without a reload.
 */
export const createCameraFovModule = (
  events: string[],
): XrCameraPipelineModule => ({
  name: 'camera-fov',

  onCameraStatusChange: ({status, video}: {
    status: CameraStatus
    reason: string | undefined
    video?: HTMLVideoElement
  }) => {
    if (status !== 'hasVideo' || !video) return
    const stream = video.srcObject
    const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : undefined
    if (!track) {
      events.push('camera-fov: no video track on the feed')
      return
    }

    const controller = new Controller(track)
    active = controller
    window.__camera = controller.report
    events.push(`camera opened at ${label(controller.report.baseline)}`)

    if (enabledByUrl() === false) {
      controller.report.state = 'off'
      controller.report.why = '?fov=off'
      events.push('camera-fov: off (?fov=off)')
      return
    }

    // Deliberately not awaited: onCameraStatusChange is on the engine's start path, and
    // a renegotiation that stalls must not hold the session up. The result lands in the
    // report either way.
    void controller.widen().then((r) => {
      events.push(`camera-fov: ${r.state} - ${r.why}`)
    })
  },

  onDetach: () => { active = null },
})
