# kamiyobi agent handoff

## 現在地

本体ブランチは `fix/site-ja-usability`。upstream未設定、このUIブランチは未push。この引き継ぎ段階でbranch/worktree/cloneは新設していない。既存資産は削除していない。実HEADは `git rev-parse HEAD` を確認する。

本体に反映したコードcommit:

- `064055d305fd15c6a29b2e0c88510a27c2ff3f2d`: 日本語検索・絞り込み、JST/AoE/date-only精度、複数投稿日程、履歴・フォーカス、歴史日付保持、COMPSAC同一募集の表示。
- `85240e35b3555b633e44c5504768a81644646e52`: 異なる年度・ラベル・round・trackを保持。同じ日時の別日程を共有URLで区別し、曖昧な旧リンクは候補を選ぶ。
- `892ec16cb7ab67c970c10f9a0744c3fd7d6ee845`: モーション軽減時の継承visibility遷移を停止し、素早い開閉後のフォーカスを回復。閉じた後や内部へ移動した利用者からは奪わない。
- `8e39f1cf1f9a41b30ee27b4885a39b6251553c5d`: 旧リンクの候補を読み上げ専用欄から可視の専用欄へ移動。実在する見出しと案内、全幅の44px以上のボタンを設け、再検索時に古い候補を解除。

5,321テスト／352ファイルと全11検証項目成功。通常・モーション軽減の両設定でヘッドレス実ブラウザ検証成功。最終コードrevision、SHA、検証の範囲と残件は `docs/agent-handoff/verification/latest.json`。これらは保護中の差分を含む作業ツリーの検証で、clean HEADだけの検証ではない。

## データと同一性

696会議、全4,968日程を横断確認。公式根拠のあるCOMPSACの2記録だけ画面上で1募集へまとめ、他の4,966日程の元記録を保持。2026-12-01は時刻未確認の投稿締切、2027年9月は掲載予定月。月初・月末を会期として作らない。アーカイブJSON/全データCSVには元の2記録を残し、画面CSV・ICSは1募集。

旧共有キーの衝突39群を年度/edition/round/track/labelで区別。違う特集号やCFP URLを共用する会議はURLだけで統合しない。常時受付ジャーナル22行、VLDB 2027の月次12ラウンド・24日程を保持。監査は `scripts/agent-handoff/identity-audit.mjs` で再現できる。

## 保護中の変更

`site/recommender.ts` の既存約8KB差分、`tests/japanese_glued_kind_fold_query.test.ts`、未追跡の `tests/held_in_suffix_query.test.ts` は依頼前からの変更。自分のcommitに含めず、ハッシュ一致を確認した。4つの `data/source-snapshots/*.json` の既存差分も保持。reset/checkout/一括stageしない。所有範囲と保護SHAは `docs/agent-handoff/verification/ownership.json`。特にrecommender.tsはlintの1MiB上限に非常に近い。

## 再現

本体のルートで `AGENTS.md` と `SPEC.md` を読む。`.agents/` は存在しない。Node >=24、依存関係は既存lockに従う。

```sh
python3 scripts/agent-handoff/verify.py
node scripts/agent-handoff/identity-audit.mjs
```

検査は型検査、lint、固定日時offlineビルド、全tests、data検証、health gate、通常ビルドと再検証を直列に実行する。通常ビルドが変更したsnapshotは検査前のバイトへ復元する。改ざんtestsとbuild/browserを併走させない。

別ターミナルで `python3 -m http.server 8771 --directory public --bind 127.0.0.1` を起動。専用Chromeを `--headless=new --remote-debugging-port=9240 --user-data-dir=<本体.cache内の専用profile> --disable-background-networking --no-first-run --no-default-browser-check about:blank` で起動する。

```sh
node scripts/agent-handoff/headless-compsac.mjs
node scripts/agent-handoff/headless-identity.mjs
node scripts/agent-handoff/headless-researcher.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-compsac.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-identity.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-researcher.mjs
```

既定はモーション軽減設定。毎回、新しいページを作り、キャッシュを無効にし、過去の成功レポートを消して開始する。HeadlessChrome以外への接続を拒否し、外部HTTPをブロックする。OS入力・Page.bringToFront・Mac GUIは使わない。CDP接続先は `KAMIYOBI_CDP_ORIGIN` で変更できるが、既存の対話用Chromeには接続しない。

JSON結果・ログ・スクリーンショットは `work/agent-verification/` に生成される。大きな生成物は既存gitignoreに従い、再現scriptと小さな検証記録をcommitした。外部作業フォルダやチャット履歴を読む必要はない。

## 未適用の更新系候補と公開

公開データ復旧候補は `docs/agent-handoff/candidates/updater-main-to-0717f50.patch` と隣のmanifest。baseはmain `b35010f7a11fb217417b2fdf0d675ea1af9a555b`、候補 `0717f506192e05517bb57af9ae260c702f90078c`。指定baseへの適用と11ファイルの一致を確認済みで、このUI作業ツリーには未適用。

既存PR955のremote headは記録時 `96881aa57eb68fb9d3c730ea75bf0ff6a9a71f05`。canary成功run `37101195216` はこのremote headを対象とする。0717f50のfixture隔離test修正はローカル候補だけで、同revisionのcanaryと混同しない。候補には古い公開identityの保持、ECIRの公式根拠による補正、evidence保持が含まれる。UI改善は更新復旧の必須条件ではない。

このUIブランチではECIR 2027の複数元記録と時刻差が残る。COMPSACの限定統合をECIRへ流用せず、更新系候補を最終baseで統合・検証する必要がある。日付・時刻・歴史年度の推測や検証無効化で通さない。

UI公開も本体commitのレビュー・統合と全runtime assetの再buildを要する。`src/build.ts`などは更新系と共通であり、両方を一括適用しない。remote/publicの最終読み取り状況は `docs/agent-handoff/verification/publication-state.json`。記録時の公開manifestは2026-09-07生成のままであり、今回のUI変更は未公開。

push/merge/deployは未承認。PR955の拒否済みmergeを再試行しない。agyへのコード送信、第三者への送信もしない。証拠は既存のcontent-addressed `data/evidence/blobs` 方式を維持する。
