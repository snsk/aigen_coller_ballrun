# aigen_coller_ballrun

3Dブラウザゲーム「Color Ball Run」のプロトタイプ。

■ クイックスタート

- 要件: Node.js 18+ / npm 9+
- 開発サーバ: `npm run dev`
- 本番ビルド: `npm run build`
- プレビュー: `npm run preview`

■ 操作

- マウス移動のみ（クリック不要）。
- 画面内でカーソルを動かすと仕分け箱が水平移動します。

■ 仕様メモ

- 物理: Rapier 3D (WASM)、固定タイムステップ 1/120s。
- 描画: Three.js。60fps目標、フルHD推奨（可変スケール）。
- ドキュメント: `docs/01_purpose.md`, `docs/02_target_env.md`, `docs/03_gdd.md` を参照。
