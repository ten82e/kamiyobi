# kamiyobi agent handoff

## 現在地

本体ブランチは `fix/site-ja-usability`。upstream未設定、このUIブランチは未push。この引き継ぎ段階でbranch/worktree/cloneは新設していない。既存資産は削除していない。実HEADは `git rev-parse HEAD` を確認する。

本体に反映したコードcommit:

- `064055d305fd15c6a29b2e0c88510a27c2ff3f2d`: 日本語検索・絞り込み、JST/AoE/date-only精度、複数投稿日程、履歴・フォーカス、歴史日付保持、COMPSAC同一募集の表示。
- `85240e35b3555b633e44c5504768a81644646e52`: 異なる年度・ラベル・round・trackを保持。同じ日時の別日程を共有URLで区別し、曖昧な旧リンクは候補を選ぶ。
- `892ec16cb7ab67c970c10f9a0744c3fd7d6ee845`: モーション軽減時の継承visibility遷移を停止し、素早い開閉後のフォーカスを回復。閉じた後や内部へ移動した利用者からは奪わない。
- `8e39f1cf1f9a41b30ee27b4885a39b6251553c5d`: 旧リンクの候補を読み上げ専用欄から可視の専用欄へ移動。実在する見出しと案内、全幅の44px以上のボタンを設け、再検索時に古い候補を解除。

5,327テスト／352ファイルと全11検証項目成功（agyレビュー後の局所修正を含む）。通常・モーション軽減の両設定でヘッドレス実ブラウザ検証成功。最終コードrevision、SHA、検証の範囲と残件は `docs/agent-handoff/verification/latest.json`。これらは保護中の差分を含む作業ツリーの検証で、clean HEADだけの検証ではない。

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

push/merge/deployは未承認。PR955の拒否済みmergeを再試行しない。今回のユーザー指示ではagyの独立・読み取り専用レビューへ必要最小限コードを渡すことが明示承認された。既存設定を維持してレビューは完了済み。追加送信は今回必要ない。上流・第三者への公開連絡はしない。証拠は既存のcontent-addressed `data/evidence/blobs` 方式を維持する。


## 統合dry-runと独立レビュー（追加成果）

`393b3c6c478c22ffb242c4ae2e303d1e43012059` はレビューで再現したUI問題の修正と、dry-run・ブラウザ再現script・agyレビュー記録。繰り返し統合してもCOMPSACの2つの別名と出典を保つ。会議タグも保つ。別kind/roundの日程へ同じ投稿募集の別名を渡さない。依頼前の7ファイルのハッシュは一致し、commitには含めていない。

本体はlint/typecheck、5,327 tests／352 files、offline/通常build、data validationとhealth gate全11項目成功。専用HeadlessChromeでCOMPSAC／曖昧URL／研究者の主要操作を通常・モーション軽減の2設定で全6検証成功。Mac GUIは使っていない。

実リポジトリ内の `work/agent-verification/integration/tree` はGit archiveによるdry-runで、branch/worktree/cloneではない。実UIブランチのsrc/config/dataへupdaterは適用していない。0717f50の11ファイルだけでは足りず、共有祖先c06b9ffからmain b35010fの前提変更を含む41ファイルを3-way比較し、9ファイルを明示的に解決した。source snapshotを保持し、特徴量は以下の原因別監査と品質検証を伴う互換差分でのみ更新する。

当初の7失敗は、履歴と当時の入力を照合して解消した。古い状態の記録は `docs/agent-handoff/verification/integration-initial-blockers.json`。ca305a3で導入した日本語分割・分野検出・3文字略称を戻さず、不変の入力と既存意味検索値から201件の特徴量を再凍結した。全semantic値・model revision・record hashと3つのmanifestは変更0。v3のdev-only再学習・校正でも「十分な一致」は無効のまま。旧い採用判断の来歴も保持する。required/full品質floorと改ざん拒否は維持し、テストの期待値やtimeoutを緩めていない。

検索の5失敗は、CVMの訂正履歴とEvoMUSARTのidentity変更が当時の固定入力に混入したためだった。テストfixtureに当時のoverrideとidentity設定を隔離し、productionの公式訂正は保持する。merge期待値は公開済みcanonical keyを保持する契約へ合わせ、旧UI keyの別名保持も検証する。詳しい原因と凍結更新の監査は `docs/agent-handoff/candidates/updater-compatibility.md` と隣のmanifest/圧縮patch。

