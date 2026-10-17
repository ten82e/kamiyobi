独立した反証レビュー結果を報告します。提供されたコード・仕様・ワークフローの範囲に基づき、既存評価の追認ではなく、最も強い反例と構造的欠陥を抽出しました。

---

### (1) この範囲で最も強い指摘

#### 1. 新規生成されたEmbeddingが全く評価されずにSealされる（検証バイパスの欠陥）
* **優先度**: 最高
* **状態**: 確定
* **成立条件**: `recommendation-bundle.yml` が実行され、`bench-recommender.ts` に `--real-v2-features` が渡されるすべてのケース。
* **原path/引用**:
  * `.github/workflows/recommendation-bundle.yml` L67-77: `Run full real-paper benchmark before sealing ... --real-v2-features data/benchmarks/real-paper-features.jsonl`
  * `src/bench-recommender.ts` L2651: `const useFrozenFeatures = requiredFeatures !== undefined;`
  * `src/bench-recommender.ts` L2668: `for (const language of useFrozenFeatures ? [] : usedLanguages) { // pipeline ロード処理 }`
* **運用への影響**: `recommendation-bundle.yml` は `src/embeddings.ts` を実行して新たな `public/embeddings.json` を生成しますが、その直後のベンチマーク検証において `--real-v2-features` を渡しています。これにより、スクリプトは**新規生成されたベクトルの推論を完全にスキップし、過去の固定スコア（Frozen features）を用いてベンチマークを通過**させます。その結果、モデルの破壊的変更やベクトル生成のバグがあっても検知されず、壊れた推論辞書が「フルベンチマーク通過済」として本番へSeal・デプロイされる致命的な穴が存在します。

#### 2. 新規追加Venueに対するSemantic Scoreの完全欠落
* **優先度**: 高
* **状態**: 確定
* **成立条件**: 運用中に `data.json` へ全く新しい会議（Venue）が追加された場合。
* **原path/引用**:
  * `src/bench-recommender.ts` L2759: `const inferredSemanticScores = useFrozenFeatures ? {} : ...`
  * `src/bench-recommender.ts` L2771-L2774: `const semanticScores = fixed?.semantic_scores ?? inferredSemanticScores;`
* **運用への影響**: 今回の変更（`derived/b8a7ba2-workflow.diff`）で `--real-v2-feature-baseline` が追加され、候補一覧の完全一致アサーション（L2793-L2799）を回避して新規Venueの追加が可能になりました。しかし、上記1の通り推論をバイパスしているため、**追加された新規VenueのSemantic Scoreは常に0点（データなし）として扱われます**。結果として、新設された会議はLexical一致がない限りレコメンドのTop-5に浮上できず、実質的に推薦機能から除外された状態でCIを通過します。

#### 3. Deploy時のStale-SHA判定におけるエラーのサイレントスキップ
* **優先度**: 中
* **状態**: 確定
* **成立条件**: `deploy.yml` 実行時に、GitHub APIのレート制限や一過性のネットワークエラーで `git ls-remote` が失敗した場合。
* **原path/引用**: `.github/workflows/deploy.yml` L34-L35: `current_main="$(git ls-remote ...)"`
* **運用への影響**: `set -e` などの厳密なエラーハンドリングが設定されていないため、`git ls-remote` が異常終了してもスクリプトはそのまま進み、`current_main` が空文字になります。結果として `TRIGGER_SHA` と一致せず `current=false` と判定され、**デプロイジョブ自体は「成功（Success）」扱いになるものの、実際にはデプロイが静かにスキップ（未実行）** されます。本番反映のサイレントな欠落を招きます。

#### 4. Health Baselineの盲目的なHEAD^フォールバックによる品質低下の連鎖
* **優先度**: 中
* **状態**: 推論（運用影響として）
* **成立条件**: `deploy.yml` で直近の成功アーティファクト（`deploy-health-baseline`）がダウンロードできず、かつリポジトリの `HEAD^` が「CIに失敗した低品質なコミット」であった場合。
* **原path/引用**: `.github/workflows/deploy.yml` L98-L102: `if [ ! -s /tmp/kamiyobi-health-baseline/health.json ]; then git worktree add --detach /tmp/kamiyobi-parent HEAD^ ...`
* **運用への影響**: ダウンロードに失敗した場合、無条件に親コミット（`HEAD^`）をビルドして比較ベースラインにしています。しかし、`HEAD^` が「最後にデプロイ成功した正常なコミット」である保証はありません。もし `HEAD^` がRegressionを含んでリジェクトされたコミットだった場合、現在の状態をその低品質な `HEAD^` と比較して通過させてしまうため、品質Gateの閾値が下がり続ける脆弱性となります。

---

### (2) 欠けた対照と別解（提案のみ、実行禁止）

* **欠けた対照（Embeddingの動的検証）**: 固定特徴量（`--real-v2-features`）でのCI保護とは別に、生成直後の `public/embeddings.json` を実際にロードして、スコア分布やTop-5の変化幅を検証する動的なテストパスが欠落しています。
* **別解（Deploy時の確実なベースライン確保）**: `deploy.yml` で `HEAD^` にフォールバックするのではなく、L92 の `gh run list` で取得した最後の成功ランの `headSha` を抽出し、その SHA をチェックアウトしてベースラインをビルドするべきです。
* **別解（Deployトリガーの排他制御）**: `git ls-remote` の不安定なAPI通信に依存するのではなく、GitHub Actionsの `concurrency: pages-main` だけで直列化を担保しつつ、デプロイ時に「対象のコミットが現在のローカル `origin/main` の祖先であるか（`git merge-base --is-ancestor`）」を検査する方がフェイルセーフです。

---

### (3) このpacketから支持できること

1. **データ更新フローの堅牢性（Fail-safe / Race-safe）**
   `update-data.yml` は、更新データを強引にPushせず `tests/update_data_fast_forward.test.ts` で証明されている通り、変更を独立ブランチで生成した上でFast-forwardマージを試みます。並列で別データがPushされた場合の競合破壊を防ぐ設計が機能しています。
2. **上流障害に対する保護（Circuit Breaker）**
   `update-data.yml` L65-L71 で、取得失敗（unreachable/retryable）が90%を超え、かつ対象が10件以上ある場合は、上流（各会議サイト）やネットワーク網の異常と見なして台帳の破壊的更新（全てを終了済みにする等）をブロックして異常終了する制御は非常に理にかなっています。
3. **オフラインビルドの自己完結性**
   `offline-build` ジョブにて、埋め込みベクトルを持たない（Lexical-only）状態であっても、静的サイトとしての最低要件（データ生成、Recommenderスクリプトの存在）を満たして稼働できる設計になっていることが証明されています。

---

### (4) 読んでいない範囲と意思決定への影響

* **読んでいない範囲**: React/UIコンポーネントの実装、スクレイピングの具体的処理（`data/manual.yaml` 等）、CLIの内部ルーチン（`src/cli.ts`, `src/embeddings.ts`, `scripts/semantic-content.ts` の詳細）、および本リポジトリ外のマスラボ/ACT-X関連環境。
* **既知の制限と意思決定への影響**: `SPEC.md` に記載された上流データ（`ccfddl`, `ai-deadlines`）のスキーマの罠（TBDの存在、タイムゾーンの揺れ、idが重複する等）や「Git APIを利用しない」制約は新発見として扱いません。しかし、これらの制限によって「IDに依存せず内容のセマンティクスで同一性を保証する」必要が生じ、結果として `semantic_content_id` のようなハッシュベースのSeal機構（L26-28）を作るという現在のアーキテクチャの意思決定に直接繋がっています。

