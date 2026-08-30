// Isolates the contact-shadow cost. Shadows are blended full-coverage discs, so
// unlike the grass cards they cannot skip any of their own fill -- worth knowing
// what they charge before leaving them on by default.
import {chromium} from 'playwright'
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
// Serves dist/, not src/: the page under test has to be the built bundle, because that
// is what a phone loads. Run `npm run build` first (npm run bench does).
const root = path.resolve('dist')
const types = {'.html':'text/html','.js':'text/javascript','.png':'image/png','.glb':'model/gltf-binary','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'}
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(root,u==='/'?'index.html':u)
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end()}
  res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)})
if (!fs.existsSync(root)) {
  console.error('dist/ not found. run: npm run build')
  process.exit(1)
}
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const O=`http://127.0.0.1:${server.address().port}`
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
const p=await (await b.newContext({viewport:{width:412,height:915},deviceScaleFactor:1})).newPage()
p.on('pageerror',e=>console.log('PAGEERROR:',String(e).slice(0,300)))
await p.goto(`${O}/bench.html?n=300&dpr=1&feed=0&shadows=0`,{waitUntil:'load'})
await p.waitForFunction(()=>window.__ready===true,null,{timeout:120000})
const run = async (patch) => {
  await p.evaluate(x => window.__setState(x), patch)
  await p.evaluate(() => window.__measure(30))
  return (await p.evaluate(() => window.__measure(120))).msMean
}
const off = await run({n:300, dpr:1, shadows:false, feed:false})
const on  = await run({n:300, dpr:1, shadows:true,  feed:false})
console.log(`300 tufts, DPR 1.0, no camera-feed blit`)
console.log(`  shadows off  ${off.toFixed(1)} ms`)
console.log(`  shadows on   ${on.toFixed(1)} ms   (${(on/off).toFixed(2)}x)`)
await p.evaluate(x => window.__setState(x), {n:60, dpr:1, shadows:true, feed:true})
await p.waitForTimeout(3000)
fs.mkdirSync('build', {recursive:true})
await p.screenshot({path:'build/shot-shadows.png'})
console.log('screenshot: build/shot-shadows.png')
await b.close(); server.close()
