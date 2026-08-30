// The placement controls and the on-device A/B measurement panel.
//
// MYAA-16 requires plan A and plan B to be compared on a real phone, and no phone was
// available where this was written. So every tap records what each method answered and
// why one was picked, and the log can be copied off the device. Flipping the mode switch
// while aiming at the same table is the actual comparison procedure.
//
// The DOM is built here rather than in index.html so this drops into a page that
// tracking-ux is already decorating without the two fighting over markup. Toasts are not
// duplicated either: they belong to tracking-ux, and it is passed in.
import type {PlacementMode, ResolveRecord} from '../xr/placement'

const fmt = (v: number | null | undefined, d = 2): string =>
  (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c] as string))

export interface PlacementPanelOptions {
  onMode?: (mode: PlacementMode) => void
  onCalibrate?: () => void
  onRecenter?: () => void
  onClear?: () => void
  toast?: (message: string) => void
}

interface LogEntry {
  n: number
  t: string
  mode: PlacementMode
  source: PlacementMode | null
  chosenY: number | null
  groundY: number
  planeY: number | null
  hitY: number | null
  hitType: string | null
  hitSpread: number | null
  hitSamples: number | null
  hitAgreeing: number | null
  why: string
}

export class PlacementPanel {
  readonly log: LogEntry[] = []
  private readonly toast: (message: string) => void
  private readonly controls: HTMLElement
  private readonly rows: HTMLElement
  private readonly summary: HTMLElement

  constructor({onMode, onCalibrate, onRecenter, onClear, toast}: PlacementPanelOptions = {}) {
    this.toast = toast ?? (() => {})

    const controls = document.createElement('div')
    controls.className = 'pp-controls'
    controls.innerHTML = `
      <div class="pp-row">
        <div class="pp-seg" role="group" aria-label="設置方式">
          <span class="pp-seg-label">方式</span>
          <button type="button" data-mode="AUTO" aria-pressed="true">自動</button>
          <button type="button" data-mode="PLANE" aria-pressed="false">A 基準面</button>
          <button type="button" data-mode="HITTEST" aria-pressed="false">B hitTest</button>
        </div>
      </div>
      <div class="pp-row">
        <button type="button" data-act="calibrate">この面を基準にする</button>
        <button type="button" data-act="recenter">basis リセット</button>
        <button type="button" data-act="clear">草を消す</button>
      </div>`
    document.body.appendChild(controls)

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'pp-toggle'
    toggle.textContent = '📊'
    toggle.setAttribute('aria-label', '計測パネル')
    document.body.appendChild(toggle)

    const panel = document.createElement('div')
    panel.className = 'pp-panel'
    panel.innerHTML = `
      <h4>設置面の計測（A / B 比較）</h4>
      <div class="pp-summary"></div>
      <table>
        <thead><tr><th>#</th><th>採用</th><th>A</th><th>B / type</th><th>判定</th></tr></thead>
        <tbody class="pp-rows"></tbody>
      </table>
      <div class="pp-foot">
        <button type="button" data-act="copy">ログをコピー</button>
        <button type="button" data-act="clearlog">クリア</button>
      </div>`
    document.body.appendChild(panel)

    this.controls = controls
    this.rows = panel.querySelector('.pp-rows') as HTMLElement
    this.summary = panel.querySelector('.pp-summary') as HTMLElement

    controls.querySelectorAll<HTMLElement>('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as PlacementMode
        this.setMode(mode)
        onMode?.(mode)
      })
    })

    const actions: Record<string, (() => void) | undefined> = {
      calibrate: onCalibrate,
      recenter: onRecenter,
      clear: onClear,
      copy: () => void this.copyLog(),
      clearlog: () => { this.log.length = 0; this.renderLog() },
    }
    for (const host of [controls, panel]) {
      host.querySelectorAll<HTMLElement>('[data-act]').forEach((btn) => {
        const fn = actions[btn.dataset.act as string]
        if (fn) btn.addEventListener('click', fn)
      })
    }
    toggle.addEventListener('click', () => panel.classList.toggle('pp-open'))
    this.renderLog()
  }

  setMode(mode: PlacementMode): void {
    this.controls.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
  }

  record(result: ResolveRecord): void {
    this.log.push({
      n: this.log.length + 1,
      t: new Date().toISOString(),
      mode: result.mode,
      source: result.chosen ? result.chosen.source : null,
      chosenY: result.chosen ? result.chosen.point.y : null,
      groundY: result.groundY,
      planeY: result.a ? result.a.y : null,
      hitY: result.b ? result.b.y : null,
      hitType: result.b ? result.b.type : null,
      hitSpread: result.b ? result.b.spread : null,
      hitSamples: result.b ? result.b.samples : null,
      hitAgreeing: result.b ? result.b.agreeing : null,
      why: result.why,
    })
    if (this.log.length > 300) this.log.shift()
    this.renderLog()
  }

  renderLog(): void {
    this.rows.innerHTML = this.log.slice(-12).reverse().map((r) => `
      <tr>
        <td>${r.n}</td>
        <td class="pp-src-${r.source ?? 'none'}">${
  r.source === 'HITTEST' ? 'B' : r.source === 'PLANE' ? 'A' : '×'}</td>
        <td>${fmt(r.planeY)}</td>
        <td>${fmt(r.hitY)}${r.hitType ? '<br>' + esc(r.hitType).replace('_', ' ') : ''}</td>
        <td>${esc(r.why)}</td>
      </tr>`).join('')

    const both = this.log.filter((r) => r.planeY != null && r.hitY != null)
    const usedB = this.log.filter((r) => r.source === 'HITTEST').length
    const types = [...new Set(this.log.map((r) => r.hitType).filter(Boolean))] as string[]
    const gaps = both.map((r) => Math.abs((r.hitY as number) - (r.planeY as number)))
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null
    this.summary.innerHTML =
      `taps ${this.log.length} / B採用 ${usedB} / |B−A|平均 ${fmt(meanGap)}m<br>` +
      `観測された type: ${types.length ? esc(types.join(', ')) : '(まだなし)'}`
  }

  async copyLog(): Promise<void> {
    const text = JSON.stringify(this.log, null, 1)
    try {
      await navigator.clipboard.writeText(text)
      this.toast(`${this.log.length} 件をコピーしました`)
    } catch {
      // Clipboard access is refused in plenty of mobile contexts; fall back to a file.
      try {
        const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}))
        const a = document.createElement('a')
        a.href = url
        a.download = 'placement-log.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
        this.toast('ログをファイルに保存しました')
      } catch {
        this.toast('コピーできませんでした')
      }
    }
  }
}
