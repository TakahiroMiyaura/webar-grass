// Quick visual check: renders bench.html once and screenshots it. Complements
// Quick visual check of the grass field (SwiftShader, so slow but correct).
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
const p=await (await b.newContext({viewport:{width:412,height:760},deviceScaleFactor:1})).newPage()
p.on('pageerror',e=>console.log('PAGEERROR:',String(e).slice(0,400)))
p.on('console',m=>{if(m.type()==='error')console.log('[err]',m.text().slice(0,400))})
const q = process.argv[2] || 'n=60&dpr=1&feed=1&shadows=1'
await p.goto(`${O}/bench.html?${q}`,{waitUntil:'load'})
await p.waitForFunction(()=>window.__ready===true,null,{timeout:120000})
await p.waitForTimeout(6000)
fs.mkdirSync('build',{recursive:true})
await p.screenshot({path:'build/shot.png'})
console.log(JSON.stringify(await p.evaluate(()=>window.__bench)))
await b.close(); server.close()
