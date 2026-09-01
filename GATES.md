# Release-readiness gates (手動運用)

CI/CD は 2026-08-31 に削除した。以下をローカルで手動実行し、全て緑でなければ
main へ反映しない（ブランチ → ローカル検査 → `git merge`）。

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
1. `node scripts/validate-data.ts -- public/data.json` — 意味検査 (`errors: 0`)
2. `node scripts/health-gate.ts public/health.json --report work/health-gate-violations.json --observation-baseline data/source-observation-baseline.json` — health gate (baseline なしでも `passed without baseline`; 判定は常に report に保存)

**データ取得・ビルドは手動で行う**（`npm run build:manual` 等）。`npm run update` は `public/` に既存のビルド成果物がある前提で検証のみを行う。

`fetch-primary --apply` / `discover` / `build --out public` は `npm run build:manual` で手動実行する。build による `data/snapshot.json` の更新は `compare-head.ts` が無視する（証拠: commit c6ca47b）。

## 更新フロー (summary)
1. `npm run build:manual` — 上流取得・候補探索・ビルド（`fetch-primary --apply → discover → build --out public`）
2. `npm run update` — 意味検査 + health gate (`validate:data + health-gate`)
3. 全て緑なら `data/snapshot.json` を更新し、main へ merge

## 注意
- `publish.json` の `workflow_run_id` はローカル実行では `null`。
- `data/next-last-known-good-health.json` は手動更新のたびに `health-gate.ts` の
  出力を保存して更新する。
- nightly 実論文ベンチ (dev/heldout) は `npm run bench` でローカル実行。
