# updater候補の互換修正

元の候補 `0717f50` とmain前提 `b35010f` は変更しない。追加差分は `updater-compatibility.patch.gz`、入力・出力SHAと特徴量の監査は隣のmanifest。実UIブランチへ候補のconfig・学習データ・モデルを適用していない。

## 元の7失敗の原因

| 失敗 | 診断と修正 |
| --- | --- |
| 凍結推薦基準1件 | `ca305a3` の日本語分割・分野検出・3文字略称照合が、共有祖先で生成した特徴量に反映されていなかった。保護中の未コミット差分を外した `b2739fa` のエンジンでも同じ826候補差分を再現した。日本語改善を戻さず、変更理由を照合して再凍結した。 |
| 検索の固定件数5件 | CVMの公式訂正履歴の「前」と、EvoMUSARTの新しいidentityに適用される観測の「の」が当時の入力に追加された。当時のoverrideとidentity設定をテスト用に隔離。期待件数・検索実装・productionの公式訂正履歴は変更しない。DASFAAも当時のUTC instantをfixtureだけに保持する。 |
| mergeの期待値1件 | 旧UIのcanonical `evomusart` を期待していた。公開済みの `evomusart-2027` を維持する候補の契約に合わせ、その代わりに旧UI keyが明示的別名として保持されることを検証する。 |

旧URLを開けない問題は実装上の不具合だった。mergeから配信catalogまで確認済みの別名を保持する。source IDが一致する確認済みのidentity設定から `legacy_keys` を読み、予約済みの他のcanonical keyとの衝突を除く。UIは年・kind・時刻・slotを変えず照合する。同時刻の別round/trackは選択を求め、別の行を黙って開かない。

## 推薦データの更新条件

不変の `real-paper-feature-baseline.json` と既存の意味検索値を入力に、committed `b2739fa` のエンジンで201件を再計算した。全件のpaper ID、profile hash、model revision、record SHA、semantic scoresは同一。3つのmanifestもバイト一致。モデル取得・論文本文の再取得・意味検索値の生成は行っていない。

共通候補の変更はbase_score・lexical_score・venue_name_evidenceだけ。日本語の分野検出により、full fixtureの一部に日本の研究会・特集号の候補が追加された。削除された候補はない。完全な差分の件数と追加先はmanifestに記録した。required subsetの826件と、full coverageの共通候補1,464件は範囲が異なる。

v3の同じ決定的trainerでdevのみから再学習・校正する。heldoutは品質評価だけで、学習や選択へ使わない。「十分な一致」の解禁条件は満たしていないため引き続き無効。#687の採用判断の3つの来歴フィールドは過去の判断として保持し、新しいheldoutによる昇格判断とはしない。custom pathやv4実験にはその来歴を付けない。

凍結候補の厳密一致と改ざん拒否テスト、required/fullの品質floorを維持する。immutable baselineの検証では全候補と全品質指標を一度評価し、50/100/200件の候補数診断は外側の現在データの評価で測る。16論理CPUを使う一斉テストでCPU競合が起きたため、再現helperは並列workerを4に制限する。60秒の個別test timeoutは変更しない。

## 再現

本体のUI修正commitを含むHEADと、元の候補Git objectが必要。7つの保護差分は既存verificationのSHAと一致させる。既存archiveを上書きしない。

```sh
python3 scripts/agent-handoff/prepare-integration.py
node scripts/agent-handoff/resolve-integration.mjs
python3 scripts/agent-handoff/apply-compatibility.py
python3 scripts/agent-handoff/verify-integration.py
python3 scripts/agent-handoff/browser-integration.py
```

prepareはcommitted archiveと明示した保護7ファイルから入力を読む。未記録の作業ツリーを3-wayへ混ぜない。prepare/resolve/applyは `KAMIYOBI_INTEGRATION_ROOT` でignored verification配下の別archiveでも適用SHAを再検証できる。browser/verifyは既定archiveを使用する。

featuresの再生成手順はarchive内で、元の意味検索値を渡し `--data data/benchmarks/real-paper-feature-baseline.json` とfull dev/heldout/negativeを指定、`--write-required-features <出力>` を付ける。その後dev-only trainerを既定の入力・出力で実行する。固定データや意味検索値を現在のpublicから作り直さない。再生成時のエンジンrevisionはmanifestと一致させる。

EvoMUSARTの公式保存blobにある概要・論文の11月1日は双方date-onlyを保持する。EvoMUSARTの変更のない旧概要URLは開く。訂正された旧論文時刻のURLでは、日時が一致しない旨と現在の同じ会議・年度・kindの日程を示し、利用者が確認して選ぶ。古い時刻を現行の日付へ流用せず、現在の共有URLで再読み込みできる。ECIRの公式訂正で廃止した古い時刻のリンクは「収録なし」と明示し、別の締切へ推測転送しない。歴史1,673開催回の年度・ID・原会期・event_start/endは変更しない。push/merge/deployとPR955の再試行は行わない。
