# webar-grass

スマートフォンのブラウザだけで動く WebAR コンテンツ。
カメラを向けて面を検出し、**画面をタップするとその場所に草が生えてくる**。

アプリのインストールは不要で、QR コードから開いてそのまま体験できることを目指している。

> **Status: 準備中**
> リポジトリの土台と公開パイプラインまでが出来ている段階。
> 現在 `web/` に入っているのは、タップした位置にキューブを置く**検証用の最小サンプル**で、
> 草の描画・演出はこれから実装する。

## なぜ WebXR ではないのか

iOS Safari は 2026 年 8 月時点でも handheld の WebXR AR（`immersive-ar`）に対応していない。
iOS / Android の両方を 1 コードベースで賄うため、WebXR Device API ではなく
**自前 SLAM を持つ 8th Wall のエンジンバイナリ**をセルフホストして使っている。

| | 使うもの | ライセンス | SLAM |
|---|---|---|---|
| OSS 版フレームワーク | `8thwall/8thwall` の `packages/engine` | MIT | なし |
| **配布エンジンバイナリ** | npm `@8thwall/engine-binary` | XR Engine License Agreement | **あり** |

world tracking が必要なので後者を使う。**アカウント・app key・アクティベーション通信は不要**で、
起動から tracking までの間に外部ドメインへのリクエストは発生しない（検証済み）。
詳細は [`docs/8thwall-selfhost-verification.md`](docs/8thwall-selfhost-verification.md) を参照。

## 技術スタック

- **8th Wall エンジンバイナリ**（セルフホスト） — カメラ映像 + SLAM + hit test
- **three.js** — 描画
- **GitHub Pages + Actions** — 公開とデプロイ

エンジンバイナリと three.js は**リポジトリに含めず**、`setup.sh` / CI が npm から取得する
（`.gitignore` 済み）。配布経路が公式のまま保たれるので、public リポジトリでもライセンス上安全。

## ローカルで動かす

カメラの取得には secure context が要るため、開発サーバも HTTPS で立てる。

```bash
./setup.sh        # three.js と 8th Wall エンジンバイナリを取得
node serve.mjs    # https://<LAN IP>:8443/ が表示される
```

スマホを同じ Wi-Fi につなぎ、表示された URL を開く。自己署名証明書の警告は一度だけ許可する。
カメラ許可 → ゆっくり左右に動かす → 面が取れたらタップ。

## 公開する

公開先は **GitHub Pages + GitHub Actions**。`main` への push で `web/` が自動デプロイされる。

初回のみ **Settings > Pages > Source** を **GitHub Actions** に設定する必要がある
（設定前の push はワークフローが失敗する）。

**COOP / COEP は不要**であることを実測で確認済みなので、レスポンスヘッダを触れない
静的ホスティングでそのまま動く。パスはすべて相対で、`https://<user>.github.io/<repo>/` の
ようなサブパス配信でも問題ない。この 2 点が「Pages で十分」と判断した理由で、
Cloudflare Pages / Netlify に移るのは `_headers` でヘッダを足したくなったときだけでよい。

### ワークフローがやること

1. `setup.sh` で three.js と エンジンバイナリを npm から取得
2. world tracking に使わない face / semantics（約 24 MB）を削除 → 実体は約 **8.3 MB**
3. エンジンの `LICENSE` が残っていることを確認（欠けるとライセンス違反になるため）
4. `tools/make-qr.mjs` で **QR コードと配布ページを生成**
5. Pages へデプロイ
6. **公開された URL を実際に叩いて疎通確認**（smoke ジョブ）

6 は「デプロイは成功したのに端末では黒画面」を防ぐためのもの。`index.html` / `app.js` /
`openin.js` / `xr.js` / `xr-slam.js` / `share.html` / `qr.png` が 200 で返り、
Content-Type が期待どおりかを検証する。1 つでも外れると赤くなる。

### QR コードと配布ページ

QR は**リポジトリにコミットせず、デプロイのたびに生成する**。URL は
`GITHUB_REPOSITORY` から導出しているので、リポジトリ名を変えても QR がずれない。

