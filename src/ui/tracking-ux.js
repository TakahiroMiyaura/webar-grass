// Tracking-state UX for the self-hosted 8th Wall engine (MYAA-15).
//
// Covers the four things a user hits before the experience works:
//   1. the first tap, which is what lets iOS show the motion/camera prompts at all
//   2. "the camera is up but SLAM has not converged yet" -> coaching
//   3. "SLAM had it and lost it" -> recovery
//   4. "the camera was denied" -> a way back
//
// It is additive, not a replacement. Two official MIT packages already cover part of
// this ground, and where they do, this module gets out of the way:
//
//   @8thwall/coaching-overlay  CoachingOverlay.pipelineModule() shows a prompt while
//                              tracking initialises. Its rule is exactly
//                              `show when LIMITED+INITIALIZING, hide when NORMAL`
//                              (dist/coaching-overlay.js, updateVisibility), so it
//                              covers first-run coaching and nothing else — a loss
//                              after tracking is up reports RELOCALIZING /
//                              TOO_MUCH_MOTION / NOT_ENOUGH_TEXTURE / NOT_AVAILABLE
//                              and leaves the overlay hidden.
//   @8thwall/xrextras          XRExtras.Loading owns the camera/motion permission
//                              error screens.
//
// So `coaching` and `permissionUi` default to 'auto': builtin only when the matching
// package is absent from window. What is always ours is the start gate, the tap
// gating, and the recovery banner — nothing upstream provides those.
//
// Engine signals this is built on, all verified present in @8thwall/engine-binary@1.0.0:
//   onCameraStatusChange({status, reason})  requesting | hasStream | hasVideo | failed
//                                           reason on failure: DENY_CAMERA | NO_CAMERA | UNSPECIFIED
//   'reality.trackingstatus' -> {status, reason}
//                                           status: UNSPECIFIED | NOT_AVAILABLE | LIMITED | NORMAL
//                                           reason: UNSPECIFIED | INITIALIZING | RELOCALIZING
//                                                 | TOO_MUCH_MOTION | NOT_ENOUGH_TEXTURE
//   onException(err)                        err.type === 'permission' for a denied permission

const PHASES = ['gate', 'starting', 'coaching', 'ready', 'recovering', 'error']

const DEFAULTS = {
  // 'auto' -> 'external' when window.CoachingOverlay is loaded, else 'builtin'.
  coaching: 'auto',
  // 'auto' -> 'external' when window.XRExtras is loaded, else 'builtin'.
  permissionUi: 'auto',
  // How long a bad tracking state must persist before we put something on screen.
  // SLAM dips to LIMITED for a frame or two constantly; without this the banner strobes.
  showDelayMs: 600,
  // And how long a good state must persist before we take it away again.
  hideDelayMs: 250,
  toastMs: 1800,
  // Ask for iOS motion permission inside the start tap rather than letting the engine
  // ask from inside XR8.run(). Same prompt, but guaranteed to be under user activation.
  requestMotionOnStart: true,
  vibrate: true,
  text: {
    gateTitle: 'カメラで空間を読み取ります',
    gateBody: '画面をタップすると始まります。\nこのあとカメラとモーションの許可を求められます。',
    gateButton: 'タップして開始',
    starting: 'カメラを起動しています…',
    coachingTitle: 'スマホをゆっくり動かしてください',
    coachingBody: '床や机が映るように、左右にゆっくり動かします',
    recoveringTitle: '位置を見失いました',
    recoverBody: {
      RELOCALIZING: '少し前に映していた場所に戻してください',
      TOO_MUCH_MOTION: '動かすのが速すぎます。ゆっくり動かしてください',
      NOT_ENOUGH_TEXTURE: '模様の少ない面です。少し別の場所を映してください',
      INITIALIZING: 'スマホをゆっくり動かしてください',
      DEFAULT: 'スマホをゆっくり動かしてください',
    },
    notReady: {
      gate: '画面をタップして開始してください',
      starting: 'カメラを起動しています…',
      coaching: 'まだ準備中です。スマホをゆっくり動かしてください',
      recovering: '位置を見失っています。ゆっくり動かして戻してください',
      DEFAULT: 'まだ準備中です',
    },
    miss: 'その場所は読み取れませんでした。少し手前を狙ってください',
    errorTitles: {
      DENY_CAMERA: 'カメラの使用が許可されていません',
      NO_CAMERA: 'カメラが見つかりません',
      DENY_MOTION: 'モーションセンサーの使用が許可されていません',
      DEFAULT: 'カメラを開けませんでした',
    },
    retry: '再読み込みして許可する',
  },
}

