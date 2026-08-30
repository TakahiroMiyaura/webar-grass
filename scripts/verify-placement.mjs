// Headless check of the placement feature (MYAA-16) against the real engine.
//
// Serves the production build with no extra response headers, starts the pipeline in
// Chromium (Android UA) and WebKit (the engine behind iOS Safari) against Playwright's
// synthetic camera, and asserts the behaviour the tap path is accountable for.
//
// What it cannot judge is accuracy: a synthetic feed has no real geometry, so "does the
// grass land on the actual table" stays a device question. scripts/verify-placement-
// preview.mjs covers the geometry side against surfaces whose height is known.
import {chromium, webkit} from 'playwright'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ensureCert} from './dev-cert.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const shots = path.join(root, 'screenshots')
// An unrelated hostname: if the engine were domain-locked, this is where it would fail.
const HOST = 'ar.example.test'
// The subpath a project site is published under.
const BASE = '/webar-grass/'

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ not built. run: npm run build')
  process.exit(1)
}
fs.mkdirSync(shots, {recursive: true})

const {key, cert} = ensureCert()
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.ktx2': 'image/ktx2', '.map': 'application/json',
}
const server = https.createServer(
  {key: fs.readFileSync(key), cert: fs.readFileSync(cert)},
  (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    if (!url.startsWith(BASE)) { res.writeHead(404); return res.end('outside base path') }
    const file = path.join(dist, url.slice(BASE.length) || 'index.html')
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'})
    fs.createReadStream(file).pipe(res)
  })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

// Headless Chrome's fake camera reports no facingMode, so an `exact` constraint fails.
const RELAX_CAMERA_CONSTRAINTS = `(() => {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => {
    const r = JSON.parse(JSON.stringify(c))
    if (r.video && typeof r.video === 'object') { delete r.video.facingMode; delete r.video.deviceId }
    return orig(r)
  }
})()`

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
}

const results = []

