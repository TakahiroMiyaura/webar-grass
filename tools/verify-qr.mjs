// Decodes the generated QR back to a URL and checks it round-trips. A QR that encodes
// the wrong URL looks identical to a correct one, so this is the only real check.
//
// With no argument the expected URL is derived the same way tools/make-qr.mjs derives
// it, so the deploy job can run this straight after generating -- pass a URL to check
// against something else:  node tools/verify-qr.mjs https://example.com/
import fs from 'node:fs'
import {PNG} from 'pngjs'
import jsQR from 'jsqr'
import {publishedUrl} from './published-url.mjs'

const expected = publishedUrl(process.argv[2])

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
