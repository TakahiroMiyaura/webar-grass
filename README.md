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
4. 「タップして開始」→ カメラの許可

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
2. 「タップして開始」をタップ
3. **「"モーションと画面の向き"へのアクセスを求めています」を許可**する
4. カメラの使用を許可する
5. 案内に従ってスマホをゆっくり動かす → 案内が消えたらタップで設置

手順 3 が iOS 固有の関門です。`DeviceMotionEvent.requestPermission()` は
ユーザー操作の中からしか呼べないため、開始ゲートを挟んでいます
（`src/ui/tracking-ux.js`。詳細は「トラッキング状態の UX」）。
一度拒否すると再度聞かれないので、その場合は
**設定 → Safari → モーションと画面の向きのアクセス** から戻してください。
アプリ内で拒否した場合は、その場でエラー画面が戻り方を案内します。

`mkcert` でローカル CA を作り、その CA を iPhone にインストールして信頼設定まで行えば
自己署名でも動きますが、端末側の手数が多いのでトンネルを推奨します。

## 非対応環境の確認

右上の **ⓘ** ボタン、または `?diag=1` を付けて開くと、判定結果のパネルが出ます。

- ブラウザ環境: HTTPS / getUserMedia / WebAssembly / WebGL / DeviceOrientation / アプリ内ブラウザ
- エンジン判定: `XR8.XrDevice.isDeviceBrowserCompatible()` と非対応理由
- 端末の推定値と生の JSON

動かせない条件が見つかった場合はパネルが自動で開き、エンジンは起動しません。
エンジンが非対応と判定した端末には 8th Wall の landing page（QR 付き）が出ます。

パネルは開始ゲートとアプリ内ブラウザのガードより**上**に出ます（`z-index: 30000`）。
これが要るのはまさにそれらに阻まれている端末なので、隠れては意味がありません。

アプリ内ブラウザはここでも判定しますが、実際に止めるのは `public/openin.js` の
ガードです（「アプリ内ブラウザ対策」を参照）。パネル側は記録だけを持ちます。

## トラッキング状態の UX

`src/ui/tracking-ux.js` + `src/ui/tracking-ux.css`。素の JS のままにしてあり、
**起動から最初のタップまで**と**トラッキングを失ったとき**を受け持つ。

- **開始ゲート** — 最初のタップを受けてから `XR8.run()` を呼ぶ。
  エンジンは `XR8.run()` の中で `DeviceMotionEvent.requestPermission()` を呼ぶが、
  iOS ではユーザー操作の外だと拒否され、エンジン自身の英語モーダル
  *"AR requires access to device motion sensors"* にフォールバックする。ゲートがあるとこれが出ない
- **コーチング** — カメラは動いているがトラッキングが未確立の間、動かし方を案内する
- **ロスト時のリカバリ** — 理由（`RELOCALIZING` / `TOO_MUCH_MOTION` / `NOT_ENOUGH_TEXTURE`）ごとに文言を変える。
  600ms 続いてから出すので、SLAM が数フレーム落ちるたびに点滅しない
- **準備前のタップに応答する** — トーストとバイブで返し、無反応にしない。
  hitTest が外れたときも別の文言で返す
- **カメラ拒否時の導線** — iOS / Android それぞれの設定手順を出し、再読み込みボタンを置く

エンジンが動き出す条件は 3 つで、順番は問わない（`src/xr/engine.ts` が毎回すべて再確認する）。

1. `xr.js` の読み込み完了
2. `public/openin.js` の `__inAppBlocked` が下りていること（アプリ内ブラウザのガード）
3. 開始ゲートがタップされたこと

アプリ内ブラウザではガード（`z-index: 99999`）が開始ゲート（同 `100`）の上に出るので、
ユーザーはガードに答えてから開始ゲートを見ることになる。

床面のワイヤーフレームと中央レティクルは**出さない**（配置はタップ位置で行うため不要）。

公式の MIT パッケージが担当する範囲からは自動的に手を引く仕組みになっている。
本プロジェクトでの設定は `src/main.ts` にあり、2 つで扱いが違う。

- **コーチングは `@8thwall/coaching-overlay` に渡す**（`coaching: 'auto'`）。
  これはパイプラインに入れてあるので、初期化中の案内はそちらが出す。
  `CoachingOverlay` が出るのは `LIMITED` かつ `INITIALIZING` のときだけなので、
  **ロスト時の表示・開始ゲート・タップへの応答は重複しない**
- **許可エラー画面は自前を使う**（`permissionUi: 'builtin'` を明示）。
  `XRExtras` は `window` に載っているので `'auto'` だと `'external'` に倒れるが、
  `XRExtras.Loading` は iOS で描画を壊すため**パイプラインに入れていない**。
  `'auto'` のままだと誰もエラー画面を出さなくなる

