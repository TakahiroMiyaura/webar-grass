# webar-grass

スマートフォンのブラウザだけで動く WebAR コンテンツ。
カメラを向けて面を検出し、**画面をタップするとその場所に草が生えてくる**。

アプリのインストールは不要で、QR コードから開いてそのまま体験できることを目指している。

> **Status: 準備中**
> 開発環境（Vite + TypeScript + three.js）と公開パイプラインまでが出来ている段階。
> タップで置かれるのはまだ緑の立方体で、草アセットと設置ロジックの作り込みはこれから。
> **iOS / Android 実機での確認は未実施。**

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
- **Vite + TypeScript** — ビルドと型
- **GitHub Pages + Actions** — 公開とデプロイ

エンジンバイナリは**リポジトリに含めず**、npm install / CI が npm から取得する
（`.gitignore` 済み）。配布経路が公式のまま保たれるので、public リポジトリでもライセンス上安全。

## セットアップ

Node.js 20 以上が必要です。

```bash
npm install
```

`npm install` の後処理で、8th Wall のランタイム 4 本が `node_modules` から
`public/external/` にコピーされます（`scripts/sync-vendor.mjs`）。合計 8.7 MB です。

これらは **リポジトリにコミットしません**（`.gitignore` 済み）。エンジンバイナリは
XR Engine License Agreement 配下で、npm の公式配布物をそのまま使うのが安全側だからです。
world tracking に不要な face / semantics（約 24 MB）は同時に除外しています。
必要になったら `FULL_ENGINE=1 npm install` で全部入ります。

## ローカル開発

```bash
npm run dev
```

起動すると LAN の IP を含む URL が表示されます。自己署名証明書は初回に自動生成され、
`.cert/` に置かれます（LAN の IPv4 が SAN に入るので、スマホから IP で開けます）。

```
➜  Phone:   https://192.168.0.24:5173/
➜  Local:   https://localhost:5173/
```

### なぜ HTTPS が必要か

`getUserMedia`（カメラ）は secure context でしか動きません。`localhost` は例外扱いですが、
LAN の IP は対象外なので、実機で開くには HTTPS が要ります。

### Android 実機での起動手順

自己署名証明書のままで動きます。

1. PC とスマホを同じ Wi-Fi につなぐ
2. `npm run dev` が表示した `https://<LAN IP>:5173/` を Chrome で開く
3. 証明書の警告が出る → 「詳細設定」→「\<IP\> にアクセスする（安全ではありません）」
4. カメラの許可 → 「はじめる」をタップ

Wi-Fi が使えない場合は USB 経由でも通せます。

```bash
adb reverse tcp:5173 tcp:5173
# スマホの Chrome で https://localhost:5173/ を開く
```

### iOS 実機での起動手順

**iOS Safari は、証明書が信頼できないオリジンにはカメラを渡しません。**
自己署名のままだと警告を通過してもカメラ取得で失敗するため、トンネルを使うのが確実です。

```bash
# ターミナル 1: HTTP で起動する（TLS はトンネル側が付ける）
HTTPS=0 npm run dev

# ターミナル 2
cloudflared tunnel --url http://localhost:5173
#   または
ngrok http 5173
```

表示された `https://....trycloudflare.com/` を iPhone の Safari で開きます。
正規の証明書が付くので、警告なしでカメラ許可のダイアログまで進みます。

1. Safari で トンネルの URL を開く
2. 「はじめる」をタップ
3. **「"モーションと画面の向き"へのアクセスを求めています」を許可**する
4. カメラの使用を許可する
5. スマホをゆっくり動かす → 面が取れるとリングが出る → タップで設置

手順 3 が iOS 固有の関門です。`DeviceMotionEvent.requestPermission()` は
ユーザー操作の中からしか呼べないため、「はじめる」ボタンを挟んでいます
（`src/ui/start-gate.ts`）。一度拒否すると再度聞かれないので、その場合は
**設定 → Safari → モーションと画面の向きのアクセス** から戻してください。

`mkcert` でローカル CA を作り、その CA を iPhone にインストールして信頼設定まで行えば
自己署名でも動きますが、端末側の手数が多いのでトンネルを推奨します。

## 非対応環境の確認

右上の **ⓘ** ボタン、または `?diag=1` を付けて開くと、判定結果のパネルが出ます。

- ブラウザ環境: HTTPS / getUserMedia / WebAssembly / WebGL / DeviceOrientation / アプリ内ブラウザ
- エンジン判定: `XR8.XrDevice.isDeviceBrowserCompatible()` と非対応理由
- 端末の推定値と生の JSON

動かせない条件が見つかった場合はパネルが自動で開き、「はじめる」は出しません。
エンジンが非対応と判定した端末には 8th Wall の landing page（QR 付き）が出ます。

LINE / Instagram などのアプリ内ブラウザは、判定はしますが停止はしません
（動く場合もあるため）。画面下に「Safari / Chrome で開き直してください」と出します。

## ビルドと公開

```bash
npm run build     # tsc --noEmit && vite build -> dist/
npm run preview   # dist/ を HTTPS で配信して確認
```

