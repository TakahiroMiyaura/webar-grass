// Decodes the generated QR back to a URL and checks it round-trips. A QR that encodes
// the wrong URL looks identical to a correct one, so this is the only real check.
import fs from 'node:fs'
import {PNG} from 'pngjs'
import jsQR from 'jsqr'

const expected = process.argv[2]
if (!expected) throw new Error('usage: node tools/verify-qr.mjs <expected-url>')

const png = PNG.sync.read(fs.readFileSync('dist/qr.png'))
const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
if (!res) { console.error('FAIL: no QR code could be decoded from dist/qr.png'); process.exit(1) }

const ok = res.data === expected
console.log(`${ok ? 'PASS' : 'FAIL'}  decoded: ${res.data}`)
if (!ok) console.error(`      expected: ${expected}`)

// The hand-out page must point at the same place the QR does.
const share = fs.readFileSync('dist/share.html', 'utf8')
const linked = share.includes(`href="${expected}"`)
console.log(`${linked ? 'PASS' : 'FAIL'}  share.html links the same URL`)

process.exit(ok && linked ? 0 : 1)
