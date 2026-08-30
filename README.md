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

`main` への push で GitHub Actions が `web/` を GitHub Pages にデプロイする。
初回のみ **Settings > Pages > Source** を **GitHub Actions** に設定する必要がある
（設定前の push はワークフローが失敗する）。

**COOP / COEP は不要**であることを実測で確認済みなので、レスポンスヘッダを触れない
静的ホスティングでそのまま動く。パスはすべて相対で、`https://<user>.github.io/<repo>/` の
ようなサブパス配信でも問題ない。

デプロイされる実体は約 8.3 MB。world tracking に使わない face / semantics（約 24 MB）は
ワークフローが落としている。

## 構成

```
web/
  index.html          エンジンを ./external/xr/xr.js から読む（CDN 参照ゼロ）
  app.js              three.js シーン + hitTest + タップ設置
  vendor/             three.js（setup.sh が配置。git 管理外）
  external/xr/        8th Wall エンジンバイナリ（fetch-engine.sh が配置。git 管理外）
setup.sh              three.js + エンジンバイナリの取得
fetch-engine.sh       エンジンバイナリのみ取得
serve.mjs             自己署名 HTTPS の開発サーバ
verify*.mjs           Playwright による headless 検証（Chromium / WebKit）
.github/workflows/    GitHub Pages への自動デプロイ
docs/                 セルフホスト検証の記録
```

## ライセンス

このリポジトリのソースコードは [MIT License](LICENSE)。

同梱していない第三者コンポーネント（8th Wall エンジンバイナリ / three.js）の扱いは
[NOTICE](NOTICE) を参照。**エンジンバイナリを改変・再 minify しないこと。**
