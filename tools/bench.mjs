// Headless run of web/bench.html.
//
// What this can establish: that the shaders compile, that the field really is one
// draw call, the triangle/instance counts, and how cost SCALES with tuft count and
// pixel ratio. What it cannot establish: absolute fps on a phone. There is no GPU
// here -- Chromium falls back to SwiftShader, a software rasteriser -- so absolute
// numbers are meaningless and only the ratios are reported.
import {chromium} from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

// Serves dist/, not src/: the page under test has to be the built bundle, because that
// is what a phone loads. Run `npm run build` first (npm run bench does).
const root = path.resolve('dist')
const types = {'.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'}
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0])
  const f = path.join(root, u === '/' ? 'index.html' : u)
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('not found')
  }
  res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'})
  fs.createReadStream(f).pipe(res)
})
// Port 0: other runs on this box may already hold the usual ones.
if (!fs.existsSync(root)) {
  console.error('dist/ not found. run: npm run build')
  process.exit(1)
}
await new Promise(r => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']})
const ctx = await browser.newContext({viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true,
  deviceScaleFactor: 1})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()) })

await page.goto(`${ORIGIN}/bench.html?n=100&dpr=1.5`, {waitUntil: 'load'})
await page.waitForFunction(() => window.__ready === true, null, {timeout: 60000})

// WebGL-level facts, which are device-independent and are the real deliverable here.
const facts = await page.evaluate(async () => {
  await window.__measure(30)
  const gl = document.getElementById('c').getContext('webgl2') || document.getElementById('c').getContext('webgl')
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    ...window.__bench,
  }
})
console.log(`GL renderer      ${facts.renderer}`)
console.log(`draw calls       ${facts.calls}      <- camera-feed blit + grass + contact shadows`)
console.log(`triangles        ${facts.triangles}`)
console.log(`live tufts       ${facts.live}`)
if (errors.length) console.log('\nERRORS:\n  ' + errors.join('\n  '))

// Relative scaling with pixel count. This is the claim the pixel-ratio advice
// rests on: if frame time tracks fragments rather than instances, then lowering
// DPR is the biggest available lever and geometry work is second-order.
// SwiftShader is a software rasteriser, so only the ratios mean anything -- and
// they are noisy, hence the long samples.
console.log('\nframe time vs pixel count, 100 tufts')
console.log('  DPR | pixels(rel) | frame time(rel)')
const base = {}
for (const dpr of [1, 1.5, 2]) {
  await page.evaluate(([n, d]) => window.__setState({n, dpr: d}), [100, dpr])
  await page.evaluate(() => window.__measure(30))
  const s = await page.evaluate(() => window.__measure(150))
  base[dpr] = s.msMean
  console.log(`  ${dpr.toFixed(1)} | ${(dpr * dpr).toFixed(2).padStart(11)}x | ${(s.msMean / base[1]).toFixed(2).padStart(15)}x`)
}

console.log('\nframe time vs tuft count, DPR 1.0')
console.log('  tufts | count(rel) | frame time(rel)')
const b0 = {}
for (const n of [100, 300, 600]) {
  await page.evaluate(([nn]) => window.__setState({n: nn, dpr: 1}), [n])
  await page.evaluate(() => window.__measure(30))
  const s = await page.evaluate(() => window.__measure(120))
  b0[n] = s.msMean
  console.log(`  ${String(n).padStart(5)} | ${(n / 100).toFixed(2).padStart(10)}x | ${(s.msMean / b0[100]).toFixed(2).padStart(15)}x`)
}

console.log('\nfeature cost at 300 tufts, DPR 1.0 (frame time)')
for (const [label, patch] of [
  ['grass only            ', {n: 300, dpr: 1, shadows: false, feed: false}],
  ['grass + contact shadow', {n: 300, dpr: 1, shadows: true, feed: false}],
  ['grass + shadow + feed ', {n: 300, dpr: 1, shadows: true, feed: true}],
]) {
  await page.evaluate(p => window.__setState(p), patch)
  await page.evaluate(() => window.__measure(30))
  const s = await page.evaluate(() => window.__measure(120))
  const b = await page.evaluate(() => window.__bench)
  console.log(`  ${label}  ${s.msMean.toFixed(1).padStart(7)} ms   calls ${b.calls}`)
}

await page.evaluate(p => window.__setState(p), {n: 100, dpr: 1.5, shadows: true, feed: true})
await page.waitForTimeout(1200)
await page.screenshot({path: 'build/bench.png'})
console.log('\nscreenshot: build/bench.png')

await browser.close()
server.close()
