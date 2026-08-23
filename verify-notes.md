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
