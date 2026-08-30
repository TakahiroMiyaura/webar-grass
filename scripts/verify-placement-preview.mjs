// Renders the known-geometry placement page and asserts that a tap aimed at a table top
// resolves to the table's height rather than the floor's, then saves the image.
//
// This is the closest thing to a correctness proof available without a phone: the scene
// has a floor at y=0 and a table at y=0.75, and the hitTest stub reports those surfaces
// exactly. It says nothing about whether real SLAM finds them.
import {chromium} from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const shots = path.join(root, 'screenshots')

if (!fs.existsSync(path.join(dist, 'placement-preview.html'))) {
  console.error('dist/ not built. run: npm run build')
  process.exit(1)
}
fs.mkdirSync(shots, {recursive: true})

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.ktx2': 'image/ktx2', '.map': 'application/json',
}
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(dist, url === '/' ? 'index.html' : url)
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    return res.end('not found')
  }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'})
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

// SwiftShader: there is no GPU here, so this checks geometry and transforms, not speed.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({viewport: {width: 900, height: 600}})
const failures = []
page.on('pageerror', (e) => failures.push(`pageerror: ${String(e).slice(0, 200)}`))
page.on('requestfailed', (r) => failures.push(`requestfailed: ${r.url().slice(0, 120)}`))
page.on('response', (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`) })

await page.goto(`http://127.0.0.1:${PORT}/placement-preview.html`, {waitUntil: 'load'})
await page.waitForFunction(() => window.__preview, null, {timeout: 30000})
await page.waitForTimeout(1500)   // let the grass finish growing

const p = await page.evaluate(() => window.__preview)
const frames = await page.evaluate(() => window.__frames)

let bad = 0
const check = (label, cond, detail) => {
  if (!cond) bad++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`)
}

console.log(`  aimed: table=${p.aimedAtTable} floor=${p.aimedAtFloor}; ` +
  `placed: table=${p.onTable} floor=${p.onFloor}; instances=${p.instances}`)

check('the scene rendered', frames > 30, `frames=${frames}`)
check('every aimed tap produced a placement',
  p.onTable === p.aimedAtTable && p.onFloor === p.aimedAtFloor,
  `table ${p.onTable}/${p.aimedAtTable}, floor ${p.onFloor}/${p.aimedAtFloor}`)
check('the table taps were carried by hitTest, not by the floor plane',
  p.usedHitTestOnTable === p.onTable, `${p.usedHitTestOnTable}/${p.onTable} used plan B`)
check('every tap on the table resolved to the table top (0.75m), not the floor',
  p.tableHeights.every((y) => Math.abs(y - 0.75) < 1e-3),
  `range ${Math.min(...p.tableHeights)}..${Math.max(...p.tableHeights)}`)
check('every tap on the floor resolved to the floor (0m)',
  p.floorHeights.every((y) => Math.abs(y) < 1e-3),
  `range ${Math.min(...p.floorHeights)}..${Math.max(...p.floorHeights)}`)
check('the two surfaces stay separated, not averaged into one plane',
  Math.min(...p.tableHeights) - Math.max(...p.floorHeights) > 0.7)
check('the planted tufts stand upright on their surface',
  p.tilts.length > 0 && p.tilts.every((a) => a < 0.35),
  `${p.tilts.length} instances, max tilt ${Math.max(...p.tilts).toFixed(3)} rad`)
check('no page errors', failures.length === 0, JSON.stringify(failures).slice(0, 300))

const shot = path.join(shots, 'placement-preview.png')
await page.screenshot({path: shot})
console.log(`  screenshot: ${path.relative(root, shot)}`)

await browser.close()
server.close()
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall preview checks passed')
process.exit(bad ? 1 : 0)
