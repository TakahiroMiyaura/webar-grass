// Environment diagnosis.
//
// Two layers, because they answer different questions at different times:
//   - inspectEnvironment() runs before the engine loads and covers the failures that
//     stop xr.js from even starting (no HTTPS, no getUserMedia, no WebGL).
//   - inspectEngine() adds XR8's own verdict once it is available.
//
// Both feed the on-screen panel, so an unsupported phone shows a reason instead of a
// black screen. In-app browsers are called out separately: they are the single most
// common way this content fails in the wild, and the fix is "open in Safari/Chrome",
// which is worth saying out loud rather than reporting as a generic incompatibility.

export interface Check {
  label: string
  ok: boolean
  detail?: string
}

export interface EnvironmentReport {
  checks: Check[]
  inAppBrowser: string | null
  blocking: Check[]
}

/**
 * Named in-app webviews. UA sniffing is unreliable in general, but these apps all
 * append a stable token, and the cost of a false negative is only a missing hint.
 */
const IN_APP_BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bLine\//i, 'LINE'],
  [/Instagram/i, 'Instagram'],
  [/\bFBAN\b|\bFBAV\b/i, 'Facebook'],
  [/\bTwitter\b/i, 'X (Twitter)'],
  [/\bTikTok\b/i, 'TikTok'],
  [/\bKAKAOTALK\b/i, 'KakaoTalk'],
  [/\bMicroMessenger\b/i, 'WeChat'],
]

export const detectInAppBrowser = (ua: string = navigator.userAgent): string | null => {
  for (const [pattern, name] of IN_APP_BROWSERS) {
    if (pattern.test(ua)) return name
  }
  return null
}

const hasWebGL = (): boolean => {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export const inspectEnvironment = (): EnvironmentReport => {
  const inAppBrowser = detectInAppBrowser()

  const checks: Check[] = [
    {
      label: 'HTTPS（secure context）',
      ok: window.isSecureContext,
      detail: window.isSecureContext ? location.protocol : 'カメラは HTTPS でしか使えません',
    },
    {
      label: 'カメラ API（getUserMedia）',
      ok: typeof navigator.mediaDevices?.getUserMedia === 'function',
    },
    {
      label: 'WebAssembly',
      ok: typeof WebAssembly === 'object',
    },
    {
      label: 'WebGL',
      ok: hasWebGL(),
    },
    {
      label: 'DeviceOrientation',
      ok: typeof window.DeviceOrientationEvent !== 'undefined',
    },
    {
      label: '通常ブラウザ',
      ok: inAppBrowser === null,
      detail: inAppBrowser ? `${inAppBrowser} のアプリ内ブラウザで開かれています` : undefined,
    },
  ]

  return {
    checks,
    inAppBrowser,
    // The in-app browser check is advisory: some webviews do grant camera access, so it
    // is reported but never treated as a hard stop.
    blocking: checks.filter((c) => !c.ok && c.label !== '通常ブラウザ'),
  }
}

export interface EngineReport {
  compatible: boolean
  reasons: string[]
  details: Record<string, unknown>
  device: string
  raw: Record<string, unknown>
}

export const inspectEngine = (): EngineReport | null => {
  if (!window.XR8) return null
  const estimate = XR8.XrDevice.deviceEstimate()
  const compatibilities = XR8.XrDevice.compatibilities()
  return {
    compatible: XR8.XrDevice.isDeviceBrowserCompatible(),
    reasons: XR8.XrDevice.incompatibleReasons(),
    details: XR8.XrDevice.incompatibleReasonDetails(),
    // Only the fields the engine documents as strings. `browser` is an object, and
    // interpolating it straight into the summary line prints [object Object].
    device: [estimate.manufacturer, estimate.model, estimate.os, estimate.osVersion]
      .filter(Boolean).join(' / '),
    // Everything else goes out verbatim: on an unknown phone the raw dump is the part
    // worth reading back over a chat, and guessing at its shape only loses information.
    raw: {estimate, compatibilities, details: XR8.XrDevice.incompatibleReasonDetails()},
  }
}