`dist/` は**そのまま静的ホスティングに置けます**。追加のレスポンスヘッダは不要です
（COOP / COEP は要りません。SharedArrayBuffer に依存していないことを確認済み）。
`base: './'` にしてあるので、`https://<user>.github.io/<repo>/` のようなサブパス配信でも動きます。

`main` への push で GitHub Actions（`.github/workflows/deploy.yml`）が
`npm ci && npm run build` を実行し、`dist/` を GitHub Pages にデプロイします。
初回のみ **Settings > Pages > Source** を **GitHub Actions** にしてください。

エンジンバイナリはリポジトリに無いので、**CI では `npm ci` が必須**です
（`postinstall` が `public/external/` を作ります）。デプロイされる実体は約 9 MB で、
world tracking に使わない face / semantics（約 24 MB）は `sync-vendor.mjs` が除外しています。

## 動作確認（headless）

```bash
npx playwright install --with-deps chromium webkit
npm run build
npm run verify
```

Chromium（Android UA）と WebKit（iOS Safari と同じエンジン）で実際にパイプラインを起動し、
以下を確認します。結果は `screenshots/` に出ます。

- カメラ映像が描画されているか（キャンバスの非黒率）
- three.js のシーンが回っているか（フレーム数）
- `hitTest()` が返り、タップで設置できるか
- **外部ドメインへのリクエストが 0 件か**（CDN 依存の作り込みを防ぐ回帰テスト）

Playwright の合成カメラには視差がないので、**SLAM の精度は測れません**。
「起動して描画してヒットテストが返る」ところまでの確認です。

## 構成

```
index.html                 エンジン等の script タグ。ライセンス表示もここ
src/
  main.ts                  エントリ。window.THREE を公開して起動する
  style.css
  xr/
    engine.ts              パイプライン構築とセッション開始
    scene.ts               three.js シーン。MYAA-16/17 が置き換える
    placement.ts           タップ座標 -> 世界座標。8th Wall 依存はここだけ
    canvas.ts              キャンバスのサイズ合わせ
    capability.ts          動作環境の判定
  ui/
    hud.ts                 ステータス表示と環境パネル
    start-gate.ts          タップして開始（iOS のモーション許可を兼ねる）
  types/8thwall.d.ts       グローバルの型定義
scripts/
  sync-vendor.mjs          8th Wall ランタイムを public/external/ に配置
  dev-cert.mjs             自己署名証明書の生成
  verify.mjs               headless 動作確認
public/external/           ↑ が生成する。コミットしない
.github/workflows/         GitHub Pages への自動デプロイ
docs/                      セルフホスト検証の記録
```

`placement.ts` に 8th Wall 依存を閉じ込めてあります。配布バイナリはクローズドソースで
公式のサポート期限も過ぎている（MYAA-19）ため、トラッキング基盤を差し替える可能性を
残す意図です。

## 既知の問題

### XRExtras の 2 モジュールが iOS のコードパスで壊れている

`XRExtras.FullWindowCanvas` と `XRExtras.Loading` は、**WebKit かつ iOS UA のときだけ**
落ちます。Chromium では iOS UA でも、WebKit でも Android UA なら再現しません。

| モジュール | 症状 |
|---|---|
| `FullWindowCanvas` | `onStart` の iOS 分岐で `appendChild(undefined)` が投げられる |
| `Loading` | 描画が始まらない（`"bindVertexArray" in g` で `g` が undefined、フレーム 0） |

どちらも自前の実装に置き換えました（`src/xr/canvas.ts` / `src/ui/start-gate.ts`）。
`RuntimeError` `CoachingOverlay` `LandingPage` は問題なく動くのでそのまま使っています。

Playwright の Linux 版 WebKit は iOS Safari そのものではないため、**実機で同じことが
起きるかは未確認**です。ただし条件が iOS UA 依存であることから、実機でも踏む可能性が高いと
見ています。実機で問題なければ標準モジュールに戻す判断もあり得ます。

### Draco 圧縮 glTF を使う場合

エンジンは Draco デコーダだけ `cdn.8thwall.com` から取りに行きます（配布物に含まれない）。
MYAA-17 で Draco 圧縮アセットを入れるときは、three.js の `DRACOLoader` に
自前ホストのデコーダを指定してください。エンジン側の Draco 経路は使いません。

## ライセンス

このリポジトリのソースコードは [MIT License](LICENSE)。

同梱していない第三者コンポーネントの扱いは [NOTICE](NOTICE) を参照。

- `@8thwall/engine-binary` — **XR Engine License Agreement**（MIT ではない）。
  改変・再 minify・再バンドル禁止。`public/external/xr/xr.js` は npm の配布物のまま置くこと。
  著作権表示はファイル先頭に含まれており、`index.html` にも記載している
  （[8thwall.org/docs/open-source](https://8thwall.org/docs/open-source) の Option A）
- `@8thwall/xrextras` / `@8thwall/coaching-overlay` / `@8thwall/landing-page` — MIT
- `three` — MIT
