// Headless check of the production build.
//
// Serves dist/ over HTTPS with *no* extra response headers - deliberately, because that
// is exactly what GitHub Pages gives us, and it is what proves the app does not depend
// on COOP/COEP. Runs the real pipeline in Chromium (Android UA) and WebKit (the engine
// behind iOS Safari) against Playwright's synthetic camera.
//
// Everything is served from a /<repo>/ prefix rather than the domain root, because that
// is how a GitHub Pages project site publishes. An absolute path that slipped into the
// HTML or a script would work at the root and 404 here.
//
// This is not a substitute for a real phone: the synthetic feed has no parallax, so it
// exercises the code path without saying anything about SLAM accuracy. What it does
// settle is "does the page load, start the camera, render, hit test, and place" and
// "does it phone home".
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

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ not built. run: npm run build')
  process.exit(1)
}
fs.mkdirSync(shots, {recursive: true})

const {key, cert} = ensureCert()
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.map': 'application/json',
}
// The subpath a project site is published under.
const BASE = '/webar-grass/'

const server = https.createServer(
  {key: fs.readFileSync(key), cert: fs.readFileSync(cert)},
  (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    if (!url.startsWith(BASE)) {
      // Anything asked for outside the subpath is a bug in the build, not a miss.
      console.log(`  off-base request: ${url}`)
      res.writeHead(404)
      return res.end('outside base path')
    }
    const rel = url.slice(BASE.length) || 'index.html'
    const file = path.join(dist, rel)
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'})
    fs.createReadStream(file).pipe(res)
  })
// Ephemeral port, so a stale server left by an interrupted run cannot block this one.
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
  const external = []
  const failures = []
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
  page.on('pageerror', (e) => failures.push(`pageerror: ${String(e).slice(0, 200)}`))
  page.on('crash', () => failures.push('page crashed'))
  page.on('requestfailed', (r) => failures.push(`requestfailed: ${r.url().slice(0, 120)}`))
  page.on('response', (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`) })

  await page.goto(origin, {waitUntil: 'load'})

  // The session only starts from a user gesture, because iOS requires one for the
  // motion permission - so the check has to press the button like a person would.
  await page.click('[data-tux="gate"]', {timeout: 60000})
    .catch((e) => failures.push(`start gate never appeared: ${e.message.split('\n')[0]}`))

  // The engine needs a while to fetch the slam chunk and converge on the fake feed.
  await page.waitForFunction(() => window.__diag?.ready === true, null, {timeout: 90000})
    .catch((e) => failures.push(`scene never reached onStart: ${e.message.split('\n')[0]}`))
  await page.waitForTimeout(15000)

  for (let i = 0; i < 6; i++) {
    await page.mouse.click(206, 500)
    await page.waitForTimeout(400)
  }

  const diag = await page.evaluate(() => window.__diag)
  const engine = await page.evaluate(() => (window.XR8 ? {
    version: XR8.version(),
    compatible: XR8.XrDevice.isDeviceBrowserCompatible(),
    reasons: XR8.XrDevice.incompatibleReasons(),
    compatibilities: XR8.XrDevice.compatibilities(),
  } : null))
  // Sample the drawing buffer: an all-black canvas means the camera feed never landed.
  const canvasHasContent = await page.evaluate(() => {
    const src = document.getElementById('camerafeed')
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    const ctx = c.getContext('2d')
    ctx.drawImage(src, 0, 0, 64, 64)
    const {data} = ctx.getImageData(0, 0, 64, 64)
    let nonBlack = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack++
    }
    return nonBlack / (64 * 64)
  })

  await page.screenshot({path: path.join(shots, `${name}.png`)})

  // Second load, this time stopping at the gate with the environment panel open: that
  // is the screen someone on an unsupported device would actually be looking at.
  await page.goto(`${origin}?diag=1`, {waitUntil: 'load'})
  await page.waitForTimeout(8000)
  await page.screenshot({path: path.join(shots, `${name}-diagnostics.png`)})

  await browser.close()

  const result = {
    name, engine, diag, canvasHasContent,
    external: [...new Set(external)],
    failures: [...new Set(failures)],
  }
  results.push(result)

  console.log(`\n########## ${name}`)
  console.log(`  XR8 version      : ${engine?.version ?? '(not loaded)'}`)
  console.log(`  compatible       : ${engine?.compatible} ${engine?.reasons?.length ? JSON.stringify(engine.reasons) : ''}`)
  console.log(`  compatibilities  : ${JSON.stringify(engine?.compatibilities)}`)
  console.log(`  scene ready      : ${diag?.ready}`)
  console.log(`  frames rendered  : ${diag?.frames}`)
  console.log(`  objects placed   : ${diag?.placed}  types=${JSON.stringify(diag?.hitTypes)}`)
  console.log(`  canvas non-black : ${(canvasHasContent * 100).toFixed(1)}%`)
  console.log(`  scene errors     : ${diag?.errors?.length ? JSON.stringify(diag.errors) : '(none)'}`)
  console.log(`  page failures    : ${result.failures.length ? JSON.stringify(result.failures) : '(none)'}`)
  console.log(`  EXTERNAL REQUESTS: ${result.external.length ? JSON.stringify(result.external) : '(none)'}`)
}

try {
await run('chromium-android', chromium, {
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--ignore-certificate-errors',
  ],
}, UA.android, `https://${HOST}:${PORT}${BASE}`)

await run('webkit-ios', webkit, {}, UA.ios, `https://127.0.0.1:${PORT}${BASE}`)
} finally {
  server.close()
}

fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(results, null, 2))

const ok = results.every((r) =>
  r.engine && r.diag?.ready && r.diag.frames > 0 && r.canvasHasContent > 0.05 &&
  r.external.length === 0)
console.log(`\n${ok ? 'PASS' : 'FAIL'}: camera feed + 3D render on both engines from a ` +
  `${BASE} subpath, no external requests`)
process.exit(ok ? 0 : 1)
