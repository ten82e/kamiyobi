# kamiyobi 独立反証レビュー（HEAD de682df、固定 packet のみ）

## (1) 最も強い指摘

### 指摘1【高・推論（コード上の根拠は強い）】封印される embeddings は、どの品質 gate でも評価されていない

**根拠**
- `--real-v2-feature-baseline` を渡すと、frozen features が必須になります。
  - `src/bench-recommender.ts:2622` `if (!requiredFeatures) throw new Error("feature baseline requires frozen semantic features")`
- frozen features があると、embedding bundle は空になり、モデルも読み込まれません。
  - `src/bench-recommender.ts:2595-2599`（`embeddings: {}`）
  - `:2668` `for (const language of useFrozenFeatures ? [] : usedLanguages)`
  - `:2774` `semanticScores = fixed?.semantic_scores ?? ...`
- bundle workflow の full benchmark は baseline と features を渡しています。`--emb` は渡していません（`.github/workflows/recommendation-bundle.yml:70-77`）。
- seal は report を渡されずに呼ばれます（`recommendation-bundle.yml:82`）。この場合 `gate_provenance` は `mode: "trusted-pipeline"` になります（`scripts/seal-recommendation-bundle.ts:100`）。それでも `required_gate: "passed"` と `full_benchmark: "passed"` が固定で書き込まれます（`:115-116`）。
- `canonicalRealPaperBenchmarkContentId` による照合（`:63-67`）は verified-reports モードでしか働きません。本番経路では一度も実行されません。

**反例**
- 直前の step（`recommendation-bundle.yml:62`）で生成された `public/embeddings.json` の品質が劣化したとします（モデル revision の変化、profile 生成のバグなど）。
- この場合でも、required gate と full benchmark は凍結済みの semantic score で採点されるため合格します。
- seal には `full_benchmark: "passed"` と記録され、`restore-recommendation-bundle.ts:25-28` の検査も通り、公開されます。

**二者択一**
full coverage の経路で main が `requiredFeatures` を渡していない場合は、上の反例は成り立ちません。代わりに `:2622` で必ず throw し、今回の修正以降 bundle が一度も seal されていない、という別の欠陥になります。どちらであるかは、修正後の recommendation-bundle の実行ログで確定できます（不足資料）。

**反証が成立する条件**
`semantic-content.ts`、`embeddingsStale`、または未読の main 配線のどこかで、生成した embeddings を独立に採点している場合です。

**影響**
- `full_benchmark: passed` が保証するのは「現行データの lexical 側と凍結 semantic の組み合わせ」の品質です。公開される semantic 成果物の品質ではありません。
- 研究上の主張（semantic 推薦の品質）と運用上の主張（品質 gate を通過した bundle を公開）を区別する必要があります。

---

### 指摘2【高・推論】immutable baseline 修正は、現行データに対しては「どちらでもない混成系」を測っている。baseline 自体も固定されていない

**現行データ側の評価から完全一致検査が外れている**
- 完全一致検査は `!featureBaselineData` のときだけ働きます（`src/bench-recommender.ts:2793-2800`）。
- 外側の run（現行データ）では検査が無効になり、内側の run（`:2623-2634`、9 番目の引数が undefined）だけで検査されます。
- 現行データの採点には c06b9ff 時点の venue key に紐づいた `semantic_scores` が使われます（`:2774`）。

**具体的な反例**
- データ更新で、汎用的で強い新しい venue が追加されたとします。
- 本番では semantic score が計算され、Top-5 に入って正解 venue を押し出します。
- gate 内では frozen record にその key が無いため、新 venue は lexical のみで評価されます。押し出しは観測されず、合格します。
- venue の key が rename された場合も、旧 key の semantic score は宙に浮きます。

**既存テストはこのケースを検証していない**
- テストが追加する venue は `{ key: "new-source-venue", title: "New Source Venue", categories: ["systems"] }` だけです（`tests/bench_recommender.test.ts:148-152`）。
- 論文と関係のないこの venue では、押し出しが起きるかを確かめられません。

**baseline が「immutable」なのはコメント上だけ**
- `data/benchmarks/real-paper-feature-baseline.json:2` の `"Immutable ... from main c06b9ff"` を強制するハッシュ pin が見当たりません。
- `benchmark_content_id` の入力にも baseline は含まれていません（`bench-recommender.ts:3534-3540`。引数は coverage, dev, heldout, negative, requiredFeatures のみ）。
- semantic_content_id の構成要素（`recommendation-bundle.yml:23-24` のコメント）にも含まれていません。
- テストが改ざん検出を確認しているのは features 側だけです（`:170-187`）。
- そのため、baseline と features を同時に再生成する PR は、内容上の検出を受けずに通ります。

