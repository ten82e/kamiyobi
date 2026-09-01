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
1. `node src/fetch-primary.ts --apply` — 一次ソース観測を適用
2. `node src/cli.ts discover` — 候補探索
3. `node src/cli.ts build --out public` — ビルド
4. `node scripts/validate-data.ts -- public/data.json` — 意味検査 (`errors: 0`)
5. `node scripts/health-gate.ts public/health.json --report work/health-gate-violations.json --observation-baseline data/source-observation-baseline.json` — health gate (baseline なしでも `passed without baseline`; 判定は常に report に保存)

全ステップが rc=0 でなければ `public/` を破棄し、前回の `data/snapshot.json` から
再生成する（SPEC.md §3.5）。

## 更新フロー (summary)
1. `npm run update` — 上流取得・候補探索・ビルド
2. `npm run validate:data -- public/data.json` — 意味検査
3. `node scripts/health-gate.ts ...` — health gate
4. 全て緑なら `data/snapshot.json` を更新し、main へ merge

## 注意
- `publish.json` の `workflow_run_id` はローカル実行では `null`。
- `data/next-last-known-good-health.json` は手動更新のたびに `health-gate.ts` の
  出力を保存して更新する。
- nightly 実論文ベンチ (dev/heldout) は `npm run bench` でローカル実行。
