# agy独立レビューの照合と採否

対象: UI `beaddd7` と updater `0717f50`、共有祖先 `c06b9ff`。送信した抜粋42,441 bytesは `agy-integration-payload.json`のpayload文字列、送信先・SHA・設定維持は request/resume-request JSON。既存CLIのplan/sandboxで実行し、モデル・認証・課金設定を変更していない。最初の60秒の印刷待ちはレビュー未完了で、同じ会話を再開して最終SUCCESSを取得。査読は抜粋だけの静的評価で、ツール・ブラウザ・編集・再委任を禁止した。元回答は `agy-integration-findings.json`。

| 指摘 | 判断と根拠 |
| --- | --- |
| 再統合でCOMPSACの旧URL・出典を失う | 採用。単独の再処理で別名が1つになると再現。再処理は同じ配列を返し、混在した入力でも既存別名と出典を重複なく保持。6回の再処理を検証。 |
| ECIR overrideにmerge-slotsがない | 不採用。実データには `mode: merge-slots` があり、抜粋の選別でmodeを省いた。captured ECIRの未変更トラック保持と未知日付の再検証テストがある。抜粋による偽陽性。 |
| 選択後の候補が残る・選択行を描画しない | 不採用。再検索時にrenderが候補を隠し内容を消す。閉じて他候補を選び直せる表示は意図した挙動。通知など現在の絞り込みに含まれない候補も、検索条件を変えず詳細を開く。本指摘の「以後も古い候補が残る」は実装全体では再現しない。 |
| 別日程に論文募集の別名を流用 | 採用。現データのCOMPSACに別日程はないが、同じeditionに査読結果を追加した回帰で再現。確認済みの選択deadlineのみにsubmissionを保持。 |
| evomusart-2027は歴史identityを壊す | 不採用。既に公開されているcanonical keyを維持するupdaterの明示契約。過去editionのID・年度・日付を書き換えていない。UI branchで使うevomusartキーとの互換性は別途統合ブラウザで確認する。 |
| 会議タグをrowタグで上書き | 採用。通常のcandidateRowsではrowタグに会議タグも含まれるが、API境界では失い得る。双方のタグを集合にして保持し回帰検証。 |
| NaNの会期が不安定ソート | 不採用。compareEventRowsはNumber.isFiniteで未確認会期を末尾へ置く。掲載予定月を会期にしないためのNaNで、標準の数値引き算だけでソートしていない。 |

未解決質問の照合: IPSJの両記録は公式URL一致を実データ・ブラウザで確認済み。EvoMUSARTの公式保存blob `2710171d2ee3d422ec6bb0842872cac5add2e18259de3da70b4e6d7d00b190aa` に「Abstract registration deadline November 1, 2026」と「Submission deadline November 1, 2026」の両方がある。ECIRにはmerge-slotsがある。update-data workflowは316行付近でevidence_changedに応じ `git add data/evidence` を実行する。

独立レビューで指摘されなかった統合問題も検証した。EvoMUSARTのpaperだけのreplace-allは既存の公式abstractを消す。dry-runのみでmerge-slotsと、確認済み旧paper値（2026-11-02T11:59:00.000Zと2026-11-01）に限定した除去を組み合わせた。未知の値・他round/track・別kindは除去しない。候補0717f50の原本patchや実運用overridesは変更していない。

推薦特徴量の凍結基準との不一致は、未コミットのrecommender差分を外したHEADエンジンでも826候補に残る。共有祖先c06b9ffのエンジンでは0件。11のvenue_name_evidence、744のbase_score、61のlexical_scoreが異なる。凍結特徴量・基準やユーザーのrecommenderを変更して通さず、統合の阻害として残す。