**明記済みの制限が意思決定をどう変えるか**
- `:2` には「live data still passes the same quality floors」と明記されています。floor が絶対値（`:2560-2568`）である以上、floor に達するまでの劣化は設計上許容されています。
- 修正前は、データ変化による mismatch の失敗が「frozen features が古くなった」という信号でした。修正でその信号が消え、再生成を促す仕組み（staleness の上限、経過日数、venue 差分の件数）がありません。
- 結果として、時間が経つほど gate の代表性は単調に下がります。

**反証が成立する条件**
- `venueRecommendations` が semantic 欠損の venue を本番と同等に扱う場合（たとえば本番も新 venue に semantic を与えない場合）。
- または `validateRealPaperFixtures` が key の集合差を拒否している場合（未読）。

---

### 指摘3【中〜高・推論】`--now` の不一致により、workflow_run 側の deploy が黙って lexical-only を公開しうる

**根拠**
- bundle workflow は `--now 2026-08-09T00:00:00Z` で data を作っています（`recommendation-bundle.yml:22`）。
- deploy は実時刻 `--now "$BUILD_NOW"` で作り直しています（`.github/workflows/deploy.yml:71-73`）。
- restore は現行 data から content id を再計算し、一致しなければ `false` を返します（`scripts/restore-recommendation-bundle.ts:19-31`）。
- `false` の場合も、`"publishing lexical-only"` と出力して exit 0 で終わります（`:46-50`）。
- deploy 後の照合は `source_commit`, `content_id`, `build_id` だけで、`semantic_status` を見ていません（`deploy.yml:193`）。

**成立条件**
`embeddingProfileHash` または `embeddingsStale` が、時刻に依存するフィールドに依存している場合に成立します。たとえば過去締切の除外、推定版（`est`）、active 判定などです。この場合、semantic 公開はすべての deploy で静かに失敗します。

**反証が成立する条件**
- content id が `--now` に依存しないこと。
- 本番の `publish.json` が `semantic_status` に lexical-only 以外の値（`ready` 相当）を示していること。

**必要な資料（不足）**
- 本番の `publish.json`。
- deploy ログ中の restore の出力行。

**影響**
CI は全て緑のまま、利用者は lexical-only の推薦を受け取ります。研究上の評価対象と、実際に配信されている系が一致しなくなります。

---

### 指摘4【中・推論（GitHub concurrency の仕様に依存）】「publication は main と monotonic」は成り立つが、liveness は成り立たない

**根拠**
- `deploy.yml:15-20` は workflow 単位の concurrency で、`cancel-in-progress: false` です。
- GitHub の仕様では、同じ group に新しい run が待機に入ると、既に待機中の run はキャンセルされます。

**反例**
1. A の deploy が実行中で、B の push deploy が待機中。
2. A の recommendation-bundle が完了し、A の workflow_run deploy が待機に入る。
3. この時点で B の push deploy がキャンセルされる。
4. A の workflow_run deploy は gate で stale と判定され、何も公開しない（`:34-40`）。
5. B の bundle が full benchmark で失敗すると、B の workflow_run deploy は起動しない（`:24`）。
6. 結果として、B は lexical-only 版も含めて一度も公開されません。Pages は次の push まで A のままです。

**その他**
- 通常の push でも、まず lexical-only が公開されてから semantic に戻ります（restore は workflow_run 経路のみ、`:74-75`）。そのため push のたびに機能低下の時間帯があります。
- コメント `:17-19` の「monotonic」は「古い版に戻らない」という意味では正しいです。ただし「必ず最新版になる」ことは保証されません。

**反証が成立する条件**
該当する時間帯にキャンセルされた deploy run の記録が存在しないこと（Actions の履歴が必要）。

---

### 指摘5【中・確定（コード上）】bundle の再利用 identity に gate 定義が含まれていない

**根拠**
- 再利用の条件は `semantic_content_id` の一致と、文字列 `"passed"` の一致だけです（`recommendation-bundle.yml:45-49`）。
- 指摘1で見たとおり、この 2 つのフラグは seal 時に固定値で書き込まれるため、実質的には content id の一致だけが条件です。
- content id には benchmark fixture、floor、今回追加した feature baseline のいずれも含まれていません（`:23-24`）。

**反例**
- 今回のように gate を強化（または変更）した commit を push します。
- 推薦データの内容が変わっていなければ、修正前の gate で seal された bundle が直近 15 run の中から再利用されます（`:37`）。
- 新しい gate は bundle workflow 内では走りません（`:63-80` は reused の場合すべて skip）。

**緩和要因**
- ci.yml の required gate は毎回走ります。
- `bundle_origin_commit` が記録されるので、出自は追跡できます。

**未確認の点**
CI 合格が main 反映の前提になっているか（branch protection）は packet に無く、不足資料です。recommendation-bundle と deploy は ci の成否に依存していません。