デプロイ後、配布ページは公開 URL の `/share.html` にある。QR・URL・操作手順・
アプリ内ブラウザの注意書きが 1 枚に載っていて、そのまま印刷できる。
QR 画像単体が要る場合は `/qr.png`（PNG）と `/qr.svg`（ベクタ、印刷向け）。

手元で確認する場合:

```bash
npm install
node tools/make-qr.mjs https://example.github.io/webar-grass/
node tools/verify-qr.mjs https://example.github.io/webar-grass/   # QR を復号して URL を照合
```

### アプリ内ブラウザ対策

QR は LINE や Instagram から読まれることが多く、その場合リンクはアプリ内の webview で開く。
そこでは `getUserMedia` が通らない、あるいは通っても SLAM にフレームが届かず、
**原因の分からない黒画面**になる。

`web/openin.js` が UA を見て以下を検出し、エンジンを起動する前に案内を出す。
カメラ許可のダイアログを出さずに止めるのが要点。

- LINE / Instagram / Facebook / X / TikTok / WeChat / Slack
- iOS で Safari・Chrome・Firefox・Edge のいずれでもない webview
- Android の `; wv)` 付き webview

脱出方法は環境ごとに変えている。LINE は `?openExternalBrowser=1` が効くのでそれを使い、
Android は `intent://` で Chrome を直接開く。iOS は `x-safari-https://` を試すが、
Instagram と Facebook はこれを塞いでいるため、**「右下の … から外部ブラウザで開く」**という
文言と URL コピーに倒している。誤検出に備えて「このまま試す」も置いてある。

検証は `node verify-inapp.mjs`（Playwright で 8 種の UA を実行し、
アプリ内ブラウザではエンジンが起動しないこと・通常のブラウザでは起動することを確認する）。

### MIME とキャッシュについて

GitHub Pages の実測値。**`.wasm` の Content-Type 事故は起きない**。

| | Content-Type | 備考 |
|---|---|---|
| `.js` | `application/javascript` | gzip で配信される（エンジン 6.5 MB → 約 2.2 MB） |
| `.wasm` | `application/wasm` | 正しい。なお現行のエンジンに `.wasm` 単体ファイルは無い |
| `.glb` | `model/gltf-binary` | 草アセットを入れるときもそのまま置ける |

- 圧縮は **gzip のみで brotli は無い**が、設定は不要で自動的にかかる
- `Cache-Control` は全ファイル `max-age=600` 固定で**変更できない**。
  10 分を過ぎた再訪では約 2.6 MB を取り直す。ここが問題になったときが
  Cloudflare Pages へ移る判断ポイント

## 構成

```
web/
  index.html          エンジンを ./external/xr/xr.js から読む（CDN 参照ゼロ）
  app.js              three.js シーン + hitTest + タップ設置
  vendor/             three.js（setup.sh が配置。git 管理外）
  external/xr/        8th Wall エンジンバイナリ（fetch-engine.sh が配置。git 管理外）
  openin.js           アプリ内ブラウザ検出と外部ブラウザへの誘導
  share.html          QR 配布ページ（デプロイ時に生成。git 管理外）
  qr.png / qr.svg     QR 画像（デプロイ時に生成。git 管理外）
setup.sh              three.js + エンジンバイナリの取得
fetch-engine.sh       エンジンバイナリのみ取得
serve.mjs             自己署名 HTTPS の開発サーバ
tools/make-qr.mjs     公開 URL から QR と配布ページを生成
tools/verify-qr.mjs   生成した QR を復号して URL を照合
verify*.mjs           Playwright による headless 検証（Chromium / WebKit）
.github/workflows/    GitHub Pages への自動デプロイと疎通確認
docs/                 セルフホスト検証の記録
```

## ライセンス

このリポジトリのソースコードは [MIT License](LICENSE)。

同梱していない第三者コンポーネント（8th Wall エンジンバイナリ / three.js）の扱いは
[NOTICE](NOTICE) を参照。**エンジンバイナリを改変・再 minify しないこと。**
