// Verifies the in-app browser guard (public/openin.js).
//
// For each user agent we assert two things that matter for the QR hand-off:
//   1. whether the guard overlay appears at all, and
//   2. whether the engine was started — a blocked webview must never get that far,
//      because XR8.run() there fires a camera prompt that yields the black screen we
//      are avoiding. "Started" is read from the app's own log (window.__diag.events)
//      rather than from a getUserMedia spy, which would be absent for reasons that have
//      nothing to do with the guard.
// Each blocked case then dismisses the overlay and asserts the engine does start.
//
// Since the tracking UX landed there is a second gate in front of the engine: the start
// tap (src/ui/tracking-ux.js). So "engine started" means "guard cleared AND gate tapped",
// and a blocked case is checked twice — once by leaving the gate alone, and once by
// force-tapping it through the overlay, which is the regression the composed condition
// in src/xr/engine.ts exists to prevent.
//
// Served over HTTPS, not plain HTTP: WebKit does not treat http://127.0.0.1 as a secure
// context, and the app refuses to start outside one — over HTTP every WebKit case would
// look "blocked" for a reason that has nothing to do with the guard.
import {webkit, chromium} from 'playwright'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {ensureCert} from './dev-cert.mjs'

const root = path.resolve('dist')
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json'}
const {key, cert} = ensureCert()
const server = https.createServer({key: fs.readFileSync(key), cert: fs.readFileSync(cert)}, (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0])
  const f = path.join(root, u === '/' ? 'index.html' : u)
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end()
  }
  res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'})
  fs.createReadStream(f).pipe(res)
})
// Ephemeral port so an interrupted run cannot block the next one.
await new Promise(r => server.listen(0, '127.0.0.1', r))
const URL_ = `https://127.0.0.1:${server.address().port}/`

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
const CASES = [
  {name: 'LINE (iOS)',        engine: 'webkit',   blocked: true,
   ua: IOS + 'Mobile/15E148 Line/14.5.0 NHNAvocado'},
  {name: 'Instagram (iOS)',   engine: 'webkit',   blocked: true,
   ua: IOS + 'Mobile/15E148 Instagram 331.0.0.37.90 (iPhone14,3; iOS 17_5; ja_JP)'},
  {name: 'Facebook (iOS)',    engine: 'webkit',   blocked: true,
   ua: IOS + 'Mobile/15E148 [FBAN/FBIOS;FBAV/456.0.0.34.108;]'},
  {name: 'LINE (Android)',    engine: 'chromium', blocked: true,
   ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36 Line/14.5.0'},
  {name: 'Android WebView',   engine: 'chromium', blocked: true,
   ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.0.0 Mobile Safari/537.36'},
  {name: 'Safari (iOS)',      engine: 'webkit',   blocked: false,
   ua: IOS + 'Version/17.5 Mobile/15E148 Safari/604.1'},
  {name: 'Chrome (Android)',  engine: 'chromium', blocked: false,
   ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36'},
  {name: 'Chrome iOS (CriOS)', engine: 'webkit',  blocked: false,
   ua: IOS + 'CriOS/128.0.6613.92 Mobile/15E148 Safari/604.1'},
]

const browsers = {
  webkit: await webkit.launch(),
  chromium: await chromium.launch({args: ['--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--ignore-certificate-errors']}),
}

let failures = 0
for (const c of CASES) {
  const ctx = await browsers[c.engine].newContext({
    userAgent: c.ua, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true, permissions: ['camera'],
  })
  const page = await ctx.newPage()
  await page.goto(URL_, {waitUntil: 'load'})
  await page.waitForTimeout(2500)

  const engineStarted = () => page.evaluate(
    () => !!(window.__diag && window.__diag.events.some(e => e.startsWith('XR8 loaded'))))

  const guard = await page.locator('#inapp-guard').count() > 0

  // Tap the start gate. In a blocked webview the guard covers it, so dispatch the click
  // at the element rather than at its coordinates — the assertion worth making is that
  // the engine refuses to start even if the gate is somehow triggered.
  await page.evaluate(() => document.querySelector('[data-tux="gate"]').click())
  await page.waitForTimeout(2500)
  const started = await engineStarted()
  const detected = await page.evaluate(() => window.__inAppBrowser || null)
  const btn = guard ? await page.locator('#ig-open').getAttribute('href').catch(() => null) : null

  // Blocked: overlay shown and engine held. Allowed: no overlay and engine running.
  const ok = guard === c.blocked && started === !c.blocked
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(20)} guard=${String(guard).padEnd(5)} ` +
    `engineStarted=${String(started).padEnd(5)} detected=${detected || '-'}`)
  if (btn) console.log(`        escape: ${btn.slice(0, 110)}`)

  // The escape hatch must not be a dead end: dismissing has to start the engine.
  if (guard) {
    await page.click('#ig-ignore')
    // The gate tap from before the dismissal still counts: app.js re-checks every
    // precondition on each signal rather than requiring them in a fixed order.
    await page.waitForTimeout(3000)
    const gone = await page.locator('#inapp-guard').count() === 0
    const nowStarted = await engineStarted()
    if (!(gone && nowStarted)) failures++
    console.log(`        ${gone && nowStarted ? 'PASS' : 'FAIL'}  after "このまま試す": ` +
      `overlay gone=${gone} engine started=${nowStarted}`)
  }
  await ctx.close()
}

await Promise.all(Object.values(browsers).map(b => b.close()))
server.close()
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall in-app guard checks passed')
process.exit(failures ? 1 : 0)