const ICON_PHONE = `<svg class="tux-phone" viewBox="0 0 48 72" aria-hidden="true">
  <rect x="6" y="2" width="36" height="68" rx="6" fill="none" stroke="currentColor" stroke-width="3"/>
  <circle cx="24" cy="26" r="7" fill="none" stroke="currentColor" stroke-width="3"/>
</svg>`

const merge = (base, over) => {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
  for (const k of Object.keys(over || {})) {
    const v = over[k]
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] || {}, v) : v
  }
  return out
}

export function createTrackingUx(options = {}) {
  const cfg = merge(DEFAULTS, options)
  const T = cfg.text

  let root = null
  let coachingMode = 'builtin'
  let permissionUiMode = 'builtin'
  let phase = 'gate'
  let status = 'UNSPECIFIED'
  let reason = 'UNSPECIFIED'
  let everReady = false
  let sawTracking = false
  let startResolve = null
  let pendingPhase = null
  let pendingTimer = null
  let toastTimer = null
  let destroyed = false
  const readyCbs = []
  const startCbs = []
  const els = {}

  const startPromise = new Promise((res) => { startResolve = res })

  // State readable from a headless probe (verify.mjs) and from the app.
  const state = {
    get phase() { return phase },
    get status() { return status },
    get reason() { return reason },
    get ready() { return phase === 'ready' },
    get everReady() { return everReady },
    log: [],
  }

  const note = (m) => {
    state.log.push(`${Math.round(performance.now())} ${m}`)
    if (state.log.length > 200) state.log.shift()
  }

  // ---------------------------------------------------------------- DOM

  const resolveModes = () => {
    coachingMode = cfg.coaching === 'auto'
      ? (window.CoachingOverlay ? 'external' : 'builtin') : cfg.coaching
    permissionUiMode = cfg.permissionUi === 'auto'
      ? (window.XRExtras && window.XRExtras.Loading ? 'external' : 'builtin') : cfg.permissionUi
    note(`coaching=${coachingMode} permissionUi=${permissionUiMode}`)
  }

  const build = () => {
    root = document.createElement('div')
    root.className = 'tux'
    root.setAttribute('data-phase', 'gate')
    root.setAttribute('data-coaching', coachingMode)
    root.setAttribute('data-permission-ui', permissionUiMode)
    root.setAttribute('data-coach-suppressed', '0')
    root.innerHTML = `
      <div class="tux-gate" data-tux="gate" role="button" tabindex="0">
        <div class="tux-gate-inner">
          ${ICON_PHONE}
          <h1>${esc(T.gateTitle)}</h1>
          <p>${esc(T.gateBody).replace(/\n/g, '<br>')}</p>
          <div class="tux-btn" data-tux="gate-button">${esc(T.gateButton)}</div>
        </div>
      </div>

      <div class="tux-coach" data-tux="coach" aria-live="polite">
        <div class="tux-coach-inner">
          <div class="tux-swing">${ICON_PHONE}</div>
          <div class="tux-coach-text">
            <strong data-tux="coach-title">${esc(T.coachingTitle)}</strong>
            <span data-tux="coach-body">${esc(T.coachingBody)}</span>
          </div>
        </div>
      </div>

      <div class="tux-error" data-tux="error" role="alert">
        <div class="tux-gate-inner">
          <h1 data-tux="error-title"></h1>
          <p data-tux="error-body"></p>
          <div class="tux-btn" data-tux="error-retry">${esc(T.retry)}</div>
        </div>
      </div>

      <div class="tux-toast" data-tux="toast" role="status" aria-live="polite"></div>
    `
    document.body.appendChild(root)
    for (const el of root.querySelectorAll('[data-tux]')) els[el.getAttribute('data-tux')] = el

    const fire = (e) => { e.preventDefault(); begin() }
    els.gate.addEventListener('touchend', fire, {passive: false})
    els.gate.addEventListener('click', fire)
    els['error-retry'].addEventListener('click', () => window.location.reload())
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]))

  // ---------------------------------------------------------------- phase

  const applyPhase = (next) => {
    if (destroyed || phase === next) return
    phase = next
    root.setAttribute('data-phase', next)
    if (next === 'ready' && !everReady) {
      everReady = true
      readyCbs.splice(0).forEach((cb) => { try { cb() } catch (e) { console.error(e) } })
    }
    note('phase=' + next)
  }

  // Debounced so a one-frame LIMITED does not flash a banner. 'error' and 'ready'
  // -> anything-bad still go through the delay; anything -> 'ready' uses hideDelayMs.
  const setPhase = (next, immediate = false) => {
    if (destroyed) return
    if (phase === 'error' && next !== 'error') return  // an error screen is terminal until reload
    if (immediate) {
      clearTimeout(pendingTimer); pendingTimer = null; pendingPhase = null
      return applyPhase(next)
    }
    if (next === phase) {
      clearTimeout(pendingTimer); pendingTimer = null; pendingPhase = null
      return
    }
    if (pendingPhase === next) return
    clearTimeout(pendingTimer)
    pendingPhase = next
    const delay = next === 'ready' ? cfg.hideDelayMs : cfg.showDelayMs
    pendingTimer = setTimeout(() => {
      pendingTimer = null; pendingPhase = null
      applyPhase(next)
    }, delay)
  }

  const setCoachText = (title, body) => {
    if (!els['coach-title']) return
    els['coach-title'].textContent = title
    els['coach-body'].textContent = body
  }

  // CoachingOverlay is on screen for exactly one state. While it is, ours stays off so
  // the user does not get two prompts; for every other bad state it shows nothing and
  // ours is the only thing that will speak.
  //
  // Before the first tracking event there is no way to know which of the two applies, and
  // on a real device the next thing to arrive is almost always LIMITED+INITIALIZING. So
  // hold ours back until we have heard something: showing it for ~1s and then swapping
  // to CoachingOverlay reads worse than a slightly later first prompt.
  const syncCoachOwner = () => {
    if (!root) return
    const owned = coachingMode === 'external' &&
      (!sawTracking || (status === 'LIMITED' && reason === 'INITIALIZING'))
    root.setAttribute('data-coach-suppressed', owned ? '1' : '0')
  }

  const onTracking = (s, r) => {
    status = s || 'UNSPECIFIED'
    reason = r || 'UNSPECIFIED'
    note(`tracking ${status}/${reason}`)
    sawTracking = true
    if (phase === 'gate' || phase === 'error') return
    syncCoachOwner()

    if (status === 'NORMAL') return setPhase('ready')

    // Anything else is "not usable". Which copy depends on whether tracking has ever
    // worked in this session: before that it is coaching, after that it is recovery.
    const body = T.recoverBody[reason] || T.recoverBody.DEFAULT
    if (everReady) {
      setCoachText(T.recoveringTitle, body)
      setPhase('recovering')
    } else {
      setCoachText(T.coachingTitle, reason === 'UNSPECIFIED' ? T.coachingBody : body)
      setPhase('coaching')
    }
  }

  const showError = (kind, detail) => {
    // In 'external' mode XRExtras.Loading is already putting its own screen up; we only
    // record the state so taps stay blocked.
    if (permissionUiMode !== 'builtin') {
      applyPhase('error')
      note('error ' + kind + ' (rendered by XRExtras.Loading)')
      return
    }
    els['error-title'].textContent = T.errorTitles[kind] || T.errorTitles.DEFAULT
    els['error-body'].textContent = permissionHelp(kind, detail)
    applyPhase('error')
    note('error ' + kind + (detail ? ' (' + detail + ')' : ''))
  }

  // The browser will not re-prompt for a permission it has already been refused, so the
  // only honest instruction is the OS-specific path back to the setting.
  const permissionHelp = (kind, detail) => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    if (kind === 'NO_CAMERA') return 'この端末でカメラを利用できません。' + (detail ? `(${detail})` : '')
    if (kind === 'DENY_MOTION') {
      return ios
        ? '設定アプリ >「Safari」>「モーションと画面の向きのアクセス」をオンにしてから、下のボタンで再読み込みしてください。'
        : 'ブラウザのモーションセンサー設定を許可してから、下のボタンで再読み込みしてください。'
    }
    // Chrome does not always report a reason for a refused camera, so the generic
    // case says the same thing as DENY_CAMERA — permission is overwhelmingly the cause.
    const lead = kind === 'DENY_CAMERA' ? '' : 'カメラの許可がオフになっている可能性があります。'
    return lead + (ios
      ? 'アドレスバー左の「ぁあ」>「Webサイトの設定」>「カメラ」を「許可」にしてから、下のボタンで再読み込みしてください。'
      : 'アドレスバー左の鍵アイコン >「サイトの設定」>「カメラ」を「許可」にしてから、下のボタンで再読み込みしてください。')
  }

  const toast = (msg) => {
    if (destroyed || !els.toast) return
    els.toast.textContent = msg
    els.toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), cfg.toastMs)
    if (cfg.vibrate && navigator.vibrate) { try { navigator.vibrate(12) } catch (e) { /* ignore */ } }
    note('toast: ' + msg)
  }

  // ---------------------------------------------------------------- start

  let started = false
  const begin = () => {
    if (started || destroyed) return
    started = true
    note('start tap')
    applyPhase('starting')

    // iOS needs this call to sit inside the tap's user activation. The engine also
    // asks during XR8.run(), but by then we are a few promise ticks past the gesture;
    // asking here first means the engine's later request resolves from cache.
    if (cfg.requestMotionOnStart &&
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        DeviceMotionEvent.requestPermission().then((res) => {
          note('devicemotion permission=' + res)
          if (res !== 'granted') showError('DENY_MOTION')
        }).catch((e) => note('devicemotion permission threw: ' + e.message))
      } catch (e) { note('devicemotion permission threw: ' + e.message) }
    }

    startCbs.splice(0).forEach((cb) => { try { cb() } catch (e) { console.error(e) } })
    startResolve()
  }

  // ---------------------------------------------------------------- pipeline

  const pipelineModule = () => ({
    name: 'tracking-ux',

    onCameraStatusChange: ({status: s, reason: r}) => {
      note('camera=' + s + (r ? ' (' + r + ')' : ''))
      if (s === 'requesting') setPhase('starting', true)
      if (s === 'hasVideo') {
        // Camera is live but SLAM has produced nothing yet: this is the coaching window.
        setCoachText(T.coachingTitle, T.coachingBody)
        syncCoachOwner()
        setPhase('coaching', true)
      }
      if (s === 'failed') showError(r === 'DENY_CAMERA' || r === 'NO_CAMERA' ? r : 'DEFAULT', r)
    },

    listeners: [{
      event: 'reality.trackingstatus',
      process: ({status: s, reason: r} = {}) => onTracking(s, r),
    }],

    // The event above is the primary signal; this is a belt-and-braces read of the same
    // values off the frame result, in case a future engine build stops dispatching it.
    onUpdate: ({processCpuResult}) => {
      const reality = processCpuResult && processCpuResult.reality
      if (!reality || !reality.trackingStatus) return
      if (reality.trackingStatus !== status || reality.trackingReason !== reason) {
        onTracking(reality.trackingStatus, reality.trackingReason)
      }
    },

    onException: (err) => {
      const type = err && err.type
      note('exception: ' + type + ' ' + (err && (err.message || err.status || '')))
      if (type === 'permission') {
        const p = err.permission
        showError(p === 'camera' ? 'DENY_CAMERA' : p === 'devicemotion' ? 'DENY_MOTION' : 'DEFAULT', p)
      }
    },
  })

  // ---------------------------------------------------------------- api

  const api = {
    state,
    get coachingMode() { return coachingMode },
    get permissionUiMode() { return permissionUiMode },
    mount() {
      if (root) return api
      resolveModes()
      build()
      syncCoachOwner()
      window.__trackingUx = api  // read by verify.mjs
      return api
    },
    pipelineModule,
    start: begin,
    whenStarted: () => startPromise,
    onStart(cb) { started ? cb() : startCbs.push(cb); return api },
    // For hosts that also have their own preconditions (see the in-app guard in
    // web/app.js): the start tap can land before or after theirs are satisfied.
    isStarted: () => started,
    onReady(cb) { everReady ? cb() : readyCbs.push(cb); return api },
    isReady: () => phase === 'ready',

    // Call this instead of dropping a tap on the floor. Every tap gets an answer.
    rejectTap() {
      toast(T.notReady[phase] || T.notReady.DEFAULT)
      return false
    },
    // Tracking was fine but the hit test came back empty.
    notifyMiss(msg) { toast(msg || T.miss) },
    toast,

    destroy() {
      destroyed = true
      clearTimeout(pendingTimer)
      clearTimeout(toastTimer)
      if (root && root.parentNode) root.parentNode.removeChild(root)
      root = null
    },
  }
  return api
}

export {PHASES}
