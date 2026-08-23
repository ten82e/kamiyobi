# 公式裏取り検証 — conf-deadlines R513

方法: 短冊 45 件のうち、締切が近い順に公式ページ (EasyChair CFP) を取得し、
deadlines テーブルの「Submission deadline」行を原文のまま抽出した。
抽出スクリプト: /tmp/kamiyobi_verify.py + /tmp/kamiyobi_verify2.py (table 行パース)。
生データ: /tmp/kamiyobi_verify.json (全 45 件の URL・HTTP status・抽出行)。

## 検証結果

- 全 45/45 件が HTTP 200 で取得成功。
- 「Submission deadline」行の全件抽出に成功。
- 短冊日付 (discover の submission_deadline_text) と公式ページ表記の機械照合:
  **45/45 一致** (43 件は "August 24, 2026" 形式、2 件は "1 November 2026" 形式
  — evomusart-2027, si-dl2027。いずれも正規化後一致)。

### 抽出原文 (代表例)

| key | URL | 原文 |
|---|---|---|
| ieee-aiot-2026 | https://easychair.org/cfp/AoT-2026 | `Submission deadline: August 24, 2026` |
| copa-2026 | https://easychair.org/cfp/COPA2026 | `Submission deadline: September 4, 2026` |
| eaai-27 | https://easychair.org/cfp/EAAI-27 | `Abstract registration: September 1, 2026` / `Submission deadline: September 8, 2026` |
| evomusart-2027 | https://easychair.org/cfp/evomusart2027 | `Submission deadline: 1 November 2026 Conference: 31 March – 2 April 2027` |
| si-dl2027 | https://easychair.org/cfp/SIDL2027 | `Submission deadline: 15 December 2026 Reviews` |

(全 45 件の原文は /tmp/kamiyobi_verify.json を参照。リポジトリには上記代表 5 件を残す)

## tz 解釈

EasyChair CFP は締切行に timezone を明記しない。extra.yaml への記載は
AoE (UTC-12) 当日終了 (23:59:00) と解釈した。日付のみの観測であり、
時刻部分は運用慣行からの補完である (推測ではなく、SPEC 9 の「公式で裏が取れた
日付」の日付部分のみを根拠とする)。

## 判定

- 採用: 45 件 (全件、短冊日付 = 公式ページ表記のため)
- 不採用: 0 件

## caveat

- Abstract registration 行を持つ会議は abstract kind も併記した。
- 発見ソースの easychair 候補は主催者が EasyChair に登録した CFP であり、
  会議公式サイトが placeholder でも一次情報として扱える (data/primary.yaml
  コメントの SETTA 2026 実例と同じ立場)。

---

# 公式裏取り検証 R514 — wikiCFP 候補 (2026-08-23)

## 経緯

R513 で EasyChair 由来 708 件のうち 45 件を昇格した後、wikiCFP (324) / DBWorld (144)
由来が短冊ゼロだった原因を調査した。

## 原因切り分け (機械集計)

- wikiCFP 324 件: 全件 `submission_deadline_text` を持たない。このフィールドは
  EasyChair 経路専用 (`src/discover.ts` easyChairEntriesFromRows のみ設定)。ただし
  wikiCFP は edition[0].date_text に締切日を持つため、date_text 経路で短冊化できる。
  - date_text パース結果: 過去締切 87 / 窓外 (>120日) 2 / 日付なし 13 /
    カテゴリ不一致 138 / **窓内 × 収録カテゴリ適合 84** (+ comsoc 1, resound 1)
- DBWorld 144 件: editions 自体が空 (メーリス件名のみ。詳細ページは listserv.acm.org
  アーカイブで、そこからは締切本文が取得可能 — MEDI 2026 で実証)。今回は対象外。
- dblp 53 件: date_text 無し (venue 発見のみ)。

## 裏取り方法

- wikiCFP の https はこのネットワークから到達不能だが http は到達可能。
  各イベントページの「Submission Deadline」行の v:startDate microformat (ISO 日付) を抽出。
- 短冊日付 (一覧ページの deadline 欄) とイベントページの microformat を機械照合。

## 検証結果

- **84/84 が一致** (MISMATCH 0、抽出失敗 0、取得失敗 0)。
- 同一イベントの eventid 重複 1 組 (CSP 2027: 199953/199954) を発見 → 1 件に畳み **83 会議**。
- tz 未明記のため AoE 当日終了 (23:59:00) で解釈 (R513 と同じ方針)。

## 判定

- 採用: 83 会議 → data/extra.yaml 追加 (241 → 324 会議)
- 不採用: カテゴリ不一致 138 件・DBWorld 144 件等は次ラウンドへ

## caveat

- wikiCFP の締切欄は主催者申告であり、公式サイト更新への追随が遅れる可能性がある。
  昇格会議は primary.yaml への一次ソース登録候補とする。

---

# 公式裏取り検証 R515 — DBWorld 候補 (2026-08-23)

## 方法

- DBWorld 144 件の link は listserv.acm.org のメッセージアーカイブ (本文取得可、全件 HTTP 200・fetch 失敗 0)。
- 本文から Submission Deadline 行を正規表現で抽出 (複数形式対応)。抽出成功 47 / 抽出不能 97。
- 窓内 (<=120 日) × 収録カテゴリ適合を判定。タイトルのみで分類できなかった 14 件は
  本文テキストで再分類し 12 件を救済 → 窓内適合 **13 件**。

