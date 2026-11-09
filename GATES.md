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

## G4 — モデル評価（nightly.yml と手動。実モデルを `.cache/embedding-models` に準備してから）
```sh
npm run test:full-pool                      # ゲート評価。品質基準（Top-5・正解）は変更しない
npm run test:full-pool-mutations            # 評価の感応度検査（3 欠陥を検出できる事）
npm run test:mcp-interrupted-mutations      # interrupted recovery の変異検査
npm run test:mcp-recovery-mutations         # same-session recovery の変異検査
npm run test:llms-count-mutations           # llms の件数検査
npm run test:real-papers                    # 実論文評価
npm run test:recommendation-mutations       # 推薦の変異検査
```

2026-11-08 実測: full-pool 9/9・full-pool-mutations 3/3 検出・interrupted 2/2 検出・
2026-11-09 実測: full-pool 9/9・full-pool-mutations 3/3 検出（baseline 19/0 →
各変異で 9-15/10-5〜4 の低下を確認）・全ゲート緑を再確認。
2026-11-09 実測 (mcp-interrupted-mutations): baseline 25/0 → 2 変異で 0/25 に低下 →
復元後 25/0。**2/2 検出** ✓。
2026-11-09 実測 (llms-count-mutations): baseline 19/0 → 3 変異系 (missing-dates 7/12・
fixed-coverage 0/19・thousands-grouping 18/1) で合計 18/18 検出 → 復元後 19/0 ✓。
llms-count・mcp-recovery の baseline（49/0）は緑。
**既知の赤**（品質基準は緩めない）:
- `test:real-papers` と `test:recommendation-mutations` の baseline は、SPEC
  §意味検索の追加比較に記録した未解決 2 項目（日本語の題名と概要の MRR 下限、
  英語の追加確認論文の題名 MRR の改善条件）で落ちる。
- `test:mcp-recovery-mutations` の変異相は、fault 注入時に準備の順序 Guard
  （"English model must be available before Japanese preparation"）で tests が
  skipped に成る。baseline は緑なので fault 検出の公示だけが効いていない既知の問題
  （2026-10 月までの記録でも同様）。データや本文書の変更とは無関係。
- `venue_scopes` の topics 追加はゲート評価を劣化させる（SPEC §募集分野の説明を人とAIで
  確認する の注意書き）。topics を復活させるなら評価を通してから。

## 注意
- `publish.json` の `workflow_run_id` はローカル実行では `null`。
- health gate の baseline は位置引数で明示する。`npm run update` は baseline なしで検証する。
- `scripts/compare-head.ts` は `data/snapshot.json` の `generated_at` と `_comment` だけを無視する。
- 実論文ベンチ (dev/heldout) は `npm run bench`、CI の `nightly.yml` でも実行する。
