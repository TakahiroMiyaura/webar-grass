// On-screen status line and the environment panel.
//
// The panel is the answer to "非対応環境の判定結果を画面に出せる": it opens by itself when
// something blocking is found, and is reachable any time from the ⓘ button or ?diag=1,
// so a failure on someone else's phone can be read out instead of guessed at.
import {inspectEngine, inspectEnvironment, type Check} from '../xr/capability'

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

  const env = inspectEnvironment()
  if (env.blocking.length > 0) {
    setStatus('この環境では動きません', env.blocking.map((c) => c.label).join(' / '))
    openDiagnostics()
  } else if (env.inAppBrowser) {
    setStatus(`${env.inAppBrowser} 内で開かれています`,
      'うまく動かない場合は Safari / Chrome で開き直してください')
  }

  if (new URLSearchParams(location.search).has('diag')) openDiagnostics()

  // The engine verdict only exists once xr.js has run, so an already-open panel needs a
  // second pass - otherwise it is stuck reporting "エンジン未読み込み".
  window.addEventListener('xrloaded', () => {
    if (!panelEl.hidden) renderDiagnostics()
  }, {once: true})
}
