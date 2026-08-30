// Headless verification for MYAA-15.
//
//   pass 1  state machine  — drives tracking-ux.js directly, no engine. Asserts the
//                            phase transitions, the anti-flicker debounce, the
//                            tap-before-ready answer and the permission-denied screen.
//   pass 2  live engine    — runs the real self-hosted engine against a synthetic
//                            camera and checks the gate actually holds XR8.run() back
//                            and that no cube is ever placed before tracking is ready.
//
// Both passes run in Chromium (Android UA) and WebKit (the Safari engine, iOS UA).
//   node verify.mjs            both passes
//   node verify.mjs --sm       state machine only (no engine binary needed)
import {chromium, webkit} from 'playwright'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {execSync} from 'node:child_process'

const root = path.resolve('web')
const PORT = Number(process.env.PORT || 8543)

// Each pass launches its own browser. On a small box it is worth running them one at
// a time (`node verify.mjs sm:webkit`); with no argument every pass runs in sequence.
const ALL = ['sm:chromium', 'sm:webkit', 'ext:chromium', 'ext:webkit',
  'live:chromium', 'live:webkit', 'denied:chromium', 'denied:webkit']
const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'))
const passes = wanted.length ? wanted : (process.argv.includes('--sm') ? ALL.slice(0, 2) : ALL)
for (const p of passes) {
  if (!ALL.includes(p)) { console.error(`unknown pass '${p}'. one of: ${ALL.join(' ')}`); process.exit(2) }
}

if (!fs.existsSync('cert/cert.pem')) {
  fs.mkdirSync('cert', {recursive: true})
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout cert/key.pem -out cert/cert.pem ' +
    '-days 365 -subj "/CN=localhost" -addext ' +
    '"subjectAltName=DNS:localhost,DNS:ar.example.test,IP:127.0.0.1"', {stdio: 'ignore'})
}

const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm'}
const server = https.createServer(
  {key: fs.readFileSync('cert/key.pem'), cert: fs.readFileSync('cert/cert.pem')},
  (req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0])
    const f = path.join(root, u === '/' ? 'index.html' : u)
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end()
    }
    res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'})
    fs.createReadStream(f).pipe(res)
  })
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

let failures = 0
const results = []
const check = (label, ok, detail) => {
  results.push({label, ok, detail})
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? '  <- ' + detail : ''}`)
}

const UA = {
  chromium: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/151.0.0.0 Mobile Safari/537.36',
  webkit: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
}
const HOST = {chromium: `https://ar.example.test:${PORT}/`, webkit: `https://127.0.0.1:${PORT}/`}
const LAUNCH = {
  chromium: {args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--host-resolver-rules=MAP ar.example.test 127.0.0.1', '--ignore-certificate-errors']},
  webkit: {},
}
// Headless Chrome's fake camera advertises no facingMode, so relax `exact` constraints.
const SHIM = `(() => {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => {
    const r = JSON.parse(JSON.stringify(c))
    if (r.video && typeof r.video === 'object') { delete r.video.facingMode; delete r.video.deviceId }
    return orig(r)
  }
})()`

const newPage = async (browser, engine, {permissions = ['camera']} = {}) => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, permissions, userAgent: UA[engine],
    viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true,
  })
  await ctx.addInitScript(SHIM)
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('    pageerror:', String(e).slice(0, 200)))
  return page
}

// ------------------------------------------------------------ pass 1

