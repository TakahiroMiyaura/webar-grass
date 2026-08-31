// Headless check of the camera field-of-view fix (MYAA-23, plan A).
//
// Two separate questions, and only the first is fully answerable without a phone:
//
//   1. Does the renegotiation do what it claims? Chromium's fake camera offers 16:9
//      native formats, so the engine's `{width:{exact:960},height:{exact:720}}` comes
//      back as `crop-and-scale` - the exact failure this fix exists for. The module
//      has to turn that into an uncropped format, and `?fov=off` has to leave it alone.
//   2. Does changing the video size mid-session break the engine? The renegotiation
//      happens after XR8.run(), so the render path, the pipeline and hitTest all have
//      to survive it. Headless can settle the rendering half. Whether the SLAM's camera
//      intrinsics follow the new frame size is a question for a real phone - a synthetic
//      feed has no parallax, so tracking accuracy is not measurable here either way.
//
// WebKit is in the run for the opposite reason: iOS never had the problem, and the
// module must not touch it.
import {chromium, webkit} from 'playwright'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ensureCert} from './dev-cert.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const HOST = 'ar.example.test'
const BASE = '/webar-grass/'

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ not built. run: npm run build')
  process.exit(1)
}

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
// The size constraints are left alone on purpose: they are the subject of this check.
const RELAX_CAMERA_CONSTRAINTS = `(() => {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => {
    const r = JSON.parse(JSON.stringify(c))
    if (r.video && typeof r.video === 'object') { delete r.video.facingMode; delete r.video.deviceId }
    return orig(r)
  }
})()`

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
}

const results = []

/** The live camera settings, read from the engine's own video element. */
const readFeed = (page) => page.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find((e) => e.videoWidth > 0)
  const t = v?.srcObject?.getVideoTracks?.()[0]
  const s = t ? t.getSettings() : null
  return {
    video: v ? {w: v.videoWidth, h: v.videoHeight} : null,
    settings: s && {width: s.width, height: s.height, resizeMode: s.resizeMode},
    report: window.__camera ?? null,
  }
})