実際の不具合だった旧URL互換はmerge・UI・配信catalogの三段階で修正した。確認済み別名だけを照合し、年・kind・時刻・slotは変えない。変更のないEvoMUSART概要URLは直接開く。訂正前の論文時刻のURLは不一致を説明し、利用者が現在のdate-only日程を選ぶ。モバイルでも44px以上のボタンに現在日付と時刻未確認を表示し、選択後はcanonical URLで再読み込みできる。旧URL14件は9件が直接開き、2件は曖昧候補、1件は訂正された日付の明示選択、廃止されたECIR 2件は収録なしの案内となる。

本体の最終runtime修正は `f0bdccd`（確認済み別名）、`3ca8f39`（固定fixtureとtrainer来歴）、`f9fc495`（配信catalogと旧日時の説明）。`891e25d` はSHA付き互換差分とarchive再現helper。新しいcommitから別archiveで9競合の解決・差分適用を再現し、実運用のsrc/site/tests/data/config/SPEC 518入力の一致を確認する。archiveの3-way入力にはcommitted archiveと明示した保護7ファイルだけを用い、未記録のworking treeを混ぜない。最終の件数・全チェック・browser・歴史保持・SHAは `verification/latest.json` と `integration-latest.json` に記録する。 本体5,327 tests／352 files・11チェック・browser 6本、統合5,337 tests／353 files・13チェック・browser 8本が全て成功。full推薦201件（dev80／heldout80／negative41）も成功。阻害点は0。

統合でEvoMUSARTのpaperだけを置換すると、公式blobにあるabstractも消える問題を発見。dry-runのみでmerge-slotsと確認済み旧paper値の限定除去を組み合わせ、概要・論文を両方date-onlyの11月1日として保持した。未知の値や他kind/round/trackは除去しない。時刻やtimezoneを作らない。2025年までの1,673 editionsのID・年度・原会期とイベント日付は全て保持、変更0件。元candidate patchは変更していない。

統合の最終検証結果は `docs/agent-handoff/verification/integration-latest.json`、独立レビューの採否は `docs/agent-handoff/reviews/agy-integration-disposition.md`。7指摘中3件を採用し、4件は全実装・履歴の照合で不採用。送信本文はJSON.payload文字列へデコードすれば正確な42,441 UTF-8 bytesを得る。Unified diffの空白を変えず、git diff --checkの例外も設けていない。CLI既存モデル・認証・課金設定は維持。秘密・raw snapshot・論文本文・ユーザー保護差分は渡していない。追加のagy呼び出しは必要ない。

再現（既存archiveにはprepareを再実行しない。現在の検証物を保持する）:

```sh
# fresh archiveの場合だけ。実UIのpublicを先に通常buildしておく。
python3 scripts/agent-handoff/prepare-integration.py
node scripts/agent-handoff/resolve-integration.mjs
python3 scripts/agent-handoff/apply-compatibility.py
python3 scripts/agent-handoff/verify-integration.py
python3 scripts/agent-handoff/browser-integration.py
```

verify-integrationは失敗項目も記録し、未影響の全チェックを最後まで実行する。16論理CPUでの過剰な同時実行を抑えるため全テストは4 workerとし、全件・60秒の個別制限を維持する。archiveにはGit metadataが無いため、exact archive cwdに限る `git show HEAD:<file>` 読み取りだけを元UI revisionへ転送するadapterを使う。それ以外のgit操作は通常のgitへ渡し、tmpのgit-initテストは自身のtmp repositoryを使う。GIT_DIRや元indexを共有しない。ブラウザは専用HeadlessChromeとlocalhost8772を使い、終了時に自分のHTTP serverを停止する。

画像: `work/agent-verification/integration/browser/screenshots/integration-evomusart-mobile.png`（表示確認済み）、`integration-corrected-link-mobile.png`（旧日時の不一致・date-onlyの選択）、`shared-link-choices-mobile.png`、`compsac-publication-mobile.png`。本体側の画像は従来の `work/agent-verification/screenshots/`。これらと大きな生成ログはignored、実行scriptと小さな結果・採否を同じローカルブランチに残す。