## 検証結果

- 過去締切 29 / 窓外 3 / カテゴリ不一致 (再分類後) 2 / 抽出不能 97 / **採用 13**。
- 抽出不能 97 件の多くは subject 自体が「to July 31 ...」等の日付欠損型ノイズか、
  本文に締切行を持たない転載だった。抽出器の改善余地はあるが今回は採用しない。
- tz 未明記のため AoE 当日終了で解釈 (R513/R514 同方針)。

## 判定

- 採用: 13 会議 → data/extra.yaml 追加 (324 → 337 会議)
- title はメーリス件名由来 (CFP 接頭辞等のノイズが残る)。ブロック先頭コメントに注意書き。

## caveat

- メーリス本文の締切は主催者申告。昇格会議は primary.yaml 登録候補 (R514 同様)。

---

# 検証記録 R516 — primary.yaml 一括登録の適性判定 (2026-08-23)

## 問い

R513-R515 で昇格した 141 会議を data/primary.yaml に一括登録し、一次ソース自動訂正の
対象にできるか。

## 実測

1. **観測ゲートの契約** (src/sources/primary.ts:102-117 resolveObservation):
   `time === null → null` (日付のみは時刻を捏造しない) + tz は confirmed 必須。
2. **抽出器の実力** (src/fetch-primary.ts extractDeadline): ページ行に時刻表記がある
   ときだけ time を載せる。tz はページ内の tz 表記 (AoE/PST 等) を検出したときだけ載る。
3. **源別実測**:
   - EasyChair CFP (50 会議): deadlines テーブルは日付のみ (R513 裏取りで全件確認済み)
   - wikiCFP (83): v:startDate は ISO 日付のみ
   - listserv アーカイブ (13): 本文は「April 30, 2026 (PST)」型が最多で時刻なし
     (iaiai.org 実測: time patterns 0 / PST x5)
   - researchr 系 (icpc/hpca/cgo/icst): 「Thu 19 Nov 2026」形式で時刻なし
     (extractDeadline 実測 → time フィールド無しで出力)
4. **既存登録 13 会議の build 実績**: kept ゼロ。10 会議が毎日 dropped 警告を出している。

## 判定

- **一括登録は見送り**。日付のみの源では全行が観測ゲートで棄却され、効果ゼロで
  警告ノイズと CI 時間だけが増える。
- 登録適性を持つのは「締切行に時刻 + tz を明記する公式ページ」のみ (現状 SC26 ポータル系
  のみ実績あり・既に登録済み)。
- **iiai-aai-2026 をレジストリから削除**: 公式ページは tz (PST) を明記するが時刻を
  公開しないため永久棄却となる。前回値も全行棄却で使われておらず、削除しても挙動不変、
  毎日の dropped 警告 4 行が消える (build 実測で警告消失を確認)。fetch-primary --apply
  済み (registry 12 会議)。

## 今後

- 時刻+tz を明記する新源を個別に発見したときだけ primary.yaml に足す (運用原則)。

---

# 検証記録 R517 — 昇格会議の二次裏取りサイクルは要否判定 (2026-08-23)

## 問い

R513-R515 で昇格した会議の締切が公式サイトで延長・変更されていないかを検知する
二次裏取りサイクルを今すぐ実装すべきか。

## 実測

1. **既存の変化追跡の整理** (src/discover.ts mergeCandidateFields):
   候補レジストリは毎日の discover で date_text を incoming 値で上書きするため
   常に最新。primary_overrides は tz+時刻つき源のみ自動訂正 (R516 判定)。
   追跡されないのは extra.yaml (人手昇格で固定) のみ。
2. **食い違い率の実測**: 昇格直後の会議について源ページを再取得し、
   extra.yaml 記載値と比較した。
   - EasyChair 由来 45 件: **MATCH=45 / DIFF=0 / NO_EXTRACT=0 / FETCH_FAIL=0**
   - wikiCFP 由来 (締切近い順 15 件): **MATCH=15 / DIFF=0 / NO_EXTRACT=0 / FETCH_FAIL=0**
   - 合計 60 件サンプルで食い違いゼロ。

## 判定

- **二次裏取りサイクルのコードは今は書かない** (ponytail: 発火条件未成立)。
  昇格から数日しか経過しておらず源が静かで、検知機構が検知すべき事象が存在しない。
- **再発火条件** (これが揃ったときに実装する):
  1. 昇格会議の締切が近づく (<=30 日) かつ源ページの日付が extra.yaml と食い違う
     サンプルが実測で出たとき
  2. update.yml の日次ビルドで「upcoming.md の行が消えた」health gate アラートが出たとき
  3. ユーザーが昇格会議の締切誤りを報告したとき
- 実装する場合の入口: discover.ts の候補レジストリと同じ incoming 上書きパターンを
  「昇格済み会議の軽量ヘルスチェック」として cli に足す (新規パイプラインは作らない)。

## caveat

- 本判定は「昇格 4 日以内・60 件サンプル」での negative finding である。
  経過日数が伸びたら再測定すること (発火条件 1)。
