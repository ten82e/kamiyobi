# Release-readiness gates

ローカルで以下が緑でなければ main へ反映しない。
`.github/workflows/ci.yml` も同じ typecheck / lint / test / offline build / データ検査を実行する。

## G1 — 型検査・静的検査
```sh
npm run typecheck   # tsc --noEmit (src + site)
npm run check       # biome lint
```

## G2 — テスト
```sh
npm test            # vitest run (全ファイル)
```
`skipped=` が 0 であること。0 件でも `NO TESTS RAN` でないこと。

## G3 — データ意味検査 + health gate（統合: `npm run update`）
```sh
npm run update
```
内部で以下を直列実行する:
1. `node scripts/validate-data.ts` — 正典入力の意味検査 (`errors: 0`)
2. `node scripts/validate-data.ts -- public/data.json` — 公開データの意味検査 (`errors: 0`)
3. `node scripts/health-gate.ts public/health.json --report work/health-gate-violations.json --observation-baseline data/source-observation-baseline.json`

`npm run update` は `public/` に既存のビルド成果物がある前提で検証する。baseline は保存しない。

## 更新フロー (summary)
1. `npm run build:manual` — ビルド（`build --out public`）
2. `npm run update` — 意味検査 + health gate
3. 全て緑なら main へ merge。CI が再検査し、`deploy.yml` が Pages を配信する

## 注意
- `publish.json` の `workflow_run_id` はローカル実行では `null`。
- health gate の baseline は位置引数で明示する。`npm run update` は baseline なしで検証する。
- `scripts/compare-head.ts` は `data/snapshot.json` の `generated_at` と `_comment` だけを無視する。
- 実論文ベンチ (dev/heldout) は `npm run bench`、CI の `nightly.yml` でも実行する。