const canvasContent = (page) => page.evaluate(() => {
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

async function start(ctx, origin) {
  const page = await ctx.newPage()
  await page.goto(origin, {waitUntil: 'load'})
  await page.waitForSelector('[data-tux="gate"]', {timeout: 60000})
  await page.click('[data-tux="gate"]')
  await page.waitForFunction(() => window.__diag?.ready === true, null, {timeout: 90000})
    .catch(() => {})
  // Long enough for the ladder to finish: applyConstraints renegotiates the source.
  await page.waitForTimeout(9000)
  return page
}

async function run(name, launcher, launchOpts, userAgent, origin, {expectWidening}) {
  const checks = []
  const check = (label, cond, detail) => {
    checks.push({label, ok: Boolean(cond)})
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
  }
  const browser = await launcher.launch(launchOpts)
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, permissions: ['camera'], userAgent,
    viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true,
  })
  await ctx.addInitScript(RELAX_CAMERA_CONSTRAINTS)

  console.log(`\n########## ${name}`)
  const page = await start(ctx, origin)
  const feed = await readFeed(page)
  const events = await page.evaluate(() => window.__diag.events)
  console.log(`  feed: ${JSON.stringify(feed.settings)}  video=${JSON.stringify(feed.video)}`)
  console.log(`  report: ${JSON.stringify(feed.report)}`)

  check('the module reported on the camera feed',
    Boolean(feed.report), JSON.stringify(feed.report))
  check('the outcome was recorded in __diag.events',
    events.some((e) => e.startsWith('camera-fov:')),
    JSON.stringify(events.filter((e) => /camera/.test(e))))

  if (expectWidening) {
    // The premise: without the fix, this browser hands back a cropped frame. If that
    // ever stops being true the fix is pointless here and the check should be revisited
    // rather than quietly passing.
    check('the engine default really is cropped on this browser',
      feed.report?.baseline?.resizeMode === 'crop-and-scale',
      `baseline=${JSON.stringify(feed.report?.baseline)}`)
    check('the feed ended up uncropped',
      feed.report?.state === 'widened' && feed.settings?.resizeMode === 'none',
      `state=${feed.report?.state} resizeMode=${feed.settings?.resizeMode}`)
    check('the video element followed the new size',
      feed.video?.w === feed.settings?.width && feed.video?.h === feed.settings?.height,
      `${JSON.stringify(feed.video)} vs ${JSON.stringify(feed.settings)}`)
  } else {
    // WebKit reports no resizeMode, so there is nothing to act on and nothing to break.
    check('the feed was left alone', feed.report?.state === 'skipped',
      `state=${feed.report?.state} -- ${feed.report?.why}`)
  }

  // The point of question 2: the renegotiation happens with the session already running.
  const after = await page.evaluate(() => ({
    ready: window.__diag.ready, frames: window.__diag.frames,
    errors: window.__diag.errors,
  }))
  const framesBefore = after.frames
  await page.waitForTimeout(1500)
  const framesNow = await page.evaluate(() => window.__diag.frames)
  const content = await canvasContent(page)

  check('the session survived the renegotiation', after.ready && after.errors.length === 0,
    JSON.stringify(after.errors))
  check('frames are still being produced', framesNow > framesBefore,
    `${framesBefore} -> ${framesNow}`)
  check('the camera feed is still on screen', content > 0.05,
    `${(content * 100).toFixed(1)}% non-black`)

  // hitTest reads the engine's world model, which is downstream of the camera frame.
  await page.evaluate(() => { window.__forceTrackingReady = true })
  await page.mouse.click(206, 640)
  await page.waitForTimeout(400)
  const placed = await page.evaluate(() => window.__diag.placed + window.__diag.missed)
  check('taps still reach the placement path after the feed changed', placed > 0,
    `placed+missed=${placed}`)

  // The panel is the on-device A/B, so both buttons have to actually move the feed.
  if (expectWidening) {
    await page.evaluate(() => document.getElementById('diag-toggle').click())
    await page.waitForSelector('[data-diag="restore"]', {timeout: 10000})
    await page.click('[data-diag="restore"]')
    await page.waitForTimeout(2500)
    const restored = await readFeed(page)
    check('the panel can put the engine default back',
      restored.settings?.width === feed.report?.baseline?.width &&
      restored.settings?.height === feed.report?.baseline?.height,
      JSON.stringify(restored.settings))

    await page.click('[data-diag="widen"]')
    await page.waitForTimeout(2500)
    const rewidened = await readFeed(page)
    check('the panel can widen it again',
      rewidened.settings?.resizeMode === 'none',
      JSON.stringify(rewidened.settings))
    check('the session is still alive after both flips',
      (await page.evaluate(() => window.__diag.errors.length)) === 0)
  }

  // The other half of the on-device comparison: the switch has to be a real off switch.
  if (expectWidening) {
    const off = await start(ctx, `${origin}?fov=off`)
    const offFeed = await readFeed(off)
    console.log(`  ?fov=off feed: ${JSON.stringify(offFeed.settings)}`)
    check('?fov=off leaves the engine feed untouched',
      offFeed.report?.state === 'off' && offFeed.settings?.width === 960 &&
      offFeed.settings?.height === 720,
      `state=${offFeed.report?.state} ${JSON.stringify(offFeed.settings)}`)
    await off.close()
  }

  await browser.close()
  const failed = checks.filter((c) => !c.ok).length
  results.push({name, total: checks.length, failed})
}

try {
  await run('chromium-android', chromium, {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  }, UA.android, `https://${HOST}:${PORT}${BASE}`, {expectWidening: true})

  await run('webkit-ios', webkit, {}, UA.ios, `https://127.0.0.1:${PORT}${BASE}`,
    {expectWidening: false})
} finally {
  server.close()
}

console.log('\n================ summary')
let bad = 0
for (const r of results) {
  console.log(`  ${r.name}: ${r.total - r.failed}/${r.total} passed`)
  bad += r.failed
}
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed')
process.exit(bad ? 1 : 0)