```bash
npm run verify:tracking-ux                              # 全パス（Chromium / WebKit）
node scripts/verify-tracking-ux.mjs sm:webkit           # 1 パスだけ
```

状態遷移の検証は**エンジンなしで**回る。`statemachine-test.html` が
パイプラインモジュールのコールバックを直接叩くので、合成カメラでは踏めない
コーチングやロストの経路も確認できる。このページはビルド対象だが、
デプロイ時にワークフローが `dist/` から削除するので公開はされない。

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

### ワークフローがやること

1. `npm ci` — postinstall がエンジンバイナリ等を `public/external/` に配置し、
   world tracking に使わない face / semantics（約 24 MB）を除外する
2. `npm run build` — 型チェックと Vite ビルド → `dist/`（実体は約 **9 MB**）
3. エンジンの `LICENSE` が残っていることを確認（欠けるとライセンス違反になるため）
4. `tools/make-qr.mjs` で **QR コードと配布ページを生成**し、復号して URL を照合
5. `statemachine-test.html`（テスト用ページ）を成果物から削除
6. Pages へデプロイ
7. **公開された URL を実際に叩いて疎通確認**（smoke ジョブ）

7 は「デプロイは成功したのに端末では黒画面」を防ぐためのもの。`index.html` /
`openin.js` / `xr.js` / `xr-slam.js` / `xrextras.js` / `share.html` / `qr.png` が 200 で返り、
Content-Type が期待どおりかを検証する。**エントリの JS はファイル名にハッシュが付く**ので、
`index.html` を読んで実際の名前を取り出してから確認している。
テスト用ページが公開されていないことも併せて見る。1 つでも外れると赤くなる。

### QR コードと配布ページ

QR は**リポジトリにコミットせず、デプロイのたびに生成する**。URL は
`GITHUB_REPOSITORY` から導出しているので、リポジトリ名を変えても QR がずれない。

デプロイ後、配布ページは公開 URL の `/share.html` にある。QR・URL・操作手順・
アプリ内ブラウザの注意書きが 1 枚に載っていて、そのまま印刷できる。
QR 画像単体が要る場合は `/qr.png`（PNG）と `/qr.svg`（ベクタ、印刷向け）。

手元で確認する場合:

```bash
npm run build
node tools/make-qr.mjs   https://example.github.io/webar-grass/
node tools/verify-qr.mjs https://example.github.io/webar-grass/   # QR を復号して URL を照合
```

QR は `dist/` に出力されるので、先に `npm run build` が要る。

### アプリ内ブラウザ対策

QR は LINE や Instagram から読まれることが多く、その場合リンクはアプリ内の webview で開く。
そこでは `getUserMedia` が通らない、あるいは通っても SLAM にフレームが届かず、
**原因の分からない黒画面**になる。

`public/openin.js` が UA を見て以下を検出し、エンジンを起動する前に案内を出す。
カメラ許可のダイアログを出さずに止めるのが要点。

- LINE / Instagram / Facebook / X / TikTok / WeChat / Slack
- iOS で Safari・Chrome・Firefox・Edge のいずれでもない webview
- Android の `; wv)` 付き webview

脱出方法は環境ごとに変えている。LINE は `?openExternalBrowser=1` が効くのでそれを使い、
Android は `intent://` で Chrome を直接開く。iOS は `x-safari-https://` を試すが、
Instagram と Facebook はこれを塞いでいるため、**「右下の … から外部ブラウザで開く」**という
文言と URL コピーに倒している。誤検出に備えて「このまま試す」も置いてある。

検証は `npm run verify:inapp`（Playwright で 8 種の UA を実行し、
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

## 動作確認（headless）

```bash
npx playwright install --with-deps chromium webkit
npm run build

npm run verify               # カメラ映像 + 3D 描画（Chromium / WebKit）
npm run verify:tracking-ux   # トラッキング UX の状態遷移と実エンジン
npm run verify:inapp         # アプリ内ブラウザのガード
```

`npm run verify` は Chromium（Android UA）と WebKit（iOS Safari と同じエンジン）で
実際にパイプラインを起動します。結果は `screenshots/` に出ます。

- カメラ映像が描画されているか（キャンバスの非黒率）
- three.js のシーンが回っているか（フレーム数）
- `hitTest()` が返り、タップで設置できるか
- **外部ドメインへのリクエストが 0 件か**（CDN 依存の作り込みを防ぐ回帰テスト）

