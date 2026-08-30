// Generates the QR code and the printable hand-out page for the published URL.
//
// The URL is derived from the repository rather than hard-coded, and this runs inside
// the deploy job, so the QR can never drift from where the site actually lives. Run it
// locally with an explicit URL to preview:  node tools/make-qr.mjs https://example.com/
import QRCode from 'qrcode'
import fs from 'node:fs'
import path from 'node:path'

const outDir = 'dist'

function publishedUrl() {
  if (process.argv[2]) return process.argv[2]

  // GitHub Pages URL rules: a repo named "<owner>.github.io" publishes at the domain
  // root, anything else publishes under /<repo>/. A CNAME file overrides both.
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('pass a URL as the first argument, or set GITHUB_REPOSITORY')
  }
  const [owner, name] = repo.split('/')
  const cname = path.join(outDir, 'CNAME')
  if (fs.existsSync(cname)) {
    return 'https://' + fs.readFileSync(cname, 'utf8').trim().replace(/\/+$/, '') + '/'
  }
  const host = owner.toLowerCase() + '.github.io'
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`
}

const url = publishedUrl()

// Error correction M with a quiet zone: scans reliably off a phone screen and survives
// a logo or a fold if the sheet gets printed.
const opts = {errorCorrectionLevel: 'M', margin: 2, scale: 12,
  color: {dark: '#0d0f12', light: '#ffffff'}}

await QRCode.toFile(path.join(outDir, 'qr.png'), url, {...opts, type: 'png'})
const svg = await QRCode.toString(url, {...opts, type: 'svg'})
fs.writeFileSync(path.join(outDir, 'qr.svg'), svg)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Hand-out page. Kept deliberately dependency-free and printable: this is the thing
// that gets shown on a laptop or stuck on a wall next to the demo.
fs.writeFileSync(path.join(outDir, 'share.html'), `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>草を生やす WebAR — QR で開く</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f3f5f7; color:#0d0f12; padding:32px 20px;
    font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; }
  .card { background:#fff; border-radius:20px; padding:40px 36px; max-width:460px; width:100%;
    text-align:center; box-shadow:0 8px 40px rgba(13,15,18,.10); }
  h1 { font-size:23px; margin:0 0 6px; letter-spacing:.01em; }
  .sub { color:#5b6572; font-size:14px; margin:0 0 26px; }
  .qr { width:262px; height:262px; margin:0 auto 22px; display:block; }
  a.url { display:inline-block; font-size:13px; color:#1a63d8; word-break:break-all;
    text-decoration:none; margin-bottom:26px; }
  ol { text-align:left; font-size:14px; line-height:1.95; color:#333b45; margin:0; padding-left:1.3em; }
  .warn { margin-top:22px; padding:14px 16px; background:#fff6e5; border-radius:12px;
    font-size:13px; line-height:1.75; color:#6b4e12; text-align:left; }
  .warn b { color:#472f00; }
  footer { margin-top:24px; font-size:11px; color:#8a94a0; line-height:1.7; }
  @media print {
    body { background:#fff; padding:0; }
    .card { box-shadow:none; max-width:none; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>草を生やす WebAR</h1>
    <p class="sub">スマホのカメラで QR を読み取ってください</p>
    <img class="qr" src="./qr.svg" alt="${esc(url)} の QR コード" width="262" height="262">
    <a class="url" href="${esc(url)}">${esc(url)}</a>
    <ol>
      <li>QR を読み取ってページを開く</li>
      <li>カメラの使用を「許可」する</li>
      <li>床や机にカメラを向けて、ゆっくり左右に動かす</li>
      <li>画面をタップすると、その場所に草が生えます</li>
    </ol>
    <div class="warn">
      <b>LINE や Instagram から開いた場合は注意</b><br>
      アプリ内ブラウザではカメラが使えません。案内が出たら
      <b>Safari</b> / <b>Chrome</b> で開き直してください。
    </div>
    <footer>
      アプリのインストールは不要です。iOS は Safari、Android は Chrome を推奨。<br>
      うまく動かないときは、明るい場所で模様のある面を映してみてください。
    </footer>
  </div>
</body>
</html>
`)

const bytes = fs.statSync(path.join(outDir, 'qr.png')).size
console.log(`QR generated for: ${url}`)
console.log(`  ${outDir}/qr.png    (${bytes} bytes)`)
console.log(`  ${outDir}/qr.svg`)
console.log(`  ${outDir}/share.html`)
