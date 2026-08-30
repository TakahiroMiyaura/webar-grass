// Headless verification of the self-hosted sample: loads it in Chromium (Android-ish)
// and WebKit (Safari engine), runs the SLAM pipeline against a synthetic camera,
// and reports every non-local network request the page makes.
import {chromium, webkit} from 'playwright'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {execSync} from 'node:child_process'

const root = path.resolve('web')
if (!fs.existsSync('cert/cert.pem')) {
  fs.mkdirSync('cert', {recursive: true})
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout cert/key.pem -out cert/cert.pem ' +
    '-days 365 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:ar.example.test,IP:127.0.0.1"', {stdio:'ignore'})
}
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.glb':'model/gltf-binary','.wasm':'application/wasm'}
const server = https.createServer({key:fs.readFileSync('cert/key.pem'),cert:fs.readFileSync('cert/cert.pem')},(req,res)=>{
  const u=decodeURIComponent(req.url.split('?')[0])
  const f=path.join(root,u==='/'?'index.html':u)
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end()}
  res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream',
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'cross-origin'})
  fs.createReadStream(f).pipe(res)
})
await new Promise(r=>server.listen(8443,'127.0.0.1',r))

// Headless Chrome's fake camera exposes no facingMode, so relax `exact` constraints.
const SHIM = `(() => {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => {
    const r = JSON.parse(JSON.stringify(c))
    if (r.video && typeof r.video === 'object') { delete r.video.facingMode; delete r.video.deviceId }
    return orig(r)
  }
})()`

const HOST = process.env.HOSTURL || 'https://ar.example.test:8443/'
async function run(name, launcher, opts, ua, host) {
  const external = []
  const browser = await launcher.launch(opts)
  const ctx = await browser.newContext({ignoreHTTPSErrors:true, permissions:['camera'], userAgent:ua,
    viewport:{width:412,height:915}, isMobile:true, hasTouch:true})
  await ctx.addInitScript(SHIM)
  const page = await ctx.newPage()
  page.on('request', r => { const h=new URL(r.url()).host
    if (h!=='ar.example.test:8443' && h!=='127.0.0.1:8443' && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.method()+' '+r.url()) })
  page.on('pageerror', e => console.log('  pageerror:', String(e).slice(0,300)))
  page.on('console', m => console.log('  console['+m.type()+']:', m.text().slice(0,250)))
  page.on('requestfailed', r => console.log('  FAILED:', r.url().slice(0,150), r.failure() && r.failure().errorText))
  page.on('response', r => { if (r.status()>=400) console.log('  HTTP', r.status(), r.url().slice(0,150)) })
  await page.goto(host, {waitUntil:'load'})
  // The experience now starts on a tap (see web/tracking-ux.js), so nothing runs
  // until the gate is dismissed.
  await page.waitForSelector('[data-tux="gate"]')
  await page.click('[data-tux="gate"]')
  // Taps are refused until tracking reports NORMAL, so wait for that rather than a
  // fixed sleep. If it never arrives the run still reports what it got to.
  await page.waitForFunction(() => window.__trackingUx && window.__trackingUx.isReady(),
    null, {timeout: 40000}).catch(() => console.log('  (tracking never reached NORMAL)'))
  await page.waitForTimeout(2000)
  // Exercise the tap -> hitTest -> place path.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => document.getElementById('camerafeed').click())
    await page.waitForTimeout(500)
  }
  const d = (await page.evaluate(() => window.__diag)) || {events:['(no __diag: module never ran)'],hitTests:[],errors:[],placed:0}
  const uxPhase = await page.evaluate(() => window.__trackingUx && window.__trackingUx.state.phase)
  const shot = `shot-${name}.png`
  await page.screenshot({path: shot})
  console.log(`\n########## ${name}`)
  d.events.forEach(e=>console.log('  ev: '+e))
  console.log('  hitTest samples: ' + JSON.stringify(d.hitTests.slice(0,2)))
  console.log('  tracking-ux phase: ' + uxPhase)
  console.log('  cubes placed: ' + d.placed + '  (taps rejected: ' + (d.rejected ?? 0) +
    ', hit-test misses: ' + (d.missed ?? 0) + ')')
  console.log('  errors: ' + (d.errors.length ? JSON.stringify(d.errors) : '(none)'))
  console.log('  EXTERNAL REQUESTS: ' + (external.length ? JSON.stringify([...new Set(external)]) : '(none)'))
  console.log('  screenshot: ' + shot)
  await browser.close()
}

await run('chromium-android', chromium, {args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
  '--host-resolver-rules=MAP ar.example.test 127.0.0.1','--ignore-certificate-errors']},
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  'https://ar.example.test:8443/')
await run('webkit-ios', webkit, {},
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  'https://127.0.0.1:8443/')
server.close()
