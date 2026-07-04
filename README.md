# Kakudo Synth · 傾きシンセ

スマホを **下向きに水平に構え、全方向に傾ける**と音が変わる Web Audio シンセサイザーです。Android / iPhone どちらでも動く **PWA**（ホーム画面に追加してアプリのように使えます）。

> 📖 詳しい使い方は [docs/guide.html](docs/guide.html)（ブラウザで開いてください）。

## 特長

- **傾きで演奏** — 左右の傾き（gamma）で音程、前後の傾き（beta）で明るさ（フィルター）が変化。
- **6 種類の音色** — サイン / ウォーム / スクエア / ノコギリ / スーパーソウ / FMベル。
- **調整スライダー** — 感度・変化の速さ・音域・明るさ幅・音量。
- **音階スナップ** — メジャー / マイナー / ペンタトニック / ブルース / 半音階 / 全音音階。
- **中央にセット** — 好きな構え方をニュートラルに校正。
- **PWA & オフライン対応** — Service Worker でアプリシェルをキャッシュ。
- センサーが無い端末では、パッドを指でドラッグしても演奏できます。

## 使い方（ローカル確認）

HTTPS もしくは `localhost` でないとセンサー API と Service Worker が動きません。

```bash
python3 -m http.server 8000
# → http://localhost:8000 を開く（スマホ実機はデプロイ後の HTTPS URL で）
```

## 公開（GitHub Pages）

`main` ブランチへ push すると [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が GitHub Pages へ自動デプロイします。

初回のみリポジトリ設定が必要です：

1. GitHub のリポジトリ → **Settings → Pages**
2. **Build and deployment → Source** を **GitHub Actions** に設定
3. `main` に push（または Actions タブから手動実行）

公開後の URL: `https://p0lyg0n.github.io/kakudo-synth/`

## アイコン再生成

```bash
python3 tools/make_icons.py
```

## 構成

```
index.html              画面
css/style.css           スタイル
js/app.js               シンセ本体（Web Audio + DeviceOrientation）
manifest.webmanifest    PWA マニフェスト
sw.js                   Service Worker
icons/                  PWA アイコン（PIL 生成）
tools/make_icons.py     アイコン生成スクリプト
docs/guide.html         使い方ガイド
.github/workflows/      Pages デプロイ
```

## ライセンス

MIT
