// Verifies the in-app browser guard (web/openin.js).
//
// For each user agent we assert two things that matter for the QR hand-off:
//   1. whether the guard overlay appears at all, and
//   2. whether the engine was started — a blocked webview must never get that far,
//      because XR8.run() there fires a camera prompt that yields the black screen we
//      are avoiding. "Started" is read from app.js's own log rather than from a
//      getUserMedia spy: headless WebKit does not treat http://127.0.0.1 as a secure
//      context, so the camera call is absent there even in plain Safari.
// Each blocked case then dismisses the overlay and asserts the engine does start.
import {webkit, chromium} from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('web')
const types = {'.html': 'text/html', '.js': 'text/javascript'}
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0])
  const f = path.join(root, u === '/' ? 'index.html' : u)
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end()
  }
  res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'})
  fs.createReadStream(f).pipe(res)
})
await new Promise(r => server.listen(8480, '127.0.0.1', r))
const URL_ = 'http://127.0.0.1:8480/'

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
  chromium: await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']}),
}

let failures = 0
for (const c of CASES) {
  const ctx = await browsers[c.engine].newContext({
    userAgent: c.ua, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true,
  })
  const page = await ctx.newPage()
  await page.goto(URL_, {waitUntil: 'load'})
  await page.waitForTimeout(2500)

  const engineStarted = () => page.evaluate(
    () => !!(window.__diag && window.__diag.events.some(e => e.startsWith('XR8 loaded'))))

  const guard = await page.locator('#inapp-guard').count() > 0
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
