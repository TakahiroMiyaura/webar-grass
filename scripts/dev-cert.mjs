// Generates a self-signed cert for the dev server.
//
// getUserMedia only runs in a secure context, and "secure" excludes plain http:// on a
// LAN address - so testing on a real phone over Wi-Fi needs HTTPS even locally. The SAN
// list includes every LAN IPv4 of this machine, because a cert for localhost alone makes
// the phone reject the connection outright instead of offering the "proceed anyway" tap.
//
// Android Chrome accepts this after tapping through the warning. iOS Safari often will
// not hand over the camera on an untrusted cert - see README for the tunnel route.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.cert')
const key = path.join(dir, 'key.pem')
const cert = path.join(dir, 'cert.pem')

export const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)

export const ensureCert = () => {
  if (fs.existsSync(key) && fs.existsSync(cert)) return {key, cert}
  fs.mkdirSync(dir, {recursive: true})
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '365',
    '-subj', '/CN=localhost', '-addext', `subjectAltName=${san}`,
  ], {stdio: 'ignore'})
  console.log(`[dev-cert] generated .cert/ for ${san}`)
  return {key, cert}
}

if (import.meta.url === `file://${process.argv[1]}`) ensureCert()
