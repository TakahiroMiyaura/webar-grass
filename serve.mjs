// HTTPS dev server for the sample. iOS Safari refuses getUserMedia on plain HTTP
// for anything but localhost, so a self-signed cert is required for LAN testing.
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execSync} from 'node:child_process'

const PORT = Number(process.env.PORT || 8443)
const root = path.resolve('web')
const certDir = path.resolve('cert')
if (!fs.existsSync(path.join(certDir, 'cert.pem'))) {
  fs.mkdirSync(certDir, {recursive: true})
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4').map(i => i.address)
  const san = ['DNS:localhost', ...ips.map(ip => 'IP:' + ip)].join(',')
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${certDir}/key.pem" ` +
    `-out "${certDir}/cert.pem" -days 365 -subj "/CN=localhost" -addext "subjectAltName=${san}"`,
    {stdio: 'ignore'})
  console.log('generated self-signed cert for: ' + san)
}
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm'}

https.createServer({key: fs.readFileSync(certDir + '/key.pem'), cert: fs.readFileSync(certDir + '/cert.pem')},
  (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(root, url === '/' ? 'index.html' : url)
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found')
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      // Required so the engine can use SharedArrayBuffer / threaded wasm.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
  }).listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
    console.log('serving ./web over HTTPS on port ' + PORT)
    console.log('  https://localhost:' + PORT + '/')
    ips.forEach(ip => console.log('  https://' + ip + ':' + PORT + '/   <- open this on the phone'))
    console.log('\nThe cert is self-signed: the phone will show a warning; tap through it once.')
  })