async function stateMachine(engine, launcher) {
  console.log(`\n########## state machine — ${engine}`)
  const browser = await launcher.launch(LAUNCH[engine])
  const page = await newPage(browser, engine)
  await page.goto(HOST[engine] + 'statemachine-test.html', {waitUntil: 'load'})
  const h = (fn, ...a) => page.evaluate(([f, args]) =>
    window.__h[f](...args), [fn, a])
  const vis = () => page.evaluate(() => window.__h.visible())
  // The coaching layer fades in/out over 220ms; give it time before asking what the
  // user can see, otherwise we assert against a half-finished transition.
  const visSettled = async () => { await page.waitForTimeout(350); return vis() }

  // 1. gate is the first thing on screen, and it is opaque (no black screen).
  let v = await vis()
  check('gate shown before start', v.gate === true && await h('phase') === 'gate')
  check('coaching hidden at gate', v.coach === false)

  // 2. a tap before anything is ready gets an answer, not silence.
  await h('rejectTap')
  v = await vis()
  check('pre-start tap answered with a toast', v.toast === true && v.toastText.length > 0,
    JSON.stringify(v.toastText))

  // 3. the tap starts things.
  await page.click('[data-tux="gate"]')
  check('tap leaves the gate', await h('phase') === 'starting', await h('phase'))
  check('gate hidden after tap', (await vis()).gate === false)

  // 4. camera up but SLAM not converged -> coaching, immediately (no debounce here:
  //    there is nothing to flicker between).
  await h('camera', 'hasVideo')
  check('hasVideo -> coaching phase', await h('phase') === 'coaching', await h('phase'))
  v = await visSettled()
  check('hasVideo -> coaching visible', v.coach === true)
  check('coaching copy asks the user to move the phone',
    v.coachTitle.includes('ゆっくり動かして'), v.coachTitle)
  check('still not ready for taps', (await h('ready')) === false)
  await h('rejectTap')
  check('tap during coaching answered', (await vis()).toast === true)

  // 5. tracking converges.
  await h('tracking', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)                       // hideDelayMs = 250
  check('NORMAL -> ready', await h('phase') === 'ready' && (await h('ready')) === true)
  v = await visSettled()
  check('coaching hidden once ready', v.coach === false)

  // 6. THE flicker case: a 200ms dip must not put anything on screen.
  await h('tracking', 'LIMITED', 'TOO_MUCH_MOTION')
  await page.waitForTimeout(200)
  const duringDip = {phase: await h('phase'), coach: (await vis()).coach}
  await h('tracking', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)
  check('a 200ms tracking dip shows nothing (debounce)',
    duringDip.phase === 'ready' && duringDip.coach === false, JSON.stringify(duringDip))
  check('still ready after the dip', await h('phase') === 'ready')

  // 7. a real loss does surface, with copy matched to the reason.
  await h('tracking', 'LIMITED', 'TOO_MUCH_MOTION')
  await page.waitForTimeout(900)                       // showDelayMs = 600
  check('sustained loss -> recovering', await h('phase') === 'recovering', await h('phase'))
  v = await visSettled()
  check('recovery banner visible', v.coach === true)
  check('recovery copy names the loss', v.coachTitle.includes('見失'), v.coachTitle)
  check('recovery copy is reason-specific (TOO_MUCH_MOTION)',
    v.coachBody.includes('速すぎ'), v.coachBody)
  check('taps rejected while recovering', (await h('ready')) === false)

  await h('tracking', 'LIMITED', 'NOT_ENOUGH_TEXTURE')
  await page.waitForTimeout(200)
  check('reason copy switches with the reason (NOT_ENOUGH_TEXTURE)',
    (await vis()).coachBody.includes('模様'), (await vis()).coachBody)

  // 8. recovery.
  await h('tracking', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)
  check('recovers back to ready', await h('phase') === 'ready')

  // 9. the frame-result path carries the same signal as the event path.
  await h('frame', 'NOT_AVAILABLE', 'RELOCALIZING')
  await page.waitForTimeout(900)
  check('onUpdate fallback also drives the state machine',
    await h('phase') === 'recovering', await h('phase'))
  check('RELOCALIZING copy tells the user where to point',
    (await vis()).coachBody.includes('戻して'), (await vis()).coachBody)
  await h('frame', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)

  // 10. a hit-test miss while tracking is fine is a different message.
  await h('miss')
  v = await vis()
  check('hit-test miss gets its own toast', v.toast === true && v.toastText.includes('読み取れません'),
    v.toastText)

  await page.screenshot({path: `shot-sm-recovering-${engine}.png`})

  // 11. camera denial is terminal and explains the way back.
  await h('camera', 'failed', 'DENY_CAMERA')
  v = await vis()
  check('DENY_CAMERA -> error screen', await h('phase') === 'error' && v.error === true)
  check('error names the camera permission', v.errorTitle.includes('カメラ'), v.errorTitle)
  const wantsIos = engine === 'webkit'
  check(`error copy is ${wantsIos ? 'iOS' : 'Android'}-specific`,
    wantsIos ? v.errorBody.includes('ぁあ') : v.errorBody.includes('鍵アイコン'), v.errorBody)
  check('error screen offers a retry', await page.isVisible('[data-tux="error-retry"]'))
  await h('tracking', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)
  check('error is not silently cleared by good tracking', await h('phase') === 'error')
  await page.screenshot({path: `shot-sm-denied-${engine}.png`})

  await browser.close()
}