配信は **`/webar-grass/` のサブパスから・追加のレスポンスヘッダなし**で行います。
GitHub Pages のプロジェクトサイトと同じ条件なので、絶対パスが紛れ込んだり
COOP / COEP に依存したりすると落ちます。

Playwright の合成カメラには視差がないので、**SLAM の精度は測れません**。
「起動して描画してヒットテストが返る」ところまでの確認です。

## 構成

```
index.html                 エンジン等の script タグ。ライセンス表示もここ
statemachine-test.html     tracking-ux の状態遷移ハーネス（公開はされない）
bench.html                 草の描画ベンチ（実機で fps を測る。これは公開される）
public/
  openin.js                アプリ内ブラウザのガード。Vite が無変換でコピーする
  external/                8th Wall ランタイム。生成物でコミットしない
src/
  main.ts                  エントリ。window.THREE の公開と tracking-ux の生成
  bench.ts                 bench.html の中身
  style.css
  assets/                  草アトラス・GLB・接地影（生成済み・コミット対象）
  xr/
    engine.ts              起動条件の合流、パイプライン構築、セッション開始
    scene.ts               three.js シーン。MYAA-16/17 が置き換える
    placement.ts           タップ座標 -> 世界座標。8th Wall 依存はここだけ
    canvas.ts              キャンバスのサイズ合わせ
    capability.ts          動作環境の判定
    grass.ts               草の描画。InstancedMesh 1 本、生長/風/消滅は GPU 側
    tuft-geometry.ts       草カードの形状。three 以外に依存しない
    perf.ts                フレーム計測と適応解像度
  ui/
    hud.ts                 環境パネルと設置数の表示
    tracking-ux.js         開始ゲート / コーチング / ロスト時リカバリ（素の JS）
    tracking-ux.css
    tracking-ux-types.ts   上記の型を実装から導出する
  types/8thwall.d.ts       グローバルの型定義
scripts/
  sync-vendor.mjs          8th Wall ランタイムを public/external/ に配置
  dev-cert.mjs             自己署名証明書の生成
  verify.mjs               カメラ映像 + 3D 描画の headless 確認
  verify-tracking-ux.mjs   トラッキング UX の headless 確認
  verify-inapp.mjs         アプリ内ブラウザガードの headless 確認
tools/
  make-qr.mjs              QR コードと配布ページの生成
  verify-qr.mjs            生成した QR を復号して URL を照合
  make-textures.mjs        草アトラスと接地影を生成
  make-grass-glb.mjs       草の GLB を生成（アルファ形状に切り詰めたカード）
  verify-geometry.mjs      GLB と手続き生成のジオメトリを突き合わせ
  compress.mjs             Draco / KTX2 を入れる価値があるかを実測
  bench.mjs                草の描画コストを headless で計測
.github/workflows/         GitHub Pages への自動デプロイ
docs/                      セルフホスト検証の記録 / 草の描画設計メモ
```

`placement.ts` に 8th Wall 依存を閉じ込めてあります。配布バイナリはクローズドソースで
公式のサポート期限も過ぎている（MYAA-19）ため、トラッキング基盤を差し替える可能性を
残す意図です。

`tracking-ux.js` だけ TypeScript にしていません。`scripts/verify-tracking-ux.mjs` が
この実装をそのまま検証しているため、書き換えるとテストと実装がずれます。
型は `tracking-ux-types.ts` が `ReturnType` で実装から導出するので、手書きの型定義が
腐ることもありません。

## 既知の問題

### XRExtras の 2 モジュールが iOS のコードパスで壊れている

`XRExtras.FullWindowCanvas` と `XRExtras.Loading` は、**WebKit かつ iOS UA のときだけ**
落ちます。Chromium では iOS UA でも、WebKit でも Android UA なら再現しません。

| モジュール | 症状 |
|---|---|
| `FullWindowCanvas` | `onStart` の iOS 分岐で `appendChild(undefined)` が投げられる |
| `Loading` | 描画が始まらない（`"bindVertexArray" in g` で `g` が undefined、フレーム 0） |

どちらも自前の実装に置き換えました。`FullWindowCanvas` は `src/xr/canvas.ts`、
`Loading` の役割（開始ゲート・許可エラー画面）は `src/ui/tracking-ux.js` が引き継いでいます。
`RuntimeError` `CoachingOverlay` `LandingPage` は問題なく動くのでそのまま使っています。

`Loading` を外している影響が 1 つあります。`XRExtras` 自体は `window` に載っているため、
`tracking-ux` の `permissionUi: 'auto'` は「上流が許可エラー画面を出す」と判断してしまいます。
実際には出す担当がいなくなるので、`src/main.ts` で `'builtin'` を明示しています。

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
