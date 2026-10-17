# kamiyobi — 独立反証レビュー 20261004T114256Z

固定HEAD: `de682df04334d5126d4a1ccbc994ebe2c30c1bf0`
入力SHA256: `05d2ab9ef29caaf47feede2cdef449d1888c5b0f5189b09e9a2a36b7f6daabb3`

Claude CodeとGoogle Antigravityの実CLI回答を別々に取得した記録。両者は同じpacketを読み、相手の回答も調整担当の照合結果も見ていない。下の要点は回答後の整理であり、外部回答の原文ではない。

- 両者: frozen semantic featuresを使うgateは、生成直後のembedding品質そのものを検査していない。固定入力によるコード回帰防止と新しいsemantic artifactの評価範囲を明示する必要がある。
- 照合: immutable baselineを先に厳密比較する変更は残っており、candidate照合を全面無効化したわけではない。新venueの本番semantic scoreが必ず0になる、との断定はpacketから導けない。
- Claude: gateだけ変更しても古いsealed bundleを再利用する経路と、遅れて来たstale workflow_runが新しいpending pushを置き換える可能性。前者は固定sourceと照合、後者は条件付きの公開遅延で、発生履歴は未確認。
- Claudeの--now不一致によるsemantic公開失敗説は未確定。調整担当が固定HEADを読むと、profile hashに時刻・締切そのものは入らない。verified-reportsへ単純切替する案にもfull benchmark identityの整合確認が必要で、この注意は調整担当の追記。
- Agy: main取得失敗がstale扱いの成功skipになる可能性。照合では原因をdefault bashの-e欠如ではなく、git ls-remote | cutでpipefailが無いことと修正した。後段の等値testは空SHAを拒否する。[GitHub公式shell仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defaultsrun-shell)。
- Agy: health artifact欠落時のHEAD^はlast successful deployとは限らない。影響は条件付きで、品質低下の連鎖が実測されたわけではない。祖先判定だけへ弱める代替案は採用しない。

原回答: [Claude Opus 5.5](claude/review.md) / [Agy Gemini 3.1 Pro High](agy/review.md)。断定を含む原文を改変せず保存した。採否・反例・正確な引用箇所とhashは調整担当の [verification.json](verification.json) を参照。

再現用の範囲: [packet.txt](packet.txt)、[manifest.json](manifest.json)、両者のrequest/metadata/execution-evidence。requestはコマンド・時刻・対象hash、metadataは成功・モデル・ツール使用ゼロを記録する。ClaudeのcostUSDはlist-price相当メタデータで追加請求の記録ではない。既存Max認証、全run overage=false。Agyは既存認証済み公式print経路を確認し、CLI init modelを記録した。Agy resultには第二のprovider modelフィールド・契約情報はない。

追加実験・研究テスト・remote job・push・merge・deploy・GUI操作は行っていない。実装ファイルや既存記録は変更せず、新しい日時付きreviewフォルダだけを作成した。範囲外の停止済み2プロジェクトは読んでいない。全repo監査や新しいHEADの承認ではない。

snapshot後の動き: [source-drift.json](source-drift.json)。supplementalがある場合、それは回答後の調整担当による根拠照合であり、独立レビューの入力へ後付けしたものではない。
