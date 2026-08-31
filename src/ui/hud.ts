// The environment panel, plus a one-line placement read-out.
//
// The panel is the answer to "非対応環境の判定結果を画面に出せる": it opens by itself when
// something blocking is found, and is reachable any time from the ⓘ button or ?diag=1,
// so a failure on someone else's phone can be read out instead of guessed at. It sits
// above the start gate and the in-app guard on purpose - the devices that need it are
// exactly the ones stuck behind one of those.
//
// User guidance is NOT here. tracking-ux owns every instruction the user reads; this
// line only reports what was placed, so the two never contradict each other.
import {inspectEngine, inspectEnvironment, type Check} from '../xr/capability'
import {getCameraFov} from '../xr/camera-fov'

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id} in index.html`)
  return node as T
}

const statusEl = el('hud-status')
const detailEl = el('hud-detail')
const panelEl = el('diag-panel')
const toggleEl = el<HTMLButtonElement>('diag-toggle')

export const setStatus = (status: string, detail = ''): void => {
  statusEl.textContent = status
  detailEl.textContent = detail
}

const renderCheck = (c: Check): string =>
  `<li class="${c.ok ? 'ok' : 'ng'}"><span>${c.ok ? '✓' : '✗'}</span>` +
  `<span>${c.label}${c.detail ? `<em>${c.detail}</em>` : ''}</span></li>`

/**
 * The camera feed section (MYAA-23).
 *
 * On Android the engine's own request comes back cropped, which reads on screen as a
 * zoomed-in camera; camera-fov.ts asks for an uncropped format instead. Whether that
 * costs anything in tracking or frame rate can only be answered on a phone, so the two
 * buttons flip between the widened feed and the engine's original one without a reload -
 * aim at the same scene, tap one, tap the other.
 */
const renderCamera = (): string => {
  const fov = getCameraFov()
  if (!fov) return '<h3>カメラ映像</h3><p>まだ映像が来ていません</p>'

  const {state, why, baseline, current, attempts} = fov.report
  const size = (r: typeof baseline): string =>
    r ? `${r.width}x${r.height}${r.resizeMode ? ` / ${r.resizeMode}` : ''}` : '(不明)'
  const tried = attempts.length
    ? `<pre>${attempts.map((a) => `${a.ok ? '✓' : '·'} ${a.request} -> ${a.got}`).join('\n')}</pre>`
    : ''

  return `<h3>カメラ映像</h3>
    <ul>${renderCheck({
    label: `画角の補正: ${state}`,
    // 'failed' is the only outcome that means something is wrong; 'skipped' just means
    // this device never had the problem.
    ok: state !== 'failed',
    detail: why || undefined,
  })}</ul>
    <p>エンジンが開いた設定: ${size(baseline)}<br>いまの設定: ${size(current)}</p>
    ${tried}
    <div class="diag-actions">
      <button type="button" data-diag="widen">広く撮る</button>
      <button type="button" data-diag="restore">エンジン既定に戻す</button>
    </div>`
}

export const renderDiagnostics = (): void => {
  const env = inspectEnvironment()
  const engine = inspectEngine()

  const engineSection = engine
    ? `<h3>エンジン判定</h3>
       <ul>${renderCheck({
    label: 'XR8 対応デバイス',
    ok: engine.compatible,
    detail: engine.reasons.length ? engine.reasons.join(', ') : undefined,
  })}</ul>
       <h3>端末</h3><p>${engine.device || '(不明)'}</p>
       <pre>${JSON.stringify(engine.raw, null, 1)}</pre>`
    : '<h3>エンジン判定</h3><p>エンジン未読み込み</p>'

  panelEl.innerHTML =
    `<h3>ブラウザ環境</h3><ul>${env.checks.map(renderCheck).join('')}</ul>` +
    engineSection +
    renderCamera() +
    `<h3>URL</h3><p class="url">${location.href}</p>`
}

export const openDiagnostics = (): void => {
  renderDiagnostics()
  panelEl.hidden = false
}

/** True when something stops the engine from running at all, e.g. the page is on http://. */
export const hasBlockingEnvironment = (): boolean => inspectEnvironment().blocking.length > 0

export const initHud = (): void => {
  toggleEl.addEventListener('click', () => {
    if (panelEl.hidden) openDiagnostics()
    else panelEl.hidden = true
  })

  // Delegated, because renderDiagnostics() replaces the panel's markup on every open.
  panelEl.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-diag]')
    const fov = getCameraFov()
    if (!act || !fov) return
    const run = act.dataset.diag === 'widen' ? fov.widen() : fov.restore()
    void run.then(renderDiagnostics)
  })

  // An in-app browser is not handled here: public/openin.js already puts a full-screen
  // guard up with the per-app escape route, long before this runs.
  const env = inspectEnvironment()
  if (env.blocking.length > 0) {
    setStatus('この環境では動きません', env.blocking.map((c) => c.label).join(' / '))
    // The ⓘ button is otherwise a debug-only tool (MYAA-22). Here it is the only
    // explanation the user is going to get, so style.css keeps it on screen for this
    // class regardless of the debug switch.
    document.body.classList.add('env-blocked')
    openDiagnostics()
  }

  if (new URLSearchParams(location.search).has('diag')) openDiagnostics()

  // The engine verdict only exists once xr.js has run, so an already-open panel needs a
  // second pass - otherwise it is stuck reporting "エンジン未読み込み".
  window.addEventListener('xrloaded', () => {
    if (!panelEl.hidden) renderDiagnostics()
  }, {once: true})
}