---

## (2) 欠けた対照と別解（提案のみ、実行はしていない）

### 欠けた対照
- **負の対照**：現行データを劣化させたときに floor で落ちることの確認。たとえば正解 venue の categories や name を削る、関連性の高い新 venue を追加するなど。今回の修正が「穴を作っていない」ことを示すには、この対照が不可欠です。
- **陽性の再現**：修正前の commit + 現行データで `required production feature mismatch` が出ていたことを示す、保存済みの CI ログ（packet に無し）。
- **baseline 改ざんの検出テスト**：features は据え置き、baseline だけを変更した場合の挙動。
- **新 venue の semantic 欠損件数の計測**：現行データで frozen record に key が無い venue の数を数え、gate の代表性を数値化する。
- **dispatch 経路の比較対照**：GITHUB_TOKEN フォールバックで起動されたデータ PR の CI では、base との比較が `pull_request` 限定のため skip され、fixture のみの回帰になります（`ci.yml:136,144,147-148`）。update-data 側の Top-5 delta（`update-data.yml:95-97`）が代わりの gate になっていますが、比較元は offline ビルド、比較先は online ビルドで、条件が異なります。

### より単純な別解
- **baseline と features の固定**：sha256 を、benchmark_content_id と seal manifest の両方の入力に入れる。
- **gate 結果を seal に結び付ける**：seal を `--required-gate` / `--full-benchmark` の verified-reports モードに切り替え、gate の実際の report を seal に紐付ける。既存のコード（`seal-recommendation-bundle.ts:94-99`）をそのまま使えます。
- **embeddings 自体の評価**：封印前に、生成した embeddings で非 frozen の採点を最低 1 回行う（`--emb public/embeddings.json` 相当）。
- **deploy の検証強化**：workflow_run 経路で restore が `false` を返したら job を失敗させるか、少なくとも `semantic_status` を照合する。
- **時刻の統一**：bundle と deploy で `--now` を揃えるか、content id が時刻に依存しないことを test で固定する。
- **staleness 検出**：frozen features を再生成すべき条件（venue key の差分件数など）を warning に出す。

## (3) この packet から支持できること

- action は SHA で pin され、`persist-credentials: false` で統一されています。権限も job 単位で最小化されています。
- 修正の意図、つまり「コードの変化は不変の入力で完全一致を検査し、データの変化は floor で測る」という分離は筋が通っています。
  - baseline 側の完全一致検査は有効です（`:2623-2636` から `:2793-2800` を経由）。
  - features の改ざんと features の欠落はテストで検出されます（`tests/bench_recommender.test.ts:170-201`）。
- baseline フラグは CI（`ci.yml:159`）、bundle、nightly（diff `b8a7ba2`）に一貫して付いています。
  - ただし diff には ci.yml の変更が含まれていないため、ci.yml にいつ追加されたかは確認できません。
- health gate は fail-closed で作られています。baseline が無い場合、観測 baseline の欠落や読み込み失敗、例外のいずれでも、違反報告を書いてから 1 を返します（`scripts/health-gate.ts:91-103,111-142,178-189`）。
- update-data の自動ブランチは次の性質を持ち、テストで裏付けられています（`tests/update_data_fast_forward.test.ts:76-123`）。
  - 無関係な編集を拒否する。
  - 競合する push を上書きしない。
  - 履歴を保持したまま fast-forward で push する。
  - 開始時点の main が変わっていれば中止する（`update-data.yml:238`）。
- deploy には次の検査があります。
  - stale な SHA を二重に検査する（`:34-35,177-181`）。
  - 配信後に manifest を照合する。
  - restore 時に embeddings の sha256 と content id を検査する。

## (4) 読んでいない範囲

- **`src/bench-recommender.ts` の未読部分**：main の full/required 配線（requiredFeatures の渡し方）、`validateRealPaperFixtures`、floor の値、`readFeatureStore`、`realPaperBenchmarkContentId`、`args.data` の既定値。bundle の required gate（`:65`）と nightly には `--data` がありません。
- **関連モジュール**：`src/semantic-content.ts`、`src/build.ts`（`evaluateHealthGate`、`embeddingsStale`、`writePublishManifest`）、`src/embeddings.ts`、推薦器本体。
- **補助スクリプト**：`scripts/semantic-content.ts`、`compare-head.ts`、`update-data-pr-body.ts`、`validate-data.ts`。
- **データ本体**：baseline JSON の 17 行目以降、features の jsonl、各 fixture。
- **運用の実データ**：CI、bundle、deploy の実行ログ、本番の `publish.json`、branch protection と required checks の設定、artifact の保持期間。
- **文書**：SPEC.md の 141 行目以降、README。
- **UI**：UI 改善全般は読んでいません。