// ------------------------------------------------------------ pass 2

async function liveEngine(engine, launcher) {
  console.log(`\n########## live engine — ${engine}`)
  const browser = await launcher.launch(LAUNCH[engine])
  const page = await newPage(browser, engine)
  const external = []
  page.on('request', r => {
    const host = new URL(r.url()).host
    if (host !== `ar.example.test:${PORT}` && host !== `127.0.0.1:${PORT}` &&
        !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url())
  })
  await page.goto(HOST[engine], {waitUntil: 'load'})
  await page.waitForTimeout(2500)

  const phase = () => page.evaluate(() => window.__trackingUx.state.phase)
  const diag = () => page.evaluate(() => window.__diag)

  // The gate must hold the engine back: XR8.run() has not been called yet.
  check('gate holds before the tap', await phase() === 'gate')
  check('engine not started before the tap', (await diag()).events.length === 0,
    JSON.stringify((await diag()).events))

  // A tap on the canvas before start must not place anything.
  await page.evaluate(() => document.getElementById('camerafeed').click())
  check('canvas tap before start places nothing', (await diag()).placed === 0)

  await page.click('[data-tux="gate"]')
  await page.waitForTimeout(1500)
  check('engine starts on the tap', (await diag()).events.some(e => e.includes('XR8 loaded')),
    JSON.stringify((await diag()).events))

  // Camera comes up; coaching should be on screen well before tracking converges.
  await page.waitForFunction(() => window.__trackingUx.state.phase !== 'starting', null,
    {timeout: 25000}).catch(() => {})
  const afterCamera = await phase()
  check('camera up -> coaching (not a blank screen)',
    afterCamera === 'coaching' || afterCamera === 'ready', afterCamera)

  // Hammer the canvas the whole time. Nothing may be placed while not ready, and
  // every rejected tap must have produced a toast.
  const before = await diag()
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => document.getElementById('camerafeed').click())
    await page.waitForTimeout(120)
  }
  const wasReady = await page.evaluate(() => window.__trackingUx.isReady())
  const after = await diag()
  if (!wasReady) {
    check('taps while not ready place nothing', after.placed === before.placed)
    check('taps while not ready are all answered',
      after.rejected >= before.rejected + 5, `${before.rejected} -> ${after.rejected}`)
  } else {
    check('taps while ready are not rejected', after.rejected === before.rejected)
  }

  // Let SLAM run against the synthetic feed and record where it got to.
  await page.waitForTimeout(20000)
  const finalPhase = await phase()
  const d = await diag()
  const uxLog = await page.evaluate(() => window.__trackingUx.state.log)
  console.log('    phase reached: ' + finalPhase)
  console.log('    ux log: ' + JSON.stringify(uxLog.filter(l =>
    /phase=|camera=|tracking |exception/.test(l)).slice(0, 14), null, 0))
  console.log('    diag: ' + JSON.stringify({placed: d.placed, rejected: d.rejected,
    missed: d.missed, errors: d.errors}))
  check('no unhandled engine errors', d.errors.length === 0, JSON.stringify(d.errors))
  check('no external network requests', external.length === 0,
    JSON.stringify([...new Set(external)]))
  await page.screenshot({path: `shot-live-${engine}.png`})
  await browser.close()
}

