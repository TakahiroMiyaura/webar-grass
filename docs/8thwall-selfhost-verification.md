# 8th Wall セルフホスト検証サンプル（平面 → タップ → キューブ設置）

MYAA-19 の検証用。8th Wall の配布エンジンバイナリを**アカウントなし・app key なし・CDN なし**で
セルフホストし、SLAM で床を推定してタップした位置にキューブを置くだけの最小構成。

## 構成

```
web/
  index.html          エンジンを ./external/xr/xr.js から読む（CDN 参照ゼロ）
  app.js              three.js シーン + hitTest + タップ設置
  vendor/             three.js 0.183.2（setup.sh が配置）
  external/xr/        8th Wall エンジンバイナリ（fetch-engine.sh が配置。リポジトリには含めない）
serve.mjs             自己署名 HTTPS 開発サーバ（iOS Safari のカメラは HTTPS 必須）
verify.mjs            Playwright による headless 検証（Chromium / WebKit）
verify-noheaders.mjs  COOP/COEP なしでも動くかの検証
verify-pages.mjs      GitHub Pages 想定（ヘッダなし + サブパス配信）の検証
.github/workflows/    GitHub Pages への自動デプロイ
```

エンジンバイナリは XR Engine License Agreement 配下のため**このサンプルには同梱していない**。
`fetch-engine.sh` が npm の `@8thwall/engine-binary` から取得する。

## 使い方

```bash
./setup.sh          # three.js とエンジンバイナリを取得
node serve.mjs      # https://<LAN IP>:8443/ が表示される
```

スマホを同じ Wi-Fi につなぎ、表示された `https://<LAN IP>:8443/` を開く。
自己署名証明書なので警告が出る → 一度だけ「詳細」→「アクセスする」。
カメラ許可 → ゆっくり左右に動かす → 緑のリングが床に出たらタップでキューブが置かれる。

## headless 検証

```bash
npm i playwright && npx playwright install --with-deps chromium webkit
node verify.mjs
```

Chromium（Android UA）と WebKit（iOS UA）でパイプラインを起動し、
外部ネットワークリクエストが 0 件であること、hitTest が結果を返すことを確認する。

## ライセンス表記について

`web/index.html` の先頭コメントと `web/external/xr/xr.js` の先頭に
Niantic Spatial の著作権表示とライセンス全文が入っている。これで
[8thwall.org/docs/open-source](https://8thwall.org/docs/open-source) の
compliance 要件（Option A）を満たす。**xr.js を改変・minify し直さないこと。**

## 公開サーバへのデプロイ（GitHub Pages）

**COOP / COEP は不要**であることを実測で確認済みなので、レスポンスヘッダを触れない
静的ホスティング（GitHub Pages 等）でそのまま動く。パスも全て相対なので
`https://<user>.github.io/<repo>/` のようなサブパス配信で問題ない。

1. この一式を public リポジトリに push（`main` ブランチ）
2. リポジトリの **Settings > Pages > Source** を **GitHub Actions** にする
3. 以降 `main` への push で `.github/workflows/deploy.yml` が動き、
   `setup.sh` が three.js とエンジンバイナリを取得して `web/` を公開する

エンジンバイナリと three.js は `.gitignore` 済みで、**CI が毎回 npm から取得する**。
リポジトリにバイナリを置かないので、ライセンス的にも配布経路が npm 公式のまま保たれる。
デプロイされる中身は約 8.3 MB（`xr.js` + `xr-slam.js` + three.js + アプリ本体）。
world tracking に不要な face / semantics（約 24 MB）はワークフローが落としている。

QR コードは公開 URL が決まってから作ればよい:

```bash
npx qrcode "https://<user>.github.io/<repo>/" -o qr.png
```

### 他のホスティングを選ぶ場合

Cloudflare Pages / Netlify / Vercel でも同じ `web/` をそのまま置けば動く。
これらは `_headers` や `vercel.json` でレスポンスヘッダを足せるので、
将来 COOP / COEP を付けて SharedArrayBuffer 経路の性能を比べたくなった場合はそちらが向く。