async function run(name, launcher, launchOpts, userAgent, origin) {
  const checks = []
  const check = (label, cond, detail) => {
    checks.push({label, ok: Boolean(cond)})
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  }
  const external = []
  const pageErrors = []
  const browser = await launcher.launch(launchOpts)
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, permissions: ['camera'], userAgent,
    viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true,
  })
  await ctx.addInitScript(RELAX_CAMERA_CONSTRAINTS)
  const page = await ctx.newPage()

  const localHosts = new Set([`${HOST}:${PORT}`, `127.0.0.1:${PORT}`])
  page.on('request', (r) => {
    const {host} = new URL(r.url())
    if (!localHosts.has(host) && !/^(data|blob):/.test(r.url())) external.push(r.url())
  })
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${String(e).slice(0, 200)}`))
  page.on('requestfailed', (r) => pageErrors.push(`requestfailed: ${r.url().slice(0, 120)}`))
  page.on('response', (r) => {
    if (r.status() >= 400) pageErrors.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`)
  })

  console.log(`\n########## ${name}`)
  await page.goto(origin, {waitUntil: 'load'})

  // tracking-ux holds XR8.run() behind a start tap so iOS sees a user gesture before the
  // permission prompts (MYAA-15). Nothing loads until that tap happens.
  await page.waitForSelector('[data-tux="gate"]', {timeout: 60000})
  const eventsBeforeTap = await page.evaluate(() => window.__diag.events.length)
  check('the start gate held the engine back until tapped', eventsBeforeTap === 0,
    `events before tap: ${eventsBeforeTap}`)
  await page.click('[data-tux="gate"]')

  await page.waitForFunction(() => window.__diag?.ready === true, null, {timeout: 90000})
    .catch((e) => pageErrors.push(`scene never reached onStart: ${e.message.split('\n')[0]}`))
  await page.waitForTimeout(12000)

  check('the placement layer is live', await page.evaluate(() => Boolean(window.__placement)))
  check('the grass field finished loading',
    await page.evaluate(() => Boolean(window.__placement?.grass)))
  check('the engine started without cross-origin isolation (GitHub Pages compatible)',
    (await page.evaluate(() => window.crossOriginIsolated)) === false)

  // Both sides of the readiness gate, driven explicitly: a synthetic feed never reaches
  // NORMAL, so neither state would be reachable by waiting.
  await page.evaluate(() => { window.__forceTrackingReady = false })
  await page.waitForTimeout(400)
  const before = await page.evaluate(() => ({
    rejected: window.__diag.rejected, placed: window.__diag.placed,
  }))
  await page.mouse.click(206, 600)
  await page.waitForTimeout(300)
  const gate = await page.evaluate((b) => ({
    rejected: window.__diag.rejected - b.rejected,
    placed: window.__diag.placed - b.placed,
    // The tap must not look ignored: something has to appear on screen.
    toast: (document.querySelector('[data-tux="toast"]')?.textContent ?? '').length > 0,
  }), before)
  check('a tap before tracking is ready is refused, not silently dropped',
    gate.rejected === 1 && gate.placed === 0 && gate.toast, JSON.stringify(gate))
  await page.evaluate(() => { window.__forceTrackingReady = true })

  // From here on, drive the resolver with a camera we control, so the geometry is
  // knowable. This is the part a synthetic feed cannot supply.
  const geo = await page.evaluate(() => {
    const {resolver, camera} = window.__placement
    const THREE = window.THREE
    // Pose the camera like a phone held at 1.6m, tilted down at the floor ahead.
    camera.position.set(0, 1.6, 0)
    camera.lookAt(new THREE.Vector3(0, 0, -2))
    camera.updateMatrixWorld(true)
    resolver.setMode('PLANE')
    return [[206, 460], [90, 620], [330, 620], [206, 700]].map(([x, y]) => {
      const r = resolver.resolve(x, y, 412, 915)
      return r.chosen
        ? {x: r.chosen.point.x, y: r.chosen.point.y, z: r.chosen.point.z, source: r.chosen.source}
        : null
    })
  })
  check('every tap in the lower half produced a placement', geo.every(Boolean))
  if (geo.every(Boolean)) {
    check('the ray follows the finger: left and right taps land apart',
      geo[1].x < -0.15 && geo[2].x > 0.15,
      `x=${geo[1].x.toFixed(2)} / ${geo[2].x.toFixed(2)}`)
    check('a lower tap lands nearer the user than a higher one',
      geo[3].z > geo[0].z, `z=${geo[3].z.toFixed(2)} vs ${geo[0].z.toFixed(2)}`)
    check('placements sit on the reference plane',
      geo.every((q) => Math.abs(q.y) < 0.06))
    check('no NaN reached the scene graph',
      geo.every((q) => [q.x, q.y, q.z].every(Number.isFinite)))
  }

  // What does the engine's hitTest actually return here? This is the number the on-device
  // comparison is meant to produce; recording it headless gives a baseline.
  const hitInfo = await page.evaluate(() => {
    const {resolver} = window.__placement
    resolver.setMode('HITTEST')
    const seen = []
    for (let i = 0; i < 6; i++) {
      const r = resolver.resolve(206, 500 + i * 40, 412, 915)
      seen.push(r.b
        ? {type: r.b.type, y: Number(r.b.y.toFixed(3)), spread: Number(r.b.spread.toFixed(3))}
        : null)
    }
    resolver.setMode('AUTO')
    return seen
  })
  console.log(`  hitTest readings: ${JSON.stringify(hitInfo)}`)
  check('hitTest was reached without throwing', hitInfo.length === 6)

  // AUTO must never hand a bad hitTest reading straight through.
  const guard = await page.evaluate(() => {
    const {resolver} = window.__placement
    const real = resolver.hitTestFn
    const stub = (type, y) => () => [{
      type, position: {x: 0, y, z: -1}, rotation: {x: 0, y: 0, z: 0, w: 0}, distance: 1.5,
    }]
    resolver.hitTestFn = stub('FEATURE_POINT', -4)
    const below = resolver.resolve(206, 700, 412, 915)
    resolver.hitTestFn = stub('ESTIMATED_SURFACE', 0.75)
    const table = resolver.resolve(206, 700, 412, 915)
    resolver.hitTestFn = real
    return {
      belowSource: below.chosen?.source, belowWhy: below.why,
      tableSource: table.chosen?.source, tableY: table.chosen?.point.y,
    }
  })
  check('a below-floor hitTest reading is rejected in AUTO',
    guard.belowSource === 'PLANE', guard.belowWhy)
  check('a table-height hitTest reading is used in AUTO',
    guard.tableSource === 'HITTEST' && Math.abs(guard.tableY - 0.75) < 1e-6,
    `${guard.tableSource} y=${guard.tableY}`)

  // A real tap through the canvas, to prove the listener path works end to end.
  await page.evaluate(() => { window.__placement.grass?.reset(); window.__diag.placed = 0 })
  await page.mouse.click(206, 640)
  await page.waitForTimeout(250)
  const single = await page.evaluate(() => ({
    placed: window.__diag.placed, live: window.__placement.grass?.liveCount ?? 0,
  }))
  check('one tap plants exactly one clump', single.placed === 1 && single.live > 0,
    JSON.stringify(single))

  // A real touch tap emits pointerdown, touchstart AND a compatibility click. Repeated,
  // because the double-fire this guards against only showed up about half the time.
  await page.evaluate(() => { window.__diag.placed = 0 })
  for (let i = 0; i < 8; i++) {
    await page.touchscreen.tap(120 + i * 20, 620)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(400)
  const taps = await page.evaluate(() => window.__diag.placed)
  check('8 touch taps plant exactly 8 clumps (no synthetic-click double fire)',
    taps === 8, `planted=${taps}`)

  // Grass is anchored in world space: moving the camera must not move it.
  const anchored = await page.evaluate(async () => {
    const {grass, camera} = window.__placement
    const THREE = window.THREE
    const read = () => {
      const m = new THREE.Matrix4()
      const out = []
      for (let i = 0; i < grass.mesh.count; i++) {
        grass.mesh.getMatrixAt(i, m)
        out.push([m.elements[12], m.elements[13], m.elements[14]])
      }
      return out
    }
    const beforePos = read()
    camera.position.set(0.8, 1.4, 0.6)
    camera.lookAt(new THREE.Vector3(0, 0, -2))
    camera.updateMatrixWorld(true)
    await new Promise((r) => setTimeout(r, 500))
    const afterPos = read()
    return beforePos.length > 0 && beforePos.every((p, i) =>
      p.every((v, k) => Math.abs(v - afterPos[i][k]) < 1e-6))
  })
  check('planted grass stays anchored when the camera moves (6DoF)', anchored)

  // The capacity cap has to hold under sustained tapping.
  const capped = await page.evaluate(() => {
    const {grass, resolver} = window.__placement
    resolver.setMode('PLANE')
    for (let i = 0; i < 400; i++) {
      const r = resolver.resolve(100 + (i % 200), 600 + (i % 60), 412, 915)
      if (r.chosen) grass.plant(r.chosen.point, r.chosen.normal)
    }
    resolver.setMode('AUTO')
    return {live: grass.liveCount, capacity: grass.opts.capacity}
  })
  check('the tuft capacity holds under sustained tapping',
    capped.live <= capped.capacity, `live=${capped.live} capacity=${capped.capacity}`)

  // Calibration is how plan A is aimed at a table rather than the floor.
  const calib = await page.evaluate(() => {
    const {resolver} = window.__placement
    const real = resolver.hitTestFn
    resolver.hitTestFn = () => [{
      type: 'ESTIMATED_SURFACE', position: {x: 0, y: 0.72, z: -1},
      rotation: {x: 0, y: 0, z: 0, w: 0}, distance: 1.4,
    }]
    document.querySelector('[data-act="calibrate"]').click()
    const groundY = resolver.groundY
    resolver.hitTestFn = real
    const planeY = resolver.planeHit(206, 700, 412, 915)?.point?.y
    document.querySelector('[data-act="recenter"]').click()
    return {groundY, planeY, reset: resolver.groundY}
  })
  check('"use this surface" moves the reference plane',
    Math.abs(calib.groundY - 0.72) < 1e-6, `groundY=${calib.groundY}`)
  check('later taps use the calibrated height',
    Math.abs(calib.planeY - 0.72) < 1e-6, `y=${calib.planeY}`)
  check('recenter resets the reference plane', calib.reset === 0, JSON.stringify(calib))

  const ui = await page.evaluate(() => {
    document.querySelector('[data-mode="PLANE"]').click()
    const pressed = document.querySelector('[data-mode="PLANE"]').getAttribute('aria-pressed')
    const mode = window.__placement.resolver.mode
    document.querySelector('[data-mode="AUTO"]').click()
    return {pressed, mode, logged: window.__placement.panel.log.length,
      summary: (document.querySelector('.pp-summary')?.textContent ?? '').trim().length > 0}
  })
  check('the mode switch drives the resolver and reflects state',
    ui.pressed === 'true' && ui.mode === 'PLANE', JSON.stringify(ui))
  check('taps are recorded for the on-device A/B comparison', ui.logged > 0,
    `entries=${ui.logged}`)
  check('the measurement panel renders a summary', ui.summary)

  const diag = await page.evaluate(() => window.__diag)
  check('no runtime errors', diag.errors.length === 0 && pageErrors.length === 0,
    JSON.stringify([...diag.errors, ...pageErrors]).slice(0, 400))
  check('no external network requests', external.length === 0,
    JSON.stringify([...new Set(external)]).slice(0, 300))

  const shot = path.join(shots, `placement-${name}.png`)
  await page.screenshot({path: shot})
  console.log(`  screenshot: ${path.relative(root, shot)}`)

  await browser.close()
  const failed = checks.filter((c) => !c.ok).length
  results.push({name, total: checks.length, failed})
}

await run('chromium-android', chromium, {
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--ignore-certificate-errors'],
}, UA.android, `https://${HOST}:${PORT}${BASE}`)
await run('webkit-ios', webkit, {}, UA.ios, `https://127.0.0.1:${PORT}${BASE}`)
server.close()

console.log('\n================ summary')
let bad = 0
for (const r of results) {
  console.log(`  ${r.name}: ${r.total - r.failed}/${r.total} passed`)
  bad += r.failed
}
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed')
process.exit(bad ? 1 : 0)