// 'auto' mode with the two official packages present. The point is that this module
// stops drawing what CoachingOverlay and XRExtras.Loading already draw, and keeps
// drawing what they do not.
async function externalMode(engine, launcher) {
  console.log(`\n########## external packages present — ${engine}`)
  const browser = await launcher.launch(LAUNCH[engine])
  const page = await newPage(browser, engine)
  await page.goto(HOST[engine] + 'statemachine-test.html?external=1', {waitUntil: 'load'})
  const h = (fn, ...a) => page.evaluate(([f, args]) => window.__h[f](...args), [fn, a])
  const vis = () => page.evaluate(() => window.__h.visible())
  const visSettled = async () => { await page.waitForTimeout(350); return vis() }

  const modes = await h('modes')
  check("'auto' resolves to the official packages",
    modes.coaching === 'external' && modes.permissionUi === 'external', JSON.stringify(modes))

  await page.click('[data-tux="gate"]')
  await h('camera', 'hasVideo')
  check('our coaching banner is held back before the first tracking event',
    (await h('suppressed')) === '1')
  check('and stays hidden', (await visSettled()).coach === false)

  // CoachingOverlay's one state: LIMITED + INITIALIZING. Ours must stay off.
  await h('tracking', 'LIMITED', 'INITIALIZING')
  await page.waitForTimeout(900)
  check('LIMITED+INITIALIZING is left to CoachingOverlay', (await h('suppressed')) === '1')
  check('no duplicate prompt during init', (await visSettled()).coach === false)
  check('taps are still gated during init', (await h('ready')) === false)
  await h('rejectTap')
  check('and a tap during init is still answered', (await vis()).toast === true)

  // The state CoachingOverlay does not cover: a loss after tracking was up.
  await h('tracking', 'NORMAL', 'UNSPECIFIED')
  await page.waitForTimeout(400)
  check('ready once NORMAL', await h('phase') === 'ready')
  await h('tracking', 'LIMITED', 'RELOCALIZING')
  await page.waitForTimeout(900)
  check('a post-init loss is ours to show', (await h('suppressed')) === '0')
  const v = await visSettled()
  check('recovery banner visible where CoachingOverlay shows nothing', v.coach === true)
  check('recovery copy is the RELOCALIZING one', v.coachBody.includes('戻して'), v.coachBody)

  // A bad pre-init state that is not INITIALIZING is also ours.
  await page.reload({waitUntil: 'load'})
  await page.click('[data-tux="gate"]')
  await h('camera', 'hasVideo')
  await h('tracking', 'LIMITED', 'NOT_ENOUGH_TEXTURE')
  await page.waitForTimeout(900)
  check('a pre-init state CoachingOverlay ignores is ours', (await h('suppressed')) === '0')
  check('and it is on screen', (await visSettled()).coach === true)

  // Permission screens belong to XRExtras.Loading here.
  await h('camera', 'failed', 'DENY_CAMERA')
  await page.waitForTimeout(200)
  check('permission failure still blocks taps', await h('phase') === 'error')
  check('but our error screen stays out of the way', (await vis()).error === false)

  await page.screenshot({path: `shot-ext-${engine}.png`})
  await browser.close()
}

// Same page, same engine, but the camera is refused. This is the path that used to
// end in a black screen; it has to end on the recovery screen instead.
async function liveDenied(engine, launcher) {
  console.log(`\n########## live engine, camera denied — ${engine}`)
  const opts = engine === 'chromium'
    ? {args: LAUNCH.chromium.args.filter(a => a !== '--use-fake-ui-for-media-stream')}
    : LAUNCH[engine]
  const browser = await launcher.launch(opts)
  const page = await newPage(browser, engine, {permissions: []})
  await page.goto(HOST[engine], {waitUntil: 'load'})
  await page.waitForTimeout(1500)
  await page.click('[data-tux="gate"]')
  await page.waitForFunction(() => window.__trackingUx.state.phase === 'error', null,
    {timeout: 20000}).catch(() => {})
  const phase = await page.evaluate(() => window.__trackingUx.state.phase)
  check('denied camera -> error screen, not a black screen', phase === 'error', phase)
  check('error screen is visible', await page.isVisible('[data-tux="error"]'))
  const title = await page.textContent('[data-tux="error-title"]')
  const body = await page.textContent('[data-tux="error-body"]')
  check('error screen explains the way back', body.includes('許可'), body)
  console.log('    shown: ' + title + ' / ' + body)
  console.log('    ux log: ' + JSON.stringify((await page.evaluate(() =>
    window.__trackingUx.state.log)).filter(l => /phase=|camera=|exception/.test(l))))
  await page.screenshot({path: `shot-denied-${engine}.png`})
  await browser.close()
}

// ------------------------------------------------------------ run

const LAUNCHER = {chromium, webkit}
const RUN = {sm: stateMachine, ext: externalMode, live: liveEngine, denied: liveDenied}
const hasEngine = fs.existsSync('web/external/xr/xr.js')

for (const pass of passes) {
  const [kind, engine] = pass.split(':')
  if (kind !== 'sm' && kind !== 'ext' && !hasEngine) {
    console.log(`\n(skipping ${pass}: no engine binary — run ./setup.sh first)`)
    continue
  }
  await RUN[kind](engine, LAUNCHER[engine])
}

server.close()
console.log(`\n########## ${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
