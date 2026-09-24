# kamiyobi 設計仕様（実装の正）

HPC・ネットワーク・システム・AI 系会議の投稿締切と開催日を、ローカルの CLI で
収集・検査し、JSON / CSV / Markdown / 静的サイトとして公開する。
手元の更新手順は `README.md` の「更新の仕組み」に定める。
`.github/workflows/` の GitHub Actions は同じ検査を CI で実行し、main への push で
Pages 配信とデータ更新 PR を扱える。

この文書は実装の契約である。ここに書かれた型、関数シグネチャ、ファイル構成から逸脱しない。
プロジェクト名は `kamiyobi` とする。

## 1. データ源（実データ全件走査で検証済み・2026-08-09 時点）

| 名前 | リポジトリ | ライセンス | 形状 |
|---|---|---|---|
| `ccfddl` | `ccfddl/ccf-deadlines` (main) | MIT | `conference/**/*.yml` **353 本 / 1150 版** |
| `aideadlines` | `huggingface/ai-deadlines` (main) | MIT | `src/data/conferences/*.yml` 68 本 / 122 版 |
| `local` | 本リポジトリ `data/manual.yaml` + `data/curated.generated.yaml` | - | 上流が扱わない会議 |

取得方法は **tarball 一括ダウンロード**（`https://codeload.github.com/<repo>/tar.gz/refs/heads/main`）。
Git API のファイル単位取得はレート制限に当たるので使わない。

### 1.1 ccfddl のスキーマ（実データから確認済み）

```yaml
- title: SIGCOMM
  description: ACM International Conference on ...   # = full_name
  sub: NW                                            # AI CG CT DB DS HI MX NW SC SE
  rank: {ccf: A, core: A*, thcpl: A}
  dblp: sigcomm
  confs:
    - year: 2026
      id: sigcomm26
      link: https://...
      timeline:
        - abstract_deadline: '2026-01-30 23:59:59'   # 任意
          deadline: '2026-02-06 23:59:59'            # 必須
          comment: '...'                             # 任意
      timezone: AoE
      date: August 17 - 21, 2026                     # 自由文
      place: Denver, Colorado, USA
```

**確認済みの罠（実測値つき。推測ではない）**

1. **再帰探索が必要**。`conference/*/*.yml` の 1 階層グロブでは `conference/DB/pods/pods.yml`
   を取りこぼす。`conference/**/*.yml` で辿り、`conference/types.yml`（分野定義であり
   会議ファイルではない）を除外する。結果は 353 本 / 1150 版。
2. `timeline` は配列で **複数ラウンドあり**（NSDI は年 2 回）。
   ただし **timeline は締切昇順とは限らない**（`sac26`・`issre23` で逆順）。
   配列添字で会議を識別しない。
3. **キー `abstract deadline`（空白入り）が実データにちょうど 1 件**存在する。
   `abstract_deadline` と同義に扱う。
4. **本文締切のキー名は `deadline`**（1591 件）。`kind_of` はこれを `paper` に落とすこと。
   ここを落とすと本文締切が全滅する。
5. `timezone` の実在値は 19 種（全件一致を確認）:
   `AoE`(622) `UTC-12`(216) `UTC-8`(59) `UTC+0`(55) `UTC-7`(44) `UTC`(40) `UTC+8`(29)
   `UTC-5`(28) `UTC-4`(23) `PT`(10) `UTC+1`(7) `UTC+7`(3) `UTC+10`(3) `UTC+2`(2)
   `UTC+3`(2) `UTC-10`(2) `UTC-11`(2) `UTC-6`(1) `UTC+9`(1)。
   `PT` は固定オフセットにしてはならない。VLDB は毎月 1 日の締切を持ち夏時間境界をまたぐ。
6. `date` は自由文。構造化された開始終了日は **無い**。実在形状の上位:
   `July 20-23, 2026` / `September 29 - October 3, 2025` / `Oct 12-16, 2025` /
   `June 28 - July 2, 2026`。
   §3 の 6 例をそのまま正規表現化した厳密版で **96.4%**、月略記の `.`・en dash・`Sept`
   を許した寛容版で **97.4%** が構造化できる。
   月のみ（`November, 2026`）・月範囲（`March-April, 2025`）・括弧内 TBD 注記・`Septemper` typo も受け、実測 **99.4%**（1143/1150、残 7 件は TBD/TBA/年のみ）を満たす。
   目標は 95% 以上。
7. 非日付は `deadline` に `TBD` が 4 件、`date` に `TBD` が 3 件（`cgo2027` `iss25` `sp27`）。
   パース失敗はスキップし警告を出す（例外にしない）。
   `confs` 空・`timeline` 空・`deadline` 欠落・不正日付形式は 0 件。
8. **`id`（edition_id）は一意でない。** 重複 5 種を実測:
   `ica3pp` は 2022/2023/2025/2026 の 4 版すべてが同じ `id: ica3pp`（年が入っていない）。
   `fse23` `fse24` `fse25` `fse26` は `SC/fse.yml`（Fast Software Encryption）と
   `SE/fse.yml`（Foundations of Software Engineering）という **別会議**が同じ id を使う。
   `edition_id` は表示用であり、会議の識別には使わない。
9. `year` と `date` の年がずれる版がある（`ICA3PP 2023` は `date: 'October 20-22, 2022'`）。
   `parse_date_range` は date 中の明示年を優先するので、開催日が過去年になる。許容する。
10. rank 値 `'N'` はランク無しの意味（`ccf: N` 33 件、`core: N` 78 件）。
    `core` キー自体の欠落が 3 件（`codes-isss` `hipeac` `performance`）。
    §5 の rank_filter は `'N'` を「該当ランク無し」として扱い、通過条件に数えない。

### 1.2 huggingface/ai-deadlines のスキーマ（実データから確認済み）

```yaml
- title: NeurIPS
  year: 2026
  id: neurips26
  full_name: Conference on Neural Information Processing Systems
  link: https://neurips.cc/
  deadlines:
    - {type: abstract, label: '...', date: '2026-05-04 23:59:59', timezone: AoE}
    - {type: paper,    label: '...', date: '2026-05-06 23:59:59', timezone: AoE}
  date: December 6-12, 2026
  start: '2026-12-06'      # 構造化。113/122 版に存在
  end: '2026-12-12'
  city: Sydney
  country: Australia
  era_rating: a
  rankings: 'CCF: A, CORE: A*, THCPL: A'   # 自由文字列。構造化 dict ではない
  tags: [machine-learning]
```

**確認済みの罠（実測値つき）**

1. **旧形式は 13 版**（`deadlines` キー自体を持たない）。うち 8 版がトップレベルに
   `deadline` / `abstract_deadline` / `timezone` を直に持つ。
2. **`cvpr26` は新旧両形式を併存させている**（`deadlines` 7 本 + トップレベル `deadline`）。
   **`deadlines` があるときはトップレベルの `deadline`/`abstract_deadline` を読まない。**
   両方読むと二重登録になる。
3. **締切を一切持たない版が 10 版**（うち 5 版は `deadlines: []` の空リスト）。
   開催イベントのみとして扱う。
4. `deadlines[]` に規定外キーが 1 件（`cec2025` が `date` と `deadline` の両方を持つ）。
   `date` を正とする。
5. `deadlines[].type` の実在値は 20 種:
   `abstract` `paper` `submission` `supplementary` `registration` `reviewer_registration`
   `commitment_deadline` `notification` `first-notification` `final-notification`
   `review_release` `rebuttal_start` `rebuttal_end` `rebuttal` `rebuttal_and_revision`
   `author_response` `withdrawal` `camera_ready` `camera-ready` `revision-deadline`。
6. `timezone` の実在値は 12 種: `AoE` `UTC` `UTC+0` `UTC-08`（ゼロ埋め） `UTC-8` `UTC-7`
   `UTC-5` `UTC+02` `GMT+02` `PST` `Europe/London` `Pacific/Honolulu`（IANA 名）。
7. **ccf/core の構造化ランクを持つ版は 0 / 122。** `rankings` は
   `'CCF: A, CORE: A*, THCPL: A'` という自由文字列（64 版）か `None`（58 版）。
   §3 の `parse_rankings` でこれを dict に落とす。
8. ファイルはリスト形式のこともスカラー（単一 dict）のこともある。両方受ける。
9. トップレベルに `rebuttal_period_end` `final_decision_date` `review_release_date` が
   各 2 件ある。**これらは読まない**（`deadlines` を持つ版にのみ現れる冗長データ）。
10. `date`/`start`/`end` が全て無い版が 1 件（`eurographics27`）。

---

## 2. ディレクトリ構成

```
kamiyobi/
├── SPEC.md                      # 本書
├── README.md                    # 利用手順（手書き。自動更新しない）
├── LICENSE                      # MIT
├── NOTICE.md                    # 上流 MIT の帰属表示
├── package.json                 # 依存・スクリプト (npm test / build)
├── tsconfig.json                # TS 設定
├── biome.json                   # lint/format
├── config.yaml                  # 収録範囲・カテゴリ定義
├── .github/workflows/
│   ├── ci.yml                   # typecheck / lint / test / offline build / データ検査
│   ├── deploy.yml               # main の Pages 配信
│   ├── nightly.yml             # 実論文ベンチと再確認マニフェスト
│   ├── recommendation-bundle.yml # 埋め込み bundle の封印
│   └── update-data.yml          # 上流取得とデータ更新 PR
├── data/
│   ├── extra.yaml               # 旧データからの移行入力
│   ├── manual.yaml              # 手入力の local 正典
│   ├── curated.generated.yaml   # promotion batch から生成する local 正典 [自動]
│   ├── overrides.yaml           # 上流の訂正・別名・カテゴリ上書き
│   ├── primary.yaml             # 一次ソース URL 一覧
│   ├── primary_overrides.yaml   # 一次ソース抽出結果（自動）              [自動]
│   ├── discovered_candidates.yaml # discover の既定出力
│   ├── discovery/                # active 候補と archive 候補
│   ├── promotions/                # 証拠付き promotion batch
│   ├── recommender-reranker.json # 軽量推薦 reranker の固定係数
│   ├── verification-ledger.json # 公式ページ再確認の永続台帳
│   ├── source-snapshots/          # データ源ごとの復元用スナップショット
│   ├── validator-findings.json    # 検証警告のレビュー状態
│   ├── semantic-reconciliation.json # Issue/PR の意味照合結果
│   ├── evidence/blobs/             # promotion・再確認本文の共通 content-addressed 保存
│   ├── evidence/index.json         # 証拠本文の参照整合性インデックス
│   ├── benchmarks/real-paper-features.jsonl # 論文特徴量の正典ストア
│   ├── benchmarks/*-manifest.json # 特徴量 split のハッシュ・件数契約
│   └── snapshot.json            # 生成物(コミットされる。上流障害時の退避) [自動]
├── src/
│   ├── capture.ts               # raw-byte page取得・制限・SSRF/redirect防御
│   ├── model.ts                 # 型・時刻解決・日付パーサ・snapshot 入出力
│   ├── args.ts                  # CLI の短縮引数互換
│   ├── util.ts                  # 共有ユーティリティ（配列正規化等）
│   ├── sources/
│   │   ├── base.ts
│   │   ├── ccfddl.ts
│   │   ├── aideadlines.ts
│   │   ├── local.ts             # manual + curated.generated 読み込み
│   │   └── primary.ts           # 一次ソース観測の検証済み適用
│   ├── merge.ts                 # 名寄せ・分類・上書き・推定
│   ├── discover.ts              # 穴場会議・ジャーナル自律探索
│   ├── fetch-primary.ts         # 一次ソース自動抽出
│   ├── review-candidates.ts     # 候補レビュー支援
│   ├── promotion.ts             # 候補昇格の観測・検証・決定
│   ├── reverify.ts               # 公式ページ再確認と台帳更新
│   ├── evidence.ts              # 証拠本文の検証・インデックス・回収
│   ├── identity-migration.ts     # health gate 用の明示的 identity 移行契約
│   ├── semantic-content.ts     # sealed bundle の semantic_content_id 算出
│   ├── embeddings.ts            # 埋め込み生成
│   ├── bench-recommender.ts     # 推薦ベンチ
│   ├── build.ts                 # JSON/CSV/MD/llms.txt/HTML 出力
│   └── cli.ts                   # エントリポイント
├── site/
│   ├── tsconfig.json            # strict なブラウザ TypeScript の型検査
│   ├── tsconfig.build.json      # public/ 用 JavaScript emit
│   ├── template.html            # コア UI（表・絞り込み。外部 CDN なし）
│   ├── app.ts                   # ブラウザ UI 実行時処理
│   ├── recommender.ts           # 論文推薦（§10。任意 CDN）
│   ├── recommendation-core.ts   # browser / benchmark / test 共通の推薦軸
│   ├── publish.ts               # publish manifest のブラウザ側検証
│   └── runtime.d.ts             # ブラウザ・生成データの型境界
├── scripts/
│   ├── compare-head.ts          # snapshot / primary_overrides の実質差分
│   ├── health-gate.ts           # 直近の健全な公開結果との配信前健全性ゲート
│   ├── generate-curated.ts      # promotion 正典から local 正典を再生成
│   ├── generate-venue-profiles.ts # 出典情報付きプロフィール成果物の再生成
│   ├── observe-cfp.ts           # CFP 本文・応答・抽出候補の保存
│   ├── refresh-ieice.ts         # 研究会発表申込システムから国内研究会の会期・締切を更新
│   ├── restore-recommendation-bundle.ts # 互換推薦 artifact の検証・復元
│   ├── seal-recommendation-bundle.ts # semantic_content_id 付き bundle 封印
│   ├── semantic-content.ts     # semantic content id の算出 CLI
│   ├── train-reranker.ts       # dev-only reranker 学習・CV・校正 artifact 生成
│   ├── validate-data.ts         # 公開データの意味検査
│   ├── verify-cfp.ts            # CFP 観測の項目別検証
│   ├── promote-candidates.ts    # promotion batch の決定・manifest 生成
│   ├── reverification-manifest.ts # VerificationState からの再検証マニフェスト生成
│   └── check-reproducible-build.zsh # 固定時刻ビルドの再現性検査
├── public/                      # 生成物(git 管理外)
├── tests/                       # vitest
```

**ビルドは手書きのファイル（README.md 等）を書き換えない。**

---

## 3. 凍結インタフェース（`src/model.ts`）

```ts
// 型・時刻解決・日付パーサ・snapshot 入出力（src/model.ts）
interface DeadlineBase { kind: string; label: string; round: number; track?: string; comment: string | null; }
export interface ExactDeadline extends DeadlineBase { precision?: "exact"; at_utc: Date; tz_raw: string; }
export interface DateOnlyDeadline extends DeadlineBase { precision: "date-only"; local_date: string; }
export type Deadline = ExactDeadline | DateOnlyDeadline;
export interface DeadlineEstimate { point_estimate: string; window_start: string; window_end: string; source_editions: number[]; method: "median-interval"; confidence: "low" | "medium"; }
export interface Edition { year: number; edition_id: string; link: string; place: string; date_text: string; event_start: Date | null; event_end: Date | null; deadlines: Deadline[]; estimated: boolean; estimate?: DeadlineEstimate; source: string; }
export interface Conference { key: string; title: string; full_name: string; link: string; rank: Record<string, string>; dblp: string | null; upstream_sub: string | null; tags: string[]; categories: string[]; editions: Edition[]; sources: string[]; }
```

### 3.1 キーの決め方（衝突が実在するので規則を凍結する）

```ts
// src/model.ts
export function slug(title: string): string;
// 小文字化、英数字以外を '-'、連続 '-' を畳む、前後 '-' 除去
// 'Hot Interconnects' -> 'hot-interconnects', 'IH&MMSec' -> 'ih-mmsec'
```

各データ源の Conference は `key = slug(title)` を持つ（ccfddl・aideadlines・local 共通）。
**同一 key に別会議が載ったときは merge_sources が upstream_sub で分割する**
（§3.6）。`key_overrides` のような設定は持たない。

実データで確認された衝突は 2 組。`venue_identities` と
`merge_sources` の分割で解決する。

| 上流 | title | 実体 | 解決後 key |
|---|---|---|---|
| `SC/fse.yml` | FSE | Fast Software Encryption | `fse-sc` |
| `SE/fse.yml` | FSE | Foundations of Software Engineering | `fse-se` |
| `DS/sec.yml` | SEC | ACM/IEEE Symposium on Edge Computing | `sec` |
| `SC/sec.yml` | SEC | IFIP Information Security Conference | `sec-sc` |

**新たな衝突が上流に生じたら検証を失敗させる。** `tests/merge.test.ts` で
「同じ key を共有する会議が 0 件（sub 分割後）」を検査する。
自動で `-{sub}` を付けて回避してはならない（既存 key が動いて識別子が変わり、
公開データの識別子が変わる）。

ccfddl と hf で同一会議が別 title になっている組は `data/overrides.yaml` の
`aliases` で寄せる。実データで確認済みの 3 組を初期値とする:
`kdd`→`sigkdd`、`siggraph`→`acm-siggraph`、`cec`→`ieee-cec`。

### 3.2 時刻と日付

```ts
// src/model.ts
export type Tz =
  | { kind: "fixed"; offsetMinutes: number }
  | { kind: "iana"; name: string };

export type TzResolution =
  | { status: "confirmed"; tz: Tz }
  | { status: "unconfirmed" };

export function resolveTzStatus(tzRaw: string | null | undefined): TzResolution;
export function isConfirmedTimezone(tzRaw: string | null | undefined): boolean;
// 'AoE'/'aoe' -> {kind:'fixed', offsetMinutes:-720}
// 'UTC' / 'GMT' -> {kind:'fixed', offsetMinutes:0}
// 'UTC+8' 'UTC-08' 'GMT+02' 'UTC+0' 'UTC+05:30' -> 固定オフセット
//   （ゼロ埋め・1〜2桁・コロン区切りの全てを受ける）
// 'PT'/'ET'/'CT'/'MT' は IANA 地域帯として DST を観測する
// 'PST'/'PDT'/'CDT'/'EST'/'EDT'/'CET'/'CEST'/'AEDT'/'AEST' 等は文字どおり固定オフセット
// 文脈の無い 'CST'/'IST'/'BST'、未知・欠落は unconfirmed
// IANA 名（'/' を含む）-> {kind:'iana', name: <そのまま>}
// resolveTz は互換 API として unconfirmed を UTC に寄せる

export function parseInstant(text: unknown, tzRaw: string | null | undefined): Date | null;
// 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DD' を受ける
// 文字列末尾の Z / ±HH:MM は文字列自身の timezone として別引数より優先する
// 文字列内 timezone と別引数が同じ時刻を表さない場合は null
// 文字列内 timezone は Deadline.tz_raw に正規化して保持する
// confirmed な timezone の naive 値だけを UTC に変換して返す
// ambiguous / unknown / 欠落 timezone は確定値にしないため null
// 'TBD' 等パース不能は null（例外にしない）
// 日付のみでも timezone が確認済みなら 23:59:59 とみなす

export function parseDateRange(
  text: string | null | undefined,
  fallbackYear: number,
): [Date | null, Date | null];
// 'August 17 - 21, 2026'            -> (2026-08-17, 2026-08-21)
// 'September 29 - October 3, 2025'  -> (2025-09-29, 2025-10-03)
// 'June 28 - July 2, 2026'          -> (2026-06-28, 2026-07-02)
// 'Oct 12-16, 2025' / 'Sept. 12-16, 2025' -> 略記・ピリオド・'Sept' を受ける
// 'November 15, 2026'               -> (2026-11-15, 2026-11-15)
// 'July 31-August 8, 2022'          -> (2022-07-31, 2022-08-08)
// en dash '–' も区切りとして受ける
// 年跨ぎ 'December 28, 2025 - January 3, 2026' は各側の明示年を優先
// date 中の明示年が Edition.year と食い違う場合も date を優先する（罠 §1.1-9）
// 解釈不能 -> [null, null]。例外にしない
```

時刻とタイムゾーンを確認できないローカル締切は `parseInstant` へ渡さず、次の形で収録する。

```yaml
- {kind: paper, label: Submission deadline, date: '2026-08-24', precision: date-only}
```

`date-only` は暦日だけを表し、UTC、JST、AoE の時刻へ変換しない。
`estimated` は開催回の推定状態であり、締切値の精度とは別である。

rankings のパースは `src/sources/aideadlines.ts` の内部関数 `rankOf`:
`'CCF: A, CORE: A*, THCPL: A'` -> `{ccf:'A', core:'A*', thcpl:'A'}`、
`null` / 解釈不能 -> `{}`。

### 3.3 締切種別の正規化

```ts
// src/model.ts
export function kindOf(rawTypeOrKey: string | null | undefined): DeadlineKind;
```

`raw` の入力は **ccfddl の timeline キー名**と **hf の `type` 値**の両方である。
実在値からの写像を全て書き下す。ここに漏れがあると締切が消える。

| raw | kind |
|---|---|
| `deadline`, `paper`, `submission`, `full_paper`, `fullpaper`, `paper_submission`, `short_paper`, `manuscript`, `manuscript_deadline`, `full_manuscript` | `paper` |
| `abstract_deadline`, `abstract deadline`, `abstract` | `abstract` |
| `supplementary` | `supplementary` |
| `notification`, `first-notification`, `final-notification` | `notification` |
| `camera_ready`, `camera-ready`, `revision-deadline`, `final_deadline` | `camera_ready` |
| `rebuttal_start`, `rebuttal_period_start` | `rebuttal_start` |
| `rebuttal_end`, `rebuttal`, `rebuttal_and_revision`, `author_response`, `author_rebuttal`, `rebuttal_period_end`, `rebuttal_deadline` | `rebuttal_end` |
| `review_release` | `review_release` |
| `registration`, `reviewer_registration`, `commitment_deadline` | `registration` |
| 上記以外（`withdrawal` 等） | `other` |

`supplementary` を `paper` に落としてはならない（CVPR は本文と補足で別日）。
`rebuttal_start` と `rebuttal_end` を同一 kind にしてはならない（AAAI は開始と終了が別日）。

### 3.4 取得源

```ts
// src/sources/base.ts
export async function fetchTarball(
  repo: string,
  ref: string,
  cacheDir: string,
  opts: { offline?: boolean },
): Promise<string>;
// codeload から tar.gz を取得して cacheDir 配下へ展開、展開先ルートを返す
// 展開時に path traversal を防ぐ（'..' や絶対パスを含むメンバを拒否）
// offline=true かつキャッシュがあればそれを使う。無ければ throw
// ネットワーク失敗時は既存キャッシュへフォールバックし警告
```

実装: `src/sources/ccfddl.ts`（`NAME = "ccfddl"`・`REPO = "ccfddl/ccf-deadlines"`）、
`src/sources/aideadlines.ts`（`NAME = "aideadlines"`・`REPO = "huggingface/ai-deadlines"`）、
`src/sources/local.ts`（`NAME = "local"`・`data/manual.yaml` と `data/curated.generated.yaml`）。
両ファイルがない移行途中の checkout だけは `data/extra.yaml` を読み込む。

### 3.5 スナップショット（上流障害時の復旧経路）

`.cache/` は git 管理外であり、新規クローンには存在しない。
上流取得が失敗したときに頼れるのはコミット済みの `data/snapshot.json` だけである。

`cli.build`（`src/cli.ts` の `cmdBuild`）の取得順序を凍結する:

1. 各データ源を順に `load()` する。
2. 失敗したデータ源ごとに、`data/snapshot.json` から該当する venue・edition・deadline slot
   だけを復元する。成功したデータ源の値と local の現行値は置き換えない。
3. 複数源を持つ edition では失敗源の欠落 slot だけを補い、local で削除済みの venue は復活させない。
4. snapshot も空なら異常終了する（黙って空の公開データを公開しない）。

snapshot は全データ源が `fresh` の online build に限り、build の最後に `data.json` から
`generated_at` を除いて書き込む。各取得源の revision、入力 hash、取得時刻、件数を
`snapshot_metadata` に保存し、offline build はこの観測時刻から鮮度を判定する。
cache-fallback・snapshot-fallback・failed・offline のいずれかを含む build は snapshot を更新しない。

各データ源の新鮮な parser 出力は `data/source-snapshots/<source>.json` にも保存する。
source snapshot は他の源と統合する前の会議・版・締切配列、source revision、取得時刻、入力 hash を持つ。
offline build は失敗した源に対応する source snapshot を優先し、無い場合だけ統合済み snapshot の源情報へ退避する。
source snapshot の parser 形式は `conferencesFromJson` が読み戻せる契約とする。
一次ソースの手動訂正は `data/source-snapshots/primary.json` に同じ形式で保存し、
`primary_overrides.yaml` がないオフライン build からも復元する。

### 3.6 統合

```ts
// src/merge.ts
export const DEFAULT_SOURCE_PRIORITY = ["local", "aideadlines", "ccfddl"];
export const DEFAULT_CROSS_SOURCE_TOLERANCE_S = 90000; // 25 h

export function mergeSources(
  groups: Conference[][],
  config: Record<string, unknown>,
  stats?: MergeStats | null,
): Conference[];
// Venue は venueId、DBLP key、公式 domain + alias、明示 aliases の順で名寄せする
// slug key だけでは統合せず、identity が不足または競合する候補は分割して統計へ残す
// Edition は editionId、公式 URL、source-local ID + 会期重複、会期 + 開催地で名寄せする
// 同一年の複数開催回や本会議・ワークショップを先頭一致で統合しない
// Deadline は和集合を取ったあと、下記「締切の重複統合」の許容幅で畳む
// 競合時の優先順は config['source_priority']（既定 ["local","aideadlines","ccfddl"]）
// stats は任意の出力引数。merged_deadlines、merged_by_key、identity_conflicts を受け取る

// config.venue_identities / edition_identities は source-local ID を stable ID へ明示的に対応付ける。
// sourceIds の値や slug が偶然一致しただけでは source をまたいで統合しない。

export function classify(confs: Conference[], config: Record<string, unknown>): Conference[];
export function applyOverrides(
  confs: Conference[],
  overrides: Record<string, unknown> | null | undefined,
): Conference[];
// editions.<year>.deadlines が指定されたらその版の締切を**置換**する
// （延長・訂正用。drop と違い、rollforward が推定版を再生成しない）。
// 形式は extra.yaml と同じ kind/label/date/tz。根拠 URL をコメントで残す。
export function rollforward(
  confs: Conference[],
  today: Date,
  config: Record<string, unknown>,
): Conference[];
// 最新版の paper 締切が過去で、未来の版が無い会議に推定版を 1 つ足す
// 推定間隔は直近 2 版の実間隔の中央値、取れなければ 364 日。曜日を保つ
// 未来の版が既に存在する会議には足さない
export function select(confs: Conference[], config: Record<string, unknown>): Conference[];
// カテゴリ・exclude・rank_filter に加え、締切も開催日も持たない会議を落とす
// （全出力が日付を軸にするので、そういう会議はどこにも描画されず件数だけ増やす）
export function dedupDeadlinesAfterRollforward(
  confs: Conference[],
  config: Record<string, unknown>,
): Conference[];
```

#### 締切の重複統合

対象は同一 Conference・同一 Edition・同一 deadline slot の 2 件である。
slot は `kind`・`round`・正規化した非汎用 `track` で識別し、異なる round や track は畳まない。
**畳む条件は源が同じか異なるかで別**である。

| 2 件の出どころ | 畳む条件 |
|---|---|
| **異なる源** | `at_utc` の差が許容幅以内。既定 **90000 秒（25 時間）**。`config['deadline_merge_cross_source_seconds']` で変えられる |
| **同じ源** | `at_utc` が完全一致し、かつ空白と大小文字を正規化した `label` も一致 |

この時刻幅は `exact` 同士に適用する。
`date-only` 同士は `local_date` が同じ場合に畳む。
`exact` と `date-only` は exact が date-only の不確実性区間内にある場合に同一slotの精度差として畳み、
exact を採用して双方の evidence を保持する。区間外なら競合として保持する。

窓の中に候補が複数あるときは**最も近いもの**に畳む。先頭一致にすると、SIGGRAPH 2026 で
ccfddl の `Paper submission`（`2026-01-22T22:00:00Z`）が aideadlines の
`Upload and conflicts deadline`（24 時間後）に吸われうる。

**なぜ源で規則を分けるか（実データ全件走査で確認済み・2026-08-09 時点）**

源をまたぐ食い違いは秒の丸めから暦日そのもののずれまで連続的に分布する。

| 差 | 実例 |
|---|---|
| 1 秒 | NeurIPS の paper が ccfddl `11:59:00Z`・aideadlines `11:59:59Z` |
| 1 時間 + 59 秒 | SGP 2026 の abstract / paper（時差解釈 1 時間と秒丸めの合成で 3659 秒） |
| 4〜12 時間 | FG・IROS・ICASSP・COLT・ICDAR・Interspeech。源ごとに元の壁時計を別のタイムゾーンで読んでいる |
| 24 時間 | CVPR 2026 の abstract（`11-07 11:59:00Z` と `11-08 11:59:59Z`）、IROS 2025・WACV 2027 の paper |

3600 秒では源をまたぐ重複が **21 組**残り（実測）、`rollforward` がそのうち
**9 件**を推定版へ複製して増幅していた。
一方で**同じ源が同一時刻に並べた 2 件は本当に別トラックのことがある**
（SIGGRAPH 2026 は `2026-04-21T22:00:00Z` に投稿トラックを 3 本持ち、
WACV は Round 1 と Round 2 の通知を同一時刻に置く）。源を問わず窓で畳むと
これらが消えるため、同一源には完全一致を要求する。

25 時間という値は「タイムゾーン解釈差の上限」ではなく実測に対する閾値である。
源をまたぐ同一 kind の差の分布には 24.02 時間の次が 26 時間で、
そこから先（ALT 26h・ICRA 27h・ECCV 130h ほか）は投稿締切の延長や
別トラックが混ざるので畳まない。**この境界はテストで固定する。**

**畳むときの規則**

- 残すのは `source_priority` が高い側の値・ラベル・`comment`・リンク。同順位のときは
  和集合に先に入った側（＝上流の記載順）が残る。
- `round` と、汎用名を除いて正規化した `track` は締切枠の識別子である。
  どちらかが異なる締切は畳まない。
- 落とした側の `label` と `comment` は、残した側の `comment` に
  `同時刻の別記載: <label>` として退避する。**文字列を捨ててはならない。**
- `kind` が違えば畳まない（CVPR の paper と supplementary は同時刻でも別物）。
- 窓を超えて離れた同一 `kind` は畳まない。NSDI の年 2 ラウンドは数か月離れており
  影響を受けない。**この不変条件はテストで固定する。**

**畳んだ後に残る同時刻の重複**

同一源の別トラックは残るので、同一 Edition・同一 `kind`・同一 `at_utc` に 2 件以上
並ぶことがある。このとき `upcoming.md` の種別欄とサイトの種別欄には
`論文締切: Posters deadline` のように `label` を添えて**区別できるようにする**。
区別できない同一表題の重複を出力に残してはならない。

**適用箇所**

この畳み込みは `merge_sources` の中で全源が寄与した後に 1 回、
`rollforward` の**後にもう 1 回**適用する（`dedup_deadlines`）。推定版は直前の実版の
締切を写すので、残った重複はそのまま推定版へ複製される。統合済みの Edition は
どの締切がどの源から来たかを保持していないため、後段の 1 回は同一源の規則
（時刻とラベルの完全一致）だけを適用する。

統合件数は `build` の統計に出す。件数は **収録された会議のぶんだけ**数える
（`merge` は `select` より前に走るため、収録しない会議まで数えると `data.json` と
突き合わせられない）。

### 3.7 出力と CLI

```ts
// src/build.ts
export async function buildAll(
  confs: Conference[],
  config: Record<string, unknown>,
  outdir: string,
  now: Date,
): Promise<BuildStats>;
```

```sh
node --experimental-strip-types src/cli.ts build [--out public] [--config config.yaml]
                              [--offline] [--now 2026-08-09T00:00:00Z] [--cache .cache]
                              [--no-embeddings]
node --experimental-strip-types src/cli.ts discover [--out path] [--categories hpc,systems]
                              [--candidate-out path] [--min-year year] [--dry-run] [--append]
node --experimental-strip-types src/cli.ts review [--candidates data/discovery/active.yaml]
                              [--limit 60] [--now 2026-08-09T00:00:00Z]
node --experimental-strip-types src/cli.ts reverify [plan|run|review|accept|apply|reject]
                               [--data public/data.json]
                               [--ledger data/verification-ledger.json] [--due]
                               [--max-pages 40] [--max-deadlines 200] [--max-per-host 5]
                               [--concurrency 4] [--timeout-ms 15000] [--max-body-bytes 5242880]
                               [--resolution id] [--reason text]
                               [--now 2026-08-09T00:00:00Z]
node --experimental-strip-types src/cli.ts evidence [verify|gc] [--dry-run]
```

`--offline` は新規の上流データ・埋め込みモデルを取得しない。上流データは cache → snapshot
の順で退避し、埋め込みモデルはローカル cache が無ければ警告して生成を省略する。
`--now` は決定的テストのため必須で実装する。既定は実時刻 UTC。
時刻成分がある値は `Z` または `±HH:MM` offset を必須とする。offset 無し
（`2026-08-09T00:00:00`）はローカル時刻になり決定性を壊すので拒否する。
`T24:00:00Z` も Date が翌日へ繰り上げるので拒否する。日付だけ
（`2026-08-09`）は UTC 0 時とする。
`--no-embeddings` は `embeddings.json` を書かない（テスト用・高速化）。
`discover` は穴場の会議・ジャーナルを探索し、`review` は候補を締切昇順・重複・
ハゲタカ会議の疑い付きで一覧する。
`reverify --due` は `verification.next_check_at` が到来した公式 URL を取得し、
`data/verification-ledger.json` と `data/evidence/blobs/` を更新する。
`reverify` の取得上限はページ40、締切200、hostあたり5、同時4、タイムアウト15000 ms、本文5 MiBで、各値は上記フラグで上書きできる。
台帳はページ、締切枠、別名、resolution を分離した schema 2 とし、schema 1 は読み込み時に移行する。
同じ公式 URL の複数枠は一度だけ取得し、ETag または Last-Modified がある場合は条件付き取得を行う。
取得本文が示す日付が現行値と異なる場合は変更種別付きの resolution を記録するが、公開データを自動上書きしない。
精度向上と本文に明示された締切延長だけを `changed` とし、前倒し、精度低下、別トラック、曖昧な候補は `manual-required` とする。
`evidence verify` は content hash、本文参照、サイズ、秘密情報を含むヘッダ、孤立本文を検査し、`evidence gc` は未参照本文を dry-run で確認した後にゴミ箱へ移す。

---

## 4. 生成物（`public/` 配下）

標準ビルドは次のファイルを生成する。推定値は `data.json` と `data.csv` に含め、
`estimated` フラグで確定値と区別する。

| ファイル | 内容 |
|---|---|
| `index.html` | 静的サイト（テンプレートに正規化データを埋め込む） |
| `data.json` | 正規化データ全体（機械可読の正）。推定版も含む |
| `health.json` | 確定・推定締切、ソース状態、警告、カテゴリ、出力ファイルの健全性レポート |
| `health.md` | `health.json` の人間向け要約 |
| `publish.json` | 埋め込み復元・生成後の最終成果物ハッシュと `semantic_status` |
| `catalog.json` | 締切画面向けの現在・近日期間カタログ（画面の最初の一覧に出る物）。履歴と論文プロフィールを含めず、全履歴の `history_ref` を持つ。**載る締切の件数と範囲は索引に実測で書く**（§4 索引・第 291 回） |
| `recommendation-index.json` | 投稿先推薦用の会議プロフィール、代表締切、埋め込みマニフェスト参照 |
| `data.csv` | 1 行 1 締切の平坦な表。推定版も含む |
| `upcoming.md` | 直近 N 日の締切と開催日の表（N は `site.upcoming_days`、既定 180） |
| `llms.txt` | エージェント向け出力索引 |
| `embeddings.json` | 会議スコープの埋め込み（§10）。`--no-embeddings` で省略可 |
| `recommender.js` | `site/recommender.ts` から生成するサイトの推薦ロジック |
| `recommendation-core.js` | `site/recommendation-core.ts` から生成する共有推薦軸 |
| `publish.js` | `site/publish.ts` から生成する publish manifest 検証 |
| `app.js` | `site/app.ts` から生成するブラウザ UI 実行時処理 |
| `icon.svg` | サイト自前のファビコン（図形のみ。外部フォントに依存しない） |
| `.nojekyll` | Pages の Jekyll 処理を無効化 |

`health.json` は `profile_hash`、`confirmed_future_deadlines`、`estimated_future_deadlines`、
`source_failures`、`snapshot_fallback`、`build_input_mode`、観測時刻・観測鮮度、
安定 warning code、identity conflict、`parse_warning_count`、カテゴリ別件数、
必須会議の存在状態、`deadline_refs`、`identity_migrations` を持つ。各 ref の
`deadline_id` は `venue|edition_id|kind|round|track` で、`exact` は `at_utc`、`date-only` は `local_date` に値を分離する。
直近の健全な公開結果との比較では、同一枠の延長は通し、公式根拠のない前倒しと
根拠のない未来枠の消失だけを配信阻止対象とする。経過した締切の削除と推定値の増減では
阻止しない。`deadline_refs` は現在未来の確定締切と短い lookback（14 日）に限るが、
正典の supersession 訂正が lookback 内にある締切は過去日でも ref に残し、
`superseded_values`（旧値・精度・reason・訂正時刻・訂正先 slot id）を添える。
track キーはラベル由来で変動するため、venue/年/kind/round と時刻が完全一致し
両側で一意な track 改名は同一締切として対応付ける。track と値が同時に変わる遷移は
対応付けず、従来どおり fail-closed である。
正典（manual.yaml / curated.generated.yaml）の `superseded_deadlines` は公式訂正の
台帳であり、消えた旧 slot・前倒し・精度後退が台帳の旧値と完全一致する場合だけ
配信阻止を免責する。免責は (1) 台帳を持つ現行 slot 自身の family
（venue/edition/kind/round）を `supersededBy` が指すこと、(2) 旧 slot と現行 slot の
kind/round 一致、(3) 訂正時刻が lookback（14 日）内であること、を全て要求する。
上流アグリゲータ（ccfddl / aideadlines）の `superseded_deadlines` は取り込まない
（gate の自己免責注入を防ぐ）。
`identity_migrations` は旧 slot から現行 slot への明示的な写像であり、`rename` と
`duplicate-collapse`（N 件を 1 件へ統合）だけが対応する slot の消失判定を緩和する。
legacy venue の消失は、移行先 venue の supersession 台帳によっても免責できる。
schema version の増加だけでは緩和しない。移行先欠落、同一 source の複数移行先、
不正な action、循環は fail-closed である。

`publish.json` は最終的な公開セットを検査する。`semantic_status` は埋め込みが有効なとき
`ready`、省略または検証に失敗したとき `lexical-only` になる。成果物一覧の `artifacts` は `publish.json`
自身を除く各公開ファイルのバイト数と SHA-256 を持つ。
schema 4 は `source_commit`、`data_commit`、`workflow_run_id`、`dirty_worktree`、ビルド入力の SHA-256、promotion batch の SHA-256、build 時刻、Node 版、offline/cache 方針、再実行コマンドを持つ。
`content_id` は source commit・入力・promotion・profile・モデル revision から計算し、
`build_id` は `content_id` と生成時刻から計算する。
固定時刻と同じ入力で生成した公開物はバイト一致しなければならない。
`scripts/check-reproducible-build.zsh` は、呼出時点の作業ツリーを
`--offline --no-embeddings` で一時出力先へ2回生成してこれを検査する。
`data.json` は venue と edition の明示 identity を保持し、snapshot 復元後も名寄せ根拠を失わない。

`index.html` に埋め込む JSON は `catalog.json` と同一である。推薦モードは
`recommendation-index.json` を遅延取得し、`embeddings.json` を参照する。
`data.json` は全履歴を含む機械可読の正典として、サイトシェルには埋め込まない。
サイトの通常起動では `data.json` を取得せず、締切モードで過去の締切を表示するときだけ
`history_ref` を同一 origin から一度だけ遅延取得する。取得中は状態を表示し、非 2xx・不正 JSON・
不正な `conferences` 配列の場合は埋め込み済みカタログを使い続けて再試行を可能にする。
推薦モードは URL に `past=1` があっても履歴を取得しない。推定の表示切替はサイト側の絞り込みで行う。 **品書（`catalog.json`）自身も期間窓で切れている** – 一覧に並ぶ締切はビルドの
`upcoming_days`（既定 180 日）までで、それより先の締切は `data.json` にしか在れない（2026-08-09
生成ビルドで、一覧に出る一番遠い締切は 2027-02-04、`data.json` には窓を越える締切が 133 件、
`deadlines.ics` には 2028-03-30 まで 928 件）。よって画面は次の二つを守る（第 290 回）。

- **品書の果てを一覧の上で伝える**: 一覧に出る一番遠い締切日（行から JST の暦日で実測する。
  ハードコードしない – 生成のたびに違う）と、それより先が読めること、カレンダーに載る範囲を、
  件数のうしろの枠に出す。読み終えたあとは黙る（同じ注記を出し続けない）。
- **既定では品書の外を読まない**: 期間を「かまわない」にすることは既定であり、そこに 6 MB 強を
  毎回読ませるのは画面を遅くする。`fullRecordNeeded(past, win, requested)` は
  「過去の締切も表示」または **押された旗**が立ったときだけ品書の外を読む。読み込み状態の語は
  「収録の全体の締切」で統一し、過去にも先にも寄らない（同じ 1 回の読み込みが両方を運ぶため）。

- **品書は、品の窓に締切が入らない会議に「収録の側に締切が在るか」を載せる**（第 295 回で加えた）:
  `conferences[].record_deadline_last` に、収録（`data.json`）の中でその会議の締切が最も遠い
  JST の暦日を書く。収録に締切が 1 本も無い会議は `null`、日付の読めない物しかない場合は `""`。
  品の窓に締切の入る会議には付けない（画面が品書から既に読める数を数え直させないため）。
  0 件の案内はこの申告だけを読み、`null` なら「収録の全体を読み込んでも 1 件も増えない」、
  暦日ならその日付と向き（これから / 過ぎた分だけ）を言う。向きを示す旗が渡されないときは、
  これからだとも過ぎたのだとも言わない。実測（2026-09-24・2026-08-09 生成ビルド）で、品書に
  締切行の無い会議 248 件のうち 74 件が `null` – そこへ読み込みを勧げるのは 6 MB 強を
  読ませて 1 件も増えない空振りをさせることになる。
- **0 件の案内は、その会のこれからの開催日を版（回）から読む**（第 297 回で加えた）: 名前で 1 件に
  絞れた会議について、いま読み込んでいる版の列からこれからの `event_start`（JST 正午で今日以降）を
  一番近い物だけ選ぶ。推定の会期（`estimated`）は数えない – 公式で裏を取っていない日は教えない。
  締め切りが過ぎただけの会と、まだ開かれるだけの会を分けないと、人は「終わった会議の話をされた」
  と誤解する（実測で、過ぎた締切しか持たない会議 174 件のうち 118 件・収録に締切の無い会議 74 件の
  うち 31 件は、品書にこれからの開催日が在る）。締切の無い会議は一覧に出ないので、行き先として
  `upcoming.html` を名指ししてよいのは、その会がそこに出る形（締切ゼロ）のときに限る。
- **収録の側に残っている締切は、一番近い日・種別・本数まで品の窓に書く**（第 298 回で加えた）:
  品の窓に締切行の無い会議のうち、収録の側に生成時刻以降の締切が 1 本以上在る物だけ
  （実測 42 件）、`record_deadline_next`（JST の暦日 – 協定世界時の幅の終端から揃える）・
  `record_deadline_next_kind`・`record_deadline_count` を載せる。一番遠い日（`record_deadline_last`）
  だけでは、人は間の締切に間に合うと思う – 実測で 42 件のうち **19 件**は近い日が遠い日より前に
  在った（CADE: 申告 2027-06-01 / 一番近いのは 2027-02-16 の概要締切・全 4 本）。画面はこれを
  そのまま数として出すので、`src/build.ts` 側で数え切り、検査は品選びを読み直して突き合わせる。
  種別は画面の表と同じ語に直す（`Recommender.kindLabelTable()`）で、表の知らない種別は括弧を付けない。
  生成は一度きりなので、画面の時計でその日が既に過ぎていたら近い日の話を落とす。
- **カレンダーの日付の欄名は、種別から決める**（第 299 回で加えた）: `deadlines.ics` の本文は
  受信側がそのまま表示するので、欄の名前がその日の呼称になる。`site/recommender.ts` の
  `kindDateFieldJa(kind)` が正本で、採否通知は「通知日」、査読結果公開は「公開日」、反論期間開始は
  「開始日」、それ以外（概要・論文・補足資料・カメラレディ・登録・反論期間終了・常時受付と
  品書きに無い種別）は「締切」を返す。会期（開催）の行は「会期」にする。`src/build.ts` の
  `DataRecord` は `date_field` を持ち、ICS はそれを書く（欄名を 2 か所に持たない）。関数は
  ビルド成果から単独で抜き出して検査するので、表中に置く（外の変数にしない）。
- **カレンダーに入る物の内訳を、出口ごとに言い換えない**（第 300 回で加えた）: 配信物の
  `X-WR-CALDESC`・機械の索引 `llms.txt`・画面の注記（`#icsScope`）・導線の説明文は、いずれも入る物を
  「締切」と呼んでいたが、実測（2026-08-09 生成ビルド）で 928 件のうち 167 件は締切ではない日
  （採否通知・査読結果公開・反論期間の開始）なので、総数と締切の件数を分けて書く。締切の件数は
  `catalog.json` の `calendar.deadline_count` が申告の正本で、ビルドが配信行から導く。締切かどうかは
  `IcsRow.deadline` に一行一値で持つ（日付の欄名を決めた所で決め、後から本文の文字列照合で真似ない）。
  内訳の申告が無いビルドに対しては、画面も索引も締切の数を言い出さない。




- **0 件の案内は、会議の名簿と突き合わせてから「無い」と言う**（第 294 回で加えた）: 品書の
  会議 687 件のうち 248 件は、一覧に差し込むデータに締切行を 1 本も持たない（締切が品の窓より
  先、または過去の会）。行の一覧だけを見て「収録データにも見当たりません」と言うと、名簿に
  載っている会を「収録に無い」と言う。語が名簿の**名前の語**として立つ間は、その語を
  「無い」の列から外し、代わりに「名簿に見えるが締切はデータに無い」を言う（`site/app.ts` の
  `nameOnlyConferenceMatch` – 読み込めている行 `rows` の会議キーと照合するので、収録の全体を
  読んだあとは自動的に黙る）。英数字の語は名前の途中に隠れただけでは語と数えない（`sc` が
  `science` を含む物をつかまえない）。名前の例として挙げるのは、打った語すべてに当たる会議が
1 件だけるときに限る – 曖昧なときは件数だけを出す。打ち方に混ざった日付の語（`2027`・
  `2027年3月`・`3/15` のように数字と日付の部品だけで出来ている語）は、名前の語として数えない
  （第 296 回で加えた） – 品書の key は年を含む物が多く、年の語を名前の語と一緒に数えると別々の
  会議がまとまって「似た名前」になる。件数も例も、名前の語すべてに当たる物だけを数える。
  語が名簿に見えるのに全部を含む会議が無い打ち方（`ACL international` など）でも、名簿の案内は
  黙らない（件数は作らない）。


- **画面が言う「生成から何日先」は品書の申告を読む**（第 293 回で加えた）: 品の窓の日数は
  `catalog.json` の `window.upcoming_days` に在る（`toCatalog` が `upcoming_days` と同じ値で書く）。
  一覧の注記と 0 件の案内はどちらもここを読み、品書に申告が無いビルドでは日数を言わない。
  昔の画面は 180 と書き写していたので、`upcoming_days` を変えたビルドでは画面が嘘を言い続けた
  （第 293 回で実測 – 改ざんで `window` を消すと、検査が「品書に申告が無い」と落ちる）。

`upcoming.md` には締切と開催日の両方を載せる。締切を持たない会議も開催行で確認できる。

**索引（`llms.txt`）は、各成果物に何が入っているかを実測の値で書く**（第 291 回）。
機械に「この先いつまでの締切が出せるか」を訊かれた人は、索引だけ見て答えを作る。かつての索引は
`catalog.json` を「現在・近日期間カタログ。」とだけ言い、`data.json` を「正規化データ全体
（機械可読の正）。」とだけ言っていた – 品書が**生成から 180 日先で切れている**ことも、
収録全体がどこまで遡りどこまで先かも、`.ics` が何件を載せるかも、どこにも読めなかった
（2026-08-09 生成ビルドの実測: 品書 872 件・2026-07-10 〜 2027-02-04 / 収録 3,253 件・
2019-05-25 〜 2028-03-30 / カレンダー 928 件・2026-08-09 〜 2028-03-30）。

- 件数と両端の暦日は **このビルドが書いた成果物から数える**（`deadlineSpan(data)` /
  `deadlineSpan(catalog)` / `icsCalendarMeta(icsRows)`）。定数を書いた時点で次のビルドの噓になる。
- 暦日は JST に揃える（`utc` をその場で数えると、時刻付きの締切が前日に見えた – 画面と
  カレンダーが見る暦日と同じ目盛りを使う）。
- 形のおかしい品書では値を作らない（`null` を返し、索引はその行を従来どおりに出す）。
  「0 件」と「知らない」を混ぜない。
- 索引の行は**句点のあとに空白を空けない**（`。 ` で文を繋ぐと、機械が 2 つの項目と取り違える）。

**`upcoming.md` の日付は曜日を添える**: `2026-08-17(月) 23:59 JST`・`2026-02-06(金) 23:59:00 AoE`・
`2026-09-30(水)（時刻未確認）・会期行は 2026-08-07(金) 〜 2026-08-09(日)` の形にする。
曜日は `YYYY-MM-DD` をその暦日として読む（`calendarDayJa`）。ビルドのタイムゾーンに依存せず、
`Date.UTC` の暦月繰り越し（`2026-13-45`）には曜日を付けない。
`data.json` / `data.csv` の `aoe` 値は機械可読なので曜日を付けない（上の実測例）。

**`upcoming.md` は対象期間と JST での読み方を最初に書く**: md を単体で読む人（grep する人、
他のツールに食わせる人）にとって、表が「いつの時点の、いつまで」を網羅しているか分からないと
使えない。先頭には生成時刻を UTC の ISO と JST の両方で（`生成時刻: 2026-08-09T00:00:00Z
（JST では 2026-08-09(日) 09:00）`。単位は 1 度だけ – 第 283 回で実出力から落ちたのに、この例が古い形のまま残っていた）、続けて `対象期間: 2026-08-09 〜 2027-02-05(金)` を
書く。進行中の会期は開始日が生成時刻より前にあるので、その旨もただし書きで明示する
（期間の下限を実測の最小日付にすると、行の並びと説明が一致しなくなる）。
`llms.txt` も同じ口径で、国内研究会の収録（`domestic-jp`）と JST 基準・AoE 併記、
サイトの日本語での引き方（月・都道府県・かな・CSV・印刷）を説明する。

**`upcoming.md` の開催地は都道府県を補う**: 会場表記に都道府県が書かれていない行
（`倉敷市芸文館`・`名古屋大学 基盤センター２F演習室`・`北九州市（FIT2026）`）には
`倉敷市芸文館 岡山県` のように県名を添える。土地で grep しても見つかるようにするためで、
公式表記の語は書き換えず末尾に空白区切りで添えるだけにする（都・道・府は正式名を足す。
`札幌市教育文化会館 北海道`。手がかりが複数の都道府県に読める場合は補わない）。語の作り方はサイトの検索と
同じ `Recommender.placeWithPrefectureJa` を呼ぶ（md 専用に都道府県表をもう作らない）。
**国名・開催形式の日本語化も同じ語で出す** — md は `placeJa(placeWithPrefectureJa(..))` の
組み合わせを使う。以前は md が都道府県側だけ、サイトの表が国名側だけを持っており、
md の海外行は `Kunming, China` のまま残っていた（「日本」で grep しても国内の行に
当たらない）。md は `title` を持てないので、補記が要る側は md だけという違いもある。

**`upcoming.md` の開催地を空欄にしない**: 値が無い行はサイトと同じ「未確認」を出す
（`Recommender.unconfirmedLabelJa()` を呼ぶ。md 専用に文言を作らない）。空欄だと
「公式が出ていない」のか「収録漏れ」なのかを md を grep する人が区別できない。
実測（検証時計 2026-08-09 のビルド）で本文 1115 行のうち 188 行が空欄だった。
`data.csv` は機械で読む成果物なので、そちらは空欄のままにする（「未確認」を文字列で
フィルタさせるより空のほうが扱いやすい）。

**`upcoming.md` でも JST 優先の規則を守る**: 「AoE 併記は公式が AoE で締切る会議だけ」は
サイト側の規則だが、md 側だけ崩れても困る（実測で締切行 779 件のうち国内 24 件、うち
AoE・公式ゾーン表記は 0 件）。md の行は公式ページへのリンクを持つので、そこから
`domestic-jp` を引いて検査している（1 件も踏まなければ検査が空回りなので、件数も見る）。

**`upcoming.md` の行の選び方**: `exact` の締切行は `at_utc` が `now` から N 日以内のもの、`date-only` の締切行は不確実性区間が `now` から N 日以内と重なるもの。
`date-only` には時刻単位の残り時間を表示しない。
不確実性区間より前は「時刻未確認」、区間内は「締切日」と表示し、区間を過ぎた行は除く。
**`exact` の日付欄は公式表記（`tz_raw`）どおりに書く**（`deadlineWhenText`）。
`JST` / `UTC+9` / `Asia/Tokyo` 宣言は `2026-08-17 23:59 JST`、`AoE` / `UTC-12` 宣言だけ AoE 壁時計で
`2026-02-06 23:59:00 AoE`、`UTC` / `GMT` / 表記なしは `… UTC`、それ以外の表記（`PT` など）は
`… UTC（公式 PT）` と換算せずに原文を添える。JST 宣言の締切を AoE で出さないのは §7 の site と同じ理由
（`23:59 JST` を `02:59 AoE` と見ると当日早朝までと誤読される）。`data.json` / `data.csv` の
`utc` / `aoe` / `tz_raw` 列は機械可読なので変えない。
**公式表記のうしろに日本時間での読みを添える**（第 287 回）: `2026-02-06(金) 23:59:00 AoE
（JST では 2026-02-07(土) 20:59）`・`2026-02-06(金) 11:59:00 UTC（JST では 2026-02-06(金) 20:59）`・
未知の表記は `… UTC（公式 PT・JST では …）` と 1 個の括弧にまとめる。単位は 1 度だけ書く
（第 283 回）。JST 宣言の行はそのまま – 読みを足すと単位が二重になる。
実測（2026-08-09 生成ビルド）で 1,126 行のうち **497 行は日本時間に直すと日が違う**
（AoE 23:59 は日本で翌日 20:59、UTC 23:59 は日本で翌朝 08:59）。この表は印刷・チャットへの
貼り込み・JavaScript を読まない画面で開かれるので、換算を `index.html` に投げると（以前は
但し書きが「換算はそちらが早い」と書いていた）この表だけで読んだ人が一日間違える。
公式表記は書き換えない – 換算は算術であって、上流の宣言の書き換えではない
（「締切の推測はしない」は保つ）。分の位は切り捨て（`23:59:59 AoE` → `20:59`）で、
残り時間を大きく言わない側の切り方に揃える。
開催行は開始日が N 日以内で、最終日をまだ過ぎていないものを載せる。
開催行の「残り」欄は開始前が日数、開始日が `本日開催`、会期中が `開催中(残りN日)`。

### 4.1 `data.json` の形

```json
{
  "generated_at": "2026-08-09T00:00:00Z",
  "site": {"domain": "ten82e.github.io", "base_url": "https://ten82e.github.io/kamiyobi"},
  "sources": [{"name": "ccfddl", "repo": "...", "license": "MIT", "url": "..."}],
  "categories": {"hpc": "High Performance Computing", "...": "..."},
  "conferences": [
    {"key":"sigcomm","title":"SIGCOMM","full_name":"...","categories":["networking"],
     "rank":{"ccf":"A","core":"A*"},"link":"...","sources":["ccfddl"],"tags":[],
     "papers":["..."],
     "editions":[{"year":2026,"id":"sigcomm26","place":"...","link":"...",
       "event_start":"2026-08-17","event_end":"2026-08-21","estimated":false,
       "deadlines":[{"kind":"paper","label":"...","precision":"exact",
                     "utc":"2026-02-06T23:59:59Z",
                     "aoe":"2026-02-06 23:59:59 AoE","tz_raw":"AoE","round":1,
                     "status":"confirmed",
                     "selection_rule":"source_priority_then_nearest_within_configured_window",
                     "evidence":[{"source_name":"ccfddl",
                       "source_url":"https://github.com/ccfddl/ccf-deadlines",
                       "observed_at":"2026-08-09T00:00:00Z",
                       "original_value":"2026-02-06 23:59:59 AoE",
                       "confidence":"aggregator"}],
                     "conflicts":[{"at_utc":"2026-02-06T23:59:00Z",
                       "label":"Paper submission","source":"aideadlines",
                       "original_value":"2026-02-06T23:59:00Z",
                       "evidence":[{"source_name":"aideadlines",
                         "source_url":"https://github.com/huggingface/ai-deadlines",
                         "observed_at":"2026-08-09T00:00:00Z",
                         "original_value":"2026-02-06T23:59:00Z",
                         "confidence":"aggregator"}]}]}]}]}
  ]
}
```

日付のみの締切は `precision: "date-only"`、`local_date: "YYYY-MM-DD"`、`earliest_utc`、`latest_utc`、`utc: null`、`aoe: null`、`tz_raw: null` として出力する。
`earliest_utc` は UTC+14 における当日 00:00、`latest_utc` は UTC-12 における当日 23:59:59.999 を UTC で表した不確実性区間であり、公式締切時刻ではない。
CSV では `deadline_precision` と `deadline_local_date` に同じ区別を保持する。

---
### 4.2 `deadlines.ics` の形

1 個の `VEVENT` は 1 個の締切。**会期（開催行）は載せない** – カレンダー側に終日が並ぶと
締切の行が見えなくなる（§7 第 266 回）。

- `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` は **JST の暦日**の終日イベント（締切に継続時間は
  無い。`DTEND` は翌日）。`TRANSP:TRANSPARENT`（締切は予定を埋めない）。
- `SUMMARY` は「会議名：種別」。推定の行は「（推定）」を種別のかたに添える。
- `DESCRIPTION` は `会議:` `種別:` `締切:` `開催地:`（+ 推定の注記・`詳細:` URL・`収録:`）を
  `\n` で繋ぐ。`締切:` の値は JST（`2026-08-11 08:59（JST）`）で、時刻を確認できていない行は
  「（時刻未確認）」を添える。開催地が出ていない行は `開催地: 未確認`（画面と同じ語）。
- **`LOCATION` は開催地が判っている行だけ**に載せる（第 288 回で加えた）。カレンダーは場所欄を
  そのまま旅行の段取りに使うので、「未確認」を場所として渡さない – 無い場所を渡すより
  空しい方がマシで、本当のことは `DESCRIPTION` の `開催地:` に書く。
  語は `upcoming.md` の開催地欄と同じ正本（`Recommender.placeJa` + 県名の補い）を呼ぶ。
- `UID` は締切日を含まない `kamiyobi-<edition_id>-<種別>`（§7 第 266 回の手当 – 締切が動いても
  同じ UID なので購読先の古い行が置き換わる）。
- TEXT 値は転義（`\,` `\;` `\\` `\n`）し、1 行 75 オクテット以内へ畳む。折り返しで 2 文字の
  転義の途中を割らない（§7 第 266 回）。
- **`X-WR-CALDESC` は、値を空白で始めない**（第 289 回で加えた）。RFC 5545 §3.1 は名前とコロンとの間に
  空白を置かないと定めており、相手は残した空白を値の一部として情報欄に出す。
- 説明欄には **入る件数と、収録している最初・最後の締切日**を実測の値で書く（第 289 回）。
  カレンダー側に「画面上の全件」のような位置の語は通じない上、収録の期間は画面に並べる
  期間より長い（2026-08-09 生成のビルドで 928 件・2026-08-09 〜 2028-03-30、画面の既定窓は
  生成から 180 日）。同じ期間を想像して購読すると、予定の方が 2 年分になる。
  同じ申告は `catalog.json` の `calendar`（`event_count`・`first_day`・`last_day`）にも載り、
  画面の「カレンダーに追加（.ics）」の下の注記がそれを読む – **数はビルドが行から導く一度きりで、
  画面は数え直さない**（別々に数えた物は必ずズレる）。
- **分野を `CATEGORIES` と説明行の `分野:` の両方に載せる**（第 292 回で加えた）。実測
  （2026-08-09 生成ビルド）で、928 個の `VEVENT` のうち `CATEGORIES` を持つ物は **0 個**、
  `DESCRIPTION` は 会議 / 種別 / 締切 / 開催地 / 詳細 / 収録 の 6 項目だけだった –
  セキュリティの会議だけを予定に入れたい人は 928 件を丸ごと購読するしかなく、カレンダーの
  検索で分野の語を引く術も無かった。語は画面の分野列と同じ入口（`Recommender.categoryLabelJa`）
  から取り、**受信側に英字の内部表記だけを見せない**（未知の語は画面と同じく原文のまま）。
  説明行の側は、受信側が分類欄を表示しなくても本文の検索に掛かる – 表示対応は kamiyobi 側では
  検証していないので、検証できる側の経路を必ず持つ。費用は実測で `deadlines.ics` が
  生 +55,393 / gzip +4,356 バイト、`index.html` が生 +523 / gzip +169 バイト
  （`catalog.json`・`data.json`・`data.csv`・`upcoming.md` は 1 バイトも同じ）。


## 5. 分類とキュレーション（`config.yaml`）

カテゴリは `hpc` / `networking` / `systems` / `ai` / `security` / `db` / `graphics` / `hci` / `theory` の 9 つ。
方針は **上流サブ分野の丸ごと取り込み + 例外リスト**（新規会議が自動で現れることが要件）。

実データ全件に対して、HotNets・APNet・SIGMETRICS・MLSys・USENIX ATC・Euro-Par を落とさない設定を契約とする。

```yaml
venue_identities:         # §3.1。source-local ID を stable venue ID に対応付ける
  sec: {source_ids: {ccfddl: DS/sec}}
  sec-sc: {source_ids: {ccfddl: SC/sec}}

taxonomy:
  networking: {ccfddl_subs: [NW]}
  ai:         {ccfddl_subs: [AI], sources: [aideadlines]}   # OR 合成
  security:   {ccfddl_subs: [SC]}
  hpc:        {venues: [sc, ipdps, hpdc, icpp, cluster, ppopp, ics, euro-par,
                             ccgrid, pact, hpcc, ica3pp, ispa, pdcat, appt, mlsys, ...]}
  systems:    {ccfddl_subs: [SE], venues: [asplos, isca, micro, hpca, fast,
                             sigops-atc, eurosys, socc, sigmetrics, icdcs, podc, rtas,
                             msst, vee, apsys, hot-chips, hotstorage, lisa, sec, ...]}

# taxonomy 内の条件は OR 合成。exclude が最優先で打ち消す
exclude: [popl, pldi, icfp, oopsla, ecoop, aplas, cp, sas, vmcai, ...]

rank_filter:
  ccf: []
  core: []
  keep_if_no_rank: true
  always_keep: [hotnets, apnet, apsys, hot-chips, hotstorage]
```

**綴りの罠（実データと照合済み）**: `atc` は存在せず `sigops-atc`（USENIX ATC 相当、ccf A）、
`europar` は存在せず `euro-par`。`hoti` と `ancs` は ccfddl に存在しない。

**MX 分野の扱い**: `MX/mlsys.yml` に **MLSys が実在する**。`MX/rtss.yml` `MX/emsoft.yml`
（実時間システム、TSN/DetNet に近い）も同様。MX 全体を取り込むと `www` `miccai` 等が
混ざるので、venues で名指しして拾う。local 正典に MLSys を重複登録しない。

**DS 分野の全数割り当て**: DS 60 会議はすべて分類対象である。
`conference/DS/` を一件ずつ見て hpc / systems / exclude のいずれかに割り当て、
未分類が 0 件であることを検査スクリプトで実測すること。

### `data/manual.yaml` と `data/curated.generated.yaml`（local 正典）

`data/manual.yaml` は手入力した local 会議を保持する。
`data/curated.generated.yaml` は `data/promotions/*/resolutions.json` から生成し、
各掲載締切に `promotion_ref: {batch, resolution}` を付ける。
手入力済み会議へ新年度だけを昇格するときは既存年度を `manual.yaml` に残し、local 読み込み時に
同じ会議の重複しない edition ID を一つへ結合する。
生成手順は `npm run generate:curated` であり、生成物を直接編集しない。
既存データを移行するための `data/extra.yaml` は入力として残すが、build は両正典を優先する。

### `data/extra.yaml`（移行入力）

収録対象: ISC High Performance / Hot Interconnects (HOTI) / OCP Global Summit /
Netdev / Linux Plumbers Conference / P4 Workshop / IEEE HPSR /
情報処理学会 HPC 研究会・ARC 研究会・OS 研究会・DPS 研究会 /
電子情報通信学会 NS 研究会・IN 研究会 / ComSys / IOTS / インターネットコンファレンス。

**MLSys は上流にあるので入れない。**
ANCS は 2021 年以降開催されていない。収録しない旨を §9 に記す。

**でっち上げた締切を入れない。** 日付の裏が取れないものは開催イベントとしてのみ出し、
`deadlines` を空にする。各エントリに根拠 URL をコメントで残す。
公式サイトで確認できなかったものは「未確認のため日付なし」と明記する。

`local` 由来は `key` を明示指定でき、`slug(title)` の規則より優先する。

```yaml
conferences:
  - key: isc-hpc                      # 明示指定。slug(title) より優先
    title: ISC High Performance
    full_name: ISC High Performance
    link: https://isc-hpc.com/
    categories: [hpc]
    editions:
      - year: 2026
        id: isc26
        link: https://isc-hpc.com/
        place: Hamburg, Germany
        date_text: June 14-18, 2026
        deadlines:
          - {kind: paper, label: Research Paper submission, date: '2025-10-27 23:59:59', tz: AoE}
```

### `data/primary.yaml`（一次ソースからの自動抽出）

手書きの `overrides.yaml` に頼らず、公式ページから締切を**一発どり**する仕組み。

- `data/primary.yaml` に会議ごとの一次ソース URL と edition 年を登録する
  （URL の発見だけが人間の仕事。データの訂正は以後自動）。
- `src/fetch-primary.ts` が各 URL を取得し、「deadline キーワード行の近傍
  （前後 1 行）の日付」だけを保守的に抽出して `data/primary_overrides.yaml`
  （自動生成・手編集禁止）を書く。日付と一緒に壁時計の時刻
  (`HH:MM[:SS]`、12h 表記は 24h に正規化) も `time` フィールドで保存する。
  ページが時刻を公表していない場合は `time` を載せない（#504）。
  各観測にはページ本文の SHA-256、取得・検証時刻、公式 URL を付ける。
  一部の締切枠だけを抽出できた場合は、その枠だけを更新し、今回見えなかった前回枠を保持する。
- build (`src/cli.ts` の `cmdBuild`) は読み込んだ primary_overrides を
  `resolvePrimaryObservations` (src/sources/primary.ts) で「検証済み観測」だけに
  フィルタしてから `overrides.yaml` → primary の順に適用する（#504）。観測は次の
  すべてを満たすときだけ確定締切として扱われる:
  1. 妥当な日付がある。時刻があれば Exact、無ければ DateOnly とする
     （日付のみの証拠から 23:59 等の時刻を捏造しない）
  2. Exact は tz が confirmed（AoE・IANA 名等。CST/IST/BST 等の曖昧略称は不確認）。
     DateOnly は時刻や tz を補わない
  3. 締切が開催時期と矛盾しない。会期が既知なら `event_start -
     primary.max_lead_days` から `event_end` まで、会期が不明なら開催年または前年を許可する
  検証を通らない行は edition パッチの `deadlines` キーごと消えるため、
  applyOverrides はメタデータのみパッチし、**既存の確定値（手書き overrides /
  上流）が保持される**。検証済み観測があるときだけ一次ソースの実測が確定値を
  上書きする。マージ層 (`src/merge.ts` の `patchDeadlineSemantics`) でも同じ
  保護を二重に持ち、全行棄却のパッチが既存配列を空で置換しない。既存締切の
  明示的な空化は `clear_deadlines: true` のときのみ許可する（#504）。
  値の手訂正は data/overrides.yaml、tz 補完は data/primary.yaml の
  tz ヒント（公式明記のみ。曖昧略称は fetch-primary 側でも外して警告）が担う。
- 抽出した edition が上流に存在しない場合、`_patch_editions` が新規 edition として
  追加する（`source: override`・`estimated: false`）。rollforward はその実測を基準に
  次 edition を推定する。
- 安全ルール:
  - 「deadline」を含まない行の裸の日付は抽出しない（会議開催日等の誤検出防止）。
  - `Edition.year` は会議の開催年であり、締切年ではない。締切日の可否は build 時に
    `resolvePrimaryObservations` が判定する。会期が既知なら暦年をまたいでも設定した期間内を
    許可し、会期が不明な場合だけ開催年または前年に制限する。
    ページ `<title>` の開催年がレジストリの edition 年と異なる場合は過去版として隔離し、
    前回値を維持する。
  - 取得失敗・抽出 0 件の会議は**前回値を維持**する（一時的なサイト障害で
    データが消えない）。警告は stderr に出るので、レジストリの URL が古くなると
    気づける。
  - 部分抽出は既存枠を消さない。枠の削除は明示的な `remove` だけで行う。
- 手動更新 (`README.md` の手順) は build の前に `node src/fetch-primary.ts --apply` を
  実行し、一次ソースを巡回する。
- 向き不向き: EasyChair CFP (`easychair.org/cfp/...`) と静的 HTML の CFP /
  Important Dates ページは抽出しやすい。JS レンダリングサイト（wacv.thecvf.com /
  vldb.org / bigdataieee.org 等）は静的 HTML に締切が無く現行抽出では 0 件になる
  ため登録しない。必要になったら個別の抽出ルールを `src/fetch-primary.ts` に足す。

### 国内研究会のスケジュール表（`scripts/refresh-ieice.ts`）

- 情報処理学会・電子情報通信学会の研究会は、個別イベントページの URL だけが `data/manual.yaml`
  に残りがちで、会期が追加されても締切が増えない。`scripts/refresh-ieice.ts` は研究会別の
  スケジュール表（`ken.ieice.org/ken/program/?tgid=IEICE-<略称>`）を巡回して、会期と
  「発表申込締切日」を `data/manual.yaml` に反映する。既定は dry-run、`--apply` で書き込む。
- **項目が日付しか持たない**ので `precision: date-only` で収録し、時刻（23:59 など）は補わない。
  会期のみ・締切 `[未定]` の回は会期だけを追記する。
- 反映は **空の `deadlines: []` の充填と、未登録の会期の追記だけ**。既存の締切値は書き換えない
  （人手で確定済みの値を上流の下記修正で壊さない）。版をまたいだ前方検索は事故になる
  （過ぎた回へ次回の締切を登録してしまう。2026-09-22 の dry-run で実検出し、版単位の
  置換に直した）。
- 会議ブロック自体は人が足す（`editions: []` の空リストで置く）。そのとき **空のインライン
  リストへ直接項を挿すと YAML が壊れる**（`editions: []` の直下に 6 字下げの項が来る）。
  ブロック表記へ直してから追記する（2026-09-22 の dry-run で実検出）。
- 収録済みは NS・IN・ISEC・CPSY・RCS・NV に加え、2026-09-22 に NWS・DC・ICSS・IBISML・DE・SS を
  追加した（公式ページの `<title>` から研究会名を取り、`full_name` の裏を取っている）。
  SUSC と AI は公式ページに開催が 1 件も出ていないので未登録のまま（空の会議を作らない）。
- 収録していない研究会は自動で増やさない。名指しでの収録は人の判断なので、実行時には
  「公式に N 回分の開催が出ている」という報告だけを出す。
- 書込み前に変更後の YAML を読み直し、会議キーの増加・版の消失を検出したら中止する。
- **情報処理学会の研究会も同じシステムに乗っている**（`?tgid=IPSJ-HPC` など）。`www.ipsj.or.jp`
  は機械取得に 403 を返すので（2026-09-22 現在も）、収録済みの IPSJ 研究会はここから更新する。
  巡回するのは HPC・CSEC・ARC・EMB・SE・DPS・UBI に、2026-09-22 に追加した DBS・AL・IFAT・
  CGVI・IOT（いずれも公式ページに今後の開催が出ていたものだけ。CN・ICS・MBL・HCI は
  開催が 0 件だったので空の会議を作らず未収録）。
  学会名付き tgid は `TGID_BY_KEY` に名指しで持ち、`-` を含む tgid はそのまま URL に使う
  （`IEICE-` を二重に付けると空ページになる）。対応表に無い tgid は IEICE の略称とみなす。
- **版 id の接頭語は会議キーと限らない**（会議キー `ipsj-sighpc` / 版 id `ipsj-hpc-2026-12`）。
  会議キーで id を組み立てると既存版に届かず、**締切が黙って取りこぼされる**（「更新なし」で
  通った。2026-09-22 に実データで発見）。接頭語は既存の版 id から導く。
- `ken.ieice.org` は既知のブラウザ UA 以外に 403 を返し、間隔を詰めると 503 を返す。
  取得は逐次 + `--interval`（既定 12 秒）で、`--cache-dir` を併用すれば取得済み HTML から
  オフラインで再実行できる。
- スケジュール表の解釈は実ページの fixture（`tests/fixtures/ieice/`）で検査する。

### CFP 候補の証拠付き昇格

- `scripts/observe-cfp.ts` は `--body` を必須とし、取得先と最終 URL、HTTP 状態、応答ヘッダ、取得時刻、本文 SHA-256、parser version、本文抜粋、抽出候補、source revision、保存本文を一つの capture として記録する。
- `scripts/verify-cfp.ts` は保存本文を再読して候補を再抽出し、本文 hash、抜粋、公式ドメイン、日付候補、取得時刻、前回 capture より新しい revision を検証する。capture 内の候補配列だけでは昇格できない。
- 公式 CFP または出版社の capture が無い観測、本文と一致しない観測、会議レビューまたはカテゴリレビューが未完了の観測は昇格しない。
- `scripts/promote-candidates.ts` は参照本文を共通 CAS の `data/evidence/blobs/` へ保存し、本文参照、observations、resolutions の SHA-256 と決定一覧を `manifest.json` に封印する。本文は batch ごとに複製しない。
- provider-aware canonicalization の最良候補と第2候補の許容差は `config.yaml` の `promotion.canonicalization_margin` で設定し、差が未満なら `hold` にする。
- `npm run generate:curated` は各 resolution に安定した ID を割り当て、batch の決定を `curated.generated.yaml` と `promotion_ref` で参照可能にする。
- 保存先は `data/promotions/<batch-id>/` とし、公開 manifest は各 batch manifest の SHA-256 を記録する。

---

## 6. 更新・配信

手元では README.md の「更新の仕組み」に示す順序で、上流取得、候補探索、
ビルド、データ検証、health gate を実行する。
`.github/workflows/` は同じ検査を GitHub Actions で実行する。

- `ci.yml` は typecheck、lint、テスト、offline build、データ検査、health、推薦回帰を実行する。
- `deploy.yml` は main の現行 SHA だけを GitHub Pages に配信し、`publish.json` を証明する。
- `update-data.yml` は上流取得と再確認の結果を data PR にする。
- `recommendation-bundle.yml` は埋め込み bundle を封印し、`nightly.yml` は実論文ベンチを残す。
- `publish.json` の `workflow_run_id` はローカル実行では `null` になる。schema 4 の型は
  `string | null` のまま維持する。
- health gate の比較用 baseline と保存先は、`health-gate.ts` の第2、第3位置引数で明示する。
  `npm run update` は既存の `public/` を baseline なしで検証し、baseline を保存しない。
- `validator-findings.json` は warning 抑制の正本である。`accepted` は `expires_at` を過ぎると
  再レビュー対象として検証を失敗させ、履歴用の `fixed` は現行 warning の baseline にしない。
- 実論文ベンチ（dev / heldout 全件）は `node src/bench-recommender.ts` で実行する。
- 手元確認は `public/` を使う。main の現行 SHA は `deploy.yml` が Pages へ配信する。

---

## 7. 静的サイト（`site/template.html`）

- **コア UI は静的テンプレートと strict TypeScript 実行時処理に分離**。表・絞り込み・テーマ・フォントは外部 CDN・
  Web フォント・外部画像を使わない（#223）。`site/app.ts` は `recommender.ts`、
  `recommendation-core.ts`、`publish.ts` を明示 import し、ビルドは同階層の
  `app.js`、`recommender.js`、`recommendation-core.js`、`publish.js` を生成する。
- 推薦機能だけ、オフライン時の代替動作を備えた任意 CDN を遅延ロードしてよい。
  許可するのは次の 3 URL に限る。
  `https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm`、
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`、
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`。
  CDN または `embeddings.json` が使えないときは画面に意味検索を利用できないことを表示し、
  語彙スコアと TXT 入力だけで動く。締切モードは推薦用埋め込みの有無に依存しない。
- `index.html` は `Content-Security-Policy` を持ち、script / worker / model 接続を上記の
  固定 origin に限定する。`unsafe-inline` は単一テンプレート内の既存 inline script/style
  を維持するためだけに使い、外部 origin の wildcard は許可しない。
- ビルド時に、テンプレート中の文字列 **`/*__DATA__*/null`** が
  `data.json` 相当の JSON リテラルに置換される。これが唯一のマーカーである。
  ビルドは JSON を JS ソースへ埋めるので `</` を `<\/` に、`<!--` を `\u003c!--` に置換し、
  U+2028 / U+2029 をエスケープすること（実データに `&` を含む文字列が 17 箇所ある）。
  テンプレートが無ければ警告して index.html をスキップする（テストのため）。
- 表示: 日時列は **JST を主表記**とし、和暦を使わず `YYYY-MM-DD(曜) HH:MM JST` の順で最上段に置く。
  JST を主にするのは、AoE 締切（`23:59 AoE`）が JST では翌日 20:59 になり、
  UTC 優先では日本でいつ提出すればよいか判定できないため。
  閲覧者のブラウザ時刻やタイムゾーンに依存してはならない（`tests/build_golden.test.ts` が
  複数の `TZ` で同一結果を確認する）。日付のみの締切（`date-only`）は §4 の不確実性区間どおり
  時刻を出さず「時刻未確認」を表示する。ただし**曜日は添える**（`weekdayJaFromDate`）。
  `YYYY-MM-DD` を UTC の暦日として読んで出すだけで、瞬間は作らない（TZ で前後しない）。
  `Date.UTC` の暦月繰り越し（`2026-13-45`）には曜日を付けない。
- 会期列も同じ `weekdayJaFromDate` で `2026-12-17(木) 〜 2026-12-18(金)` の形にし、出張・会場押さえを
  曜日で見込めるようにする（暦日が読めない `date_text` 中心の会期はそのまま出す）。
- 日時列の 2 段目は **公式表記の注記**とし、`site/recommender.ts` の `officialZone`（`tz_raw` の正本）で決める。
  `AoE` 締切は `公式 … AoE`、`JST` / `UTC+9` 宣言の締切は `公式 JST 締切`、
  `UTC` または表記なしは `… UTC`、それ以外の未知の表記は原文のまま `公式 <表記> ／ … UTC` を出す。
  **JST 宣言の締切に AoE を併記しない。** 存在しない AoE 締切があるという誤解を生むため
  （国内研究会・国内シンポジウムの多くは `UTC+9` / `JST` 宣言）。表と詳細ドロワーは同じ式を使う。
- 分野の表示名は日本語とし、`site/recommender.ts` の `CATEGORY_LABELS_JA` を単一正典とする。
  `data.json` / `catalog.json` の `categories` は機械可読の英表記を維持し、書き換えない。
  検索語（行の `hay`）には分野キー・分野の日本語名・国内会議の「国内」を含める
  （チップを知らない利用者が「ネットワーク」「国内」と打って絞り込めるようにするため）。
- 開催地の表示は `site/recommender.ts` の `placeJa` を正本とし、**各 `/` 区切りの末尾カンマ句に
  現れる国名・開催形式（online / virtual / hybrid / in person / TBD）だけを**日本語に寄せる。
  会場名・都市名を含む先頭側は置換しない（`Panama City, Panama` を「パナマ City」に化かすと
  場所を特定できない）。対応表に無い語は推測せず原文を残す。
  - **対応表に足すのは、収録済みカタログの末尾句に実際に現れた語だけ**にする
    （都道府県の補完と同じ方針。未収録の語を先回りで入れても検証できない）。
    国名を書かない表記では州・州名が末尾に来る（`Boulder, Colorado` →
    `Boulder, コロラド州`）。国名も州も無い行は都市が末尾になるので、都市も同じ扱いにする
    （`Paris` → `パリ`）。追加前后の実測で、英語のまま残る末尾句は 43 種 88 版 → 2 版 に減った
    （1622 版のうち。残る 2 版は下の意図的な除外）。
  - **意図的に入れていない語**: 二字の国コード（`Antwerp, BE`。`GA` のように州と国で迷うので
    推測しない）、会場名の中に含まれる国名（`Radisson Grenada Beach Resort Grenada` を
    置換すると会場名が壊れる）。
  一覧のセルには `title` に原文を、詳細ドロワーには「原表記」として原文を出す。
  行の検索語 `hay` には日本語化後の開催地も含める（「韓国」「オンライン」で検索できる）。
- 0 件のとき、**検索語が収録データ全体では何件に当たるか**も併せて出す（`queryMatchCounts`）。
  表は投稿締切・未来だけを出すので、収録している語でも 0 件になりうる。実測（検証時計
  2026-08-09）で `情報検索` は収録 17 件・既定画面 0 件、`大規模言語モデル` 18 件・0 件、
  `強化学習` 7 件・0 件（主題タグとしてドロワーに出る語たち）。
  「 kamiyobi に無い」と「今出していない」が区別できないと、そこで検索をやめてしまう。
  文言は「検索語『情報検索』は収録済みで 17 件に当たります（表は投稿締切でこれから先のもの
  だけを出す既定と、いまの絞り込みで 0 件になっています）」で、**どの条件を外せば出るとは
  言わない**（他の条件で 0 件のときに過剰な約束になる。外せる条件は下記の並べ替えに譲る）。
  常時受付ジャーナルに当たるときは「『種別』で選べます」を添える。収録に無い語では出さない。
- 0 件の案内は**原因を特定したら他の説明文を足さない**。考えられる理由を全部並べると
  「結局どうすればいい」が読めないため。原因（種別に当たる / 収録はあるが既定で出さない）が
  分かったら、①原因の文を先に立て、②外せる条件は `外せる条件: …` として後ろに添い、
  ③推測で並べる `多いのは …` には切り替えない、④`検索語を短くする` や会期のみ
  （`upcoming.md`）の案内は落とす。外せる条件が何も残らなければ原因だけで打ち切る。
  実測（検証時計 2026-08-09、ビルド後の `emptyDeadlineHint` の出力）:
  - `情報検索` → 「検索語「情報検索」は収録済みで 17 件に当たります（…）。
    外せる条件: 「過去の締切も表示」をオン。」（108 字）
  - 条件を全部外して 0 件 → 「多いのは 「過去の締切も表示」をオン。開催日だけが…」（74 字）
- 0 件のときは `emptyDeadlineHint` で、まず**検索語が表に出さない種別に当たっているか**を見る
  （`queryHiddenKindMatches`）。`採否通知` は てびき と件数欄に語が出るのに、表は投稿締切だけ
  を出すため検索すると 0 件になる（「収録が無い」と誤解して離脱する）。部分一致が及ばない
  言い方は `HIDDEN_KIND_ALIASES_JA` で受ける（`合否` → 採否通知、`camera ready` → カメラレディ締切）。
  外せる条件は実名で並べる（**数えるのはセレクト・チップ・トグルの実在する絞り込みすべて**。
  種別 `kind` を数えないと「概要締切 + `音声`」で 0 件になった人に外せる条件が無いと
  言って打ち止めにする。実際、`音声` は検索語だけなら 1 件あるのに概要締切を合わせると 0 件）。
  ラベルは選択肢の生成と同じ定数（`KIND_ALL_LABEL_JA`）を読み、案内が古いラベルを指さないようにする。
  「締切まで」を「かまわない」に変更 /
  「過去の締切も表示」をオン / 分野チップをはずす / 「国内研究会・国内シンポジウムのみ」をオフ /
  ランクを「すべて」に変更 / 検索語を短くする）。条件をすべて外して 0 件のときは
  「開催日だけが確定している会議は表に出さず upcoming.md に載せる」と説明する
  （§7 の表は投稿締切だけ、という仕様を読者に伝えるため）。
- **開く前に何のサイトかわからせる**: `index.html` は `lang="ja"` に加え、日本語の
  `description` と Open Graph（`og:locale: ja_JP` 含む）を持つ。入口は検索とチャット
  （研究室のグループに貼ったとき）の両方なので、どちらでも「JST・曜日で見る締切一覧」
  が伝わる文面にする。`canonical` と `og:url` は `config.yaml` の `site.base_url` と
  一致させる（テストで検査）。`og:image` は SVG をプレビューできないチャットがあるため置かない。
- **絞り込んだ結果を CSV で書き出せる**（`Recommender.deadlinesToCsv`）。書き出すのはページング後の
  表示分ではなく `shown`（絞り込み後の全行）。列は日本語（締切 / 公式表記 / **残り日数** / 会議 /
  種別 / ラウンド / CCF / CORE / THCPL / 会期 / 開催地 / 状態 / URL）、改行は CRLF、締切は JST＋
  曜日を主とし `公式表記` 列に AoE などの原文を受ける。ダウンロード時に **UTF-8 BOM を付ける**
  （Excel が BOM 無しを日本語として読めないため）。推薦モードではボタンを出さない。
  **CSV の列は表に見えている情報を落とさない** — 表に出す評価一覧（CCF・CORE・THCPL）は
  CSV にも載る（THCPL 列を持たなかった時期は、画面で見る評価が書き出し後に消えていた）。
- **CSV の `残り日数` は数値、画面の「残り」は読みやすい語**。CSV は `13` / `0` / `-5` の数値で
  出し、過ぎた締切は負の数にする（`残り13日` の文字列だと表計算で `120` が `2` より前に並び、
  締切の近い順に並べ替えられなかった）。日付だけの行も日粒度の数値を出す（時刻の未確認は
  `公式表記` 列が既に伝えている）。常時受付ジャーナルは空欄。画面側は §4 の語彙
  （`あと N 日` など）のまま変えない。
- **印刷して研究室に貼れる**: `@media print` で操作要素（モード切替・絞り込み・てびき・
  CSV ボタン・さらに表示・ドロワー）を落とし、行の分断を防ぎ、紙で押せないリンクは URL を
  本文へ印字する。幅せまカード表示のメディアクエリが印刷幅でも当たることがあるため、
  表として印刷させる。画面は 40 行ずつの描画なので、`beforeprint` で絞り込み後の全行を
  描画し `afterprint` で戻す（印刷物だけ直近 40 件で打ち切らない）。データ源の行は
  出典として印刷物でも価値があるので残す。
- **日本語 IME の変換中に再計算を走らせない**（`wireDebouncedInput`）。
  `compositionstart` / `compositionend` で変換中を判別し、未確定のひらがな（「きかい」）で
  一覧を入れ替えない。確定後に debounce（検索 180 ms / 論文入力 200 ms）で一度だけ適用する。
  値は `apply()` 側で入力欄から読むので、遅らせても取りこぼさない。
  - **対象は検索欄だけではない**。論文入力のタイトル・要旨・キーワード・参考文献は
    日本語で打つ欄なので、検索欄だけ守っても使っている人は同じもたつきを踏む。
    入力欄はこの経路に集約し、`input` を生で張った欄を残さない（検査が 1 箇所に固定する）。
  - 打鍵ごとに走らせてよい軽い処理（埋め込みキャッシュの無効化）は `onType` で分ける。
    再計算を後回しにしても、変換の隙に分野チップ等を押したとき古い結果を使い回さないため。
  - `compositionstart` を飛ばして `compositionend` だけ飛ぶ経路でも取りこぼさない
    （`compositionend` 自身も適用を予約する）。
- **相対月でも引ける**（`expandRelativeMonths`）。`今月 / 来月 / 再来月 / 先月 / 先々月` を
  JST の暦月として `YYYY年M月` に展開する（展開先は `monthTermsJa` が hay に入れた語と揃える）。
  月の加算は日付を足さず月だけで行う（1/31 に 1 ヶ月足すと 3/3 になるため）で、年跨ぎに
  対応する。UI は展開後の語で絞り込み（`searchQuery`）、判定式は recommender に一本化して
  二重実装しない。展開を伏せると誤信を生むので、件数欄に `｜ 来月 = 2026年10月` を出す。
- **都道府県でも引ける**（`placePrefectureJa` / `placePrefectures` / `prefectureOfficialJa`）。
  会場表記に都道府県が書かれていない行（`倉敷市芸文館`、`名古屋大学 基盤センター`、
  `北九州市（FIT2026）`、`能登方面の予定`）は「岡山」「愛知」「福岡」「石川」で引っかからない。
  収録済みの国内会議の会場表記に現れた都市名だけを都道府県の手がかりとして検索語に足す
  （都市表を実データの見聞なく広げない）。語は `岡山 岡山県` の形で入れるので `岡山県` でも
  `おかやま` でも引ける。表示する公式表記は書き換えない。
  - **正式名を使う**（`PREFECTURE_OFFICIAL_JA`）。`県` を一律に足すと `北海道県` `東京県`
    `京都府県` という実在しない地名ができる（札幌の会場補記で実際に発生した）。
    東京は `東京都`、京都は `京都府`、大阪は `大阪府`、北海道はそのまま。正式名が都道府県名と
    同じものは語を繰り返さない。
  - **複数の都道府県に読める表記は補記しない**。都市名は部分一致で見るため `東京都市大学` は
    東京と京都の両方に該当する。間違った土地を printed に載せるほうが悪いので、手がかりが
    1 件のときだけ末尾に空白区切りで添える。
  表の開催地表示は公式表記のまま。
- **「残り」の語彙は てびき に書き出す**: `あと N 日`（14 日以内は強調）・`あと N 時間`（当日）・
  `まもなく`（1 時間未満）・`本日終了`・`N 日前に終了`・`時刻未確認`（日付だけの締切は
  `remain()` を通らず呼び出し側で出す）。ラベルの実装断片と てびき の説明を両方検査して、
  文言を変えても説明だけ古いままにならないようにする。
- **表に出す語は、実カタログの全値について日本語表記を持つ**。実ビルドの `data.json` を
  読み、出現する締切種別・分野・主題タグを総当たりして検査する（対応表に無い語は
  種別と分野はそのまま英語で出たり、主題ドロワーから黙って消えたりする。データに語を
  足した人が気づかないまま溜まる系列）。主題ドロワーに出さないタグの許容リストと理由は
  次の 4 つに限定する（`tests/build_golden.test.ts` と合わせる）。
  `domestic-jp`（「国内のみ」しぼりの構造タグ。行頭に「国内」を出す）／
  `journal`（種別列が「常時受付」として既に伝える）／
  `sensys`（統合先の名前。「掲載終了」「統合済み」が伝える）／
  `virtual-execution`（開催地が "Virtual" を示し「オンライン参加可」が伝える。
  開催地がオンラインを示さない会議に付いた場合は検査が落とす）。
- **分野と締切種別の言い方を寄せる**（`QUERY_SYNONYMS_JA`）。日本の研究者が口にする語を、
  **表に出している語そのもの**（分野名・締切種別・主題タグの表記）へクエリ側で展開する
  （`スパコン` → `高性能計算` / `hpc`、`抄録` → `概要締切` / `abstract`）。
  寄せ先は画面に出す表記の対応表（`CATEGORY_LABELS_JA` / `KIND_LABEL_JA` / `TAG_LABELS_JA`）に
  載っている語だけに限る。表に無い語（会議名の中の言葉など）へ寄せない — 寄せ先が行に
  見えない語になると、なぜその行が出たか分からなくなる。実測（3234 行）で
  `スパコン` は 0 件、`スパコン` を寄せると 214 件（`hpc` と同件数）。
  締切種別も同じで、`抄録`・`要旨`・`アブストラクト` が 0 件（`概要` は 660 件）、
  `全文`・`本論文`・`フルペーパー` が 0 件（`論文` は 1971 件）だった。学会側の語は
  「抄録締切」なので、そのままでは自分の投稿先が見つからない。
  「高性能計算」は収録しているのに引き方が分からない、という食い違いを防ぐためで、
  展開は 1 描画 1 回なので
  打鍵あたりの全走査は 9.6 ms のまま（語 1 つごとに分解しない方針は変えない）。
  - **寄せたことは件数欄に書く**（`「スパコン」は分野「高性能計算」で探しています`）。
    理由も出さずに分野全体の行を並べると、なぜ出たか分からないまま行数の壁になる。
  - **精密に引ける語は寄せない**。`機械学習` は主題で当たるので、分野全体に寄せると
    2 桁多く出て精密さを失う。
  - 展開語は分野名・主題タグの日本語表記だけを指す（内部キーだけの指向にしない）。
    同義語表の行き先が画面に出る語であることを検査する。
- **種別セレクトには到達可能な種別だけを並べる**。「選んでも 0 件になる選択肢」は
  選択肢として成立しない。正本は `SELECTABLE_KINDS`（概要・論文・常時受付）で、
  `filter()` の `byKind` が通す集合と必ず揃える。これまで選択肢は `KIND_LABEL` の全鍵から
  作られていて、採否通知・カメラレディ・登録締切など 8 種別を選んでも 0 件だった
  （実測: 採否通知は収録 242 件あるのに選択結果は 0 件）。採否通知などを表に出さないのは
  既存の仕様（§7「サイト表は投稿締切のみ表示する」）なので変えず、追う場所を
  `upcoming.md` に残す。URL で実在する投稿締切以外の種別を受けたときは黙って捨てず、
  件数欄に理由を添える（相対月を解決したときと同じ方針）。不明な種別名は説明を出さない。
  検査はビルド後の `filter()` を実データで走らせ、選択肢の各値が行を返すこと、
  投稿締切以外は 0 件であること、`selectableKind` が理由を返すことを見る。

- **件数欄は「のぞいた行数」の内訳を添える**。「477 件 / 全 3234 件」だけだと、探した締切が
  **無い**のか、既定で**隠れている**のかを読み手が区別できない。既定で隠れる 3 条件
  （過去の締切・推定日程・投稿締切以外の種別）で落ちた行数を `hiddenDeadlineCounts()` が持つ。
  条件式を UI 側に書き出す二重実装を避けるため、`filter()` の述語の中で
  `byEst` / `byPast` / `byKind` に名前を付けて、絞り込みと計数を同じ判定から使う。
  各条件は**独立に**数える（1 行が過去かつ投稿締切以外なら両方に立つ）ので、
  内訳を足すと全件を超える — 表示は「のぞく: …」の形にして合計を読ませない。
  推薦モード（論文入力あり）では締切画面用の条件を適用しないので数えない。
  実測（検証時計 2026-08-09 のビルド）で 全 3234 行 / 表示 477 行 /
  のぞく 過去の締切 2317 件・投稿締切以外の種別 603 件・推定 0 件
  （このビルドでは推定版に締切が無く、行そのものを作らない）。

- **分野チップに件数を添える**。数は「その分野の絞り込み以外を通った行」の数（facet の
  通常の形）。選んだ分野で自分の選択肢が消えると、次が何度でも 0 件に見える。
  `filter()` は述語を **分野以外（`matchesExceptCats`）と分野**に分割し、分野のカット前に
  数えて `catFacetCounts` へ入れる（UI 側に条件式を二重化しない）。チップへの反映は
  `updateCategoryCounts()` が描画のたびに行う。0 の分野は**消さずに薄く出す**
  （`.chip-count.zero`）— 消すと収録が無いのか絞り込みのせいか区別できない。
  実測（検証時計 2026-08-09、推定を除く投稿締切・未来の 477 行）で
  AI 182 / システム 92 / セキュリティ 78 / DB 71 / HPC 50 / ネットワーク 39 / 理論 32 /
  グラフィクス 27 / HCI 10。
- **ランクの表示語を読める語に直し、その語で検索できるようにする**。評価一覧に載るが評価の
  付いていない値は §2 で `N` = ランク無しと検証済みだが、表は内部トークンの `N` をそのまま
  出していた（`CCF N`）。`Recommender.rankPairLabelJa` が `CCF 評価なし` に直す正本で、
  表・ドロワーのどちらもここを受ける。評価一覧にそもそも載らない行は「未確認」（§7 の
  空欄規則）なので、**語を使い分ける** — 「 kamiyobi が未確認」と「一覧が評価を付けていない」は
  別の事実だから、1 語に潰さない。
  `rankSearchTerms` が表に出す語（`ccf b`・`評価なし`・`ccf評価なし`）を `hay` に添える。
  実測（検証時計 2026-08-09 のビルド、全 3234 行）で `CCF B` は 2 行 → 1463 行、
  `A*` は 0 行 → 941 行、`評価なし` は 0 行 → 847 行（`N` を持つ行は 847 行で一致）。
  検索の照合は語の AND なので、`CCF B` は「ccf を持つ行」と「単独の b を持つ行」の積になる。
  会場名中の「B」も入るため、**絞り込みの正確さはランクのセレクト側**が持つ
  （`rankMatches` の grade 厳密比較。ビルド成果で grade ごとに既定画面の部分集合であることを見る）。
- **英字 1〜2 文字は語の境界で照合する**（`isShortLatinTerm`）。部分一致のままだと `N` が
  3234 行中 3219 行に当たり、検索として成立しなかった（実測）。`matchFoldedGroups` で
  1〜2 文字の英字だけ英数字に挟まれた一致を使わないことにする（正規表現を作らず走査する。
  語の分解は 1 描画 1 回の方針は変えない）。実測で `N` は 3219 行 → 24 行。
  日本語表記の末尾記号（`122号館B` の B）は語の境界として残す。
  全走査のコストは変更前と同水準（1 走約 9.6〜12.5 ms / 3234 行。境界走査を足した
  短い語の照合で約 +2 ms）。
  - **2 文字も同じ扱いにした理由**は、会議の略称が `SC` など 2 文字で書かれるため。
    部分一致のまま略称と年を合わせ打てるようにすると `sc26` が 199 行に膨らみ、
    `adc 2026`・`ai4s 2026`（"science" の一部）まで拾った（実測）。境界照合にして
    `sc` は 342 行 → 45 行、`sc 26` は 199 行 → 23 行に減り、`SC26` の直書きは残る。

- **略称に年を貼り付けて打てる**（`abbrevYearGroups`）。表は `NSDI 2027` と別々の語に割れて
  書くが、打たれるのは `nsdi27` / `nsdi2027` のような 1 語の形で、そのままでは 1 件も
  当たらなかった（実測: `ICDE2027` 0 件 / `ICDE 2027` 6 件、`nsdi27` 0 件、`OSDI26` 0 件、
  `INFOCOM26` 0 件）。語を「略称か打ち込まれた形」「年か打ち込まれた形」の 2 組に分解して
  AND で要求する（語の組は OR、語同士は AND という §7 の組み方のまま）。
  - **両方の組に打ち込まれた形そのものも入れる**。`SC26` のように語が割れていない行を
    割った条件だけで落とさないため（実測で `SC26` の 5 行はそのまま残る）。
  - 末尾の数字は 2 桁（`27`）と 4 桁（`2027`）の両方を受け、年の組には両方の表記を入れる
    （hay は `2027` と書くので `27` だけでは当たらない）。
  - **略称 1 文字では割らない**（取り合わせで何でも当たる）。
  - 割ったことは件数欄に書く（`「nsdi27」は「nsdi」と「2027」に分けて探しています`）。
    理由の見えない行数の壁にしないためで、分野の言い方と同じ入口
    （`querySynonymNotes`）から返す。

- **ドロワー（行の詳細）は一覧の情報を落とさない**。分野（`catLabel` の日本語名）、
  ランク表記は表のセルと同じ形（`CCF B`）、ラウンド（`第 N ラウンド`）と `dl.label` を
  併記する。詳細を開いたのに一覧より分からない、という状態を防ぐ。
  値が無い項目は**見出しごと出さない**（主題タグと同じ扱いで、
  一覧は列が必須なので「未確認」を出すのとは事情が違う）。`DrawerRow` には `cats` / `rankPairs` を optional で足す
  （表の行以外から呼ぶ経路もあるため）。
  検査はビルド後の `openDrawer` を実行して文言を見る。`openDrawer` は関数式として eval する
  ため、モジュールスコープの語（`UNCONFIRMED_JA` など）は仮引数で渡す必要がある。

- **空の値は「未確認」として出す**（会期・開催地・ランク）。記号「-」だけだと、
  利用者は「該当なし」「収録漏れ」「公式未発表」を区別できない。理由文は title に置く。
  「未定」にしない — 会議が決めていないという主張になり、 kamiyobi が確認できていない
  という事実とは別の話になる（`締切の推測はしない` と同じ方向）。ドロワーも同じ語を使う。
  実測（検証時計 2026-08-09 の既定表示 477 行）で会場が空または未定が 113 行、
  会期が皆無が 105 行あり、かつては全て「-」だった。
  **画面に出す語なので検索でも引けるようにする**（§7 の「表示している語で検索できる」）。
  `Recommender.unconfirmedSearchTerms` が `未確認` と項目付きの語（`開催地未確認` など）を
  `hay` に添え、条件は表のセルの作り方と揃える（会期は `event_start`、開催地は `place`、
  ランクは `rankPairs`）。語そのものは `unconfirmedLabelJa()` の一箇所だけを持ち、
  表・ドロワー・md で言い方が割れないようにする。
  実測（同ビルドの全 3234 行）で `未確認` 584 行、`開催地未確認` 253 行、
  `会期未確認` 261 行、`ランク未確認` 450 行。全て揃った行はヒットしない。
  ランクは会議単位（`conf.rank`）なので、同じ会議内でランク欠落/充足の行は作れない。
- **「オンライン参加可のみ」の絞り込みがある**（チェックボックス＋ショートカット、URL は
  `online=1`）。判定は `Recommender.placeOffersOnline` が持ち、会場表記に「オンライン」
  「ハイブリッド」「Online」「Virtual」などの記述がある行だけを通す。
  **記述の無い行を対面とは判定しない**（書かれていないことから参加形式は推定しない）。
  会場名そのものに語が含まれる例（`KSIR Virtual Conference Center`）は
  `ONLINE_VENUE_FALSE_POSITIVES` で除外する（2026-09-22 の実データで誤判定になった）。
  比較は `kanaFold` 済みテキストに対して行うので、照合語も同じ形に畳んで持つ。
  実測（検証時計 2026-08-09 のビルド）で 3234 行のうち 98 行、うち国内 16 行。
- **ドロワーに「今後の会期」を併記する**: 研究会は毎月開くので、行になっている回より後の会期を
  同じ研究会から最大 3 件並べる（過ぎた回と、いま見ている回は出さない）。日程の書き方は
  一覧と同一の `meetingRangeJa()` を使い、案内側（0 件時）とドロワーで書式がズレないようにする。
  関数は索引を作る側と同じ `recommender.js` に置く（第 220 回）。**並べた日程はその行の検索語にも
  入れる**（行の詳細に書いた日付が検索で引けないのは噓なので）が、併記する会場名は入れない –
  入れると「南米」や「ハイブリッド」の当たり方が壊れる（実測は第 220 回の項目に書く）。
  「会期のみ・締切未定」は てびき にも語彙として立てる。
- **0 件のときは「会期だけ確定している次回」をその場に出す**: 締切が未定の研究会は締切一覧の
  表に載らない（`upcoming.md` 側にしか出ない）ため、検索語が合っているのに 0 件で終わる。
  `Recommender.scheduleOnlyEditions()` が「締切を持たない版」を `candidateRows` と同じ検索要素
  （分類・開催地・都道府県・月・タグ）で返し、`renderNextMeetingNote()` が最高 3 件を
  「2026-11-12(木)〜11-13(金) 情報処理学会 AL 研究会 ＠松江テルサ（島根県）」の形で並べる
  （同じ年は年を二度書かず、時刻は付けない）。期間・分野・国内の絞り込みは表と同じ条件で従う。
- **並び順も URL に乗せる**。絞り込み（`q` / `cats` / `win` / `domestic` / `past` / `rank` / `kind` /
  `est`）に混えて `sort`（`rem` / `date` / `conf` / `rank`）と `dir=desc` を書く。既定の並び
  （残りの昇順）なら引数を足さない。開いた側では `SORTABLE_KEYS` に無い key を無視して既定に
  戻し、復元した並びは表の中身だけでなくヘッダーにも反映する（見出しが既定を
  指したまま中身だけ並ぶのは読み違えのもと）。`SORTABLE_KEYS` は `th[data-sort]` と一致させる。
  - **並び順は目に見える方でも伝える**。`aria-sort` は支援技術向けで、マウス利用者には
    何も見えないため、見出しの語尾の目印を押している列だけ `↑` / `↓` に変える
    （`sortMarkJa`。他の列は `↕` のまま）。見出しは「語 + 目印」の一字列なので、
    語尾の目印だけを入れ替え語は削らない。降順にすると月の区切りが消える
    （§7 の月グループ化は昇順のときだけ）ので、その理由も目印で分かる。
  - 見出しには `title` で押した結果を書く（「ここを押すと『日時（JST）』の昇順・降順を
    切り替えます」）。押す前に意味が分かるようにするため。
- **「締切まで N 日」は、過去を表示しているときに前後が対称になる**（`windowFloorMs`）。
  変更前は窓が未来側にしか無く（上側は `windowLimitMs` のみ）、「過去の締切も表示」と同時に
  選んだとき過去分が片端から残った。実測（投稿締切のみ）で **「7 日以内」+ 過去表示 =
  2,059 行**（2019 年まで全部）となり、窓が意味を失っていた。過去表示時は同じ日数の前後の窓と
  して扱い、同じ条件で **55 行**（過去 16 件 + 今後 7 日 39 件）になる。日付だけの行は終端側
  （`tLast`）で窓に触れているかを見る。「かまわない」のときは下限を課さない。
  てびきの「締切まで」の説明は変更前の実装と逆のことを書いていた
  （「過ぎた締切は期間の外に出ます」）ので、実装に合わせて書き直した。
- **開催地は日本語の表記でも引ける**（`PLACE_QUERY_ALIASES_JA`）。開催地のセルは公式表記
  （`Seattle, USA` / `Montréal`）を変えない方針を維持したまま、検索語側だけで届かせる。
  変更前の実測（収録カタログ 3,234 行・既定画面 477 行）: `東京` 0 件（`tokyo` は 28 件）、
  `シアトル` 0 件（以後 22 件）、`ホノルル` 0 件、`米国` 0 件（`アメリカ` は画面に見える語）。
  表は収録カタログの開催地に現れる都市に限定する（実測で英字の都市句 124 種。収録に無い
  `仙台` / `広島` の英文字表記は、会場が日本語で書かれているため死語になるので置かない）。
  国名の別表記（`米国` `合衆国` `英国` `豪州`）も同じ場所へ寄せる。
- **`（hybrid）` と書かれた行が「オンライン参加可」に入ってなかった**（`ONLINE_TERMS_EN` の
   英語側に対面併用の語が無かった。2026-09-23 実測: `Málaga, Spain (hybrid)` のような
   表記が 18 行あり、ぜんぶチェックボックスで落ちていた。日本語表記の `ハイブリッド` は
   `ONLINE_TERMS_JA` に入っていたので、**英語表記だけ漏れる不整合**だった）。語を足して
   オンライン参加可の行を収録 97 → **117 行**（投稿締切・非推定では 96 → 114 行）に広げた。
   既定画面は 15 行のまま（hybrid の行はいずれも過去の締切なので目立たないが、
   「過去の締切も表示」をオンにした人と、今後の収録で効く）。
- **「中国」で国名と地方の両方が引けるようにした**（`REGION_READINGS` に `中国` を追加）。
  `中国` は国名の行に当たり、中国地方の行は `中国地方` と打たないと出なかった
  （2026-09-23 実測: `中国` 233 行、中国地方 3 行が別入力）。地方の行を**足す方向**に広げて
  236 行にし（`中国` ⊇ `中国地方` を検査）、どちらを探しているかを件数欄に書く
  （「「中国」は国名と中国地方の両方（鳥取・島根 など 5 か所の表記）で探しています」）。
  `中国地方` は地方だけを出し続ける。
  同じ作業で **`アジア` に国内の行が混ざる回帰**を出したので、その場で止めた
  （`アジア` → `中国` の先が地方見出しになったため、1 ホップ合成（この節の
  「かなで打った地名」）が都道府県まで連鎖させてアジアが 523 → 526 行に膨らんだ。
  「『アジア』に国内研究会は入らない」はてびきで書いている約束なので、
  **地域・地方の見出しでは hop を止める**規則を入れ、収録カタログで
  `アジア`・`ヨーロッパ` に domestic-jp の行が 0 件であることを検査に加えた）。
- **日常語の地方名も引ける**（`首都圏` 28 行・`東海` / `東海地方` 9 行。変更前はいずれも
  0 件）。構成員は収録の開催地に現れる都道府県だけにする（既存の検査が同じ規則を
  見ていて、神奈川・埼玉・千葉・三重・静岡は未収録なので足さない。収録された日に
  検査が足す案内になる）。`甲信越`・`信越`・`南関東` は構成県がすべて 0 行なので置いていない。
  構成員が 1 つの語では説明を「東京・tokyo」の形に直す（「など 1 か所」は日本語として変）。
- **「来年」「今年」と打つと 0 件だった**（2026-08-09 生成ビルドで実測・第 210 回）。月・週・日の相対語は解決するのに、年の語だけ展開されず、そのまま語として検索されていた。

  「来月の締切」「来週の締切」は解決する（`expandRelativeMonths` と `relativeDayGroups`）。年の語は
  どちらの表にも入っていなかったので、`searchNormalize` された `来年` が hay に在るかだけを見て
  **0 件**。2027 年の締切は 863 行中 435 行あり、相対語の中で最も広い該当が黙って消えていた。

  | 検索語 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `来年` | 0 件 | 435 件（`2027年M月` の和集合 435 と一致） |
  | `今年` | 0 件 | 779 件 |
  | `ことし` | 0 件 | 779 件（ひらがなも同じ） |
  | `来年`（時計を 2027-01-01 にする） | 0 件 | 0 件（2028 年の収録が無い） |
  | `今年`（同じ時計） | 0 件 | 435 件 |
  | `去年`（同じ時計） | 0 件 | 779 件 |
  | `来年 福岡` / `来年 国内` | 0 件 / 0 件 | 1 件 / 2 件（他の語とのかけ算は壊れない） |
  | `来月` / `今月` / `再来月` / `先月` | 236 / 183 / 185 / 47 件 | 236 / 183 / 185 / 47 件（変更不要） |

  - 直し方: `RELATIVE_YEAR_OFFSETS_JA`（今年・ことし・本年・来年・らいねん・再来年・さらいねん・
    去年・きょねん・せんねん・一昨年・いとおととし）と `yearMonthTermsJa` を `recommender.ts` に足し、
    `queryTokenGroups` の 1 グループとして返す。年の語は 1〜12 か月語の **OR** なので、相対月と同じ
    文字列展開では作れない（語同士は AND なので、スペースで並べた時点で 0 件になる）。週の語と
    同じ形に従った。基準は JST の暦年（一覧の日時列と同じ）で、年跨ぎは時計から求める。
  - 黙って条件が変わったように見せないため、件数欄に `来年 = 2027年の締切（1〜12 か月）` の形を
    出す（相対月・相対週と同じ `relativeDayNotes` の方針）。てびきの「検索」にも年の語の引き方を追記した。
  - `去年` を 2026 年の時計で打つと 0 件のまま。2025 年の締切行が収録に無い（過去の行は既定で
    隠れる）ためで、展開が壊れているのとは別の話。`再来年`（2028 年）も同じ。
  - 追加した検査は 1 本。「来年」「今年」の件数がその年の 1〜12 か月語の**和集合**と一致すること、
    ひらがな入力が同じ結果になること、時計を 2027-01-01 に移して「今年」「去年」がそれぞれ 2027 年・
    2026 年の和集合と一致すること（年跨ぎ）、他の語とのかけ算が絞り込みとして効くこと、件数欄に
    解決結果が出ることを見る。和集合を使ったのは、12 か月語の件数を足すと同じ行を数え直すため。
    改ざんで落ちることを実測:
    - `queryTokenGroups` の年の展開を消す → `「来年」が 2027 年の和集合と違う件数を出した: expected +0 to be 113`
    - 件数欄の解決結果を消す → `「来年」の解決結果が件数欄に出ない: expected '' to contain '来年 = 2027年'`
  - 検査の作り直し: 絞り込みを検証する既存の検査（`recommendation filter ignores deadline-only state`）は
    built の recommender から検索機構の関数を抜き出して組み立てているため、新しい年の語の定義を
    注入一覧に足さないと同じ検査が `ReferenceError: yearMonthTermsJa is not defined` で落ちた
    （実際に入って、`FILTER_RUNTIME_STUBS` の注入一覧に `RELATIVE_YEAR_OFFSETS_JA` と
    `yearMonthTermsJa` を追加した）。
  - 参考: 今回いっしょに調べて、次は大丈夫だったもの – ランク・CCF・CORE・THCPL・状態・ラウンドの
    表示語はすべてその行で引ける（863 行で不一致 0）、会期に ISO が無く原文を出す 193 行も原文が
    引ける、常時受付 22 行の「残り日数」は空欄で `NaN` は出ていない。

- **カレンダーに入る物の呼称を、内訳まで含めて 4 か所で直した**（第 300 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: 第 299 回で日付の欄名を種別ごとに分けたが、
    入る物の呼び方はそのまま残っていた。928 件のうち **167 件**は採否通知 144・査読結果公開 12・
    反論期間開始 11 で、その日までに何かを出す必要は無い。それを呼んでいた先は 4 か所 –
    ① カレンダー自体の説明 `X-WR-CALDESC`「 kamiyobi が収録した会議の締切。1 件 = 1 つの締切で…
    入るのは収録している今後の締切すべてで、いま 928 件」（カレンダーアプリはこれを情報欄に出すので、
    購読する人が最初に読む話）、② 機械の索引 `llms.txt`「締切をカレンダーに入れるための 1 本 …
    1 締切 = 1 イベント」「今後の締切 928 件」、③ 画面の注記「カレンダーに追加（.ics）に入る締切は
    928 件」、④ 導線の説明文「1 件 = 1 つの締切の終日」。
  - 直し方（`src/build.ts` + `site/app.ts` + `site/template.html`）: 配信行に `deadline`（日付の欄が
    「締切」か）を一行一値で持つ – 最初に本文の文字列照合で数えようとしたが、`IcsRow.body` は
    エスケープ済みの `DESCRIPTION:` 行なので 0 件になった（実測 – 第 300 回。数え方を後から真似ない）。
    `icsCalendarMeta` が `deadline_count` を導き、`catalog.json` の `calendar` に載る（実測 761 件）。
    画面の注記は「入る日は 928 件（…）うち締切が 761 件で、残りの 167 件は採否通知・査読結果公開・
    反論期間の開始のように、その日までに何かを出す必要の無い日です」と言い、内訳の申告が無い古い
    ビルドでは締切の数を言わない。CALDESC・`llms.txt`・導線も同じ内訳に従う。
  - 検査: `tests/calendar_span_declared.test.ts` に 7 件を足す（品書の申告の内訳が配信物の実測と
    一致・`index.html` の埋め込み品書にも同じ欄・CALDESC が内訳と例を書く・画面の注記が総数と締切を
    分ける・内訳の申告が無いビルドでは締切の数を言わない＋全て締切のビルドで内訳を足さない・
    `llms.txt` が内訳を書く・導線が「1 件 = 1 つの締切」に戻っていない）。内訳の件数が 0 件だけの
    空振りも張る。改ざん 45 種（内訳を総数で偽る / 行が締切かを常に締切と決める / 索引で同じ件数を
    二度書く / CALDESC から内訳を消す / 注記から内訳を消す / 注記を「入る締切は」に戻す /
    導線を締切だけが入る言い方に戻す / 第 299 回までの 38 種）すべて検査が落ち、対照は通る。
  - 副産物（同じ回で直した 2 件）: ① 埋め込み品書の照合が、品書の欄を手で写した文字列
    （`"calendar": {"event_count": N, "first_day": …}`）を待っていて、新しい欄を足すと「品書に無い欄を
    待つ」形に壊れていた。品書に載った欄の分だけ照らす形に直す（項目数が 3 未満なら落ちる）。
    ② `llms.txt` の項で「`N 件` が 2 個まで」と個数を張っていた検査は、内訳という別の事実を
    載せると壊れる。個数ではなく「同じ数を二度書いていないか」を見る検査に変えた（同じ数を 2 度
    書いたら落ちることを改ざんで確認）。
  - 代償: `app.js` +1,317 B（gzip +356 B – 決め事ごとのコメントを含む）・`catalog.json` +27 B・
    `index.html` +92 B・`deadlines.ics` +227 B・`llms.txt` +270 B。`recommender.js`・`data.json`・
    `upcoming.md` は第 299 回からバイト一致。
- **カレンダーの中で、締切ではない日が「締切」と呼ばれていた**（第 299 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: `deadlines.ics` の 928 個のイベントのうち
    **167 個**が採否通知 144・査読結果公開 12・反論期間開始 11 で、本文の行は全て
    「締切: 2026-08-09 09:00（JST）」の形だった（実例 `EDBT 2027：採否通知` の本文は
    「会議: EDBT 2027 / 種別: 採否通知 / … / 締切: 2026-08-09 09:00（JST）」）。採否通知は
    結果が届く日で、人はその日までに何かを出す必要が無い。カレンダーは本文の行をそのまま出すので、
    一覧に並んだ瞬間に締切に見える。サイトの表はこれらの種別を出さない仕様で
    （第 283 回 – 「それらを追うのは `upcoming.html`」）、カレンダー側だけ「締切」のままだった。
  - 直し方（`site/recommender.ts` + `src/build.ts`）: 種別から日付の欄名を決める
    `kindDateFieldJa` を品選びの正本に足し（採否通知 → 通知日 / 査読結果公開 → 公開日 /
    反論期間開始 → 開始日 / 他は締切）、`DataRecord.date_field` に持たせて ICS の本文がそれを書く
    ようにした。提出を待つ日（概要・論文・補足資料・カメラレディ・登録・反論期間終了・常時受付）と、
    品書きに無い種別は「締切」のまま – 直し過ぎない。会期（開催）の行は「会期」（今は
    カレンダーに入れていないので、将来入れたときのために決めておく）。
  - 実測した直し後（同じビルド）: 採否通知 144 件 → 「通知日: 2026-08-09 09:00（JST）」、
    査読結果公開 12 件 → 「公開日: …」、反論期間開始 11 件 → 「開始日: …」で、締切ではない日に
    「締切:」を書いたイベントは 0 件。逆に論文締切 391・概要締切 104・カメラレディ締切 86・
    反論期間終了 26・登録締切 6・補足資料締切 2 は「締切:」のままで、日付の欄が 0 個または
    2 個以上のイベントも 0 件。
  - 検査: `tests/ics_feed.test.ts` を 44 件に増やした（第 299 回で 6 件 – 採否通知は通知日 /
    査読結果公開は公開日・反論期間開始は開始日 / 提出する日は締切のまま（直し過ぎ防止） /
    日付の欄は必ず 1 個 / ビルド成果の品選びが欄名の正本になっている（知らない種別・種別なしは
    「締切」） / 実ビルドのカレンダーに締切ではない日の『締切』が残っていない（件数の下限付き））。
    改ざん 38 種（本文を常に「締切:」にする / 品書きを作るときに欄名を決めない / 品選びの表から
    採否通知を落とす / 反論期間開始を締切に混ぜる / 欄名の関数を品選びの外に出さない /
    第 298 回までの 33 種）すべて検査が落ち、対照は通る。
  - 副産物（同じ回で直した 2 件）: ① 購読手順の本文に、開発側の名前「品書」が 4 箇所残っていた
    （第 294 回からの追記で混んだ – 画面に出ない語はコメントと SPEC 限り）。収録・
    `catalog.json` に直し、てびきの本文に混ぜない検査を `tests/build_golden.test.ts` に足した
    （品書を戻すと落ちることを実測で確認）。② 文書に項を足す手順が錨の行末に改行を足しておらず、
    次の項が同じ行に潰れていた 4 箇所（購読手順 1・SPEC 3）を直した。Markdown は同じ行の「- 」を
    項と数えないので、見出しが増えたのに一覧に無い状態になっていた。繋がりを防ぐ検査を
    `tests/docs_rounds.test.ts` に足した（繋ぎ直すと落ちることを実測で確認）。
  - 代償: `recommender.js` +1,330 B（gzip +383 B – 欄名の表と決め事ごと）・`deadlines.ics`
    +516 B（gzip +561 B）。`app.js`・`catalog.json`・`index.html`・`data.json`・`upcoming.md` は
    第 298 回からバイト一致。
- **収録にある締切の日を、一番遠い日しか言わなかった**（第 298 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: 第 295 回から、収録にこれからの締切が在る会議を
    引いた人へ「その会には 2027-06-01 の締切が収録に在りますが」と言っていた。これは収録の
    締切行の**一番遠い日**だった。実測で、収録にこれからの締切が在る会議 **42 件のうち 19 件**は、
    一番近い締切がその日より前に在る（CADE: 申告 2027-06-01 / 一番近いのは 2027-02-16 の概要締切で
    全 4 本・NETYS: 2028-03-30 と申告していたが概要は 2028-03-23・FORTE: 2028-02-05 に対し
    2028-01-29）。締切が複数あるのは普通で、遠い日だけを教えると人は間の締切にも間に合うと思う。
  - 直し方（`src/build.ts` + `site/app.ts`）: 品の窓に締切行の無い会議のうち収録に生成時刻以降の
    締切が在る 42 件に、`record_deadline_next`（一番近い日）・`record_deadline_next_kind`・
    `record_deadline_count` を載せ、案内はそれをそのまま使う（「その会の締切が収録に 4 本在って、
    一番早いのは …」ではなく、一覧と同じ並びの言葉で「その会の締切が収録に 4 本在って、一番
    近いのは 2027-02-16（概要締切）です。」）。1 本のときだけ「一番近いのは」を落とす。種別は
    表と同じ語（`kindLabelTable()`）に直して括弧に括り、表の知らない種別では括弧を付けない。
    品書の生成は一度きりなので、画面の時計で近い日が過ぎていたら近い日の話を落として、
    第 295 回の文（遠い日を指す旧文）に戻る。
  - 実測した画面の言葉（実ビルドの品書 + ビルド成果の関数・時計 2026-08-09）: `CADE` →
    「その会の締切が収録に 4 本在って、一番近いのは 2027-02-16（概要締切）です。いま読み込んで
    いるデータには入りません（一覧に出せる締切は 2027-02-04 まで）。この欄の『収録の全体を
    読み込む』を押すと、その締切も一覧に載せられます。」/ `FORTE`（2 本）・`NETYS`（2 本）も同じ形に
    なった。締切が 1 本も無い `CCPE` は第 297 回の文のまま（近い日の文は混ざらない）。
  - 検査: `tests/hint_name_only_conference.test.ts` を 45 件に増やした（第 297 回から 10 件 –
    申告から近い日・種別・本数を読んでいる / 例に絞れない会議には近い日を教えない / 品書の種別を
    表と同じ日本語に直している（ビルド成果の `kindLabelTable()` を読む – 訳語を書き写さない）/
    近い日が過ぎていたら古い申告の日で言う / 本数と近い日を一緒に言う / 1 本のときは「一番近い」を
    言わない / 表が知らない種別では括弧を付けない / 過ぎた締切だけの案内に近い日の文を混ぜない /
    実ビルドの品書で近い日が遠い日より後ろにならない / 品書の数えた本数が収録の締切の数え上げと
    一致する）。改ざん 33 種（近い日の申告を読まない / 過ぎた近い日もこれからの締切に数える /
    曖昧な会議にも近い日を渡す / 種別を表の日本語に直さない / 本数を数えない / 近い日ではなく
    遠い日を選ぶ / 1 本の締切に「一番近い」と言う / 第 297 回までの 26 種）すべて検査が落ち、
    対照は通る。
  - 代償: `app.js` +3,399 B（gzip +731 B）・品書 +5,175 B（gzip +769 B）・`index.html`
    +4,419 B（gzip +782 B – 品書を埋め込んでいる分）。`recommender.js`・`data.json`・
    `deadlines.ics`・`upcoming.md` は第 297 回からバイト一致。
- **「締切が過ぎた」と「会議が終わった」を、画面が混ぜていた**（第 297 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: 第 295 回の案内は、過ぎた締切しか持たない会議を
    引いた人に「収録にあるのは過ぎた締切（2026-07-06）だけ」と言うだけで、その会がこれから開かる
    ことを言わなかった。実測で、過ぎた締切しか持たない会議 **174 件のうち 118 件**・収録に締切の
    無い会議 **74 件のうち 31 件**は、品書にこれからの開催日を既に持っていた（収録にこれからの会期が
    在る 74 件候補の 33 件のうち、品書に会期が載っているのは 31 件で、それは `upcoming.html` に
    出ている物と同じ 31 件 – 新しい項目は要らなかった）。
  - 直し方（`site/app.ts` の 1 本）: 名前で 1 件に絞れた会議について、いま読み込んでいる版の列から
    これからの `event_start` を一番近い物だけ拾い（推定の会期は数えない・当日は「これから」に残す –
    一覧の過去判定と同じ `jstNoonMs` で見る）、二つの分支に添えた。締切ゼロ →「その会の開催日
    （2026-10-01）は決まっています。締切の無い会議は一覧に出ないので、upcoming.html に載せて
    います。」/ 過ぎた締切だけ →「なお、その会の開催日（2026-12-14）はこれからです。締切が過ぎた
    というだけで、会議が終わったわけではありません。」例に絞れない会議には添えない（第 295 回と
    同じ判断）。
  - 実測した画面の言葉（実ビルドの品書 + ビルド成果の関数・時計 2026-08-09）: `AMBRE-2026`（締切
    ゼロ + 2026-10-01）と `ACCV`（過ぎた締切 2026-07-06 + 開催日 2026-12-14）で、上の文がそのまま
    出ることを確かめた。
  - 捨てた仮説（実測で否定）: 前回「`2027` だけの打ち方が範囲の案内に乗らない」と候補に書いたが、
    品の窓の締切行 872 件のうち **374 件**が 2027 を含んで 0 件にならない – 案内が出る前提が崩れて
    おり、直すべき箇所は無かった。
  - 検査: `tests/hint_name_only_conference.test.ts` を 35 件に増やした（第 296 回から 7 件 –
    これからの開催日を一番近い物から選んでいる / 過ぎた開催日と推定の会期は数えない（当日は
    残す） / 例に絞れない会議には添えない / 締切ゼロの案内は行き先を添える / 過ぎた締切の案内は
    会議が終わったではないことを添える / 開催日が読み込めていなければ従来の文のまま / 実ビルドの
    品書で、挙げた開催日が品書の一番近い会期と一致している）。改ざん 26 種（開催日を言わない ×2・
    推定の会期を確定として数える / 過ぎた開催日をこれからの開催日に数える / 曖昧な会議にも添える /
    第 296 回までの 21 種）すべて検査が落ち、対照は通る。
  - 代償: `app.js` +2,202 B（gzip +472 B）のみ。品書・`index.html`・`recommender.js`・`data.json`・
    `deadlines.ics`・`upcoming.md` は第 296 回からバイト一致。
- **会議の名前を打ったのに年を添えただけで、案内が的外れになった**（第 296 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: 第 294 回・第 295 回の名簿の案内は、打った語
    **すべて**が名前に当たる会議を探していた。品書の key は年を含む物（`ambre-2026` など）が
    多いので、`NETYS 2027` は「`netys` か `2027` に当たる会議」を 35 件集めて「似た名前の会議が
    35 件見えます」と言い、例も収録側の締切日も出さなかった（`CoNLL 2027`・`CADE 2027` も同じ
    35 件 – 同じ年を引いた別々の会議が混ざった数）。`2027` だけでも 34 件、`SC 2027` は 40 件、
    `FORTE 2027年3月` は 1 件なのに例を挙げない、という形になっていた。実測の内訳:
    `NETYS 2027` 35 件 → 名前の語だけなら **1 件（NETYS）**・`CoNLL 2027` 35 件 → **1 件**・
    `CADE 2027` 35 件 → **1 件**・`FORTE 2027年3月` → **1 件（FORTE）**・`SC 2027` 40 件 →
    **6 件**・`2027` 34 件 → **数えない**（日付だけの打ち方は第 293 回の範囲の案内が言う）。
  - 直し方（`site/app.ts` の 1 本）: 語を「名前の語」と「日付の語」に分ける – 数字と日付の言い方
    の部品（`年` `月` `日` `/` `-` など）だけで出来ている語は、締切の日として打ち足された物と
    見る。日付の語だけで引いたときは名簿の話をしない。件数と例は、名前の語すべてに当たる会議
    だけから数える（`distributed systems` のように名前の語を二つ打ったときは、いずれかに当たる
    物 103 件ではなく、両方に当たる物を数える – 実測で 103 件は語ごとの最少 17 件より大きく、
    打ち直しようがなかった）。
  - 同じ調べ中に出た二つ目の穴: 語ばらを並べて**いっしょに含む会議が名簿に無い**打ち方
    （`ACL international`）では件数 0 となり、名簿の案内が全く出ずに「語をすべて含む行は
    ありません（「ACL」0件・「international」0件）。いずれかの語を外すと増えます」だけが出て
    いた（実測）。語が名簿に見えるなら件数を作らずに案内する形にし、効かない「別の語で試す」を
    消した – 引いた会議の締切がそもそも読み込めていないことが、この形では伝わっていなかった。
  - 実測した画面の言葉（実ビルドの品書 + ビルド成果の関数・時計 2026-08-09）: `NETYS 2027` →
    「その会には 2028-03-30 の締切が収録に在りますが … 押すと、その締切も一覧に載せられます」・
    `CoNLL 2027` → 2027-02-19・`FORTE 2027年3月` → 2028-02-05・`ccpe 2027` → 「収録は締切を
    1 本も持っていません … 押しても 1 件も増えません」・`SC 2027` → 名簿 6 件・`2027` →
    数を作らない。
  - 検査: `tests/hint_name_only_conference.test.ts` を 28 件に増やした（第 295 回から 7 件 –
    年を添えても名前一つと同じ会議に絞れる / 和暦風の月の指定を添えても同じ / 日付だけでは
    名簿の話をしない / 語の形を曲げた打ち方（`netys-2027`・`sc2027`）は日付と数えない / 件数は
    名前の語すべてに当たる物だけ / 全てに当たる会議が無くても名簿に在る語は「無い」の列から
    外れる / 日付を添えた打ち方も収録側の話と押し先を送る）。改ざんで実測 21 種（日付の語を
    名前の語に混ぜる / いずれかに当たる物まで件数に数える / 例を 1 件に絞れなくても挙げる /
    名前の語が名簿に見えるだけで黙る / 第 295 回の 16 種）すべて検査が落ち、対照は通る。
  - 代償: `app.js` +2,310 B（gzip +750 B）のみ。品書（`catalog.json`）・`index.html`・`data.json`・
    `deadlines.ics`・`upcoming.md` は第 295 回からバイト一致。
- **収録の側に何も待っていない人に、6 MB 強の空振りを押させていた**（第 295 回）。
  - 事実（2026-09-24 実測・2026-08-09 生成ビルド）: 第 294 回の案内は、名簿に在るのに締切行の
    無い会議を引いた人に「収録の全体を読み込む」を勧げる形にした。品書に締切行の無い会議
    248 件を収録（`data.json`）と突き合わせると、内訳は **収録にも締切が 1 本も無い 74 件 /
    収録にこれからの締切が在る 42 件 / 過ぎた締切だけ 132 件**。74 件（`acm-toit`・`ccpe`・
    `ccgrid-workshops` など – 収録に条目は在るが締切の記録が無い会）には、品書に締切行が
    無いこと自体が原因なので、読み込んでも 1 件も増えない – 収録の品から行を作っても
    **計 0 本**であることを実測で確かめた。42 件については、収録の品から作った行にその日が
    立つ（同一日 32 件・AoE の寄りで一日ずれ 10 件・行が立たない物 0 件）ので、日付を言って
    よい。
  - 直し方（正本 3 か所）: 品書に `record_deadline_last` を載せ（§4）、画面はその申告を
    そのまま案内に渡す。三つに言い分けた – 「その会について、収録は締切を 1 本も持って
    いません … 押しても 1 件も増えません」/「その会には 2028-03-30 の締切が収録に在りますが、
    いま読み込んでいるデータには入りません（一覧に出せる締切は 2027-02-04 まで）…
    『収録の全体を読み込む』を押すと、その締切も一覧に載せられます」/「収録にあるのは過ぎた
    締切（2026-06-27）だけ … 読み込まれるときは『過去の締切も表示』もいっしょにオン」。
    向き（これからか過ぎたか）は行と同じ暦日の基準で見ると決めたので、`jstNoonMs` を品選びの
    公開に足した。向きを示す旗が渡されない形では、どちらとも言わずに第 294 回の語に寄せる
    （実際に一度、渡さない組み立て方で 2028-03-30 を「過ぎた締切」と言っており、検査で塞いだ）。
  - 名簿の案内が原因と押し先を言い切った 0 件案内には、「外せる条件」を並べない（第 247 回の
    原則）。過去の締切をオンにしても推定を足しても、その会は 1 件も増えないので、あっても
    効かない条件を「外せる条件」として載せるのは空振りへの誘いになる。窓が狭いときは原因が
    二つあるので、従来どおり他の案内に重ねる。
  - 検査: `tests/hint_name_only_conference.test.ts` を 21 件に増やした（第 294 回から 10 件 –
    申告を付けるのは品の窓に締切の無い会議だけ / 申告の形は暦日か `null` / 締切ゼロは
    「押しても増えない」と言う / これからの締切は日付を言って読み込むへ送る / 過ぎた分だけは
    過去表示も送る / 曖昧な会議には収録側の話を添えない / 品書の申告をそのまま案内に渡している /
    向きは行と同じ暦日の基準（当日を過ぎた日にしない） / 効かない条件を並べない / 古い描画側の
    形では向きを言わない）。改ざんで実測 17 種（締切ゼロに「載せられます」と言う / 過ぎた分だけ
    をこれからの締切として勧める / `null` を不明と混ぜる / 収録の締切日を言わない / 原因を
    データの切れ目にすり替える / 曖昧な会議にも添える / 向きを数えない / 読めない日を日付として
    通す / 過去表示に送らない / 効かない条件を並べる / 申告を締切の在る会議にも付ける / 品書に
    収録側の締切日を載せない など）すべて検査が落ち、何も変えない対照は通る。
  - 代償: `app.js` +4,124 B（gzip +1,020 B）・`recommender.js` +30 B・`index.html` +8,832 B
    （gzip +1,258 B）・`catalog.json` +10,320 B（gzip +1,591 B）。`data.json`・`deadlines.ics`・
    `upcoming.md` はバイト一致。
- **名前で引いた人に、効かない助言だけを出していた**（第 294 回）。
  品書に載る会議 687 件のうち **248 件は、一覧に差し込むデータに締切行を 1 本も持たない**
  （2026-09-24 実測・2026-08-09 生成ビルド – NETYS・FORTE・CADE・CoNLL など、締切がデータの
  切れ目より先にある会議たち）。`NETYS` を引くと 0 件で、案内は「過去の締切も表示」をオン
  （過去の締切 120 件）/「推定締切を含める」をオン（推定 30 件）/ 別の語で試す、を勧げるが、
  **どれも 1 件も増えない**（NETYS は品書に締切行が 0 本で、`upcoming.html` にも出ていない –
  実測 0 回）。さらに `NETYS 2027` では
  「検索語のうち「NETYS」・「2027」は収録データにも見当たりません」と言い、**これは噓だった** –
  NETYS は品書の名簿に在り、収録には 2028-03-30 の締切が在る（0 件と知らないを混ぜるな、に
  反していた – 第 290 回で「収録データにも見当たりません」を調べたときは、品書に会議自体が
  無い物しか見ておらず、**行を持たない会議**の形を落としていた）。
  - 直したこと: `nameOnlyConferenceMatch(query, rows)` を増やし、語が会議の名前（略称・題名・
    正式名・key）に立つのに、いま読み込めている行にその会議が 1 本も無い場合を数える。
    そのときは「打った語に似た名前の会議（NETYS）は、収録の名簿に見えます。ただしその締切は、
    いま読み込んでいるデータに 1 本も入っていません（一覧に出せる締切は 2027-02-04 まで –
    締切がそれより先の会議は、名簿だけが残っています）。この欄の「収録の全体を読み込む」を
    押すと、収録の全体の締切から同じ語を引き直します」と言い、噓になる語を「無い」の列から
    外す（本当に無い語 – `2027` – はそのまま挙げる）。語を変えても増えないので「別の語で試す」は
    立てない。**「その締切が出ます」とは言っていない** – 実測で 248 件のうち 74 件
    （`acm-toit`・`ccpe` など）は収録の側にも締切が 1 本も無く、全体を読んでも増えないので、
    出る約束を画面が言えない（品書には「収録の側に締切が在るか」が載っていない – 次の回以降で
    載せて、前者は「押す必要はありません」と言う余地が残る）。
  - 数を作らない: 例に挙げるのは、打った語すべてに当たる会議が 1 件だけるとき（`international`
    のように多数に散る語は件数だけを出す – `CoNLL 2027` に `ACM SAC 2027 - DBDM Track` を
    挙げても人は信じない）。切れ目の日数（2027-02-04）は読み込めている行から実測し、第 293 回と
    同じく品書の申告 (`window.upcoming_days`) は日数のほうに使う。行が在るかを見るので、
    収録の全体を読み込んだあとは自動的に黙る。
  - 検査: `tests/hint_name_only_conference.test.ts`（11 件 – 品書に行の無い会議が実在する /
    名簿に在る語を「収録に無い」と言わない / 切れ目の日数といっしょに言って押し先を送る /
    曖昧な語では例を挙げない / 名前の途中を語と数えない / 全体を読んだあとは黙る /
    窓が狭いときは他の案内に重ねる / 切れ目を知らないビルドは数を作らない / 画面のボタン名と
    一字一句同じ / 描画側が `nameOnly` を渡している）。改ざんで実測 9 種（曖昧でも例を挙げる /
    名簿に在る語を収録に無いまま言う / 描画側が案内に渡さない / 行が在る会議も名簿に立てる /
    切れ目の日数を言わない / 名前の途中を語として通す / 案内の押し先のボタン名を書き換える /
    効かない打ち直しを消さない / 行の有無を数えないで名簿を数える）すべて検査が落ち、
    何も変えない対照は通る。
  - 代償: `app.js` +6,034 B（gzip +1,704 B）。`index.html`・`catalog.json`・`data.json`・
    `deadlines.ics`・`upcoming.html`・`upcoming.md` はバイト一致（名簿は品書に既に載っていた）。

- **日付で引いた人に、効かない打ち直しだけを案内していた**（第 293 回）。
  検索欄に `2027年3月` を打つと 0 件で、案内は「別の語で試す（分野名・主題・開催地の日本語でも
  引けます）」だけだった（2026-09-24 実測・2026-08-09 生成ビルド）。収録の側にはその月だけで
  締切 40 件・会議 32 件が在り、品書の一覧に出る一番遠い締切 2027-02-04 で速く開くためのデータが
  切れているだけ – 語を変えても 1 件も増えない打ち直しを、全員に勧げていた。`2027年12月20日`
  `2028-01-15` も同じ文だった。品書の果て自体は第 290 回で注記にしたが、**件数が 0 になったときの
  案内に繋がっていなかった**。
  - 原因は `site/app.ts` の `emptyDeadlineHint` が「語が収録に無い」「表その物を指す語」
    「画面の言葉で引く」等の原因だけを見て、**打った日付が品書の窓の果てより先**という原因を
    見ていなかったこと。日付の語は `Recommender.searchMatcher` の `monthTermsJa`・`dayTermsJa`・
    `isoDayJa` が hay に載せる形で引けるので、引ける形その物は悪くなかった。
  - 対策（正本 2 か所）: `site/recommender.ts` に `queryDaySpanJa` を増やし、**一覧の検索が
    実際に持つ形だけ**（`YYYY年M月` / `YYYY年M月D日` / `YYYY-MM` / `YYYY-MM-DD`）を暦日の幅に
    落とした。月末は暦から求める（2028年2月 → 2028-02-29）。年を言わない `3月10日` は年を作る
    推測になるので `null`（収録の契約「締切の推測はしない」）。`emptyDeadlineHint` はその幅が
    いま読み込んでいるデータの果て（`rows` から実測する `farthestRowDayJa`）より**完全に先**の
    ときだけ言い、月の途中までが一覧に出る場合（`2027年2月` → 果て 02-04）は黙る。
  - 言うこと: 果てより先で収録の範囲内なら「いま読み込んでいるデータ（2027-02-04 まで）より
    先です … この欄の「収録の全体を読み込む」を押すと、一覧がその先も探します（収録の中で一番
    遠い締切は 2028-03-30 です）」。**その月に締切が在るかは品書では分からない**ので「探します」
    までしか言わない（2027年10月は収録でも 0 件 – 在ると約束しない）。収録その物
    （`catalog.calendar.last_day`）より先なら「その日付に締切が在るかどうかも、まだ確認できて
    いません」と言い、押し先を作らない。
  - 数を書き写さない: 「生成から N 日先」の N は `catalog.json` の `window.upcoming_days` から
    読む（第 290 回の注記も同じ入口に寄せた）。申告の無いビルドでは「一定の日数先」と言い、
    数をでっち上げない。
  - 重ねると黙るの使い分け: 「締切まで」を絞っているときは窓も原因なので、この案内を他の案内に
    **重ねる**（窓を広げずに全体を読んでも増えないので原因を一つに絞れない）。窓が
    「かまわない」なら原因が特定できた扱いにして、打ち直しの提案を消す（第 247 回と同じ原則）。
  - 検査: `tests/hint_beyond_loaded_horizon.test.ts`（16 件 – 月・暦日・ISO の 3 形で言える /
    範囲の中の日とまたがる月は黙る / 収録より先は「分からない」/ 全体を読み込んだあとは黙る /
    URL を貼った人を日付の話に引きずり込まない / 日の数を知らないビルドは数を作らない /
    案内が送るボタン名が画面のボタンと一字一句同じ / 描画側が幅と果てを案内に渡している /
    品書の申告とてびきの書いた日数が一致 / 品書が品の窓を越えた締切を一覧に混ぜていない）。
    改ざんで実測 10 種（判定の向きを反らす / 原因を特定した扱いをやめる / ボタン名を書き換える /
    収録より先を「読めば出る」にする / 月末を暦から数えない / 有り得ない日付を通す / 画面が
    180 を書き写す / 品書から申告を消す / 申告だけ品の窓を短くする / 注記の数を数え直す）
    すべて検査が落ち、何も変えない対照は通る。
  - 代償: `app.js` +4,020 B（gzip +1,016 B）、`recommender.js` +2,780 B（gzip +877 B）。
    `index.html`・`catalog.json`・`data.json`・`deadlines.ics` はバイト一致（品の窓は品書に
    既に在ったので、配信物側の形は変えていない）。

- **カレンダーに分野が 1 つも載っていなかった**（第 292 回）。
  `deadlines.ics` の 928 個の `VEVENT` のうち `CATEGORIES` を持つ物は **0 個**で、説明欄も
  会議 / 種別 / 締切 / 開催地 / 詳細 / 収録 の 6 項目だけだった（2026-09-24 実測・
  2026-08-09 生成ビルド）。てびきは「画面の絞り込みは効かない」と正直に言っていた – が、
  それが意味するのは **セキュリティの会議だけを見たい人も 928 件を丸ごと購読し、カレンダーの
  検索で分野を引く手段もない** ことだった。収録側には分野が在る（会議の 687 件のうち 577 件が
  1 分野、最大 5 分野。語は 人工知能 223 / システム 178 / セキュリティ 102 …）。
  - 直し方: 分野を **二か所**に載せる。`CATEGORIES`（規格の分類欄。対応した受信側なら色分け・
    絞りが効く）と、説明欄の `分野:` の行（どの受信側でも本文の検索に掛かる）。
    **受信側の表示対応は kamiyobi 側では検証できない**ので、検証できる側の経路を残す –
    「対応していれば効く」だけに依存しない。
  - 語は画面と同じ入口（`Recommender.categoryLabelJa`）から取る – 書き写した瞬間に、
    画面で「セキュリティ」と検索できる語がカレンダーで通らなくなる。未知の語は画面と同じく
    原文で出す（カレンダーだけ翻訳した顔にしない）。
  - 分野の無い会議には **何も書かない**（`分野: 未確認` を作らない – 「知らない」を値にしない）。
  - `CATEGORIES` は値の区切りにカンマを使うので、`icsEscapeText`（カンマを逃がす）をそのまま
    使えない。値の中のバックスラッシュ・セミコロン・カンマだけを逃がす組み立てにする
    （改ざんで実測: 逃げを外すと `a,b` が二つの分野に割れた）。
  - 見張り（新規 9 本・`tests/ics_category.test.ts`）: 説明の `分野:` と `CATEGORIES` が同じ語を
    同じ順で並べる / 分野を持つイベントが 9 割以上 / 値が全部、画面の分野の語（ビルドした
    実行時処理から取り出す。書き写さない）/ 折り畳みを戻して比べ、75 バイト超の行が無い /
    件数は品書の申告（`catalog.json` の `calendar`）と同じ / 未知の語は原文・重複は落とす /
    値のエスケープ / 分野の無い会議は両方とも作らない / 複数分野は ・ 順が同じ。
  - 改ざん 8 通りと対照群（すべて検出、対照群は不発、正本はバイト一致で復元）: 説明行から分野を
    落とす / `CATEGORIES` を落とす / 未知の語を落とす / 重複を並べる / エスケープを外す /
    画面の語をやめて英表記を出す / 分野の無い行に「未確認」と書く / `CATEGORIES` の語順だけ逆にする。
- **機械が読む索引（`llms.txt`）が、収録の範囲を一言も言わなかった**（第 291 回）。
  索引の行は `catalog.json` =「締切画面向けの現在・近日期間カタログ。」、`data.json` =
  「正規化データ全体（機械可読の正）。」、`deadlines.ics` =「…画面の絞り込みは効かない」まで –
  **何件・いつまで**がどこにも無かった（2026-08-09 生成ビルドの実測: 品書 872 件・
  2026-07-10 〜 2027-02-04 / 収録全体 3,253 件・2019-05-25 〜 2028-03-30 / カレンダー 928 件・
  2026-08-09 〜 2028-03-30）。第 290 回で画面に「収録の全体を読み込む」を置いたときも、索引は
  その入口を説明していなかった。
  - 直し方: 索引の三行（`data.json` / `catalog.json` / `deadlines.ics`）に、**このビルドが書いた
    成果物から数えた**件数と両端の暦日を続ける。品書の行は「生成から N 日先で切る」ことと
    「それより先と過去の全履歴は `data.json` に在り、画面では『収録の全体を読み込む』で見る」
    まで書く – 索引を読む側に、次の文件的な行動を渡す。
  - 数え方は `deadlineSpan` に集約し、`utc` は **JST の暦日**に揃えてから数える（画面と
    カレンダーが使う目盛りと同じ。協定世界時のまま数えると 15:30 UTC の締切が前に入る）。
  - `catalog.json` を組む所を 1 箇所にまとめた（`catalog.json` の書き出し・画面への差し込み・
    索引への受け渡しが、それぞれ違う品書を指さないように – 第 289 回に学んだ呼び出し口の増え方）。
  - 費用（実測）: `llms.txt` 生 +849 バイト。**`index.html`・`app.js`・`catalog.json`・
    `deadlines.ics`・`data.csv`・`data.json`・`upcoming.*` は 1 バイトも同じ**（索引だけ直した）。
  - 見張り（新規 7 本・`tests/llms_scope_declared.test.ts`）: 索引の品書の行が品書を実測した
    件数・両端の日・窓の日数を言う（同じ数を 2 度以上書かない）/ `data.json` の行が収録全体を
    実測した値を言う / `.ics` の行が配信物から数え直した件数・範囲と「画面に並べる期間より長い」を
    言う / 品書より先を読む道（`data.json` と画面の入口の語）を出す / 索引が句点のあとに空白を
    空けない / 範囲を渡さないビルドでも索引が黙って従来どおり出る / 範囲は JST の暦日で数え、
    形のおかしい品書では値を作らない。
  - 改ざん 8 通りと対照群（すべて検出、対照群は不発、正本はバイト一致で復元）: 品書の行から
    件数を落とす / 収録全体の範囲を定数（約 3,000 件・2019-01-01 〜 2028-12-31）で書く /
    先を読む道を落とす / 「画面より長い」を落とす / 協定世界時の暦日で数える / 窓の日数を
    渡さない / 索引の文を空白で繋ぐ / 形を検査せず 0 件と申告する。
- **既定の「締切まで: かまわない」が、品書の果てで切れていることを誰も言わなかった**（第 290 回）。
  てびきは「既定は「かまわない」で、**期限なく先の締切も出します**」と書いていた – が、画面に
  差し込む品書（`catalog.json`）は生成から 180 日先で切れており、2026-08-09 生成ビルドで
  一覧に出る一番遠い締切は **2027-02-04** だった。収録その物には品書の果てを越える締切が
  **133 件（74 会議）** 在り、カレンダー（`deadlines.ics`）には **2028-03-30 まで 928 件**
  入っている（2026-09-24 実測）。2027 年秋の締切を調べようとした人は、収録に在ると知られずに
  画面を閉じるしかなかった。しかも品書の外を読む入口は「**過去の締切も表示**」だけだった –
  先の締切を見るのに、過去を見るチェックを外せない取り合わせ（過去分が混ざる）だった。
  - 直し方: 件数のうしろに **品書の果てを伝える枠**を置き、押した人だけ品書の外を読ませる。
    「一番遠い締切日」は一覧の行から JST の暦日で実測する（ビルドごとに違う数を固定しない）。
    読み込みの判断は `fullRecordNeeded(past, win, requested)` に集約し、品書の外を読む 5 か所
    （初期化 / 条件適用 / モード切替 / 状態同期 / 件数欄と状態欄の語）すべてをそこから見る。
  - **既定では読ませない**: 「かまわない」は既定の選択なので、そこに 6 MB 強（実測 6,263,899
    バイト）の読み込みを置くと画面を開くのが遅くなる。旗（`fullRecordRequested`）はボタンで
    立つ。品書を見ている間だけ注記を出し、読み終えたら黙る（`activeData === DATA` の間だけ）。
  - 読み込み状態の語を「過去の締切」→「**収録の全体の締切**」に変えた（同じ 1 回の読み込みが
    過去の行と品書の果てより先の締切を一緒に運ぶので、どちらかに寄いた語は噓になる）。てびきの
    再試行の語・状態欄の語も同じ名詞に揃えた – 既存の見張りが「再試行のボタンが別の名詞に
    なっている」として拾った（`過去の締切を再試行` の字列を画面に置いていた）。
  - 費用（実測）: `index.html` 生 +1,399 / gzip +393 バイト、`app.js` 生 +5,074 / gzip +1,568。
    `catalog.json`・`data.json`・`deadlines.ics`・`data.csv`・`upcoming.md` は 1 バイトも同じ。
  - 見張り（新規 8 本・`tests/full_record_offer.test.ts`）: 注記が必要な理由が実在する（品書の
    末尾 < カレンダーの末尾、かつ品書の果てを越える締切が収録に在る）/ 既定の読み方は品書だけ
    （真偽表を組み出しで実行）/ ボタンが旗と読み込みを繋ぐ / 注記の語が実測の日・180 日・
    カレンダーの末尾を言う / 一番遠い締切日は JST の暦日 / てびきが実態と違う文を残していない /
    読み込み状態の語が過去にも先にも寄っていない / 枠は紙に載らない。
  - 改ざん 8 通りと対照群（いずれも検出、対照群は不発、正本はバイト一致で復元）:
    既定で品書の外を読みに行かせる / 判断を常に真にする / 注記から 180 日を落とす /
    一番遠い締切日を UTC の暦日で出す / ボタンから読み込みへ繋がない / 枠を紙に載せる /
    てびきの実態と違う文を戻す / 枠ごと画面から消す。
  - 一度目の改ざん実行で、対照群の置換字列が 1 文字短く、**正本を壊したまま抜けた**
    （`"「…` が `""…` になって TypeScript が通らない）。書き換えを試す検査は
    `finally` で戻す – 戻し忘れは、次の検査の失敗原因を化けさせる（この回も
    「ビルドが通らない」という別々の原因を追わされた）。
- **カレンダーを購読する人が、何年分を自分の予定の上に載せるか知らなかった**（第 289 回）。
  `deadlines.ics` の説明欄（`X-WR-CALDESC`）は ① 値を **半角スペースで始めて**いて
  （`" kamiyobi が…"`。RFC 5545 §3.1 は名前とコロンとの間に空白を置かない、相手は残した空白を
  値として情報欄に出す）、② 「画面の絞り込みは効かない（**上の全件**）」と書いていた –
  カレンダー側に「上」は無い。③ なにより収録の実期間は **2026-08-09 〜 2028-03-30 の 928 件**
  （2026-08-09 生成ビルドの実測）で、画面に並べる期間（既定は生成から 180 日）よりずっと
  長かった – いつまでが入るかは、購読する前にも押す前にも、どこにも読めなかった。
  - 直し方: 説明欄に **入る件数と、収録の最初・最後の締切日**を実測の値で書く（生成時刻も）。
    値は `icsEventRows` の行から導く – `icsCalendarMeta` が件数と両端の日を返し、
    説明欄（`X-WR-CALDESC`）と `catalog.json` の `calendar` が同じ導出を読む。
  - 同じ申告を **画面の「カレンダーに追加（.ics）」の下**に出す（てびきにも「収録の期間は
    この一覧に並べる期間より長い」と書いた）。画面は数え直さず、ビルドが配信物から導いた
    値を読む – 数える所が 2 つになると、必ずどちらかが嘘をつく。
  - 申告の形が化けているときは注記を作らない（`calendarSpan` が型の違う物・日付の形の違う物を
    弾く）。「0 件」と「知らない」を混ぜない。
  - 費用（実測）: `deadlines.ics` 生 +320 バイト / `catalog.json` +105 / `index.html` +897。
    `data.csv`・`data.json`・`upcoming.md` は 1 バイトも同じ。
  - 見張り（新規 8 本・`tests/calendar_span_declared.test.ts`）: 値の先頭が空白でない /
    説明欄が実測の件数・両端の日・生成時刻を言う / `catalog.json` の申告が **配信物を実測した
    値と一致** / `index.html` の埋め込み品書にも同じ値 / 画面の注記が件数・範囲・
    「絞り込みは引き継がれません」を出す（区切りの数え方も一覧と同じ） / 化けた申告では注記を
    作らない / 注記が必要な理由（収録が窓より長い）が実在する / てびきの語。
  - 改ざん 8 通りと対照群: 先頭スペースを戻す / 件数と期間を落とす / 件数を 1 増やす /
    埋め込み品書から申告を落とす / 注記から範囲を消す / 申告の形を検査しない /
    てびきの案内を消す / 品書だけ 7 件多く言う – いずれも落ちた
    （「expected `{ event_count: 437 }` to deeply equal `{ event_count: 430 }`」）。
    カレンダーの名前だけ言い換える対照群は落ちない。
  - 自らの手違いも 2 つ書いた: 受け口を増やすときに使い道の無い仮の引き数を 1 つ挟んだら、
    次の位置に渡す値が 1 つ前へ入り `catalog.json` の申告が `null` になった（型が `unknown` なので
    型検査は通る）。同じく `toCatalog` は **2 か所**から呼ばれていた（`catalog.json` と
    `index.html` に埋め込む品書）ので、片方にだけ通すと画面だけが黙る。
    差し込み口は全部見る – 実データで確認するまで信用しない。
- **カレンダーに入れた締切が、どこであるかを言わなかった**（第 288 回）。
  `deadlines.ics` は RFC 5545 の `VEVENT` を 928 個出すのに、`LOCATION` は **1 個も無く**、
  `DESCRIPTION` も 会議・種別・締切・詳細・収録 だけで開催地を書かなかった（2026-08-09 生成
  ビルドの実測）。出張の段取りはカレンダーの側で読むので、国内か海外かを確かめにサイトを
  再び開くしかない – サイト側は第 274 回から開催地を日本語で州・国まで揃えているのに、
  配信物の一侧だけがその情報を持っていない形だった。
  - 直し方: `toIcsText` が `LOCATION` を載せる。語は `upcoming.md` の開催地欄と同じ手の同じ値
    （`Recommender.placeJa(Recommender.placeWithPrefectureJa(..))` – 県名の補い・国名の日本語化も
    同じ正本なので、2 つの成果物の語が離れない）。転義・折り返しは既存の `icsEscapeText` /
    `icsFoldLine` を通す（`Chicago, IL, アメリカ` のカンマは護らないと値の区切りとして読まれる）。
  - **出ていない行には `LOCATION` を書かない**: カレンダーの場所欄に「未確認」は場所として
    表示されるので、無い場所を渡すよりマシ。本当のことは `DESCRIPTION` の `開催地:` に
    全行書く（画面と同じ「未確認」の語 – 実測で 242 行）。挿れる位置は `URL` のうしろ –
    並び替えが本文の 6 行目（`SUMMARY`）を鍵にしているので、それより前に挿れると
    イベントの並びの意味が変わる。
  - 費用（実測）: `deadlines.ics` は生 +58,594 バイト / gzip +11,291 バイト（463 -> 522 キロバイト）。
    変化した成果物はこの 1 個とハッシュを持つ 4 個だけで、`index.html`・`upcoming.html`・
    `upcoming.md`・`data.csv`・`data.json` は 1 バイトも同じ。
  - 見張り（新規 5 本・`tests/calendar_location.test.ts`）: 場所が判る行に `LOCATION` が有り
    判らない行に無い / 無い行は `DESCRIPTION` の `開催地:` が 1 通りの語で「未確認」 /
    転義と折り返しを戻した値が **`upcoming.md` の開催地欄と同じ**（鍵は `URL`） /
    カンマ・セミコロン・バックスラッシュの転義 + 護る対象が実際に有る / 1 行 75 オクテットと
    転義をまたぐ折り返しの禁止 / 行の並びが締切の瞬間順のまま（`LOCATION` の位置の副作用を見る）。
  - 改ざん 6 通りと対照群 1 通り: `LOCATION` を載せない / 判らない行にも「未確認」を載せる /
    転義しない / 日本語化しない（上流の生表記）/ `DESCRIPTION` の開催地行を消す /
    並びを会議名順に変える – いずれも落ちた（音は「LOCATION が 1 個も無い（かつての実測そのもの）」
    「護っていないカンマを含む値: Okinawa, 日本 …」「DTSTART が戻っている行: 205 件」）。
    注記の語だけ変える対照群は落ちない。
- **静的な一覧の日付欄が、日本時間に直すと日が変わる行で換算を出さなかった**（第 287 回）。
  `upcoming.md` / `upcoming.html` の日付欄は締切の公式表記（`AoE`・`UTC`・JST 宣言）をそのまま
  載せており、但し書きは「日本時間への換算と曜日は `index.html` が同じ式で出すので、直近の締切を
  眺める用途はそちらが早い」と書いていた。実測（2026-08-09 生成ビルド）で、1,126 行のうち
  **497 行は日本時間に直すと「日」が変わる**（`23:59:59 AoE` は日本では翌日 20:59、
  `23:59:00 UTC` は日本では翌朝 08:59）。表示の暦日は単調でなく 150 箇所戻る（行は締切の瞬間順）
  ので、読み方を書かないと表が壊れても見えていた。画面は「投稿作業は日本の時刻で回る」を
  但し書きに置いて JST を主表記にしていた（`site/app.ts`・SPEC §7）のに、**印刷・チャットへの貼り込み・JavaScript を
  読まない画面で開かれるこの表だけ**が換算をよそへ投げていた。
  - 直し方: `deadlineWhenText` が公式表記のうしろに `（JST では 2026-02-07(土) 20:59）` を添える
    （`jstClock` の同じ式 – 曜日も同じ規則）。JST 宣言の行は何も足さない（単位が二重になる）。
    未知の公式表記（`PT` など）は `… UTC（公式 PT・JST では …）` と 1 個の括弧にまとめる。
    公式表記はそのまま残す – 換算は算術で、上流の宣言の書き換えではない。
  - 但し書きも同時に書き換えた: 読み方の例・行の並びが瞬間順であること（表示の暦日の順ではない）・
    絞り込みと並び替えは画面が早い、の 3 つを表のうえに置く。
  - 第 286 回で自分が書いた `upcoming.html` の説明文が「日時は日本時間（JST）と曜日で出します」と
    呟いていたが、その頃の本文は公式表記だけで**説明文が噓を書いていた**（この回の実測で発覚）。
    直し方を変えたので声明が実態に合った。検査は head の説明と本文の値を突き合わせる
    （声明だけ先に走らせるのがいちばん危ない）。
  - 費用（2026-08-09 生成ビルドの実測）: `upcoming.html` は生 +20,604 バイト / gzip +1,564 バイト、
    `upcoming.md` は生 +20,583 バイト / gzip +1,931 バイト（1 行に約 18 バイト）。変化した成果物はこの 2 つ
    とハッシュを持つ 4 個だけで、`index.html`・`data.csv`・`data.json`・`deadlines.ics` は
    1 バイトも同じ – 機械可読な列は据え置き、と §4 どおり。
  - 見張り（新規 7 本・`tests/static_table_jst_reading.test.ts`）: AoE / UTC 表記の行が
    **例外なく**読みを持っている（ビルド後の全行。検査用ビルドで 224 行、`repo/.cache` 付きで
    524 行）/ 添えた読みが**算術として合っている**（表示された壁時計＋宣言から組み直して
    全照合。曜日と分も同じ式）/ 日が違う行が 150 行以上有る（読みが飾りでない証明）/
    JST 宣言の行はそのまま・単位が二重になっていない / 但し書きが読み方と並び順を一緒に
    語っている / head の説明が呟いた「日本時間（JST）」を本文が出している /
    マークダウン版と HTML 版で日付欄の値が同じ。
  - 改ざん 6 通りと対照群 1 通り: 読みを添えない / 換算を 9 時間分間違える / 単位を二重に書く /
    JST 宣言の行にも読みを添える / 但し書きから並び順の話を落とす / 説明文から日本時間を削る –
    いずれも落ちた（音は「読みが添えてない行: 157 件」「換算の値が合っていない行」など）。
    注記の語だけ変える対照群は落ちない。
- **静的な一覧（`upcoming.html`）の head が 3 個だけだった**（第 286 回）。
  画面（`index.html`）は、検索結果とチャット（Slack・Teams・X）のリンクプレビューを入口に
  するために、説明・og（type・site_name・locale・title・description・url）・twitter:card・
  アイコン・canonical・theme-color（明暗 2 値）・Content-Security-Policy を head に載せている。
  同じ表の別の入口である `upcoming.html` には、それが **1 個も無く**、head は
  `charset`・`viewport`・`title` の 3 個だけだった（2026-09-24 実測: 2026-08-09 生成ビルド）。
  絞り込みを使わない人がカレンダー代わりに共有するのはこのページなので、貼ったときに
  何のページか分からない・tab にアイコンが着かない・スマホの縁が暗色で浮く、が起きていた。
  - 直し方: `src/build.ts` の `toUpcomingHtml` に、画面と同じ項目を書いた。説明文は
    **見出しと列の名前から組み立てる**（`pageDescription`）。同じ語を手写しすると、表の語が
    変わったときに説明が噓を書く（第 276 回の `<caption>` と同じ方針）。実測で出た説明は
    「直近 180 日の締切と開催を一覧にしたページです。日付・残り・会議・種別・ラウンド・推定・
    開催地の列で、日時は日本時間（JST）と曜日で出します。…」。
  - `og:url` と `canonical` は `config.yaml` の `site.base_url` + `/upcoming.html`（画面は
    `base_url` そのかなので、複製として扱われる場所の違いは保つ）。所在を渡さない呼び出し方は
    「自分の場所」を書かないだけで、表と説明はそのまま出る（ページが真っ白にならない）。
  - CSP は画面より強く締められる – このページは JavaScript を 1 文字も読まない（実測:
    `script` 0 個）ので `script-src 'none'`。内の様式（画面と同じ物を運んでいる）は
    `style-src 'unsafe-inline'` で生かす。声明と実態の矛盾も検査に入れた。
  - 費用: `upcoming.html` は生 +1,595 バイト / gzip +450 バイト。変わった成果物は
    `upcoming.html` とハッシュを持つ 4 個だけで、`index.html`・`data.csv`・`deadlines.ics`・
    `catalog.json`・`app.js` は 1 バイトも同じ（実測）。
  - 見張り（新規 6 本・`tests/static_page_head.test.ts`）: 画面と同じ項目が並ぶこと（項目名は
    ビルド後の両ページから取る – 手写しの語-list にしない）/ 説明が空でなく日本語で
    200 字以内で、**表の実語（列の名前）を 3 つ以上**参照していること / og の説明と
    `description`、og の見出しと `title` が同じ物 / 生成時刻の絶対値を焼いていないこと /
    `og:url` と `canonical` が `config.yaml` の `site.base_url` からの組み立てで、画面の
    canonical とは違う場所 / CSP に `script-src 'none'` が有り、実際にページへ `script` が
    0 本 / theme-color の 2 値が正本 `site/template.html` と一致 / `icon.svg` が成果物に実在 /
    所在なしの呼び出しでも壊れないこと。
  - 改ざん 6 通りと対照群 1 通り: 説明を空にする / 説明に生成時刻を焼き込む / 自分の場所を
    画面と同じに向ける / CSP の `script` を開ける / theme-color を画面と違う色にする /
    `og:url` を出さなくする – いずれも落ちた（音は「説明が列の名前を 1 つも参照していない」
    「スクリプトを読まない頁なのに script を開いている」など）。注記の語だけ変える対照群は
    落ちない。
- **てびきの 39 語が、見出しの無い 1 個の列だった**（第 285 回）。
  「見方のてびき」は締切一覧の語をその場で説明する欄だが、39 語が `dl` **1 個**に並び、
  画面の静的な見出しは `h1` 1 個と `h2` 3 個（うち 2 個は画面に出ない名乗り、1 個は詳細の
  欄の実行時の物）だけだった（2026-09-24 実測）。てびきを開いても見出し一覧には何も増えず、
  見出し辿りでは 39 語がひと塊の文章にしか見えない。読み上げで見出しから飛ぶと、
  「推定」の隣の「CSV」へまとめて跳んでしまう。
  - 直し方: 語の**並びと説明文を 1 バイトも動かさず**、連なりの先頭に `h3` を置いて `dl` を
    9 つに割った（3–6 語 / 群れ）。本文を切り貼しないので、説明が減る事故が起きない事を実測で
    確かめられる（割る前後で、見出しと入れ物を退けた本文 32,357 文字が一致）。
    `site/template.html` 1 ファイルだけ。
  - 見出しの語は**画面がよそで既に使っている語の列挙**にした（「日時・残り・AoE・時刻」
    「CSV・並び順・共有・印刷・キーボード」など）。画面のよそで使っていない語を見出しに足すと、
    用語集の語と見出しが二重になって検索と読み上げで紛れる。
  - 見た目は `dt` より一段大きく、前に余白を置く規則を 1 個足しただけ（地色は着せない –
    てびき全体が既に面板の中）。`index.html` は生 +1,213 バイト / gzip +331 バイト、
    同じ規則を共有する `upcoming.html` は gzip +159 バイト。`data.csv`・`deadlines.ics`・
    `catalog.json`・`app.js`・`recommender.js` は 1 バイトも変わっていない（実測）。
  - 見張り（新規 5 本・`tests/guide_grouped_by_headings.test.ts`）: 正本と画面でてびきの本文が
    一字も違わないこと（空振りを防ぐため本文 2 万字以上も見る）/ 語が 39 個そろい、
    1 個も見出しの外に置き去りでないこと / 群れは 2–8 語（1 語だけの群れは作りすぎ、
    9 語以上は壁）/ 見出しの語が本文に一度は出ること / 英文字の塊を混じらないこと /
    段が飛んでいないこと（静的な画面に `h4` 以降が無く、静的な `h3` はてびきの物だけ）/
    `dt` と区別できる太さ・字の大きさ・余白の規則が有ること。
  - **入れ物を割ると、読む側の検査が静かに細くなる**（今回の実発生）: 9 本の検査が
    `id="helpPanel"` から**最初の `</dl>` まで**でてびきを取り出していたので、割った瞬間に
    先頭の 4 語しか見えなくなり、9 本が落ちた（「てびきに『会期のみ・締切未定』が無い」など、
    無い事になってしまった）。読む側を `</details>` までに変えた。本文を削ったのではない事が
    上記の「一字も違わない」検査で裏まで取れている。
  - 改ざん 5 通りと対照群 1 通り: 語を 1 個落とす（38 個で検出）/ 最初の群れの見出しを段落に
    戻す（35 個で検出）/ 見出しに英文字の造語を置く / 見出しを、てびきの本文に一度も出ていない語にする/ 見出しの規則を消す – いずれも落ちた。説明文の語だけ変える対照群は落ちない
    （本文の検査が写しでなく比較になっている証拠）。
- **縦に長い表が、「どの行か」を自分で持っていなかった**（第 284 回）。
  締切の一覧は 1,126 行（`index.html` 側も同じ形）あるが、**行ヘッダーは 1 個も無く**、
  全マスが `td` だった（2026-09-24 実測）。列の名前（`scope="col"`）は出ていたので、
  読み上げで一マスずつ辿ると「種別」「推定」とは読めるが、**どの会議に対する値か**が
  付いてこない。同じ検査の途中で、幅せま画面の作りも壊れていた: その幅では列見出しを消し、
  各マスの前に `content: attr(data-label) "："` を出してカードに積む作りなのに、
  `upcoming.html` のマス 6,756 個に `data-label` が **1 個も無く**、その幅では各項目が
  「：論文締切」のように、記号だけ先頭に来る（列名が空のまま）。
  - 直し方（両ページに同じ形で効く 3 か所）: 会議の列を行ヘッダー（`th` に `scope="row"`）に
    した。静的な `upcoming.html` は列ヘッダー（`scope="col"`）から列名を割り出して各マスに
    `data-label` として載せる（列の番号は書き込まない）。一覧側はセルを作る手が
    4 番目の引数で受ける。`src/build.ts`・`site/app.ts`・`site/template.html`。
  - 見た目は変えない。列見出しの見た目（灰色の地・小さな字・大文字化・押せそうに見える
    カーソル）を決める規則を `th` から **`thead th` へ限定**した。打ち消し規則を後から
    並べると、**次に列見出しへ規則を足す側が打ち消しを忘れ**て、行の中が静かに壊れる。
    ブラウザが `th` を太字にする所だけ、普通のセルへ戻す規則を明示した。行へのホバー・
    選択・最後の行・幅せまのカード化・印刷の各規則にも行ヘッダーを並べた（足さないと、
    そのマスだけ地色が変わらない）。
  - 大きさの実測: `upcoming.html` は生で 288,662 → 471,118 バイト（列名をマスごとに書くため
    +182 KB）だが、gzip 後は 44,594 → 49,213 バイト（+4.6 KB – 一割の伸び）で、手機で
    開いた時に届く量は小さい方に留まった。`data.csv`・`deadlines.ics`・`catalog.json`・
    `recommender.js` は 1 バイトも変わっていない。
  - 見張り（新規 8 本・`tests/row_headers_and_labels.test.ts`）: すべての行に 1 個有り、
    列ヘッダーから割り出した「会議」の列に有り、中身が空でないこと / 全マスが列名を
    持ち、その語が列ヘッダーと一致すること / カード化と列名を出す規則が行ヘッダーを
    置き去りにしていないこと（`,` で並べた規則はハーネスが個別の規則に割るので、対応する
    規則が同じ幅に有るかで見ます）/ 素の `th` を狙う規則が残っていないこと（`td` 側にも
    同じ項目が書いてある物だけ許す）/ 行の状態（ホバー・選択・最後の行）と印刷で
    行ヘッダーが置き去りにならないこと / 一覧側は `scope="row"` を付ける列を 1 列だけ
    持つこと。既存の 3 ファイル（`table_markup_balance`・`built_golden_3`・
    `upcoming_long_table`）は、マスを `td` だけ・`<td>` の字面だけで数えていたので、
    両方を含む数え方へ直した。
  - 改ざん 6 通りと対照群 1 通り: ラベルを出さない / 会議の列を `td` に戻す / 一覧側の指定を
    外す / 列見出しの見た目を素の `th` に戻す / ホバーの地色から行ヘッダーを落とす /
    印刷で表のマスに戻さなくする – いずれも落ちた（上の 2 通りは「4,137 マスに列名が
    無い」「591 行に行ヘッダーが無い」という量の音で落ちた）。注記の語だけ変える対照群は
    落ちない。
- **生成時刻の行で、単位（JST）が同じ括弧の中に二度出ていた**（第 283 回）。
  `upcoming.md` と `upcoming.html` の先頭は「いつの時点の表か」を書く。実際は
  `生成時刻: 2026-08-09T00:00:00Z（JST では 2026-08-09(日) 09:00 JST）` だった（2026-09-24 実測）。
  JST の壁時計を作る関数が**必ず文末に単位を付ける**作りで、文の中で既に「JST では」と
  書いてある場所と重なった。値は正しいが、締切の時刻を扱う表の頭文が言い直しになっている。
  - 直し方: 壁時計（曜日付きの日付と時刻）を作る関数を、**単位を付けない物**として切り出し、
    単位を足す方はそれを呼ぶ形にした。日付列など単位が必要な所は今まで通り `… JST`、
    「JST では」の後ろは単位を付けない。`src/build.ts` の 2 箇所。
  - 変わった成果物は `upcoming.md`・`upcoming.html` と、ハッシュを持つ 4 個だけ
    （`index.html`・`data.csv`・`deadlines.ics`・`catalog.json` は 1 バイトも同じ – 実測）。
  - 見張り（新規 8 本・`tests/unit_word_not_doubled.test.ts`）: 画面に出る文章（`script`・`style`・
    タグ・文字参照を退けた後）で、**同じ括弧の中に同じ時間単位（JST・UTC・AoE）が二度
    入っていない**ことを 5 つの成果物それぞれで見る / 生成時刻の行の形 / 全体で JST を含む
    括弧が 10 件以上有ること（空振り防止）/ 直前まで出ていた形を実際に作って、それが
    弾かれること。`tests/build_golden.test.ts` の生成時刻の検査も、単位を外に一度だけ書く
    形へ直した（旧表記のままでは落ちる）。
  - しきい値をページごとに一律に出来なかった実測: 括弧は `index.html` 296・`upcoming.html` 303・
    `upcoming.md` 302・`llms.txt` 61・`health.md` に 29 個あるが、**JST を含む括弧は
    `health.md` に 0 個**（同 15・3・2・2・0）。そこで「ページ別には括弧の数」、
    「JST を含む括弧の数は全体合計」に分けた（一律に ≥1 を要求すると `health.md` が空振りで落ちる）。
  - 改ざん 3 通りと対照群 1 通り: 生成時刻の行を単位を付ける関数で書く（元の形）/ 壁時計の
    関数自体に単位を足す（根本で言い直しに戻る – 他の検査も同時に落ちた）/ 別の単位でも
    言い直しが出る形 – いずれも落ちた。注記の語だけ変える対照群は落ちない。
- **カレンダー配信用の畳み目が、2 文字の転義を切っていた**（第 282 回）。
  `deadlines.ics` の説明欄は「会議: … \n種別: … \n詳細: <url>」のように `
` で区切る。
  1 行を 75 オクテットへ畳む時、**切れ目がたまたまバックスラッシュの直後になる**箇所が
  2026-09-24 の配信物に **30 箇所**あった（前の行が `\` で終わり、続きの行が `n…` で始まる）。
  RFC 5545 §3.1 は 2 文字の転義をまたぐことを禁じている。行を開いてから転義を解く受け手では
  元に戻るが、**行ごとに扱う受け手では転義が解けず `\` がそのままカレンダーの画面に出る**。
  前回の検査は「75 オクテット以内」と「開くと元に戻る」だけを見ていて、切れ目の位置を
  見ていなかった（第 266 回の検査の目が届かなかった所）。
  - 直し方: 切れ目が転義の先頭になったときは、**バックスラッシュを続きの行へ送る**
    （前の行を短くする形で、75 オクテットの上限は保つ）。`src/build.ts` の畳む関数 1 箇所。
  - 直し前後の実測: 配信物 463,452 バイトは**同じ長さ**・継続行 2,459 行も同じ・
    75 を越える行 0 のまま・**行末がバックスラッシュの行 30 → 0**・**開いた結果は 9,292 論理行
    すべて一致**（中身を変えていない）。他の成果物 18 個のうち 13 個は 1 バイトも同じ
    （`index.html`・`app.js`・`upcoming.html`・`data.csv`・`catalog.json` を含む）。
  - 見張り（`tests/ics_feed.test.ts` に 4 本）: 実データの配信物に行末だけバックスラッシュの行が
    無い（畳まれた行が 100 行以上有ることも見て空振りを防ぐ）/ 開いた値に行末の転義が
    残らない / 折り返しを跨いだ収録元 URL が最後まで続く / **転義の位置を 40〜80 文字まで
    1 文字ずつ動かして**、どの位置でも前の行に残らない・75 オクテット以内・開くと元に戻る。
  - 改ざん 4 通りと対照群 1 通り: 転義をまたがない分岐を消す（元の欠陥）/ 上限を 76 にする /
    折り返しの行頭を空白 2 個にする / オクテット数ではなく文字数で切る – いずれも落ちた。
    注記の語だけ変える対照群は落ちない。
- **正本と配る JavaScript に、文字 NUL が 4 個混ざっていた**（第 281 回）。
  地名の盾（都市名を、国名の語の置き換えから守る仕組み）が、目印として **ソースに生の NUL
  バイト**を書いていた（同じファイルの別の所では ` ` の書き表しを使っていて、書き方が
  割れていた）。画面に出る値は正しかったが、**ビルド後の `recommender.js`（利用者全員に配る物）
  にも同じ 4 個が入る**（実測 395,417 バイトの中に 0x00 が 4 個）。テキストとして扱う筈の
  ファイルが、一部の仕組みで連続した文章として開けなくなる – 実際にこのセッションで
  **編集機能がこのファイルを「バイナリ」と拒否**した（検査の追記ごとに byte レベルの操作を
  強いられた）。git と grep は平気だった（NUL が先頭 8,000 バイト以降に有るため – 実測）ので、
  気づかれないまま長年入っていた。
  - 直し方: 生ではなく ` ` の書き表しで書く（意味も動きも同じ）。関数の頭に注記を書き、
    目印を生で書かない理由を残した。
  - 置き換えても中身が変わらないことの実測: 実データの掲載先 329 と、こちらで足した語を合わせた
    **343 行を `placeJa`・`placeWithPrefectureJa`・`placePrefectureJa`・`placeOffersOnline` に
    通した結果が 1 行も同じ**（差分 0 件）。他の成果物（`index.html`・`app.js`・`upcoming.html`・
    `data.csv`・`catalog.json`・`deadlines.ics` など）は 1 バイトも変わらなかった。
    `recommender.js` は +20 バイト（4 箇所の書き表しが 1 バイト → 6 バイトになった分）で、
    `health.md`・`publish.json`・`recommendation-index.json` の差分はその長さとハッシュだけ。
  - 見張り（新規 4 本・`tests/no_nul_bytes.test.ts`）: ビルド成果物のどれにも 0x00 が無い /
    正本（`site`・`src`・`tests`）にも無い / 盾の関数の目印は書き表しで書かれている /
    **実データ 329 件の掲載先すべて**で、目印が値に漏れない・入力にある英文字の語が
    置き換えの語彙（**正本の列表から取り出す**）で説明できる物以外残る・入力に無い数字が
    値に出ない・盾の語は末尾の句に有っても残る。
  - 改ざん 5 通りと対照群 1 通り: 目印を生 NUL で書く（作る側 / 戻す側）/ 目印を作る側と
    戻す側で違う制御文字にする / 戻す処理を壊して番号を残す / 退避をやめて目印を使わない –
    いずれも落ちた。関数の注記の語だけ変える対照群は落ちない。
- **内訳に出る要素の名前を、てびきが説明していなかった**（第 280 回）。
  投稿先を探す画面は、なぜその候補が出たかを**当たった要素の名前**で出す。論文ごとの行には
  短い名前が並ぶ（分野・会議名・採択論文・日本語・タグ・過去掲載先）。2026-09-24 にビルドで
  実測: てびきに **「採択論文」も「過去掲載先」も 1 回も出ていなかった**（他の 4 語も本文に
  紛れるだけで、名前の意味をまとめて読む場所が無かった）。候補のカードのチップは説明文を
  自分の隣に持っているが、**内訳の行は名前だけ**なので、画面の中に説明が有るのはチップだけだった。
  論文を複数入力した人ほど内訳の行を読むので、その人向けの説明が欠けていた。
  - 直し方: てびきに「**当たった要素の名前**」の項目を立て、6 つの名前を並べて括弧で意味を
    添えた（意味は組み立て側が持っている説明と同じ向きで書く – 勝手に作らない）。
    「過去掲載先」は**主題の一致とは別の補助情報**であること、内訳の数字は**一致スコアの点の
    足し算ではない**こと（第 175 回で手作業の重みを消した件）、カードでは「～一致」の書き方を
    すること、`同じ分野（掲載先から推定）` と `目立つ一致はない` の意味も同じ項目に書いた。
  - 見張り（新規 4 本・`tests/recommendation_terms_explained.test.ts`）: 内訳の行に出る名前は
    **ビルド後の `app.js` から取り出して**（書き写さず）、てびきの項目に `名前</strong>（意味）` の
    形で並んでいる / 補助情報であることと点の足し算ではないことを**否定形まで**見る /
    チップの説明欄が空の組み立てが 1 つも無い / チップの語の本体がてびきに有る。
    新しい名前を内訳に足しててびきに書かないと、1 本目が落ちる（語の増減と説明のズレを防ぐ）。
  - 改ざん 7 通りと対照群 2 通り: 項目を消す / ラベルの語を消す / 語を残して意味の括弧だけ消す /
    補助情報の区別を消す / 点の足し算ではないという否定を消す / チップの説明を 2 文字へ減らす /
    内訳に新しい語を足す – いずれも落ちた。項目の語だけ変える、括弧の意味の語だけ変える
    対照群は落ちない。
- **既定画面の列見出しが、閉じられていなかった**（第 279 回）。
  2026-09-24 にビルドの `index.html` を数えると `<th` が 7 個開いているのに `</th>` は **3 個**で、
  並び順を切り替えられる 5 列のうち「残り」「日時（JST）」「会議」「ランク」の 4 列が閉じられて
  いなかった（閉じていたのは「種別」「会期」「開催地」だけ）。表示する仕組みは次の `<th>` で
  前のセルを勝手に閉じるので、**画面では壊れて見えない**。しかしこれは不正な HTML で、
  検証器は落ちるし、表を組み直して扱う処理系（他サービスへの貼り付け、紙や電子書籍への書き出し、
  読み上げ側の HTML 補正）ではセルの区別が潰れることがある。
  「直近 180 日の締切と開催」（`upcoming.html`）は同じ表を組み立てているのに閉じていた
  （`src/build.ts` 側は閉じを書いていた – **静的な側だけ**抜けていた – `site/template.html`）。
  - 直し方: 4 個の `</th>` を書く（静的な HTML なので組み立ては変えない）。
  - 見張り（新規 5 本・`tests/table_markup_balance.test.ts`）: 表を組み立てる要素（table・thead・
    tbody・tr・th・td・caption）の開きと閉きが**両ページ**で対応している / 既定画面の見出しは
    7 個の列として 1 個ずつ読める（名前も固定 – 閉じ忘れで中身が混ざると読めなくなる）/
    列はすべて `scope="col"` を名乗る / 押せる列は `rem・date・conf・rank・event` の 5 個で、
    押せる列は必ず `aria-sort` を出す / `upcoming.html` は全行が 7 列。
  - 改ざん 6 通りと対照群 1 通り: 「残り」を閉じない（元の欠陥）/ 「日時（JST）」を閉じない /
    1 列が `scope` を手放す / 押せる列の状態を消す / 押せる列を 1 列減らす /
    `upcoming.html` 側のセルを閉じない – いずれも落ちた。見出しの注記の語だけ変える対照群は落ちない。
- **当たり方の説明が、画面で最も小さい字だった**（第 278 回）。
  「投稿先を探す」の内訳の項目に付く**当たり方の説明**（どの項目の何が当たったかを、項目の下に
  そのまま書く文）は、第 233 回まで `title` の注記（マウスを乗せたときだけ出る物）にしか無く、
  タッチ端末と読み上げで辿れないので常に出す形へ直していた。ところが 2026-09-24 にビルドの CSS を測ると、その
  `.reason-why` は **0.7rem = 11.2px** で、画面全体でも最も小さい部類だった（同じ 0.7rem が
  当たった要素名の列 `.perline-parts` にも乗り、当たり方のチップ `.reason-chip` と
  「過去掲載先一致 …」の `.perline-venue` は 0.72rem = 11.52px）。読める場所へ移したと言いながら、
  出した先が最小の字では仮名が潰れる。
  - 直し方: `:root` に注記の床 `--fs-note: 0.78rem`（12.48px）を 1 個置き、日本語を読む 4 規則
    （`.reason-why` / `.reason-chip` / `.perline-parts` / `.perline-venue`）をそこへ寄せる。
    規則ごとに数値を書き写さない（第 261 回の色の取り決めと同じ型）。
  - **意図的な例外**: 行の連番 `.perline-idx` は 0.7rem のまま（数字だけなので仮名が潰れない）。
    例外は検査に書いて置き、次の人が床へ巻き戻して幅を食わないようにする。
  - 見張り（新規 5 本・`tests/note_text_legibility.test.ts`）: 床が 12px 以上 / 4 規則は
    画面幅 1280px と 390px の**両方**で床以上（`effectiveCss` で後勝ちまで見る）/ 4 規則が
    `--fs-note` を読んでいる（数値の書き写しの検出）/ 連番は 0.7rem のまま（例外の記録）/
    説明が画面に出ている（`display: none` や絶対配置での追放の検出）。
  - 改ざん 5 通りと対照群 3 通り: 床を 0.6rem へ下げる / 説明に数値を書き戻す / 説明を
    `display: none` にする / 連番を床に巻き戻す / 狭い画面でだけ 0.62rem に縮める規則を**後ろに**
    足す – いずれも落ちた。床を 0.8rem へ上げる、同じ縮小規則を床以上の 0.8rem で足す、
    説明文の語を変える対照群は落ちない。
- **てびきの入口が名乗った語の項目が、中に無かった**（第 277 回）。
  「見方のてびき」を閉じた状態で目に見える文字は `<summary>` 1 行だけで、そこは
  「（「推定」「未確認」「該当なし」の意味・過去の締切の見方・CSV と印刷）」と書いていた。
  2026-08-09 生成ビルドで実測: 中の項目は 36 個で、`<dt>推定</dt>` と `<dt>未確認</dt>` は
  有るが **`<dt>該当なし</dt>` は 0 個**。意味は「会期のみ・締切未定」の項目の末尾に 1 文
  混じっているだけで、画面の会期・開催地列に実際に並ぶ語なのに、その語で見出しを辿れなかった
  （読み上げで見出し一覧を作る人、36 項目を流し読みする人のどちらも辿れない）。
  - 直し方: 「該当なし」の項目を新しく立て、説明文は**移す**（書き写さない – 移動なので
    説明が 2 個並ばない）。入口が名乗る語は必ず自分の項目を持つ、という約束に見張り直す。
  - 見張り（新規 4 本・`tests/guide_summary_entries.test.ts`）: 入口が名乗る語は全部項目として
    並んでいる / 「該当なし」の項目が常時受付の期刊行だと書き、向こう側の語（ kamiyobi が公式で
    裏を取れていないだけ）の意味にも触れて区別している / 同じ説明文が 2 か所に並んでいない /
    項目名が重複・空になっていない。既存の 1 本（常時受付の行の検査）は、見ていた場所が
    「未確認」の項目だったのを新しい項目へ移す。
  - 改ざん 7 通りと対照群 1 通り: 「該当なし」の項目を消す（入口だけ名乗る元の状態）/ 項目の
    説明から「未確認」との区別を消す / 「 kamiyobi が公式で裏を取れていない」の箇所をぼかす /
    説明文を他の項目へ書き写す / 同じ名前の項目を 2 つ作る / 入口に項目の無い語を名乗らせる –
    いずれも落ちた。説明の語だけ変える対照群は落ちない。
- **`upcoming.html` の表に、支援技術が読める名前が無かった**（第 276 回）。
  2026-08-09 生成ビルドで実測: 一覧の表には `<caption>` が 1 個有るのに、`upcoming.html` の
  `<table>`（1 個・**1,127 行**）に対する `<caption>` は **0 個** で、列見出し 7 個すべてに
  `scope="col"` が付いているのに表その物の名前が無かった。支援技術では名前の無い表に入り、
  「何の表か」を確かめる手段がないまま 1,127 行を辿ることになる（一覧を開けば同じ表に名前が
  付いているので、この表だけが名前無しだった）。
  - 直し方: 説明は **ページの見出し（h1）と列の名前（表の 1 行目）から組み立てる**。同じ語を
    別個に書くと、片方だけ変わったときに支援技術へ違うことを伝えるので、出所を 1 個に寄せた。
    画面には出さない（一覧と同じ `only-sr`）。`<caption>` は `<table>` の最初の子に置く。
  - 見張り（`tests/upcoming_marker_legend.test.ts` に 2 本）: 表に説明が有り、`only-sr` が
    付いている / 説明が数える列の並びが、実際に並ぶ列と一字一句同じ / ページの見出しをそのまま
    含んでいる / `<thead>` より前に有る / 一覧の表と同じ言い回しの形（「〜の一覧」）。
  - 改ざん 10 通りと対照群 1 通り: 説明を消す / 画面に出る形にする / 列の並びを書き写して実際の
    列とズラす / 列見出しより後ろへ回す / 説明にこの表へ並ばない語を定義する / `AoE` の説明を
    消す / 説明文を表の中に戻す / 「無いと決めた意味ではない」を逆に読む文へ反転 / 正本の文を
    呼び側へ書き写す – いずれも落ちた。注釈の語だけ変える対照群は落ちない。
- **`upcoming.html` / `upcoming.md` を単体で開いた人に「未確認」の意味が伝わらず、そのうえ表のうえの説明が表の中に落ちていた**（第 275 回）。
  2026-08-09 生成ビルドで実測: この表は 1,127 行で、開催地が「未確認」の行が **182 行**、日付に
  「（時刻未確認）」を持つ行が **180 行**、`AoE` の宣言が **410 か所** ある。表のうえの説明は
  「残り」「開催」「ラウンド」「推定」にしか触れておらず、いちばん多く出る「未確認」の意味が
  このページに無かった。読み手は「収録元が無いと決めたのだ」と読み違えて、探している会議を
  捨てうる（ kamiyobi が裏取りできていないだけなので事実と違う）。
  同じ頃、`toUpcomingHtml` は生成した本文全体を `<table>` で囲んでいたため、表のうえの
  見出し・生成時刻・対象期間・列の意味が `<table>` の**中**に落ちていた（実測: `<table class="upcoming">`
  の直後に h1 と blockquote が並ぶ）。ブラウザは表に置けない要素を表の外へ押し出すので、
  画面の見えとマークアップがズレ、支援技術には「表の中身」として読まれる。
  - 直し方（①語の意味）: 「未確認」と「AoE」の一文を `recommender.ts` の正本に置き
    （`unconfirmedMeaningJa` / `aoeMeaningJa`）、画面のてびき・印刷の但し書き・この表の 3 か所で
    同じ関数を呼ぶ。手コピーをやめるので 3 か所がズレない。表の側の説明は、必ずその表に並ぶ
    語だけを名乗る（第 269 回の印刷凡例と同じ約束）。
  - 直し方（②入れ子）: 表を囲む枠を行組み立ての側（`flushTable`）へ移し、表ごとに包む。
    説明文は表の外に出る。
  - 見張り（新規 6 本・`tests/upcoming_marker_legend.test.ts`）: 目印の語が表のうえで**定義の形**
    （「◯◯」は、）で説明されている / 説明が名乗る語は必ずその表に並ぶ / 「無いと決めた意味では
    ない」と書いてある / 意味の文は正本 1 個（ビルドした `app.js` に書き写しが 0 本）/
    印刷の但し書きは正本の文を繋いでも語尾が破れない / HTML では説明が表の外に有り、表の中に
    見出しや段落が落ちていない。
  - 改ざん 12 通りと対照群 2 通り: 「未確認」「時刻未確認」「推定」「AoE」の説明をそれぞれ消す /
    「無いと決めた意味ではない」を逆の意味に反転 / 正本の文を `app.ts` とビルド成果物に書き写す（2 か所）/
    語を書き写す / 説明文を表の中に戻す / 表の閉じを一つ消す / この表へ並ばない語を説明で定義する –
    いずれも落ちた。注釈の語だけ変える対照群は落ちない。
- **画面を構成する領域に、見出しが無かった**（第 274 回）。
  2026-08-09 生成ビルドで実測: 静的な HTML の見出しは `h1 kamiyobi 投稿締切` と、実行時に埋まる
  ドロワーの `h2` の **2 個だけ**。本文欄より前に Tab で止まる物は **44 個**有り、
  「締切の一覧へ進む」で跳んでも、跳んだ先が何なのか名乗りが無かった（表には `caption` で
  「締切の一覧（日時は JST で出しています）」が有るが、`caption` は見出し一覧に出ない）。
  VoiceOver のローターや NVDA の見出し一覧を開いても、移動先が 1 件しか並ばない画面だった。
  推薦モードの欄も 4 つの入力欄と見本のボタンが並ぶだけで、塊としての名前が無かった。
  - 直し方: 本文欄（`main`）に `only-sr` の **締切の一覧** 見出しを置き、`aria-labelledby` で
    ランドマークの名前も同じにする。推薦モードの論文を入れる塊を `role="region"` にして
    **論文の入力** 見出しで名乗らせる。語はどちらも画面に既に出ている物（スキップリンクと表の
    見出しが「締切の一覧」、ボタンとてびきが「論文の入力を消す」「論文の入力とサンプル」）で、
    新しい語は作っていない。`only-sr` は画面にも紙にも出ないので、見た目は変わらない。
  - 候補のカードは `h3` を持つので、推薦モードでは候補その物も見出し一覧から辿れる（見張りに足した）。
  - 見張り（新規 7 本・`tests/region_headings.test.ts`）: 見出し一覧に 2 つの領域が並ぶ / h1 は 1 個 /
    見出しが `only-sr` を着ている（規則が生きていても、クラスを外せば画面に出てしまう）/
    印刷 CSS が画面に出ない語を復活させていない / 見出しの語はよそでも使っている語（英文字の混入も見る）/
    `aria-labelledby` は実在 id を指し、その主役が見出し / スキップリンクの到達先が自分を名乗る /
    静的な HTML の空の見出しはドロワーだけで、必ず埋められる。
  - 改ざん 12 通りと対照群 2 通り: 見出しを消す（2 か所）/ 空にする / `only-sr` を外す（2 か所）/
    作った英語の見出しに替える / `aria-labelledby` を宙に浮がす / 名前を付ける先を `div` にする /
    `role="region"` を消す / 印刷で `only-sr` を復活させる / ドロワーの見出しを埋めるのをやめる –
    いずれも落ちた。注釈の語だけ変える対照群は落ちない。
- **続きを最後まで足した人のフォーカスが、消えたボタンに乗ったままだった**（第 273 回）。
  「さらに表示」「すべて表示」は足す物が無くなると `updateMoreButton` が `hidden` にするが、
  **押した人自身のフォーカスの行き先は誰も面倒を見ていなかった**。画面に 28 個有るボタンのうち、
  押すと自分が消える 2 個だけこの形（`beforeprint` は押さないし、条件の欄は消えない）。
  フォーカスが消えた物に乗ると、その後の Tab は画面の先頭からやり直しになり、読み上げも
  居場所を失う。マウスならスクロールバーで現在地が分かるが、キーボードだけで読む人には
  一覧の最後まで辿り着いた瞬間にそこが分からなくなる。読み上げ欄（`#countLive`）にも
  最後まで出したことは流れなかった（総数は押す前と同じなので、件数欄の変化が無い）。
  - 直し方: 続きを足す関数（`drawMore` / `drawMoreCards` / `drawAll`）の末尾で、
    **フォーカスがまだボタンの上にあり、かつ両方のボタンが消えたときだけ**、最後に足した行
    （推薦カードでは最後のカード）へ移し、`#countLive` に「… をすべて出しました」を流す。
    条件を変えて `render()` から呼ばれたときはフォーカスが条件の欄に乗っているので入らない。
    既存の `sharedRowNotice`（0 件案内と同じ「 ｜ 」の形）を使うので、読み上げの書式は変わらない。
  - 行の選び方（月見出し `.month-row` と行内展開 `.detail-row` を除く）を **3 か所に書き写す
    ところだった**ので、`dataRows()` の 1 本にまとめた（既存 2 か所もそこを通る）。
    実際、改ざんで除外条件を外した検査が「手当てできない（2 件）」と報告した = 式が
    2 か所に有ったという報告その物だった。
  - 見張り（新規 8 本・`tests/focus_after_showing_all.test.ts`）: 抜き出した本物を代用の画面で
    動かし、①ボタンが消えたら最後のデータ行へ移る ②読み上げに総数付きで伝わる
    ③まだ足す物が残っているなら動かさない ④押していない人（条件の欄）のフォーカスを動かさない
    ⑤推薦カードでは最後のカードへ移り、`tabindex` 属性を与えられる ⑥行が 0 件でも落ちない
    ⑦行の選び方が 1 本の関数に集まっている ⑧続きを足す 3 関数の末尾から呼ばれている。
  - 改ざん 10 通りと対照群 1 通り: 呼び出しを消す（3 か所各） / `focus()` を消す /
    読み上げを消す / 「押した人だけ」ガードを外す / 「全部消えたときだけ」ガードを外す /
    カードに `tabindex` を与えない / 行の選び方から月見出し・展開行の除外をそれぞれ消す –
    いずれも落ちた。読み上げの冒頭の語だけ変える対照群は落ちない。
- **一覧の続きが 40 件ずつで、一番下まで 11 回押させる作りだった**（第 272 回）。
  2026-08-09 生成ビルドで実測: 一覧は `PAGE = 40` 件しか一度に並べず、既定の 478 件を読むには
  「さらに表示」を **11 回**押す必要が有った。同じ内容を印刷すると全行出る（`beforeprint` が
  全部足す）ので、**画面だけ押しまくる**という差が残っていた。画面に「すべて表示」に相当する
  口は無く（`app.js` 中の「すべて」はランクの選択欄のラベルなど別物ばかり）、検索も絞り込みも
  使わないまま一覧を眺めたい人にだけ、特にきつかった。
  - 直し方: 「さらに表示」のとなりに **すべて表示 (残り N 件)** を置き、残りを一気に入れる。
    足し方自体は既存の `drawMore` / `drawMoreCards` をそのまま呼ぶ（続きの出し方に式を 2 つ
    持たない）。表示可否とラベルは `updateMoreButton` の一か所でそろう（表と推薦カードで
    同じ口を共有しているため、どちらのモードでも効く）。印刷物には出さない。
  - 初期状態は `hidden`（足す物が無いときに見える噓の口にしない）。件数の区切りも
    同じ `countJa` を通すので、4 桁をこえても画面と同じ `3,213 件` の形になる。
  - 見張り: ラベルと表示可否は**抜き出した本物を実行して**確かめた。そのとき既存の検査
    （`tests/built_golden_2.test.ts`）が `$ = () => more` という粗い代用でボタンを 1 つしか
    作っていなかったため、`showAll` に書いた文言が `more` に写って壊れた（**画面に 2 つある物を、
    検査が 1 つだと思っていた**）。id で作り分ける形に直し、抜き出した関数の依存にも
    `showAllButtonLabel` を足した。
  - 改ざん 9 通りと対照群 1 通りの実測: ボタンを消す / 初期 `hidden` を外す / ラベルの語を変える /
    開く側で `showAll` の更新を消す / 閉じる側で `showAll` を消さない / クリックの配線を消す /
    進まないときの `break` を消す / 印刷で消さない / てびきの案内を消す – 9 通りはいずれも落ちる。
    余白だけ変える対照群 1 通りは落ちない。
- **案内が、画面の実物の語を使っていなかった**（第 271 回）。2026-08-09 生成ビルドで実測:
  - てびきの CSV の項目は「残りは**表の下に出るボタン**で足します」と言い、そのボタンの名を
    一度も出さなかった。画面では **さらに表示 (残り N 件)** と出る（ラベルの正本は
    `moreButtonLabel`）。目の前のボタンと案内が対応づけできなかった。
  - 「締切まで」の項目も「締切日からの日数で絞ります」とだけ言い、実際の選択肢
    （かまわない・7 日以内・30 日以内・90 日以内・180 日以内）を一つも挙げていなかった。
    「180 日以内」という語はガイド全体にも 1 度も無かった。
  - `upcoming.md`（1,126 行）は前置きで「`index.html` の表が同じ式で出すので…そちらが早い」と
    **名指すだけ**で、**index.html へのリンクは 0 本**だった。GitHub の生的な表示では
    コードspan になるだけで辿れない。表の最後まで読むと出口も無く、そこで終わりだった
    （`upcoming.html` には第 269 回で出口を置いたが、マークダウンには置いていなかった）。
  - 直し方: ① てびきの CSV の項目に「さらに表示」を名指しで書き足す（動詞の説明だけではない）。
    ② 「締切まで」の項目の末尾に選択肢を並べる（クイック抽出のボタン名は、既存の
    「早め絞り込みのボタン」の項目が既に 5 つとも名乗っていたので、**追記せず削った** –
    同じ語を 2 か所に持たない方針は案内にも当たる）。③ マークダウンの前置きの指し先を
    リンクにし、終端に出口を置く。出口の言い回しは `upcoming.html` と**同じ正本**
    （`UPCOMING_BACK_TEXT_JA`。HTML 側はそこに矢印を足す）から組む。
  - 見張りはガイド全体ではなく**項目単位**（`<dt>` と続いている `<dd>` の中）で見る。
    ガイド全体で語の存在を見ると、別の項目の例文（「「締切まで 7 日以内」を超える N 件」など）が
    語を拾って空振りする（第 271 回の改ざんで実発生）。
  - 改ざん 9 通りの実測: てびきのボタン名を元の内容戻す / 「締切まで」の項目から選択肢を 1 つ消す /
    選択肢を全部消す / 早め絞り込みの項目から日数ボタンの名を消す / 画面のボタンの語だけ変える
    （案内とズレる）/ 前置きを辿れない名指しに戻す / 終端の出口を消す / マークダウン側の言い回し
    だけ変える / 出口を最後の行より前に置く – いずれも落ちる。出口の説明文の語だけ変える、
    選択肢の並びだけ変える、の 2 通りの対照群は落ちない。
- **公開している CSV だけ、種別が上流の英語と揺れる自由文だった**（第 270 回）。
  2026-08-09 生成ビルドで実測: `data.csv` は 3,253 行・25 欄で、**日本語の種別欄は 0 本**。
  種別は `kind`（英語のキー 10 種）と `label`（上流の自由文）だけだった。`label` はつづりが
  揺れる（'Paper submission' 1,483 行 / 'Paper Submission' 48 行 / 'Paper submission deadline'
  54 行が同じ物を指す）。同じ内容を出す `upcoming.md`（種別欄 11 語）と `deadlines.ics`
  （DESCRIPTION に種別）は最初から日本語で、**この表だけ**スプレッドシートで並べ替え・
  絞り込みをする人が英語に頼る形になっていた。JavaScript が動かない人にとっては、この画面で
  唯一使える生の CSV がこれなので、出口が無いのと同じだった。
  - 直し方: `kind_ja` を **1 欄だけ末尾に足す**（列の順序で読む下流を壊さないため）。語は
    マークダウンと同じ正本（`kind_label` ← `KIND_LABEL_JA`）から引くので、言い回しは増えない。
    画面の書き出し CSV は既に日本語ヘッダーなので、これで三つの成果物が同じ語になる。
  - `llms.txt` の「data.csv の列」は元々「**値は機械可読のまま**にしてある。日本語は書かない」
    という契約を書いていた。実物を変えたので、**契約側も正直に更新**し、種別だけを例外として
    理由込みで明記した（書かないままにすると索引が噓をつく）。索引には「CSV の全欄の意味を
    持つ」検査を置き、以後は欄を足して説明を忘れると落ちる。
  - 案内も直した。てびきの「CSV」の項目に、生の CSV に日本語の種別欄（`kind_ja`）が有ることと
    `label` はつづりが揺れることを書き、JavaScript 無効の画面の `data.csv` の説明にも
    「並び替え・絞り込みは日本語の欄でできる」と書いた。
  - 改ざん 9 通りの実測: 値を空欄にする / 値に英語のキーをそのまま入れる / 列を真ん中に置く /
    列の名前を消す（値だけ残す）/ 列の説明を空欄にする / 索引の例外宣言を消す /
    索引の CSV の説明から欄の名前を消す / てびきの案内文を消す / JavaScript 無効の案内を消す –
    いずれも落ちる。説明の語だけ変える対照群は落ちない。
- **静的な一覧（`upcoming.html`）は 1,127 行あるのに、戻る口が先頭に 1 個しか無く、
   少しスクロールすると欄の名前が消えた**（第 269 回）。2026-08-09 生成ビルドで実測:
  - `index.html` へのリンクは文書全体で **1 個**、`</table>` のうしろには何も無い。
    最後の行（SGP 2027・CHIL 2027 あたり）まで読んだ人は、約 50 画面ぶん上に戻ら
    なければ次の動作ができなかった。
  - スタイルシートに `sticky` は **1 度も無い**。1 枚の長い表なので、800 行目の数字が
    「残り」なのか「会期」なのかがその場では読めない（画面は 40 行ずつなので顕在化しなかった）。
  - 直し方（`toUpcomingHtml` と共有スタイルの 2 か所。どちらもそれぞれの正本に置く）:
    終端に「先頭に戻る」「締切の一覧に戻る」を置く。言い回しは入口と終端で**同じ正本
    （`UPCOMING_BACK_LABEL_JA`）から組む**（同じ語を 2 か所に書かない方針）。
    列見出しを `position: sticky` にする。ただし `.tablewrap` の `overflow-x: auto` は
    粘着を止める（内側に貼り付く扱いになり、この箱は高さを持たないので効かない）ので、
    **横に越えない幅だけ** `overflow` を戻す。その幅は 表の `min-width: 880px` +
    `.wrap` の左右 24 px + `.tablewrap` の枠 1 px + **縦スクロールバー 17 px** = 947 px
    以上（バーの分を忘れると、ぎりぎりの幅でページ全体の横スクロールが起きる）。
    余裕を持って 960 px。狭い幅（640 以下）は行がカードになり見出し自体が消えるので触らない。
  - 並び替えられない列の見出し地 `--accent-subtle` は半透明なので、粘着中は下を走る行が
    透ける。**不透明な下地（`--panel`）を敷いてから同じ地を乗せる**（並び替えられる列は
    不透明な `--chip` を既に持つので、`th:not([data-sort])` にだけ当てる。画面の見た目を
    壊さないため）。
  - 改ざん 9 通りの実測: 終端の出口を消す / 出口を表より前に置く / 終端の言い回しを入口と
    違う物にする / 見出しを粘らせない / 粘着位置を 40 px 下げる / `overflow` を戻す規則を
    消す / 越える幅でも粘らせる / 下地を敷かない / 紙に粘着を混ぜる – いずれも落ちる。
    言い回しだけ変える対照群は落ちない。
- **購読には URL を打ち込む必要があるのに、その場所を取り出せなかった**（第 268 回）。
  第 266 回のてびきは「このファイルの場所をそのまま購読先（URL）に指定すると毎日置き換わる」と
  書いていたが、画面にはその場所を取り出す物が何も無かった（リンクを右クリックして「リンク
  コピー」を選ぶしかなく、スマートフォンの長押しはなおさら届かない）。ビルド前の `app.ts` を
  実測すると、クリップボードに触るコードは 1 行も無かった。
  - 直し方: 「カレンダーに追加（.ics）」の隣に「**購読 URL をコピー**」を置き、押すと
    クリップボードへ入れることと、指定する URL を選べる形（`<code>`）で画面に出す。
    JavaScript が動いていない画面と紙には出さない（押せない物なので）。
  - **URL は `document.baseURI` から組み立てる**。配信先を代码に書かない方針は第 242 回から
    そのまま（ビルド成果物に特定ホスト名は 1 度も出ない）。サブパス配信でも自前ホストでも
    同じコードで正しい URL になることを、にせの `document` を入れて検査する。
  - **自動でコピーできない開き方（このページを http で開く等）を噓にしない**: クリップボードが
    無い・拒否したときは、できたと言うのではなく「自動ではできませんでした」と言い、同じ URL を
    手で指定する方法をそのまま見せる。失敗時に成功を返さないことも検査する。
  - 改ざん 12 通りの実測: HTML として書き込む / 失敗時に成功と言う / コピーできないときに URL を
    教えない / 配信先を打ち込む / 配線を外す / JavaScript 無し画面に出す / 読み上げ指定を外す /
    紙に刷る（`#icsCopy` を消す・`#icsCopyNote` を消す）/ てびきの案内を消す – いずれも落ちる。
    言い回しだけ変える対照群は落ちない。
- **出口を作ったのに、出口の在りかを言う場所が 3 か所ずれていた**（第 267 回）。
  第 266 回で `deadlines.ics` を出したが、それを指す場所は一行も直していなかった。実測
  （2026-08-09 生成ビルド）:
  - JavaScript が動かない人向けの案内は「同じ場所にある **2 つのファイル**で直接読めます」と
    数を言い切り、`data.csv` と `upcoming.html` の 2 本しか並べていなかった。表が空に見える
    人にいちばん効く出口を、いちばん見えない位置に置いたままだった。
  - 静的な `upcoming.html`（README と索引から辿れる直近一覧）は `deadlines.ics` が **0 回**。
  - `llms.txt` は `index.html` の説明を「`data.csv`・`upcoming.md` への導線を内側に持つ」と書き、
    実物は 3 本になった導線を 2 本と伝えていた。
  - 第 266 回で自分が書いた説明文に、全角読点のうしろへ半角空白が 1 箇所残っていた
    （文字列連結の続きの行を空白で始めた）。
  - 直し方: 案内は**数を数えない文**にして（物を足すたびに噓になる形を消す）3 本目を並べ、
    `upcoming.html` の先頭の案内に出口を置き、索引の説明を実物に合わせ、空白を落とした。
    検査は案内のリンクが全て相対パスでビルド先に実在すること、索引の説明が画面と会うこと、
    全角句読点のうしろの空白を見る。改ざん 5 通り（数を戻す / 案内から外す / 静的ページから
    外す / 索引から外す / 空白を戻す）はいずれも落ち、言い回しを変える対照群は落ちない。
- **締切を自分のカレンダーに入れる出口が無かった**（第 266 回）。
  サイトの売りは ICS 配信だが、ビルドは `*.ics` を 1 本も出しておらず、画面にも README にも
  「カレンダー」という語すら無かった（`購読` `カレンダー` `.ics` の出現数: ビルド済み
  `index.html` / `site/template.html` / `site/app.ts` すべて 0）。締切は画面を開いた人にしか
  見えず、研究者の実際の動作（自分のカレンダーに入れておく）ができなかった。
  - 直し方: `deadlines.ics`（RFC 5545）を加え（`src/build.ts` の `toIcsText`）、一覧の件数欄の隣に
    「カレンダーに追加（.ics）」の導線、てびきに項目を立てた。2026-08-09 生成ビルドで
    **928 イベント**（時刻未確認 172 / 推定と書いた物 127）、UID は 928 個すべて異なり、
    75 オクテットの折り畳みも UTF-8 の途中では切っていない。
  - **終日イベント（`DTSTART;VALUE=DATE`）で、日は JST の暦日**。締切に継続時間は無いので、
    「何時から何時まで」を作るのは締切の推測になる（収録の契約）。時刻その物は説明に JST で書く
    （`2026-10-04T20:00Z` → `20261005` と `2026-10-05 05:00（JST）`）。
  - `estimated` は行と同じ「推定」を要約に載せる。時刻未確認も説明に書く。過ぎた締切は入れないが、
    当日の日付だけで過ぎたか確かめられない物は残す（消すほうが噓）。
  - **UID に日付を載せない**。上流で一番起きる変更は締切日その物で、日付を UID に載せると
    「同じ締切が動いた」のに新しい UID となり、購読先に古い日付が残る。ビルドが変わっても
    同じ締切は同じ UID（検査で Pins）。日本語の種別は UID の文字種に収まらないので、
    収まらない物は短くハッシュする。
  - `llms.txt` の一覧に載せない実在する出力も、載せている実在しない出力もどちらも誤りなので、
    「実在しない `.ics` を載せない」見張りは「カレンダーのファイルは 1 本きり」に意味を移した
    （`tests/build_golden.test.ts` 3 か所）。収録 0 件のビルドでは空のカレンダーが出て
    イベントだけ 0 件になる（購読側はファイルの在無では壊れたと分からないため）。
  - 改ざん 12 通りの実測: 時刻付きで出す / 過ぎた締切も入れる / 確かめられない物も消す /
    推定と書かない / UID に日付を載せる / 75 オクテットを文字数で数える / 折り畳みをしない /
    TEXT をエスケープしない / JST でなく UTC の暦日を入れる / 画面の導線を消す /
    てびきの約束を消す / 索引から外す – いずれも落ちる。対照群（更新間隔を 12 時間に変える）は
    落ちないので、色の見張りのときと同じ過学習の対照になっている。
- **641〜879 px の幅で、締切の一覧が横に動くことが分からなかった**（第 265 回）。
  `table { min-width: 880px }` / 7 列（2026-08-09 生成ビルド・収録 687 会議で実測）。640 px 以下は
  行がカードになるので越えないが、**その上の帯だけ**横向きのスクロールが起きる（iPad 縦持ち
  768・810・834、論文の PDF と並べた画面分割の窓、拡大表示）。
  - `overflow-x: auto` の箱は既定でフォーカスされないため、**キーボードでは動かせなかった**
    （WCAG 2.1.1 操作可能性）。`title` の注記すら無く、導線は何も無かった。
  - 直し方: 越えているときだけ、その箱に `role="region"`・`aria-label`・`tabindex="0"` を付けて
    `Tab` で受けられるようにし、上に表示文を出す（「← → で横にスクロールできます（…右に続きが
    あります）」）。越えていなければ**焦点も表示文も置かない**（空の焦点点を増やさない）。
  - 「越えている」の境界は 1 px 以下の差を無視する（越えていないのに「続きがある」と言うほうが
    害が大きい）。一覧その物が隠れている画面（投稿先を探す・0 件）は測れないので出さない。
  - 見張り方: ビルド済み `app.js` から `tableScrollOver` / `syncTableScroll` を**名前で抜き出して**
    にせの要素で動かし、`tabindex`・`role`・`aria-label`・表示文の出し入れを実際の動きで検める
    （時間の話も、ビルド前の書き方には縛っていない）。表示文の文字色は両配色で 4.5 倍以上を
    見る（`--muted` の実測最悪値 4.69 – 明るい面の `--panel-hover` 上）。
  - 改ざん 10 通りの実測: `tabindex` を付けない / 越えていないときの後始末をしない / 判定を逆にする /
    窓の幅で揃え直さない / 一覧を組み直したときに揃えない / 説明をその場に書き写す /
    表示の場をスクロール面の中にも置く / 表示の場を消す / 紙にも刷る / 焦点の目印を消す – 落ちる。
    対照群として表示文の文字を本文色に換える差し込みは落ちない（色の見張りが過学習していないこと）。
- **速さを壁時計で比べる検査が、同じ機械の並列実行で落ちた**（第 264 回）。
  第 258 回に作った「検索の畳み込みを憶える」検査は、同じビルドの中で初回と 2 回目の時間を比べて
  3 倍以上を見ていた。検査を連続実行した 2026-09-24 に実測で落ちる（初回 4.6 ms / 2 回目 6.2 ms –
  比 0.73）。暖機を別の文字列で済ませても、他の検査とコアを奪い合うと同じ結果になる。
  - 主張したいのは「時間が短かった」ではなく「**同じ行を二度畳まなかった**」なので、検める対象を
    働き方に変えた。畳む関数（`kanaFold`）を検査側へ渡す窓を 1 本あけ（`kanaFoldMemo` –
    憶える量はその関数の側にある `Map` なので、**検査側の `Map` を差し込んで**読み・書き・捨ての
    回数を数える）。初回は読み 400 / 書き 400、2 回目は読み 400 / **書き 0** が合格の形。
  - 画面と同じ経路（`searchMatcher`）で同じ表を 2 回掛けたときも、畳み直しが起きないことを同じ
    数え上げで見る（関数単体の話にならなくする）。上限でまとめて捨てる動きも、時間を測らず
    「捨てた回数」と「捨てた後の数」で検める。
  - 絶対時間の記録（31 ms → 0.8 ms など）は検査の合格条件から外し、この記録にだけ残す。
  - 改ざん 5 通りの実測: 憶えた値を読む道を消す（2 回目で書き 400 – 落ちる）/ 書き込まない
    （初回の書き 0）/ 上限を 1,200 万件に緩める（捨てない）/ 窓が憶えない関数を返す（読み 0）/
    窓をなくす（検査が空振りしない）。5 通りとも期待どおり落ちた。
- **`upcoming.md` へ送っていた導線が、ブラウザでは読めない行き先だった**（第 263 回）。
  「表に出さない種別（採否通知・カメラレディ・登録・開催案内）」「締切未定で会期だけ決まった会」は
  ここにしか載らないとして、画面とてびきから 3 本のリンクを送っていた。ところが配信先は
  `content-type: text/markdown` を返し（§7 の別の項で HEAD を実測済み）、ブラウザはそれを表に
  整形しない。2026-08-09T00:00:00Z ビルドで実測すると、`upcoming.md` は 1,128 行が `|` の表組みで、
  会議名の 1,126 行が `[名前](URL)` のマークダウン記号のまま – 押した人は表ではなく
  記号の並んだ文章かダウンロードを受け取る（触る端末では `title` も読めない）。
  - 以前の防ぎ方は「リンクの説明で正直に書く」だけだった。説明が正しくても**手は止まる**ので、
    同じ場所にもう 1 つ **ブラウザで読める版 `upcoming.html`** を出し、導線 3 本はこちらへ向け直した。
    Markdown 版は機械が読む用のまま残し、そちらの説明（整形されない／ダウンロードされ得る）は
    書き続ける（噓にしない）。
  - **中身は 1 本だけ持つ**：`upcoming.html` は `toUpcomingMd` の出力を変換して作る
    （表示用の表をもう 1 本作らない）。変換が handle するのは生成物が出る形だけ –
    `# ` 見出し / `> ` 注記 / `|` の表 / 通常の行、セルの中の `[文字列](URL)` と `コード`。
    セルの中の縦棒は `escapeMdCell` が `\|` に逃がすので、そこで区切ってから戻す。
  - 見張り方は「md と html の実数を突き合わせる」にした（行 1,127 / セル 7,889 / リンク 1,126 が
    2026-08-09 ビルドでの一致値）。作っている間に**自分の検査側の数え方が 3 回噓をついた**：
    列の名前を `<th>` に出しているのに `<td>` だけを数えた / `https://` だけで数えて `http://` の
    23 本を取りこぼした / エスケープ済みの縦棒でセルを割った。いずれも数の差を追って直した
    （数が合ったから正しいのではなく、**どの数を合わせたか**を書く）。
  - 改ざん 8 通りの実測: 導線を Markdown に戻す（導線 3 → 1 で失敗）/ `upcoming.html` を出さなくする
    （読み取れず失敗）/ 表を 30 行で打ち切る（行の数が違う）/ 列の名前を `<td>` に落とす（0 対 7）/
    列の名前を 1 文字変える（名前が一致しない）/ セルのリンクを起こさなくする（0 対 590）/
    一覧へ戻る導線を消す / Markdown 版の説明から「ダウンロード」を消す – いずれも期待どおり落ちた。
    失敗に見えた 2 通りは**改ざん自体が効いていなかった**（`cond ? x : value && real` は値を変えなかった /
    ツールチップの語が 2 か所に同じ）ので、効く形に作って直した。
- **`Tab` で出る「締切の一覧へ進む」が、暗い画面でほぼ読めなかった**（ビルド済み `index.html`
  のスタイルから計算して実測・第 262 回）。スキップリンクは `background: var(--accent)` の上に
  `color: #fff` を書き写していた – ライトモードでは 5.72 で足りるが、暗い画面の `--accent`
  （`#8ab4f8`）の上では **2.11**（WCAG 1.4.3 の 4.5 に遠く届かない）。スキップリンクを
  見る人（キーボード・支援技術の使用者）がちょうど通るところだった。
  - 根本原因は第 261 回と同じ形 – **背景に敷く色に対する文字色を、画面の明るさごとに決めて
    いなかった**。1 色で両方に使える値は無い（白は暗い画面で 2.11 / `#18181b` は明るい画面で
    3.10）ので、**背景を敷く色の上の文字色を画面の明るさごとに決める `--on-accent`**
    （ライト `#ffffff` / ダーク `#18181b`）を 1 本足した（5.72 / 8.41）。
    `background: var(--accent)` を使う所は画面にこの 1 か所しかない。
  - 第 261 回の検査は「名前で決めた規則」だけを見ていて、この 1 か所を捕まえられなかった。
    そこで **文字色と背景を同じ規則に持つ語を機械的に総当たり**する検査に作り直した
    （2026-08-09 ビルドで 22 規則 × 2 主題 = 44 組・最低 4.56 – 4.5 未満は 0 組）。
    - 半透明の背景（`--accent-subtle` など）は「後ろ」が規則だけでは決まらないので、
      `--bg` / `--panel` / `--chip` の**一番不利な組合せ**で数える。
    - `var()` を **解決してから**アルファを見る（`--accent-subtle` の実体は `rgba(…)`。
      解決前に見ると半透明と気づかず、白い背景との合成になってしまう – 実発生）。
    - `background: transparent` は「アルファ 0（後ろの色がそのまま見える）」として扱う
      （「解釈できない」と誤ると `.btn-reset` などが数えられなかった）。
    - **紙用の `@media print` の塊は落とす**（紙用に薄い色へ差し替えた規則が並んでいる）。
      紙の中だけに悪い色を置いても落ちないことを、改ざんで実測した（検査の意図どおり）。
    - 読めた組の数だけだと、規則の名前が変わって静かに抜けると気づけない。薄い背景を敷く
      規則 7 本（`.skip-link`・`.brand-badge`・`.month-row th`・`.tag.match`・`.tag.est`・
      `.tag.past`・`.chips label`）を名前で指しておき、消えたら落ちるようにした。
  - 改ざんの実測（計 8 通り）: スキップリンクを `#fff` に戻す（2.11）/ 暗い画面用の
    `--on-accent` を決めない（2.11）/ 徽章の文字を背景と同じ色にする（1.01）/
    背景の指定を別名にする（規則が見えず失敗）/ `.skip-link` 規則を消す（同じく失敗）/
    紙用の塊だけに悪い色を置く（**落ちない**）/ 第 261 回から流用の 3 通り – すべて期待どおり。
  - 作業中に自分の道具で正本を一度空にした（`io.open(path, "w")` は**呼び出しの引数を評価する前に**
    ファイルを切る。`write(s.replace(..., clean(...)))` の `clean` が失敗しても手遅れ）。
    `git checkout` で復旧した（743,872 B）。以後この手の直し方は「読む → 組み立てる →
    一時ファイルに書く → 戻す」の順で行う（§8 に書いた）。
- **薄い緑・茶の語が、薄い背景の上で 4.5 対 1 に届いていなかった**（ビルド済み `index.html`
  のスタイルから計算して実測・第 261 回）。WCAG 1.4.3 は本文サイズの文字に **4.5:1 以上**を
  要求する（この画面で 11.5 〜 14 px の語はすべて該当 –
  https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html）。
  半透明の背景（`rgba(…, 0.06)`）は後ろの色と合成したうえで数えた。実測した不合格:

  | 色の組 | 実測 |
  | --- | --- |
  | 「主題が合う」の緑（`.tag.match`）**ダークモード** | **2.65** |
  | 「推定」の茶（`.tag.est`）ライト | 4.01 |
  | 「主題が合う」の緑 ライト | 4.26 |
  | 「過ぎました」のタグ（`.tag.past`）ライト | 4.29 |

  - 根本原因は 2 つ。**緑（`#0f7a55`）を 3 か所（`.tag.match`・`.reason-chip em`・
    `.perline-venue`）に写し書いていて、暗い画面用の指定が無かった**（同じ緑を暗い背景に
    載せると 2.25 まで落ちる – 改ざんで実測）。**茶は薄い背景を想定した深さになっていなかった**。
  - 直し方: 主題の色として `--ok` を 1 本足した（ライト `#0d6e4c` / ダーク `#7fd6a8`）し、
    書き写していた 3 か所をそこに寄せる。「まもなく」の茶は `#9a6700 → #8a5c00` に寄せる
    （薄い背景の上で 4.01 → 4.79、表の本文 `まもなく締切` は 4.87 → 5.81 に上がる）。
    `.tag.past` の薄い色は `rgba(120,120,120,0.08) → 0.02`（4.29 → 4.59 – 薄い色の濃さが
    コントラストを落としていた）。
  - 検査 `tests/color_contrast.test.ts`（2 本）: ビルド後のスタイルから `:root` と
    ダークモードの `:root` を読み、`var()` を解決して **合成後の背景**との比を出す。
    タグ 4 種別 × 2 主題 + 主題色の総当たり（6 色 × 3 背景 × 2 主題）+ 背景を自分で持たない
    規則（理由チップの語・内訳行の投稿先）= 52 組以上を読んで 4.5 以上を見る
    （読んだ組数が基準未満なら失敗 – 空振り防止）。2 本目は `rgba` を合成して数えていること自体を見る。
    改ざん 4 通りの実測: 暗い画面用の緑を決めない形に戻す（2.25）/ 茶を元の色に戻す（4.01）/
    「過ぎました」の薄い色を濃く戻す（4.29）/ 規則を画面から消す（「規則が見つからない」で失敗）。
  - 副次的な実発生: `html.match(/<style>([\s\S]*?)<\/style>/g)` は **`g` 付きの `match` が
    捕獲グループを捨てて全体一致だけ返す**（`<style>` の語が残って `:root` が読めない）。
    `matchAll` で中身を集める形にした（第 259 回の入力欄の検査も同じ書き方だったが、
    あちらは規則本文だけを読んでいたため誤作動しなかった）。
- **指で押すには小さい操作対象が並んでいた**（ビルド済み `index.html` のスタイルから実測・第 260 回）。
  上余白 + 下余白 + 文字の高さ + 枠で測った高さ:

  | 操作 | 実測 |
  | --- | --- |
  | 主題の絞り込みボタン（`button.tag`） | **約 17.8 px** |
  | チェック欄（`label.check` – 過去の締切も表示 ほか 4 つ） | **約 19.7 px** |
  | 入力の例（`.sample-btn`） | 約 24.4 px |
  | 入力の presets（`.preset-btn`） | 約 25 px |
  | 「条件をすべて外す」（`.btn-reset`） | 約 29.4 px |
  | 分野チップ（`.chips label`） | 約 29.2 px |
  | 並び替え・表示切替のボタン | 約 33.7 / 34.3 px |

  下から 2 つは **WCAG 2.5.8（target size minimum – 24 × 24 CSS px）に届かない**
  （https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html）。
  - 直し方: `@media (hover: none), (pointer: coarse)` の中に 8 対象の `min-height: 44px` を足した
    （Apple の Human Interface Guidelines の 44 pt に合わせた）。**幅ではなく操作手段で分ける**
    ので、パソコンの窓を狭くした人は従来どおりの見た目のまま（第 85 回と同じ判断）。
    表の中に並ぶ情報チップ（`.tag` のうち `<button>` でないもの）は押せない ので広げていない。
  - 検査 `tests/touch_target_size.test.ts`（2 本）: 操作手段の块の中で、対象ごとに
    **付いた規則の一番大きい高さ**が 44 px 以上を見る（見た目だけの規則を見て
    「高さ未指定」と誤らない – 実発生）。読んだ対象が 8 に満たなければ失敗（空振り防止）。
    2 本目は **块の外（＝パソコンも含む既定）に 44 px を置かない**ことを見る。
    改ざん 4 通りの実測: 高さを消す / 44 → 30 px に落とす / 対象を 1 つ減らす /
    块の外に移す（パソコンが太る側も落ちる）– すべて該当検査が落ちる。
  - ビルド済みスタイルの読み取りで気づいた副次的な事実: `:root` に `font-size` が無く
    基準 16 px のまま（第 259 回の入力欄の検査も同じ前提に立っている）。
- **電話で検索欄を押すと、画面が勝手に拡大していた**（ビルド済み `index.html` のスタイルを
  読み取って実測・第 259 回）。iOS の Safari は **文字の大きさが 16 px 未満の入力欄**に焦点が
  当たると画面を自動拡大する（拡大すると表が画面外に消え、戻す操作が増える）。
  実際の指定は検索欄・テキスト欄が `0.88rem` = **14.08 px**、セレクト（種別・等級など）と
  文章欄（論文の概要）が `0.85rem` = **13.6 px** で、4 つすべて 16 px 未満（`:root` に `font-size` が
  ないので基準 16 px のまま、という前提も検査で固定した）。
  - 直し方: 入力欄 3 種の `font-size` を `1rem`（16 px）に上げた。**`viewport` に
    `maximum-scale` や `user-scalable=no` を足して拡大そのものを止める手は使わない**
    （拡大したい人の操作も奪う – WCAG 1.4.4）。画面には拡大制限が無いことも検査で見る。
  - 根拠: https://github.com/saadeghi/daisyui/issues/3871 ・
    https://github.com/heroui-inc/heroui/issues/5326
  - 検査 `tests/mobile_input_zoom.test.ts`: ビルド後のスタイルから入力欄に直接付いた
    `font-size` を読み、`rem` / `px` を px に直して 16 px 以上を見る。
    **セレクタが画面から消えても落ちる**形（読んだ件数が 4 件未満なら失敗）にして、
    空振りを防ぐ。改ざん 5 通りの実測: 検索欄を 0.88rem に戻す / セレクトを 0.85rem に戻す /
    文章欄を 0.85rem に戻す / viewport に `maximum-scale` を足す / セレクタを画面に無い名前に
    変える – すべて該当検査が落ちる。
  - 同じ画面には 640 px 未満で行をカードにするレイアウトが既にある（第 90 回ころ）。
    今回の欠けはレイアウトではなく**入力欄の文字の大きさ**で、狭い画面用の块には
    `font-size` が無かった。
- **検索 1 打鍵の半分以上が、同じ行を何度も畳み直す作業だった**（2026-08-09 生成ビルド・候補行
  3,253 行 / 210 万字で実測・第 258 回）。検索の述語は行ごとに `kanaFold(hay)`（全角・半角・
  仮名のゆらぎを寄せる）を掛け、語ごとの件数（`queryTermCounts`）は**語 1 つぶんずつ表を
  読み直して**いた。内訳:
  - 行の畳み込み 1 走 **13.6 ms**（検索 1 走 31 ms の内訳）＋ 語ごとの件数 **93 ms**
    （`ネットワーク 福岡`）・**124 ms**（`量子 計算 学会`） – 検索そのものの 3〜4 倍。
  - 1 打鍵で表 1 回ぶん（4 MB）の文字列を組み直して捨てていたので、検索欄 1 打鍵 83 ms の
    大半がこれ。**語を並べて打つ人ほど重かった**（1 語なら 31 ms、3 語なら 124 ms）。
  - 直し方: 畳み込みは入力の文字列だけで決まる純粋な関数なので、**畳んだ結果を憶える**
    （`kanaFold` の側に保持。上限 12,000 件で、越えたら捨てて組み直す）。語ごとの件数は
    第 257 回と同じ形で表を 1 回だけ読むようにした。実測: 検索 1 走 31.2 → **0.8 ms**、
    語ごとの件数 93.7 → **4.0 ms**・123.7 → 4.3 ms、打ち直しの見当 61.9 → 23.0 ms。
    調べた 16 調べ（件数 11 語 + 当たり行数 5 語）で**結果は変更前と完全に同一**。
  - 鍵は生文字列（`null` と `"null"` は別物 – 文字列以外は憶えない）。上限を越えた後も
    数が変わらないことを 13,000 行の合成収録で見た。絶対時間は機械の負荷で化けるので、
    検査は**同じビルドの中の初回と 2 回目の比**で見た（実測 20 倍超、下限 3 倍）。
    改ざん 4 通り（憶えない / 文字列以外も同じ鍵 / 小仮名の折り込みを落とす / 上限 0 件）
    すべてで該当検査が落ちることを実測（`tests/search_fold_cache.test.ts` 5 本）。
  - 畳み込みの「今」も同じ検査に書き留めた（全角英字・半角仮名・大きい仮名と小さい仮名・
    促音はツに折る – `セショ` では `セッション` に当たらない）。
- **打ち直しの見当を数える処理が、0 件の画面で 1 打鍵 0.6 秒固まっていた**（2026-08-09 生成ビルド・
  候補行 3,275 行 / 210 万字で実測・第 257 回）。第 256 回で足した `shorterHitWordsJa` は、
  見当の語ごとに `searchMatcher` を作って表を読み直していた。検索の述語は行ごとに
  `kanaFold(hay)`（全角・半角・仮名のゆらぎを寄せる）を掛けるので、**行の畳み込みが見当の語の
  数だけ走り**、`分散並列処理基盤システム` 1 語で **628 ms**、`高速計算` 155 ms、`GPU` 97 ms
  （この画面は検索 1 打鍵 83 ms をころうとする – 収録に無い語を打った人だけが固まる形）。
  - 直し方: 行の畳み込みを 1 回にまとめてから、見当の語を順に当てる（同じ表を 1 回読む）。
    述語の組み立ては `searchMatcher` から `searchGroups` に抜き出して**両者で共有**した
    （同じ述べ方を 2 か所に持つと必ず片方が古くなる – 第 215 回などと同じ判断）。
    実測: 628 ms → **63 ms**、155 ms → 37 ms、97 ms → 38 ms（結果は 8 語すべてで完全に同一）。
  - 検査は絶対時間を数えない（機械の負荷で化ける）。**表の行を読んだ回数**を `Proxy` で数えて
    2 回分以内に押さえ、昔の形に戻ると必ず越える形で見た。加えてビルド済みの関数本体を見て、
    見当が `searchMatcher` を呼ばないこと・`searchGroups` を共有していることを検める。
  - 畳み込みを省略すると全角表記の行が数えられず、同じ画面の検索と見当の件数が食い違う
    （`ＡＩ 国際会議` の行は畳み込みを通してだけ `AI` に当たる）。合成の収録でそれを実測し、
    「表を畳まない」改ざんがその検査で落ちることを確かめた。
  - **ハーネスの穴（第 256 回の実発生と同じ）**: recommender に共有部品を 1 本足すと、関数を
    名前で注入している検査ハーネス（`tests/built_golden_shared.ts` の `FILTER_RUNTIME_STUBS`）は
    その部品を知らず、古い形で述語を組み立てようとして **14 本の検査が落ちた**
    （`searchGroups is not defined`）。注入リストに `searchGroups` を足して直した。
    音もなく古くなるよりマシだが、共有部品を増やすときは注入リストも同じ変更で足す。
- **0 件の案内が、効かない打ち直しを全員の共通の助言として出していた**（2026-08-09 生成ビルド・固定時刻
  2026-08-09T00:00:00Z で実測・第 256 回）。研究者が打ちそうな言い方 93 語を試すと **47 語が 0 行**で、
  案内はどれにも同じ「検索語を短くする（分野名・主題・開催地の日本語でも引けます）」を出していた。
  その語を短くした形が収録に無ければ、指示どおりに打ち直しても 0 行のまま画面が動かない
  （`高速計算` を短くした `高速計` `速計算` はいずれも 0 行、`博士前期` `GPU` `採択率` も同じ）。
  - 直し方: 0 件の画面で**収録の上打ち直しの見当を数える**（`Recommender.shorterHitWordsJa`）。
    見る形は 3 通り – 語を 1 つに絞る（`ネットワーク 福岡 GPU` → `ネットワーク` 267 件）、
    続きを落とす・前を落とす（`生成AI` → `AI` 1,083 件、`高速計算` → `計算` 307 件、
    `査読付き` → `査読` 32 件）、2 語に割る（`学生論文` → `学生 論文`）。**割った組みの数は
    両方を書く行数**を使う（`学生` 1 行・`論文` 2 行でも、両方は 1 行 – 打ち直した人に見えるのは 1 行）。
  - 見当が無いときは「検索語を短くする」を出さず、「別の語で試す」に切り替える（効かない指示を
    並べない）。見当があるときは一般的な助言を伏せ、名指しした語と件数だけを出す。
  - 当たっている語は短縮の見当に出さない（`ネットワーク 福岡 GPU` に `ネットワー` を勧めていた –
    「その語を外すと増えます」と同時に立つと打ち直しの方針が二つになる。実発生）。
  - 見本は**打たれた形**で出す（`生成AI` に `ai` と出すと、読み手はそのまま打てない）。数え上げは
    展開済みの語で、見本は元の文字で、と役割を分けた。展開済みの文字列を渡す形にすると化けるので、
    展開は `shorterHitWordsJa` の内側でやる。
  - 読み上げ（`zeroResultLiveNote`）も同じ判断で、「語「生成AI」は収録データにありません」の前に
    「『生成AI』は無くて『AI』なら 1,083 件当たります」を出す。aria-live は 60 字までなので、
    収まらない語（`分散並列処理基盤システム` など）では短い形に落ちることを検査で見る。
  - 数え上げの集合は語ごとの件数（`queryTermCounts`）と同じ **候補行 + 常時受付のジャーナル行**。
    0 件のときだけ数える（通常描画では走らせない）。
  - 検査: `tests/zero_result_recovery.test.ts`（7 本）。改ざん 6 通りで落ちることを実測 –
    見当を常に出さない / 当たっている語も短くする / 割った組みの数を一方の語だけで数える /
    見本を小文字に折る / 見当を件数順に並べ替える / 効かないときも「短くする」を出す。
    いずれも該当検査が落ちる（1〜3 本）。
  - 「1 ファイルに全検査を並べない」の続き: 0 件案内のハーネス（`deadlineHintFunction`）は
    `emptyDeadlineHint` が必要する語だけを注入して組み立てる。モジュールレベルの新しい関数を
    呼ぶ形にすると、そのハーネスで `shorterHitTipsJa is not defined` になった（実発生 –
    案内の内側で組む形にして解決）。
- **`秋`・`春`・`夏`・`冬` と打つと 0 行で、案内も無かった**（2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測・第 254 回）。「秋の学会に出したい」は分野をまたいだ計画の言い方。

  | 打ち方 | 直す前 | 直したあと | 独立に作った期待値 |
  | --- | --- | --- | --- |
  | `秋` | 0 行 | 802 行 | 802（2026年9〜11月） |
  | `秋の会議` | 0 行 | 802 行 | 802 |
  | `春` | 0 行 | 335 行 | 335（2027年3〜5月） |
  | `夏` | 0 行 | 278 行 | 278（2026年8月だけ） |
  | `冬` | 0 行 | 418 行 | 418（2026年12月 + 2027年1・2月） |
  | `来年の秋` | 0 行 | 34 行 | 34（2027年9〜11月） |
  | `セキュリティ 秋` | 0 行 | 119 行 | 119 |

  - 月の範囲（第 252 回）と同じ暦月語 `YYYY年M月` の OR グループへ展開する。区切りは気象月の四つ組み
    （春 3〜5・夏 6〜8・秋 9〜11・冬 12〜2）。締切名に「秋開催」のような表記は無いので、季節の語は表に書かれていない語として扱う。
  - **季節の途中ならこれから来る月だけ**出す（8 月に `夏` を打って 7 月の締切を出さない）。単月語が
    「基準月より前なら来年」と扱うのと同じ方向。`冬` は年を跨ぐので、12 月に打ったときと 1・2 月に打ったときで終了年が変わる（時計を 3 つ動かして検査）。
  - **年を冠で書いたら繰り上げない**（`来年の秋` = 2027年9〜11月・`去年の秋` = 2025年9〜11月）。
    ただし `来年の秋` は `queryTokens` が助詞で「来年」「秋」に割るため、そのままだと
    「2027 年のどこか」×「2026年9〜11月」のかけ算になり、**噓の 245 行**が出ていた（実測）。
    `mergeSeasonTokens` で 1 まとめの語に寄せる（第 249 回で助詞の対応ずれを直したときと同じ系列）。
  - `splitQueryToken` は 1 文字の語を割ることを嫌う（ひらがな地名を守るため – `ながさき` が `な`+`さき` に割れた実測がある）。
    季節の語は 1 文字なので、**語彙表に有る語だけ**長さの検査を通す（`秋田` は割れない。`ながさき`・`やまぐち` の寄せはそのまま）。
  - 展開した範囲は件数欄に出す（伏せた範囲指定は誤信を生む – 同じ画面の約束）。`秋 = 2026年9月から2026年11月`。
  - 既存の言い方を変えていないことを実測で確認した: 68 語（相対日・相対週・相対年・相対月・月の範囲・場所・主題・記号・評価・期間の語）で前後の行数が同じで、変わったのは意図した 7 語だけ。
  - 検査: 単位 1 本（展開表・季節の途中・年跨ぎ・時計 3 種・年の冠・negative）とビルド済みデータに対する 1 本
    （期待値は行が持つ暦月語から独立に作り、行数と中身の両方が一致を見る。助詞で繋いだ形と空白で並べた形が同じ行に出ることも同じ検査で見る）。
    改ざんで落ちることを 6 通り実測: 季節の途中の扱いを外す / 1 文字の語を通さない / 年の冠を寄せない /
    季節の展開そのものを外す / 年跨ぎの終了年を間違える / 年の語と季節の語を結ぶ線を外す。
  - 抜き出しハーネスに季節の部品（`SEASON_*` の定義と 6 関数）を注入した。`tests/build_golden.test.ts` は **1,048,272 バイト**で
    biome が読み飛ばす 1 MiB まで **304 バイト**。次の追記の前には分割が要る（この検査ファイルは 351 本・1 テスト 2.7 秒で、
    並列実行時に 1 本がタイムアウトで落ちることも実測 – 分割すべき理由がもう 1 つ増えた）。

- **プロモーションの判定が実行時の時計で化けていた**（第 254 回・`src/promotion.ts`）。`writePromotionBatch` が
  `options.now` を個々の判定（`resolvePromotion` / `resolvePromotionAgainst`）へ引き継いでいなかったため、
  同じ入力でも日付が過ぎれば promote → hold へ変わる。バッチの判定は `--now` で再現できるべきという
  ビルドと同じ約束が守れていなかった。
  - 実測: 2026-09-24 に `tests/promotion.test.ts` の 13 件が落ちた（fixture の締切 2026-09・2026-10 が過去になった）。
    fixture の日付を動かすのでなく、**判定に時刻を渡す**方を直した（検査側は収集時刻の直後に固定）。
  - `scripts/promote-candidates.ts` に `--now` を追加（`build --now` と同じ形）。不正な値は他の選択肢と同じ `optionError` の形で exit 2。
  - 検査: システム時計を 2028-05-05 へ動かして `promote` のままであることを見る検査を 1 本足した（引き継ぎを 1 か所でも忘れると戻る）。
    改ざんで落ちることを 3 通り実測: 判定への引き継ぎを外す / `--now` を知らない選択肢にする / 検査側の既定時計を外す。

- **`1か月以内`・`1週間以内`・`3日以内` と打つと 0 行で、案内も無かった**（2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測・第 253 回）。締切の切り出しでいちばん言う言い方だった。

  | 打ち方 | 直す前 | 直したあと |
  | --- | --- | --- |
  | `3日以内` `7日以内` `1週間以内` `2週間以内` `1か月以内` `3ヶ月以内` `90日以内` `180日以内` `1年以内` | 0 行・案内なし | 0 行のまま。ただし 0 件案内と読み上げが「締切まで」の選択欄の該当する選択肢を言う |
  | `1か月以内` の案内 | 「語「1か月以内」は収録データにありません」+「検索語を短くする」 | 「締切まで」の選択欄で「30 日以内」を選ぶと同じ話です（締切日で数え、会期では数えません） |

  - **暦日のグループへ展開するのはやめた**（当初の案）。表の暦日語は締切日だけじゃなく会期の日時も含む
    （実測: `2026年8月30日` に当たる 14 行のうち締切がその日の行は 0 行・`2026年8月9日` は 18 行中 1 行）。
    「3 日以内に締切がある行」のつもりで、会期が 3 日以内の行が大量に混じる – 第 236 回で
    「暦日で引く以上、会期がその日の行も当たる」と書いた前提が、範囲の語では裏目にする。
    画面には既に締切日からの日数で絞る「締切まで」（7・30・90・180 日以内）があるので、**そこへ連れていく**のが正直な直し方。
  - 行き先は選択肢に**実在する語だけ**を出す（`dayRangeWindowJa` が `[値, ラベル, same|near|cap]` を返す）。
    3・2 週間のように選択肢に無い長さは「いちばん近いのは 7 日以内」と言い、1 年超は「いちばん長いのは 180 日以内」と上限を言う。
    検査はビルド済み `index.html` の `<select id="win">` の `<option>` を読んで、**案内が行く手を挙げた語が本当に選択肢に有るか**を見る
    （画面に無い値を案内するのは別の噓になる – 改ざんで `15 日以内` を足すと落ちる）。
  - 同じ語列表を画面（`emptyDeadlineHint`）と読み上げ（`zeroResultLiveNote`）で共用し、読み上げは 60 文字以内に収めた（実測の最長 48）。
  - 「語を外すと増えます」「検索語を短くする」を**同時に立てない**。`1か月以内` は termCounts で 0 件になるので、
    放置すると「収録データにも見当たりません」という直らない助言が同じ画面に並ぶ（改ざんで結線を外すとその文に戻る）。
  - `9月` `明日` `3ヶ月から` `0日以内` `以内` など、行き先がちがう語には案内を出さない（単位検査で negative を見る）。
  - 検査: 単位 1 本（対応表・選択肢に無い長さ・上限・全角数字・negative・読み上げの長さ）とビルド済み検査 1 本。
    改ざんで落ちることを 5 通り実測: 案内を消す / 画面側の結線だけ外す（「検索語を短くする」に戻る） /
    選択肢に無い `15 日以内` を行き先にする / 読み上げを 60 文字超に伸ばす / 語の形を見ない照合にして `9月` を巻き込む。
  - 抜き出しハーネスの注（再発防止）: 新しい正本関数を `emptyDeadlineHint` や `zeroResultLiveNote` から呼ぶと、
    `tests/runtime_extract.ts` と `tests/build_golden.test.ts` の `const Recommender = { … }` スタブに名前を足さないと
    `Recommender.dayRangeNoteJa is not a function` になる（今回 8 か所）。また抜く関数は独立していなければならない –
    `searchNormalize` を呼ぶ形で抜いたら `ReferenceError` になったので、NFKC をその関数の中で行うようにした。
  - `tests/build_golden.test.ts` は **1,047,999 バイト**（biome が読み飛ばす 1 MiB まで **577 バイト**）。
    今回の追記で 1,048,182 まで行ったため、自分が足したコメントを詰めて戻した。**分割がまだ残っている**。

- **月の範囲の言い方（`9月以降`・`9月から11月`）で 0 行だった**（2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測・第 252 回）。
  研究計画や出張の相談では「期間」で言うのに、画面は単月の語しか受け付けていなかった。

  | 打ち方 | 直す前 | 直したあと | 独立に作った期待値 |
  | --- | --- | --- | --- |
  | `9月` | 687 行 | 687 行 | （変えていない） |
  | `9月以降` | **0 行** | 957 行 | 2026年9〜12月 = 957 行 |
  | `9月から` | **0 行** | 957 行 | 同じ |
  | `9月から11月` | **0 行** | 802 行 | 2026年9〜11月 = 802 行 |
  | `8月から12月` | **0 行** | 1,093 行 | 2026年8〜12月 = 1,093 行 |
  | `11月から2月` | **0 行** | 680 行 | 2026年11・12月 + 2027年1・2月 = 680 行 |
  | `来月以降` | **0 行** | 957 行 | 2026年9〜12月 = 957 行 |
  | `来年9月以降` | **0 行** | 36 行 | 2027年9〜12月 = 36 行 |
  | `9月以降 セキュリティ` | **0 行** | 148 行 | （9〜12月の行）∩（セキュリティ）= 148 行 |

  - 直し方: 表に出る暦月語（`monthTermsJa` が hay に入れる `2026年9月` の形）の **OR グループ**
    へ展開する。週の語（7 暦日の OR）・年の語（12 か月の OR）と同じ仕組みで、語同士は AND
    なので空白で並べて作れるものではない。展開できたときは元の語を組に残さない – 表に無い語を
    残すと当たり方を狭めるだけになる（時刻の語と同じ扱い）。
  - **「以降」のレンジは暦年の終わりまで**と決めた。上限をなくすと収録の何年先まで出すか
    を画面が言えなくなるためで、代わりに**件数欄へ出した範囲そのものを書く**
    （「9月以降 = 2026年9月から2026年12月」）。伏せた範囲指定は誤信を生むという同じ画面の
    約束に従っている。範囲の組は recommender 側が持つ（`monthRangePairs`）。
  - **基準月より前の月を打たれたら翌年として受ける**（8 月に `1月以降` と打つ人は翌年 1 月を
    見ている）。年の冠（`来年9月以降`）があるときは繰り上げない – 年を言っているため。
    どちらも件数欄に出る範囲で検証できる。
  - 既存の言い方を変えていないことを実測で確認した: 69 語（相対日・相対週・相対年・相対月・
    場所・主題・記号・評価）で前後の行数が同じで、変わったのは意図した `9月以降 セキュリティ`
    だけ。`3ヶ月から` `研究から` `13月以降` `0月から1月` は展開しない（月の語ではない）ことを
    単位検査で見る。
  - 検査: 単位 1 本（展開される暦月語の一覧・年跨ぎ・冠・範囲を作らない語・案内の組）と
    ビルド済みデータに対する 1 本（期待値は行が持つ暦月語から独立に作り、**行数と中身の
    両方**が一致ことを見る。他の語とのかけ算、単月との上下関係、ビルド済み `app.js` が
    案内の部品を使っていることも同じ検査で見る）。改ざんで落ちることを 4 通り実測:
    「以降」を 1 か月に縮める / 展開の掛け金を外す / 翌年へ繰らない / 案内の組を作らない。
  - `tests/build_golden.test.ts` は **1,047,966 バイト**になり、biome が読み飛ばす 1 MiB
    （1,048,576 バイト）まで **610 バイト**しかない（`tests/lint_budget.test.ts` が守っている）。
    次の追記の前には分割が必要 – **次回の候補**。

- **`来月の締切` と打つと 0 行だった**（2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測・第 251 回）。
  研究計画の立て方でいちばん言う形が、いちばん踏む穴になっていた。

  | 打ち方 | 直す前 | 直したあと |
  | --- | --- | --- |
  | `来月` | 343 行 | 343 行 |
  | `来月 セキュリティ` | 41 行 | 41 行 |
  | `来月の締切` | **0 行** | 286 行 |
  | `来月の論文締切` | **0 行** | 185 行 |
  | `今月の会議` | **0 行** | 278 行 |
  | `再来月の国内研究会` | **0 行** | 9 行 |
  | `先月の締切` | **0 行** | 199 行 |
  | `来月中の締切` | **0 行** | 286 行 |

  - 原因: 相対月を `YYYY年M月` へ展開する `expandRelativeMonths` が**空白で区切られた語しか
    見ていなかった**。日本語は助詞のまわりに空白を書かないので `来月の締切` は 1 語のまま
    展開を通り越し、あとで助詞から割られた `来月` は暦月へ解決されない語として残った。
    年の語・週の語・日の語は検索語の組を作る側で解決されていて、相対月だけが別経路だった。
  - 直し方は 2 箇所。① 展開の側を助詞で割った語に通す。ただし**相対月を含まない語は
    打たれた形のまま**返す（件数欄が「検索語『X』」にその形を書くので、利用者の入力と違う
    文字列にしない – `セキュリティの会議` はそのまま）。② 検索語の組を作る `queryTokenGroups`
    でも同じ解決をする（年・週・日と同じ場所）。これで展開を呼ばずに照合する経路も含めて
    当たり方が揃う。既存の 66 語（相対日・相対週・相対年・場所・主題・記号まわり）で
    前後の行数が変わらないことを実測で確認した。
  - **件数欄の「打った語 = 解決した西暦月」が、助詞の形で対応のずれた文を出していた**
    （`来月の締切` → 「来月の締切 = 2026年9月」）。展開前後を番号で突き合わせていたためで、
    1 語が 2 語に展開されると組がずれる。解決の内側で組を持つ `relativeMonthPairs` を
    recommender に作り、画面はそれを見るようにした。てびきの「件数欄に展開結果を出す」という
    約束が、助詞で繋がれた形では守られていなかった。
  - **計測の層を間違えて一時に違う報告をしそうになった**（記録として残す）。画面の検索は
    `expandRelativeMonths` を通してから照合するので、`searchMatcher` だけを呼ぶ測定では
    `来月` が 0 行に見えた（実際の画面は 343 行）。今回の行数はすべて画面と同じ経路
    （展開 → 照合）で測り直した。
  - 検査: 単位検査 2 本（展開の文字列と、件数欄に出す組）とビルド済みデータに対する検査
    1 本（助詞で繋いだ形と空白で区いた形が**同じ行数**になること、検索語の組に暦月が
    出ることを両方見る）。既有の画面検査 2 本を新しい引き数に合わせた。改ざんで落ちることを
    4 通り実測: 助詞で割るのをやめる / 検索語の組側の解決を消す / ずれた暦月へ展開する /
    番号で突き合わせる作り方に戻す（`来月の締切 = 2026年10月` という誤読をだす）。

- **言い換えの寄せ先が地域まとめの見出しのときだけ、0 行のままだった**（2026-08-09 生成ビルドで実測・第 250 回）。
  第 249 回に `米国開催` を載せられなかった原因はこれだった。`米国` は 787 行に当たるが、
  行のなかに「米国」の表記は 1 つも無く（`data.json` で 0 件）、地域まとめの展開が効いて
  初めて当たる語。ところが検索語の組を作る hop 合成が**地域まとめの見出しで止まっていた**
  （`アジア` → `中国` → 都道府県と連鎖して組が膨らむのを防ぐため – 2026-09-23 の実測で
  アジアが 523 → 526 行に広がって既定が壊れた件）。そのため、言い換えた語 `米国` が
  見出しのときだけ 0 行のままで、件数欄だけが「探しています」と噓を言っていた。

  - hop を進めるのは**打ち込まれた語が見出しでないときだけ**にした（見出しの止め方は
    そのまま）。`米国開催` `アメリカ開催` `米国向け` は 0 行 → **787 行**（`米国` と同じ行数）に
    なった。**言い換え表の語とよく打ちそうな語を合わせた 92 語について前後の行数を突き合わせ、変わったのはこの 3 語だけ**
    であることを実測で確認した（見出しの展開 `アジア` 523 / `欧州` 1008 / `中国` 236 /
    `九州` 9 / `関西` 28 はそのままだ）。
  - 「『アジア』に国内の行は入らない」という既定が今も守れていることを検査に書いた。
    見出しの止め方を外す改ざんをすると、`アジア` の展開に国内研究会の行が 2 件混ざる
    （実測）ので検査が落ちる。
  - **「分野の言い方は、画面に出る語だけを指す」検査の並べ先を 1 つ増やした**（第 249 回に
    行の表記を認めたのに続く）。行にそのままは出ないが、**サイトが行の開催地の読みとして
    持つ見出し語**（`PLACE_READINGS` `REGION_READINGS` `CONTINENT_READINGS` の見出し）も
    寄せ先にできる。`米国` はこれで通る。一覧はビルド後の成果物から読み、読めなければ
    検査が空洞になる（長さが 2,000 字未満なら失敗）。
    - 展開語を行にも見出しにも無い語（`まだない寄せ先`）に替える改ざんは落ちることを実測。
  - 検査を 1 本足した（2,017 件 / 35 ファイル）。改ざんで落ちることを 4 通り実測:
    hop の例外を消す / `米国開催` の条目を消す / 打ち込まれた見出しでも hop を進める /
    展開語を画面に出る語ではない語に替える。

- **参加形式の「対面」側と「国内開催」を打った人に、画面が何も言わなかった**（2026-08-09 生成ビルドで実測・第 249 回）。
  `対面` `対面開催` `オフライン` `オンサイト` `現地` `現地開催` `リアル` `リアル開催`、
  および `国内開催` `国内会議` `日本開催` `国内向け` の 12 語が 0 行で、案内も読み上げも空だった。

  - **対面側は収録していない事実として言った**（`UI_WORD_GROUPS_JA` の組を 1 つ増やした）。
    `対面` はビルド後の `data.json` に **1 度も現れない**（実測 0 件）ので、「対面かどうかは
    収録していません」が正しい。参加形式の印は『オンライン参加可』だけを出していて、
    オンライン側（`ハイブリッド` `リモート` `遠隔` `ウェブ開催` など）は
    `QUERY_SYNONYMS_JA` で『オンライン参加可』に寄せるので、そちらは行が出る（121 行）。
    読み上げは短い形で言い、**最長 59 字**（8 語を実測、上限 60 字）。
    - `仮想` は寄せも案内もしない – 「仮想マシン」等の会議名に当たって行をよけいに出す
      （第 246 回の `virtual` と同じ理由）。
  - **`国内開催` 系は行に出会わせた**（`QUERY_SYNONYMS_JA` に 4 語を寄せた）。実測: 4 語とも
    0 行で、`国内` は **46 行**に当たった（行は「国内研究会」等の表記を持つ）。寄せたことで
    4 語とも 46 行に出会えるようになり、件数欄は「『国内』のつく行（国内研究会・国内
    シンポジウム）で探しています」と言う。
    - **`米国開催` は載せない**（実測してやめた）。`米国` は 787 行に当たるが、行のなかに
      「米国」の表記は 1 つも無く（`data.json` で 0 件）、国名の別名展開が効いて初めて
      当たる語だった。展開語に `["米国"]` と書くと 0 行のままで、案内だけが「探しています」
      と噓を言う（実際に足して 0 行になるのを見た）。国名の別名展開の内側でさらに開く
      別な仕組みが要る – **次回の候補**（→ 第 250 回で hop を直して載せた）。
  - **「分野の言い方は、画面に出る語だけを指す」検査の並べ先を広げた**（第 249 回）。
    これまで展開語は欄の選択肢の語（分野名・締切種別・主題タグ・参加形式・評価なし）に
    限られていたため、`国内` のように**行の表記に実在する語**を寄せ先にできなかった。
    ビルド後の行の文字列（`catalog.json` から `candidateRows` を呼んだ `hay`）に実在する表記も
    認めることにした。
    - **最初はビルド成果物のテキスト（recommender.js 自身）で買って検査を空洞にした**
      （展開語を `もともとの表記` に変える改ざんが exit 0 になった – 実測）。書き足した語は
      成果物にも出るため当然で、**行の文字列で見る**ように直して改ざんが落ちることを確認した。
  - 検査を 2 本足した（2,016 件 / 35 ファイル）。改ざんで落ちることを 5 通り実測:
    「収録していません」を消す / 対面組から語を落とす / `国内開催` の寄せを消す /
    行に出ない `米国` へ寄せる（噓の案内）/ 展開語を行に無い語に変える
    → いずれも落ちることを確認した。

- **画面自身の語を打った人に、画面が行き先を言わなかった**（2026-08-09 生成ビルドで実測・第 248 回）。
  `使い方` `ヘルプ` `てびき` `つかいかた` `みかた` `確定` `並び替え` `並び順` `絞り込み` `フィルタ`
  `条件` `出典` `一次情報` `データ源` `カテゴリ` `カテゴリー` `ラベル` `フィールド` の 18 語が
  いずれも 0 行で、画面は「語「X」は収録データにありません」としか出さず、打ち直し方は
  「検索語を短くする」だけだった（短くしても増えない語なので、これでは直らない）。

  - 行き先を名指す案内を `UI_WORD_GROUPS_JA`（`site/recommender.ts`）に一本化し、0 件案内
    （`emptyDeadlineHint`）と読み上げ（`zeroResultLiveNote`）が同じ表を向くようにした。言う先は
    画面に実在する語だけ – 『見方のてびき』（`使い方` 系と `確定`。`使い方` という語は画面に
    1 度も出ないので、てびき以外の行き先を持たせない）/ 上にある欄（『並び順』『種別』『ランク』
    『締切まで』『条件クリア』）（`並び替え` 系）/ 『データ源』（`出典` 系）/ 『分野』『種別』
    『参加形式』（欄の名前を打たれた人）。**案内が名指す語がビルド済み HTML に実在すること**を
    検査が見る（行先も存在しない場所へ送れた）。
  - `一覧` `一覧表` `締切一覧` は「表その物を指す語」（`WHOLE_TABLE_QUERY_JA`）に回した
    （第 245 回の `会議` と同じ – 表を見ている人が「一覧が見たい」と打つ語で、絞り込みにならない）。
    実測: `一覧` `一覧表` `締切一覧` はいずれも 0 行、`一覧 セキュリティ` は 0 行 → 529 行になった。
    `リスト`（1 行に本当に当たる）と `表`（64 行に当たる）は載せない – 絞れる語を「絞れません」と
    言わないため。
  - `カテゴリ` `カテゴリー` `フィルタ` は**打たれた語としてだけ受け入れ、案内には書き返さない**。
    「説明文に開発用語を残さない」検査は禁止語をビルド後の文字列リテラル全体から見ていたので、
    これらの語を検索語の別名に載せると必ず当たった（第 244 回で欄の名前の案内を作れなかった理由）。
    検査を二つに分けた – 禁止語のままの語はリテラルに出たら落ちる、別名だけ受け入れる語は
    ①てびき ②ビルド済み HTML の画面に出る部分 ③案内文・読み上げ（正本の語すべて）
    に出ないことを見る。案内が打たれた語を書き返さないことは `quiet` の語で実測（16 語ぶん）。
  - 読み上げは 60 字の上限があるので行き先を短い形で言い、**最長 58 字**（16 語を実測）。

- **0 件の案内が「絞り込みのせい」と言い続けていた**（2026-08-09 生成ビルドで実測・第 247 回）。

  検索語が表に出さない種別（採否通知・カメラレディ締切・登録締切・査読結果公開など）に当たっている
  とき、画面は次の二つの文を並べていた。

  | 画面に出ていた文 | 問題 |
  | --- | --- |
  | 「検索語は『採否通知』の種別に当たります（表には投稿締切だけを出します）」 | 正しい |
  | 「検索語『採択通知』は収録済みで 129 件に当たります（表は投稿締切でこれから先のものだけを出す既定と、**いまの絞り込みで 0 件になっています**）」 | 噓 – 条件をどれを外しても 129 件は表に出ない |

  - 直し方: 種別に当たっているときは、件数の文の後半を行き先に変える（`hiddenKindDeliveryJa` を
    1 箇所に置き、0 件案内と読み上げが同じことを言う）。
    「その種別は表には出しません。条件を変えてもこの 129 件は表には出ず、締切一覧のファイル
    upcoming.md に載せています。」
  - 読み上げ（aria-live）は 60 字までの検査が見ているので、同じことを短い形で言う
    （「（表に出さず upcoming.md）」）。長い文を流さない検査を通る範囲で行先を残した。
  - **案内が種別を名指す規則自体も直した**（実測で二つの事故を確認）。
    - 語の途中での一致（部分一致）を双方向に許可していたため、`〆切`（正規化で `締切`）が
      補足資料締切・カメラレディ締切・登録締切・締切 の**四つ**に当たっていた。`締切 福岡` も同じ。
      → 部分一致は**複数の種別に同時に当たった時点で区別では無い**ので名指さない。
      1 つの種別にしか当たらない語（`通知` → 採否通知、`査読` → 査読結果公開）は従来どおり名指す。
    - 種別 `other` の表示語「締切」は他の種別の語にすっぽり含まれるので、語がその物でも名指さない。
    - `反論` は 反論期間開始・反論期間終了 の二つにまたがるので名指さない（第 246 回で
      `リバットル` を言い換え表に載せなかったのと同じ理屈）。別名として語がその物なら
      （`リバットル` `rebuttal`）二つとも名指す。
  - **第 246 回の言い換えの重複を直した**（正本を一つに戻す）。`HIDDEN_KIND_ALIASES_JA` に
    `採択通知` `合否` `結果通知` `最終稿` `最終原稿` を、`QUERY_SYNONYMS_JA` とは別にもう一度
    書いていた（第 246 回の実過ち）。案内の側も言い換えの正本を上から読むようにし、別名の表には
    画面のラベルに対応語の無い英文（`camera ready`）だけを残した。重複した語を検査で落とす
    （検査機のビルドではなくソースを見る – 正本の重複を防ぐ検査だから）。
  - **第 246 回の記録の訂正**: 「採択通知」など 16 語を寄せて「129 行に出会える」と書いたが、
    会ったのは**照合の内側**だけで、画面は 0 件のままだった（表は既定で投稿締切だけを出すため）。
    実測し直して直す: 表に出る行数ではなく、案内が行先を言うようになったことが今回の成果。
  - 検査を 1 本追加（2,010 → 2,011 件 / 34 ファイル）。改ざん 6 通りで落ちることを実測:
    - 部分一致の「1 つの種別に当たるときだけ」を外す → 「『〆切』で筋の違う種別を名指した:
      expected '補足資料締切,カメラレディ締切,登録締切' to be ””」
    - 他の種別の語に含まれる語を名指す規則を外す → 「『〆切』で筋の違う種別を名指した:
      expected '締切' to be ””」
    - 言い換えの正本を通す塊を外す → 「『採択』が種別『採否通知』を名指さない」
    - 別名の表に言い換えをもう一度書く → 「『登録期限』を言い換えの表と別名の表の二箇所に書いている」
    - 0 件案内に行き先を出さない → 「当たった件数を出していない: … to contain
      'この 129 件は表には出ず'」
    - 読み上げから行先を消す → 「expected ' ｜ 検索語は「採否通知」の種別に当たります。下に外せる
      条件も書いてあります' to contain 'upcoming.md'」
  - 作業中に自分の手で **`site/app.ts` を 0 バイトに切り詰めた**（Python で
    `io.open(path,"w").write(内容)` と書くと、**開いた時点で切り詰められてから**内容の計算が
    走り、計算が失敗すると空のファイルが残る。`git checkout -- site/app.ts` で復旧し、以後は
    内容を計算してから開く + 内容に検査を 3 本通す形にした（ビルドと検査が即座に気づいた）。
  - **次回の候補**（実測済み・未修正）: 種別の選択欄に出るのは「概要締切」「論文締切」「常時受付」の
    三つだけ（`SELECTABLE_KINDS`）。2026-08-09 生成ビルドでは 採否通知 129・カメラレディ締切 70・
    反論期間終了 19・反論期間開始 8・査読結果公開 13・登録締切 7・補足資料締切 2・other 21 の
    **計 269 行**（872 行の 31%）が選択欄から選べない。表に出さない仕様なので検索の 0 件案内と
    てびきが場所を言う状態が続く。

- **種別の言い方を打った人は 0 行に当たっていた**（2026-08-09 生成ビルドで実測・872 行・第 246 回）。

  | 打たれた語 | 直す前 | 直した後 | 寄せ先（種別） |
  | --- | --- | --- | --- |
  | `採択通知` `採択` `採択結果` `結果通知` `合否通知` `受理通知` `合否` | 0 行 | 129 行 | 採否通知 |
  | `最終原稿` `最終稿` `カメラレディ原稿` | 0 行 | 70 行 | カメラレディ締切 |
  | `登録期限` `事前登録` `登録開始` | 0 行 | 7 行 | 登録締切 |
  | `レビュー結果` `審査結果` `査読公開` | 0 行 | 13 行 | 査読結果公開 |

  - 表の種別の欄に出る語（`kindLabelJa` の 採否通知 / カメラレディ締切 / 登録締切 / 査読結果公開）と
    違う言い方で打つ人が多かった。第 242 回と同じ型で、画面に出る語への言い換え表に 16 語を足した。
    件数欄に「『採択通知』は種別『採否通知』で探しています」と出る。
  - **寄せなかった語も実測で決めた**（意味が広がる語を寄せると噓になる）。
    - `最終版` `最終提出` – 提出その物の話で、論文締切（461 行）と混じる。カメラレディ締切（70 行）に
      寄せると「いつまでに提出か」を間違える。
    - `リバットル` – 「反論期間開始」（8 行）と「反論期間終了」の二つの語にまたがる。片方に寄せる訳に
      いかない。`反論`（27 行）・`rebuttal`（28 行）は従来どおり引ける。
    - `採択通知日` – 日付の打ち直しの話で、語のかけ算（`採択通知 12月`）で直せる。
  - 語のかけ算はそのまま効く（実測: `採択通知 2027` 77 行で `採択通知` 129 行より絞れる）。
  - 後退が無いことを実測した（`セキュリティ` 152・`締切` 709・`論文締切` 461・`投稿締切` 461・
    `オンライン参加可` 24・`スパコン` 108・`〆切` 709・`オンライン開催` 24・`査読` 13・`反論` 27・
    `カメラレディ` 70 はいずれも変化なし）。
  - 検査を 1 本追加（2,009 → 2,010 件 / 34 ファイル）。検査機のビルド（固定時計 + 収録の一部）には
    査読結果公開の行が無いので、語の寄せは作った文字列で確かめ、行が有る種別は行レベルでも確かめる
    形にした（行レベルの検査が 1 組も走らなかったら空洞として落ちるようにする）。
    改ざん 4 通りで落ちることを実測:
    - 16 語を消す → 「『採択通知』が『採否通知』に寄せられていない: expected false to be true」
    - 寄せない語（`最終版`）を寄せる → 「『最終版』を寄せている（意味が広がる語）:
      expected '「最終版」は種別「カメラレディ締切」で探しています' to be ''」
    - 寄せ先を種別「論文締切」に変える → 「『採択通知』が『採否通知』に寄せられていない」
    - 寄せ先を画面に出ない語（`採択の案内`）にする → 新しい検査に加えて、長年の検査
      「分野の言い方は、画面に出る語だけを指す」が「採択通知 → 採択の案内 が画面に出る語ではない」で落ちる
  - **次回の候補**（実測済み・未修正）: 種別の選択欄に出るのは 概要締切・論文締切・常時受付 の 3 つだけ
    （`SELECTABLE_KINDS = ["abstract","paper","journal"]`）。採否通知・カメラレディ締切・登録締切・
    査読結果公開は選択欄で選べないので、検索語で打つしかない（今回はそこを導いたが、選択欄の話は
    出していない）。

- **助詞で繋いだ検索語は 0 行だった**（2026-08-09 生成ビルドで実測・872 行・第 245 回）。

  | 検索語（助詞入り） | 直す前 | 直した後 | 比べる語 |
  | --- | --- | --- | --- |
  | `セキュリティの会議` | **0 行** | 152 行 | `セキュリティ` 152 行 |
  | `分散システムの会議` | 0 行 | 259 行 | `分散システム` 259 行 |
  | `スパコンの会議` | 0 行 | 108 行 | `スパコン` 108 行 |
  | `9月の締切` | 0 行 | 209 行 | `9月 締切` 209 行 |
  | `国内の研究会` | 0 行 | 23 行 | `国内研究会` 23 行 |
  | `採否の通知` | 0 行 | 129 行 | `採否通知` 129 行 |
  | `登録の締切` | 0 行 | 7 行 | `登録締切` 7 行 |
  | `せきゅりてぃのかいぎ` | 0 行 | 152 行 | `せきゅりてぃ` 152 行 |

  - 原因は日本語の分かち書きが無かったことではなく、**検索語を空白でしか分けていなかった**こと
    （`queryTokens` は `normalized.split(" ")` だけ）。助詞を挟んだ語は 1 語として扱われ、
    行の文字列にその連結文字列が無いので 0 行になった。
  - 直し方 1: 助詞（`のもへがをやをでには`）を語の区切りとして読む。**分けた語が 2 つ以上で
    2 文字以上のときだけ**採用する – ひらがなの地名は助詞と同じ字を語の中に持っているため、
    無条件で割ると壊れる（実測: `ながさき` は `が` で `な` + `さき` になり、`やまぐち` は `や` が
    抜けて `まぐち` になった。既存の検査「かな入力の地名が、漢字で引ける行を取りこぼさない」が
    実際に落ちてこれを教えた）。片仮名は折らないので `ソフトウェア` の `ト` は平仮名 `と` と違い、
    語を壊さない（実測: `ソフトウェア` 4 行のまま）。
  - 直し方 2: 表の全行にあてはまる語（`会議` `大会` `カンファレンス` と、漢字語の生字
    `かいぎ` `たいかい`）は、**他の語を一緒に打ったときだけ**照合でのく。`会議` は行の文字列に
      1 度も出ない語なので（実測: `会議` 0 行）、要求すると全部 0 行になっていた。
    第 239 回の `WHOLE_TABLE_QUERY_JA` を拡張して 1 本にし、注記側と照合側が同じ列を向くようにした。
    - 部分集合の語は落とさない（実測: `セキュリティのワークショップ` 0 → 19 行で、
      `セキュリティ` 152 行より絞れている。`ワークショップ` 126 行・`シンポジウム` 3 行・
      `学会` 24 行を全行の語にしない）。
    - その語だけを打った人は 0 行のままにして、第 239 回の注記で理由を言う。
    - 照合で落としたときは件数欄に出す: 「『会議』はこの表の全行にあてはまる語なので絞り込みに
      使い、他の語（『セキュリティ』）で探しています」。
  - 後退が無いことを実測で確かめた（`セキュリティ` 152・`締切` 709・`スパコン` 108・
    `オンライン参加可` 24・`論文締切` 461・`〆切` 709・`オンライン開催` 24・`を` 1・`の` 390 は
    いずれも変化なし。ひらがな地名は `きょうと` 2 行・`おきなわ` 4 行のまま）。
  - てびきの検索の項に、助詞の読み方と表じゅうの語の扱いを書いた。
  - 検査を 1 本追加（2,008 → 2,009 件 / 34 ファイル）。改ざん 5 通りで落ちることを実測:
    - 助詞で割る処理を止める → 「『セキュリティの会議』が『セキュリティ』と同じ行に出会えない:
      expected +0 to be 68」
    - 「分けた語が 2 文字以上」の条件を外す → 「『ながさき』を助詞で割った（別々に含む行に
      当たっている）: expected true to be false」
    - 全行の語をのかないようにする → 同じく「『セキュリティの会議』が…同じ行に出会えない」
    - 注記を出さない → 「どう探したかを出していない: expected （空文字列） to contain
      『この表の全行にあてはまる語なので絞り込みに使い』」
    - てびきの文を消す → 「てびきに助詞の読み方を書いていない」
    - **2 番目の改ざんは 1 度めの検査では通ってしまった**（作った文字列 `ふりがな ながさき 開会` が
      分割後の部品 `な` と `さき` を両方含んでいて、空洞だった）。割れた部品を**別々に**含む行に
      当たってはいけない形で検査を書き直し、落ちることを確認した。
  - 検査機の注入も直した（`WHOLE_TABLE_QUERY_JA` を抜く正規表現が 1 行目を仮定していたので
    複数行対応に変え、`splitQueryToken` と `withoutWholeTableGroups` を注入に足した。
    実測で 7 本の検査が `ReferenceError` 系で落ちた後に直した）。

- **欄の名前その物を打った人は 0 行で、「その語は収録に無い」と言われていた**（2026-08-09 生成ビルドで実測・第 244 回）。

  | 打たれた語 | 当たり | 打ち直し方として出す値（当たり数） |
  | --- | --- | --- |
  | `分野` `テーマ` `分類` | 0 行 | `セキュリティ` 152・`機械学習` 81・`高性能計算` 102 |
  | `種別` `種類` `ステータス` | 0 行 | `論文締切` 461・`概要締切` 142 |
  | `参加形式` | 0 行 | `オンライン参加可` 24 |
  | `会場` `都道府県` | 0 行 | `国内` 38・`米国` 208 |
  | `地域` | 0 行 | `アジア` 143・`ヨーロッパ` 210 |

  - 軸の名前なので 1 行も減らないのに、読み上げは「語「分野」は収録データにありません」と
    言っていた（値の `セキュリティ` は 152 行当たる）。0 件案内の方も「その語を外すと増えます」で、
    **外しても何も変わらない**ことを勧めていた。
  - 直し方: 打たれた語 -> 画面に出る欄の名前 -> 値の例、を `recommender.ts` に一か所（
    `COLUMN_QUERY_WORDS_JA` と `COLUMN_VALUE_EXAMPLES_JA`）置いて、0 件案内と読み上げの両方が
    そこを通るようにした。値の例に挙げた語は、案内の文から検査が拾って**本当に当たりを持つこと**を
    確かめる（無い語を勧められても打てないため）。
    - 0 件案内: 「『分野』はこの表の欄の名前で、値その物ではありません。値で打ってください
      （例: 『セキュリティ』・『機械学習』・『高性能計算』）。」
    - 読み上げ: 「『分野』は欄の名前です。値（『セキュリティ』など）で打ってください」
    - 欄の名前を打ち返したくなるときがあるのか、注記が自分の語を打ち返せない問題は
      第 243 回で実測して、ここで直した。
  - **載せなかった語**（実測で決めた）:
    - `カテゴリ` `カテゴリー` は 0 行だが、この画面で使ってはいけない語を並べる検査
      （「説明文に開発用語を残さない」）に当たる。打たれた語を案内に書き返すので載せられない。
    - `ランク` 847 行・`会期` 185 行・`開催地` 180 行・`国` 116 行・`エリア` 1 行は当たりが
      あるので、注記を出すと噓になる（`セキュリティ` などの値の語にも出さない）。
  - てびきの検索の項にも同じ話を書いた（欄の名前を打つと 0 件になる理由と、値の例）。
  - 検査を 1 本追加（2,007 → 2,008 件 / 34 ファイル）。改ざん 4 通りで落ちることを実測:
    - 語の表を空にする → 「『分野』に対する打ち直し方を出していない: expected （空文字列） to
      contain 「値で打ってください」」
    - 値の例に実在しない語を置く → 「『分野』の例の『存在しない値の語』が 0 行で打ち直せない:
      expected 0 to be greater than 0」
    - 読み上げの分岐を消す → 「読み上げがこの注記を通っていない: expected -1 to be greater than -1」
    - てびきの文を消す → 「てびきに欄の名前の話を書いていない」
    - **改ざんの強さを 1 度上げている**: 語の表から 1 行だけ消す改ざんは検査が通ってしまった
      （欄の名前でも当てる作りにしてあるため、`分野` は別行経由で当たり続けた）。表を丸ごと
      空にする改ざんで落ちることを確認した。
  - 途中でゲートに拾われて直した自分のできの悪さ（実測 8 件の検査落ち）:
    - 新しい注記関数を検査機の注入に入れていなかった（`Recommender.columnQueryNoteJa is not a
      function` が 8 本の検査で出た）。第 239 回の注入入口 `wholeTableQueryStubs` に足した。
    - ビルド成果物は字下げがソースの字下げと同じではないので、定数をつかまえる正規表現は `\n\s*\};` にした
      （ソース側の 2 字下げを仮定するとビルドで空振りする。ビルド済みの `recommender.js` で実測）。
    - `cols.forEach((src) => expect(...))` は `lint/suspicious/useIterableCallbackReturn` の
      **エラー**（2 度目の踩み – 返し値のある矢印関数を `forEach` に渡さない）。

- **参加形式の言い方を打った人は 0 行に当たっていた**（2026-08-09 生成ビルドで実測・第 243 回）。

  | 検索語 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `オンライン開催` | **0 行** | 24 行 |
  | `ハイブリッド開催` | 0 行 | 24 行 |
  | `リモート` / `遠隔` | 0 行 / 0 行 | 24 行 |
  | `ウェブ開催` / `Web開催` | 0 行 / 0 行 | 24 行 |
  | `hybrid` | 4 行 | 24 行 |
  | `online` | 3 行 | 24 行 |
  | `remote` | 0 行 | 24 行 |
  | `オンライン参加可`（画面の語） | 24 行 | 24 行（変化なし） |

  - 画面に出る参加形式の語は「オンライン参加可」だけで、既存の言い換え表も日本語の
    `ハイブリッド` しか載せていなかった。いちばん自然な「オンライン開催」が 0 行だった。
    表に出る語への言い換え表に 9 語を足した（既存の `ハイブリッド` と同じ型）。
  - **寄せなかった語も決めた**（実測で決めたので、ここに記録する）。
    - `virtual` – 会議名の "Virtual Reality" に当たってよけいに出る。寄せた形で 34 行、
      そのうち参加形式の印がある行は 24 行で、余った 10 行は
      「International Conference on Virtual Reality and Visualization」などの会議名だった。
    - `対面` `in-person` `onsite` `現地参加` – 逆の意味の語。収録のデータに語その物が
      1 度も出てこない（実測）ので、寄せるどころか語として存在しない。0 件の案内に任せる。
    - `オンラインのみ` `online only` – 「オンライン参加可」の部分集合なので、寄せると
      hybrid の行を交えて広くしすぎる（実測: 1 行のまま変えていない）。
  - 語のかけ算はそのまま効く（実測: `オンライン開催 国内` は 16 行で、`オンライン参加可 国内` と同じ）。
  - 検査を 1 本追加（2,006 → 2,007 件 / 34 ファイル。`tests/search_words.test.ts` に置いた –
    1 ファイルに集める方針は lint の上限と衝突するので、ことし増えた検査はそこに置く）。
    改ざん 4 通りで落ちることを実測:
    - 9 語を消す → 「『オンライン開催』で参加形式の行に出会えない: expected 0 to be greater than or equal to 20」
    - `virtual` を寄せる → 「『virtual』を寄せている（逆の意味や会議名を引く語）:
      expected '「virtual」は参加形式「オンライン参加可」で探しています' to be ''」
    - 寄せ先を種別「論文締切」に変える → 「『オンライン開催』で寄せ先の行が落ちた」
    - `対面` を寄せる → 「『対面』を寄せている（逆の意味や会議名を引く語）」
  - **次回の候補**: 件数欄の注記が使う語「参加形式」をそのまま打つと 0 行になる（実測:
    `参加形式` 0 行 – 画面の欄の名前ではなく注記にしか出てこない語）。注記が自分の語を
    打ち返せない仕組みになっている。

- **『投稿締切』で引いた人は 2 行の画面しか見ていなかった**（2026-08-09 生成ビルドで実測・第 242 回）。

  | 検索語 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `投稿締切` | 2 行 | **454 行**（`論文締切` と同じ） |
  | `論文投稿` | 1 行 | 454 行 |
  | `論文提出` | 0 行 | 454 行 |
  | `原稿提出` | 0 行 | 454 行 |
  | `投稿` / `提出` | 2 行 / 0 行 | 454 行 |
  | `論文締切` | 454 行 | 454 行（変化なし） |

  - 日本の研究者がいちばん書く言い方（投稿・提出）と、表に出る種別の語（論文締切）が噛み合って
    いなかった。原文の "paper submission" は 440 行当たるので、**英語で打てる人だけが使える表**に
    なっていた。
  - 直し方は既存の言い換え表 `QUERY_SYNONYMS_JA` に 6 語を足すだけ（`論文募集` と同じ型）。
    寄せたことは件数欄に出す（実測: 「『投稿締切』は種別『論文締切』で探しています」）。
  - 原文の "paper" には寄せない – `論文募集` のときの実測どおり、採否通知のラベルに混ざる語。
    検査でも「寄せた行の種別は `paper`（投稿締切）だけ」を確かめている（実測: 誤った寄せ先を
    指定した改ざんは「expected 61 to be 264」で落ちる）。
  - 語のかけ算は壊れていない（実測: `セキュリティ 提出` は 454 行より少なく、0 より多い）。
  - **検査の置き場所を変えた**（実測で詰まったから）。`tests/build_golden.test.ts` は 1 ファイルに
    全検査を並べていて、第 241 回の終わり時点で上限まで残り 222 バイトだった（次の 1 本で
    `tests/lint_budget.test.ts` が落ちる）。ビルド済みサイトを共有する入口
    `tests/built_site.ts` を作って（`tests/helpers.ts` の `runCli` を 1 プロセス 1 回だけ呼ぶ）、
    ことしの今回の新しい検査と、ことし増えた検査 2 本を `tests/search_words.test.ts` と `tests/docs_rounds.test.ts` に置いた。
    残り容量は 222 バイト → **6,078 バイト**（実測）。
  - 検査を 1 本追加（2,005 → 2,006 件）し、検査ファイルは 32 → 34 に増えた（検査 3 本を新しい 2 ファイルに置き、うち 1 本が今回の新しい検査）。改ざん 5 通りで落ちることを実測:
    - 略字の折込みを消す / 違う漢字に折る → 「略字が折込まれていない（`〆切` が単独の語のまま
      残った）: expected 4 to be 374」
    - 言い換えの 6 語を消す → 「『投稿締切』で種別『論文締切』の行に出会えない: expected 2 to be 264」
    - 寄せ先を `概要締切` に変える → 同じ検査が「expected 61 to be 264」
    - てびきの文を消す → 「てびきに折込む語の組を書いていない」

- **略字で引いた人が同じ画面に出会えていなかった**（2026-08-09 生成ビルドで実測・第 241 回）。

  | 検索語 | 折込む前 | 折込んだ後 |
  | --- | --- | --- |
  | `〆切` | 4 行 | **700 行**（`締切` と同じ） |
  | `締切` | 700 行 | 700 行（変化なし） |
  | `発表申込〆切` | 2 行 | 20 行 |
  | `〆` | 4 行 | 700 行 |
  | `応募〆切` | 0 行 | 0 行（原表記が「発表申込〆切」なので別問題） |

  - 検索の正規化 `searchNormalize` は NFKC + アクセント折込み + 全角・半角を使うが、漢字の略字は
    折不がない。収録元が原表記のまま入る行（情報処理学会研究会の「発表申込〆切(延長後)」
    「発表原稿〆切」）で差が出ていた。照合側（hay を作る側）と検索語側が同じ関数を通るので、
    `KANJI_VARIANT_FOLD_JA`（いまは `〆` → `締`）をそこに足して一か所で両方に効かせた。
  - 画面に出す文字は `searchNormalize` を通らないので、**原表記はそのまま**（ビルド後の
    `data.json` に「〆」は 7 箇所残る）。表示を書き換える変更ではない。
  - 実測した 23 の検索語（`締切` `論文締切` `セキュリティ` `機械学習` `国内` `SC` `パリ` `今月中`
    `スパコン` など）で、当たり数が減った語は **0 語**。
  - **同時に直した運用の穴（lint が黙って検査ファイルを読むのをやめていた）**: 検査を 1 本足した
    この変更で `tests/build_golden.test.ts` が 1,048,895 バイトになり、biome の既定の上限
    （1 MiB = 1,048,576 バイト）を 319 バイト越えた。biome はエラーも警告も出さず、そのファイルを
    丸ごと飛ばした（`npm run check` で `Checked 76 files` → `75 files`、警告 35 件 → 6 件）。
    前のコミット（1,044,350 バイト）は上限まで 4,226 バイトで、**検査 1 本で黙って無検査に
    変わる状態**だった。
    - 直し方: 設定は触らず、ファイルを上限の内（1,048,221 バイト / 残り 355 バイト）に戻して、
      越えたら理由を名指す検査を別ファイル `tests/lint_budget.test.ts` にした（`src` `scripts`
      `site` `tests` の `.ts` をバイト数で測る – 日本語は 1 字 3 バイトなので文字数では測れない）。
    - 上限を上げる計測も残す: `files.maxSize: 8192` は **8 KiB と解釈**されて逆に `Checked 22 files`
      に減った。`"8MiB"` と書くと設定ごと無視されて 111 件のエラー（既定の規則が効く）+ `Checked 78 files`。
      単位なしのバイト数で 8388608（8 MiB）と書けば確かに越境を解けたが、これまでサイズで
      黙って外れていた固定データまで検査対象に入って 111 件のエラーになった（すべて実測）。
      **いまは `biome.json` を元に戻してある。**
    - **次回の候補**: 1 ファイルに全検査を集める方針自体が上限と衝突する。検査の共通部品
      （`siteRuntime` / `SEARCH_CANON` / ビルド済みディレクトリ）をモジュールに切り出して、
      検査を複数のファイルに分ける（残 355 バイトなので、次の検査でこの検査が落ちる）。
  - **第 248 回に「次回の候補」を実行した（途中で再び越境した – 実測）**: 検査を 3 本足した途中で
    `tests/build_golden.test.ts` が **1,049,774 バイト**（上限を 1,198 バイト超過）になり、biome は
    何も言わずにそのファイルを読まなかった。`Checked 80 files` は越境の前後で**変わらなかった**
    （越境前は警告 35 件 / 参考 62 件、越境中は **7 件 / 5 件**） – ファイル数では気づけず、
    診断の数の減少だけが兆候だった（19,000 行の検査が黙って無検査を通っていた）。
    - 直し方: 抜き出しの共通部品（`siteRuntime` / `jsFunction` / `vmSafeSource` /
      `wholeTableQueryStubs` / `liveNoteSource` / 0 件案内のハーネス `deadlineHintFunction`）を
      `tests/runtime_extract.ts` に切り出し、新しい検査は `tests/ui_word_notes.test.ts` に置いた
      （現在 1,043,410 バイト / 残り 5,166 バイト）。**共通部品を書き写さない**方針はそのまま
      （ビルド成果物から抜く）。
    - 抜き出し関数を増やすときは、その関数が**読む定数も一緒に**注入する（`uiWordNoteJa` などを
      足したとき `COLUMN_QUERY_WORDS_JA is not defined` に化けた – `columnQueryEntry` が本体で
      読む定数を返し忘れていた。実発生）。
    - **第 255 回に 4 ファイルへ分割した（上の「次回の候補」の完成形）**: `tests/build_golden.test.ts` が
      **1,048,272 バイト**（上限まで 304 バイト）になり、検査を 1 本足すだけで黙って上限を越える
      状態だった。ビルド成果物を読む検査を
      `tests/build_golden.test.ts`（276,540 B）・`tests/built_golden_2.test.ts`（274,983 B）・
      `tests/built_golden_3.test.ts`（272,302 B）・`tests/built_golden_4.test.ts`（208,802 B）に分け、
      テストの合間に置かれていたトップレベルの定義（`site` `data` `siteHtmlRuntime` `conf`
      `SEARCH_CANON` `SORT_CANON` `SORT_CANON_EVAL` `FILTER_RUNTIME_STUBS` `cssBlocks`
      `effectiveCss` など 17 個）と `beforeAll` は `tests/built_golden_shared.ts`（18,112 B）へ
      移して export した（**書き写さない**方針はそのまま – 元の行をそのまま動かす）。
      - 分割は列順を変えない（最初の `it(` 以降を、0 桁に始まる構文塊の単位で、その順序のまま
        約 275 KB ごとに切る）。どの行もどれかの塊に属していることを分割スクリプト自身の検査で
        確かめた – 終端の行の形（`}` `};` `});` `];` `].join(…);` `})();`）を 1 つ読み忘れると、
        その定義が**黙って消える**（実際に `FILTER_RUNTIME_STUBS` が消えた – 網羅検査で止めた）。
      - 各ファイルへ全 import をコピーすると未使用の import が 29 本残って警告が増えた
        （35 件 → 64 件）。 biome の `noUnusedImports` で落として **32 件**（参考 62 件 → 5 件 –
        未整列の import が片付いた分）。検査の本数は分割の前後で **2,027 件のまま**（ビルド成果物の
        検査は 351 件が 4 ファイルに散っただけ）。
      - 再び 1 ファイルに育つのを止めるため、`tests/lint_budget.test.ts` に作業上限 400 KB を足した
        （1 MiB まで残り 304 バイト、という状態は「越えたら分かる」では守れない – 越えた日は
        何も出ない）。改ざんで落ちることを実測: 検査ファイルを 1 本 400 KB 超に膨らませると
        「検査ファイルが大きすぎる（新しい検査ファイルに分け、共通の部品は
        tests/built_golden_shared.ts へ移す – 書き写すと正本とズレる）」で落ちる。


  - 検査を 2 本追加（2,005 件 / 32 ファイル）。改ざんで落ちることを 4 通り実測:
    - 折込みの適用を消す / 違う漢字に折る（`〆` → `抱`）/ 折込みの表を空にする
      → いずれも「略字が折込まれていない（`〆切` が単独の語のまま残った）: expected 4 to be 443」
      （テストのビルドでは 443 行、実データのビルドでは 700 行。**第 242 回に実測して直した**：
      違いの原因は日付ではなく、検査のビルドが上流を fixture キャッシュから読むことだった。
      両者は同じ時刻（2026-08-09）で組んでいる – 同じ時刻で組んだ 2 つのビルドが 368 件と 680 件だった）
    - てびきの文を丸ごと消す → 「てびきに折込む語の組を書いていない: expected '<!DOCTYPE html>…'
      to contain '<code>〆</code> → <code>締</code>」
  - **検査の数え上げ方を 1 つやめた**: 当たり数を固定値（`論文締切` 454 行など）で持つと、
    テストのビルドは**実データより小さい fixture の上流**で組むので、当たり数の絶対値は
    実測の表と食い違って偽りに落ちる（実際に一度落ちた – 第 241 回ではそれを「日付が動いた」
    と説明していたが、第 242 回の実測では検査のビルドも固定時計 2026-08-09 で、違いはデータの
    出どころだった）。同じ理由で、**検査は絶対値のかわりに「同じ意味の語と同じ数」を見る**。
    略字の折込みが無関係な文字列を変えないことは、照合の関数のレベルで見る
    （`論文締切` は `論文締切 2026年10月` に当たる）。
  - **てびきの検査は built の `index.html` に当てる**（第 239 回の教訓を続けた）。`siteHtmlRuntime()`
    は app.js を継ぐので、コードの中の日本語が混ざって空振りする。

- **読み上げが、収録にある語を「収録データにありません」と言っていた**（2026-08-09 生成ビルドで実測・第 240 回）。

  | 検索語 | 表の当たり | ジャーナルの当たり | 直し前の読み上げ | 直し後 |
  | --- | --- | --- | --- | --- |
  | `常時受付` | 0 行 | 22 行 | 「語「常時受付」は収録データにありません」（38 字） | 「検索語は収録の常時受付ジャーナル 22 件に当たります（「種別」で選べます）…」（57 字） |
  | `〆切` | 4 行 | 0 行 | 「収録で 4 件に当たりますが、いまの条件では 0 件です」 | 変えない（第 241 回で 700 行の語になった） |
  | `ネットワーク GPU` | 0 行 | 0 行 | 「語「gpu」は収録データにありません」 | 変えない（収録全体で 0 件のときだけ名指す） |

  - 読み上げの「その語が収録に無い」判断は、語の数え上げ `queryTermCounts` が数えた**表の行だけ**を
    見ていた。ジャーナルの行は `journalRows` に別れていて数え上げに入らないので、表 0 件・ジャーナル 22 件
    という語が「収録に無い」語として名指された。同じ 0 件画面の `emptyDeadlineHint` は
    `queryMatch.catalog + journal` を読むので正しい文を出していて、**同じ画面で目の字と読み上げが
    矛盾した**（てびきは「種別の選択欄に並ぶのは、選べば結果が返る種別（概要・論文・常時受付）だけ」と
    先に正しく書いていた）。
  - 直し方は判断の条件だけ変えた: 語を名指すのは `queryMatch.catalog + journal === 0` のときだけ。
    当たっているときは既存のジャーナル分岐（件数と「種別」で選べることを言う）に落ちる。
    文の書き直しはしていない – 正しい文はすでにそこにあり、届いていなかっただけ。
  - **手順のミスも同時に直す（自分の書き込みミス・記録）**: 第 239 回の README 項（変更履歴 7 行 × 4 と
    使い方の項 × 4）が重複したまま前回コミットに入っていた。追記スクリプトを 4 度実行したためで、
    実行のたびに文書だけ先に書き終わり、後続の検査で落ちていた。読み返した自查で発見した
    （`git show HEAD:README.md` で出現数を数えて実測）。1 つに戻し、同じ形の再発を防ぐ検査を足した:
    README / SPEC の上階層の見出し行が重複していないこと、`第 N 回` の見出しが同じ番号で複数並んでいない
    こと（見出しの語句を言い換えて隠した日にも落ちる）。現在の出現数は README 7 回・SPEC 67 回で重複なし。
  - 検査を 2 本追加（2,002 件）。1 本目: 実測の前提（表 0 件 / ジャーナル > 0 件）をメッセージ付きで置き、
    読み上げが「収録データにありません」を言わないこと・「常時受付ジャーナル」と件数と「種別」を出すこと・
    同じ画面の案内がジャーナルを言うこと・収録全体で 0 件のときは従来どおり名指すこと・表に当たりが
    ある語の文が変わらないこと。2 本目: 上の文書の重複見出し検査。
  - 改ざんで落ちることを 4 通り実測:
    - 判断条件を直し前に戻す → 「表に出ない語を『収録データにありません』と言った: expected ' ｜ 語「常時受付」は収録データにありません。…' not to contain '収録データにありません'」
    - ジャーナルの分岐を消す（別の正しい文に落ちる形） → 「外し方を出していない: expected ' ｜ 検索語は収録で 0 件と常時受付ジャーナル 22 件に当たりますが、…' to contain '種別'」
      （噓ではないが「いまの条件では 0 件です」で止まり、そこで読む人は操作をやめる）
    - 件数を数えなくする → 「expected '…常時受付ジャーナルに当たります（「種別」で選べます）。…' to contain '22 件'」
    - 語の名指しをまとめて消す → 「当たらない語を名指さなくなった」
  - **次回の候補（実測済み・第 241 回）**: `〆切` は 4 行にしか当たらない（同じ意味の `締切` は 700 行）。
    `〆` を含む行は情報処理学会研究会の「発表申込〆切(延長後)」「発表原稿〆切」で、原表記のまま入っている。
    `searchNormalize` は NFKC を使うが `〆` は折不ぎしない。`〆` を `締` に折ると `〆切` の当たりは
    4 → 700 行になり、`締切` の当たりは 700 行のまま（該当の 4 行は種別語「概要締切」「論文締切」を
    hay に持つので既に入っている）。`応募〆切` は 0 行のまま（原表記が「発表申込〆切」なので別問題）。

- **表その物を指す語を打った人に、この表に締切が無いように読める 0 件案内が出ていた**（2026-08-09 生成ビルドで実測・第 239 回）。

  | 打たれた語 | 当たり行数 | 直し前の 0 件案内 | 直し後 |
  | --- | --- | --- | --- |
  | `締め切り` `締切り` `しめきり` `締切日` `提出期限` | 各 0 行（収録 863 行） | 「該当する締切はありません。多いのは 検索語を短くする」 | 理由と打ち直し方を画面と読み上げに出す |
  | `締切` | 700 行 | 結果が出る（案内は出ない） | 変えない（当たっているので「絞れません」は噓になる） |
  | `〆切` | 4 行 | 結果が出る（案内は出ない） | 変えない（同上） |

  - 語その物は欄に現れないだけだった。種別の欄に出る語は「論文締切」（454 行）と「概要締切」（140 行）で、
    「この表は締切の一覧」という前提を画面が一度も言わなかった。
  - 直し方は recommender に語列表 `WHOLE_TABLE_QUERY_JA` を一つ置き、`wholeTableQueryWordJa`（語の判定）と
    `wholeTableQueryNoteJa`（画面に出す文）をそこから作った。0 件案内（`emptyDeadlineHint`）と読み上げ
    （`zeroResultLiveNote`）は同じ関数を読むので、目の字と読み上げで噓が違う状態を作れない。
    読み上げは短い形だけ流す方針（第 88 回）を保ち、実測 50 字に収めた。
  - **立てない条件**を同じ判断に入れた。当たり数が 0 でないときに「絞れません」と言うのは噓なので、
    `締切`（700 行）・`〆切`（4 行）は表その物の語として扱わない。複合で打たれた語（`締め切り 関西`）も
    打ち直しが効いている側なので立てない。
  - 原因を特定できたときに余計な助言を重ねない規則（既存）に この文も従わせ、
    「検索語を短くする」が消えることを検査で見た。
  - 副産物として、数値だけの打ち直し方の文に崩れた語が残っていたのを直した（「締め切日」→「締切日」。
    表の「締切日経過」・てびき・README が使う語に揃えた）。`25` を打った人に出る文で、実測 1 箇所のみ。
  - 検査を 1 本追加（2,001 件）。ビルド成果物の上で 5 つの語の当たり数が 0 であること（前提が変わったことを
    教えるメッセージ付き）→ 5 つの語を表その物の語とすること → `論文締切`・`セキュリティ`・`〆切`・`締切`・
    複合語・空文字には立てないこと → 実の `emptyDeadlineHint` / `zeroResultLiveNote` を動かして理由と
    打ち直し方が出ることを実測 50 字 / 画面の文 103 字より短いこと → 当たり数 0 でない画面で立てないこと（同じ語でも
    収録に行がある場合を作る）→ 崩れた語が残っていないこと → てびきに同じ話があること。
  - 改ざんで落ちることを 8 通り実測:
    - 画面の案内から文を落とす → 「0 件になる理由を書いていない: expected '該当する締切はありません。 外せる条件: …' to contain '全行にあてはまる語'」
    - 原因を特定した扱いにしない（`specific` から外す） → 同じ検査で「多いのは …」が残り失敗
    - 読み上げの分岐を落とす → 「読み上げに理由を出していない: expected ' ｜ いまの条件では行がありません。…' to contain '検索では絞れません'」
    - `しめきり` を語列表から消す → 「しめきり を表その物の語としていない: expected '' to be 'しめきり'」
    - `セキュリティ` を語列表に入れる → 「セキュリティ に立ててしまった: expected 'セキュリティ' to be ''」
    - 崩れた語に戻す → 「expected '数値だけでは締め切日を絞れていません…' to contain '締切日'」
    - 当たり数を見ずに立てる → 「当たっているのに『絞れません』と言った」
    - てびきの語を差し替える → 「てびきにこの話を書いていない」
  - **検査ハーネスの落とし穴として記録する**: てびきの語を `siteHtmlRuntime()` で検査すると、ビルド後の
    `app.js`（ソースの注釈を含む）をつなぐので、てびきから語を消しても通った（改ざんで実測・1 本目の
    作成時）。てびきの語は `readFileSync(join(site, "index.html"))` で HTML だけを読むこと。
    同じ形の使用箇所が検査に 9 箇所あるので、次回の点検対象として残す（第 240 回）。

- **早め絞り込みのボタンは、押されている状態が点灯（CSS クラス）でしか伝わらなかった**（2026-08-09 生成ビルドで実測・第 238 回）。

  | 画面上の面 | 押されている状態の出し方（直し前） | ビルド後の `index.html` |
  | --- | --- | --- |
  | 画面切替（投稿先を探す / 締切を検索） | `aria-pressed` を書く | 2 要素 |
  | 並び順のボタン（列見出しの中） | JS が `aria-pressed` を入れる | 静的には無し |
  | 早め絞り込みのボタン 5 個 | **クラスだけの点灯** | **0 要素** |

  - 読み上げには「オンライン参加可 ボタン」としか読まず、押された状態が分かりません。点灯は目に
    しか見えない合図なので、タッチ操作の端末（点灯は見えている）で気づきにくい穴でした。
    てびきの「押している間は点いたままです」は、目を使う人への説明として書かれていました。
  - 直し方は語の追加ではなく**状態の出口を揃える**こと: `updatePresetActive` で点灯と同じ正本
    `presetIsActive` を一度だけ評価し、`classList.toggle` と `setAttribute("aria-pressed", …)` の
    両方に渡す。マークアップにも初期値 `aria-pressed="false"` を置いて、JS が走る前も同じ形にした
    （`index.html` の `aria-pressed` を持つ要素は 2 → 7）。
  - 検査を 1 本追加（2,000 件）。実の `updatePresetActive` を偽の `document` で動かし、5 プリセットを
    1 つずつ空の状態から押した形で
    ① 点いたボタンの集合と `aria-pressed="true"` の集合が一致すること
    ② 押していないボタンも `false` を書くこと（属性を消すと「押されているか分からない」に戻る）
    ③ 静的なマークアップの 5 ボタンが初期値を持つこと ④ てびきが同じ出し方を書くこと。
    既存の「早め絞り込みのボタンは、入っている条件が点く」検査にも同じ読み合わせを入れ、
    複合状態 7 パターン（検索語を足した状態など）で点灯と `aria-pressed` が違えば落とす。
  - 改ざんで落ちることを 4 通り実測:
    - `setAttribute("aria-pressed", …)` を消す → 新検査「7d を押したとき読み上げに伝わる状態: expected [ null, null, null, null, null ] to deeply equal [ 'true', 'false', … 」＋既存検査「状態を書いていない早め絞り込みのボタンがいる」
    - 常に `"false"` を書く（押していても押していないと嘘をつく） → 新検査「expected [ 'false', 'false', … ] to deeply equal [ 'true', 'false', … ]」＋既存検査「点灯と読み上げの状態が違う」
    - 1 つのボタンだけ初期値を消す → 「初期状態を書いていない早め絞り込みのボタンがある: expected 4 to be 5」
    - てびきを「点いているかどうかは目で見てください」に直す → 「てびきに読み上げへの出し方を書いていない」
  - **検査ハーネスの落とし穴として記録する**:
    - 偽のボタンに `setAttribute` が無いと、実装が正しい場合でも検査が落ちる。注入する偽の面は、
      画面の面と同じ口（ここでは `setAttribute`）を持たせること。
    - 注入する行の `};` を一つ落とすとソースが構文エラーになり、`Expected ',', got ';'` が
      1 行目を指して出る（実発生 – 症状が原因と違う場所に出る）。
  - 残っている計測済みの穴: `<option>` に入れた注記（`評価なし` と等級の絞り込みの説明）は
    ブラウザがまず表示しないので、実質てびきにしか無い。`app.js` の `element.title = …` は 10 箇所。

- **評価なしで絞った人だけ、件数欄と 0 件案内が収録データの内部トークンを見ていた**（2026-08-09 生成ビルドで実測・第 237 回）。

  | 選択欄の語 | 絞り込みの値 | 直し前の件数欄 | 直し後 |
  | --- | --- | --- | --- |
  | `A*` | `A*` | 評価「A*」を持たない行 417 件 | 変化なし |
  | `A` `B` `C` | 同じ | 評価「A」を持たない行 … | 変化なし |
  | `評価なし` | `N` | **評価「N」を持たない行 719 件** | **評価なしの行以外 719 件** |

  - 件数欄（`parts.push(`評価「${state.rank}」…`)`）と 0 件案内の但し書き（`tip(...)`）が、
    選択欄の見出しではなく URL にも書く**値**をそのまま書いていた。`N` は表にも行の詳細にも
    出さない語に決めていて（第 216 回・てびきも「データ内部の表記は `N`」と別枠）、
    コードの注も「選択欄の等級表記をそのまま書く（画面の語で探す人が探せる形に）」としていた –
    注が実装と違うことを言っていた。
  - 規模の実測: 収録 863 行のうち評価なしを含む行は 144 行。評価なしを選ぶと 719 行が
    「持たない」側に回る（＝機械の語が出る場面の大きさ）。
  - のぞいた行を指す語を `rankDropWordsJa` の一か所に集め、件数欄と 0 件案内の両方から呼ぶ。
    表記は選択欄と同じ正本 `rankFilterLabelJa`（＝`recommender.js` の `rankUnratedLabelJa`）から取る。
    `評価なし` だけ文の形も変える（「評価「評価なし」を持たない」は読めない）。
  - **検査の 固定を一つ減らした**: 件数欄の語を `app.toContain("評価「${state.rank}」を持たない行 …")`
    という**ビルド成果物の文字列**で見ていた。これは整形（テンプレートリテラル化）で壊れる上、
    語その物も縛る。配線（`rankDropWordsJa(state.rank)`）を見る検査に替え、語の形は
    関数を組み立てて実際に動かす新しい検査で見る。副産物として `npm run check` の警告が
    1 件減った（36 → 35。文字列の中に `${` を持つ pin を消したので `noTemplateCurlyInString` が消えた）。
  - 検査を 1 本追加（1,999 件）。① 選択欄に並ぶ値すべてで、のぞいた行を指す語が**その欄の見出しと同じ語**を含むこと
    ② どの等級の説明にも内部トークンを括弧で囲んだ形（「N」）が出ないこと
    ③ 評価なしは `評価なしの行以外` の形になること
    ④ `rankDropWordsJa` が定義以外から 2 か所（件数欄と 0 件案内）から見えていること
    ⑤ 収録カタログに評価なしの行が 1 行以上あること（空振りガード）⑥ てびきが同じ文の形を書くこと。
  - 改ざんで落ちることを 3 通り実測:
    - `rankFilterLabelJa(grade)` を使わず値を書く → 「評価「N」の説明が選択欄の語（評価なし）を含まない: expected '評価「N」を持たない行' to contain '評価なし'」
    - 件数欄だけを旧の書き方に戻す → 「のぞいた行の語が定義以外から 1 か所でしか使われていない: expected 2 to be 3」＋旧検査も「件数欄が評価で絞った件数を書いていない」で落ちる
    - てびきを「件数欄は値どおり『N』と出します」に直す → 「てびきに評価なしの件数欄の出し方を書いていない」
  - 残っている計測済みの穴: `<option>` に入れた注記（`評価なし` と等級の絞り込みの説明）は
    ブラウザがまず表示しないので、実質てびきにしか無い。`app.js` の `element.title = …` は 10 箇所。

- **「未確認」「該当なし」「評価なし」の理由が、表のセルにマウスを乗せたときの注記にしか無かった**（2026-08-09 生成ビルドで実測・第 236 回）。

  | 場面 | 該当行（収録 863 行） | 直し前の理由の出し方 | 直し後 |
  | --- | --- | --- | --- |
  | 会期が空 | 186 行 | `title` の注記のみ | 注記 + 行の詳細の本文 |
  | 開催地が空 | 186 行 | `title` の注記のみ | 注記 + 行の詳細の本文 |
  | `評価なし` を含む等級の組 | 144 行 | `title` の注記のみ | 注記 + 行の詳細の本文 |
  | 等級の組が無い（一覧は `未確認`） | 388 行 | `title` の注記のみ | **行の詳細にも `ランク: 未確認` の行を出す**＋理由 |

  - 理由の文（「 kamiyobi が公式で会期を確認できていません。」等）は `app.js` の中に在ったが、
    表のセルの `element.title = …` にだけ入れていた。注記はタッチ操作の端末と読み上げに
    届かない（第 233 回に一致評価の内訳で同じ事故を直したばかりで、画面には同じ型の穴が
    まだ残っていた）。
  - **同じ実測ともう一つ**: 行の詳細は等級の組が無い行で「ランク」の行その物を落としていた。
    一覧のセルは同じ行に `未確認` と書くので、詳細の方が一覧より情報を落としていた
    （`app.js` の注には「表にある分野・ランクをドロワーで落とさない」と書いてあり、
    実装が自分の注と矛盾していた – 45%（388/863）の行で起きる）。
  - 直し方は語の書き足しではなく**入口を一つにした**: 理由の語と、それを出す条件
    （値が出ているか / `該当なし` か / `評価なし` の語がいるか）を `fieldReasonsJa` に集め、
    表のセル（`title`）と行の詳細（本文の注記行）の両方から呼ぶ。条件を 2 箇所で書くと
    どちらかだけ直って言い方が分かれる（`<option>` の注記には同じ入口を当てていない –
    次の候補）。
  - **検査が実装の誤りを覚えていた**例として記録する。`ドロワーは表の情報（分野・ランク・
    ラウンド）を落とさない` は「等級の組が無い行では `ランク:` の見出しを出さない」ことを
    正当な振る舞いとして固定していた（`expect(out.bare).not.toContain("ランク:")`）。
    理由とあわせて、実の `openDrawer` + 実の `fieldReasonsJa`（正本の定数塊をそのまま注入）で
    `ランク: 未確認` と理由の文が出ることを見る検査に置き換えた。
  - 検査を 1 本追加（1,998 件）。① 理由の語・条件を組んだ断片がビルド後の `app.js` から
    全部見つかること（欠けたら落とす）② 収録行に対して会期・開催地・`評価なし`・ランク無しの
    該当行が 1 行以上あること（空振りガード）③ `fieldReasonsJa.event/place/rank` が
    **表と行の詳細の 2 か所**から見えること（一か所の約束）④ `note("")` が空文字
    （値がある行に空の `<p>` を並べない）⑤ てびきが同じ出し方を書くこと。
  - 改ざんで落ちることを 4 通り実測:
    - 等級の組が無い行の理由を空文字にする → 「ランクを行その物で出す行が 1 も無い: expected 0 to be greater than 0」
    - ランクの行を条件付き（無い行は出さない）に戻す → 「expected '…' to match /<strong>ランク:<\/strong> 未確認<\/p>/」
    - 表のセルだけを別の定数に見せる → 「rank の理由が表と行の詳細のどちらかからしか見えていない: expected 1 to be 2」
    - てびきを「行の詳細では理由を出しません」に直す → 「てびきに行の詳細の出し方を書いていない」
  - **ハーネスの実測として残す教訓**（この作業で 3 回無駄踏みした）:
    - `openDrawer` を単体で動かす検査は 4 箇所あり、引数リストを手で伸ばす必要がある。
      語の塊は 1 つのオブジェクトにまとめて渡す形にした（関数 4 本を別々に注入すると
      それだけ引数が増えて壊れやすい）。
    - 注入する語は検査側に書かず、`recommender.js` の `UNCONFIRMED_LABEL_JA` など正本から取る。
    - `node -e` に渡す文字列の中に `${` を混ぜると外側のテンプレートリテラルで展開される。
      単一引用符で書く。
    - 表のセルの行を組み立てる検査は `makeRow` をスクリプトレベルに置いていたので、
      同じ場所に対象の定数塊を足すだけで済んだ（`new Function` の引数を伸ばす必要は無い）。
  - 残っている計測済みの穴: `app.js` に `element.title = …` が 10 箇所（直し前は 12 箇所）。
    特に `<option>` へ入れた注記（`評価なし` と `ランク` 絞り込みの説明）はブラウザがまず
    表示しないので、画面のどこにも出ないのと同じ。

- **等級（評価）を『A 類』『B 類』と呼ぶ人だけ 0 件になっていた**（2026-08-09 生成ビルドで実測・第 235 回）。

  | 打ち方 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `Aランク` | 286 件 | 286 件（変化なし） |
  | `A評価` | 286 件 | 286 件（変化なし） |
  | `ccf a` | 313 件 | 313 件（変化なし） |
  | `A類` | **0 件** | 286 件 |
  | `B類` | **0 件** | 260 件 |
  | `C類` | **0 件** | 145 件 |
  | `A*類` | **0 件** | 156 件 |
  | `A 類`（半角スペース） | **0 件** | 313 件（`A ランク` 317 件・`A 評価` 313 件と同じ形） |
  | `類` だけ | **0 件** | 451 件＋件数欄の注意 |

  - 原因は等級の検索語を作る `rankSearchTerms` が `${等級}ランク` `${等級}評価` の二つの形しか
    持っていなかったこと。画面の呼び方（列の見出し・選択欄・早め絞り込みのボタン）から来ていた
    語で、日本語で等級を並べるときの `類` が抜けていた。同じ関数に `${等級}類` を足しただけ
    （展開の計算も表も増やしていない）。
  - `類` だけを打った人は等級を絞れていないので、`ランク`・`評価` と同じ約束で件数欄が注意を
    出す（「『類』だけでは等級を絞れていません（`A*ランク` のように等級の語をいっしょに入れて
    ください）」）。実測: `類` 451 件・`ランク` 839 件・`評価` 475 件で、いずれも語だけでは
    等級を絞っていない。
  - 照合式（等級の語がいるかを見る正規表現）にも `類` を足した。足さないと
    `ランク A類` のように打った人に「絞れて ありません」の注意が出てしまう（実測で確認）。
  - **同じラウンドで誤った仮説を一つ引き返した**（記録しておく価値がある）。
    「相対月（`今月` `来月`）は件数欄に読み方が出ない」と実測して暦月の展開式を共有化する
    パッチを書いたが、画面に出す説明は `app.js` 側の `relativeMonthNote` がすでに
    展開の差分から作っていた（実測: `来月` → 説明 `来月 = 2026年9月`、`今月中` →
    `今月中 = 2026年8月`、`来週 来月` → 週と月で別の説明が並ぶ）。
    そのまま入れていたら「来月 = 2026年9月」と「来月 = 2026年9月の締切」が二重に出て、
    直す前より読めない画面になっていた。**教訓: 件数欄の語は `recommender.js` と `app.js` の
    両方から組み立つ。片方だけ測って「出ていない」と言うな。** パッチは破棄した。
  - 検査を 1 本追加（1,997 件）。① `rankSearchTerms` が `a類` `a*類` の形を持つこと
    ② fixture の行で `A類` が `Aランク`・`A評価` と**同じ行の並び**になること（1 件以上）
    ③ `類` だけには注意が出て、`ランク A類` には出ないこと ④ てびきが同じ言い方を書くこと。
  - 改ざんで落ちることを 4 通り実測:
    - 等級の語に `類` の形を足す行を消す → 「等級の語に `類` の形が無く、この呼び方が引けない: expected 'ccf a ccf a aランク a評価 ランク 評価 類' to contain 'a類'」
    - 件数欄の注意を出す語の一覧から `類` を消す → 「`類` だけでは絞れないことを件数欄が言っていない: expected '' to contain 'だけでは等級を絞れていません'」
    - 照合式から `類` を消す → 「『A類』が等級の語として数えられていない: expected '「ランク」だけでは等級を絞れていません…' not to contain 'だけでは等級を絞れていません'」
    - てびきを『A 類』は使いませんに戻す → 「てびきに『A 類』の言い方を書いていない」
  - **検査の弱点を一つ直した実測**: 最初は「`A類` だけでは注意が出ないこと」を見ていたが、
    照合式から `類` を抜いた改ざんでも**そのまま合格した**（注意は語単独のときだけ出るため）。
    `ランク A類` を足して、注意の出入りが照合式を見るようにした。
  - 残っている計測済みの穴: 表のセルは `element.title = …` の注記を 12 箇所使う（開催地の原表記・
    ランクなど。タッチ端末で出ない）。`国際会議` は 0 件 – 収録データの会議名は原文の英語で
    書かれており、日本語の「国際」という語その物は 1 行にも出ない（実測: `国際` 0 件）ため、
    寄せる先が無い。0 件案内が「収録データにありません」と言う。

- **`今日中` `今週中` `今月中` と打った人だけ 0 件の壁に当たっていた**（2026-08-09 生成ビルドで実測・第 234 回）。

  | 打ち方（ビルド後の検索で実測） | 直し前 | 直し後 |
  | --- | --- | --- |
  | `今日` / `今日中` | 2 件 / **0 件** | 2 件 / 2 件 |
  | `本日` / `本日中` | 2 件 / **0 件** | 2 件 / 2 件 |
  | `明日` / `明日中` | 4 件 / **0 件** | 4 件 / 4 件 |
  | `今週` / `今週中` | 19 件 / **0 件** | 19 件 / 19 件 |
  | `来週` / `来週中` | 53 件 / **0 件** | 53 件 / 53 件 |
  | `今月` / `今月中` | 189 件 / **0 件** | 189 件 / 189 件 |
  | `来月` / `来月中` | 241 件 / **0 件** | 241 件 / 241 件 |
  | `再来月` / `再来月中` | 186 件 / **0 件** | 186 件 / 186 件 |
  | `チュートリアル` / `チュートリアル提案` | 6 件 / **0 件** | 6 件 / 6 件 |
  | `ワークショップ` / `ワークショップ提案` | 126 件 / **0 件** | 126 件 / 126 件 |
  | `セッション` / `セッション募集` | 3 件 / **0 件** | 3 件 / 3 件 |
  | `学生` / `学生発表` | 1 件 / **0 件** | 1 件 / 1 件 |
  | `ポスター` / `ポスター提案` | 6 件 / **0 件** | 6 件 / 6 件 |

  - 語の表（`RELATIVE_DAY_OFFSETS_JA` / `RELATIVE_WEEK_OFFSETS_JA` / `RELATIVE_MONTH_OFFSETS_JA` と
    `UPSTREAM_TEXT_QUERY_SYNONYMS_JA`）は語その物だけを持っていたので、`中` `提案` `募集` `発表` を
    足した言い方が表に無く、その瞬間に 0 件になっていた。既存の `ポスター発表` `ポスター募集` が
    通るのと同じ形に揃えただけで、展開の計算は増やしていない。
  - **`中` は別の日数を足す意味にしない**（『今日中』は今日の話、『今週中』はその週の話）。
    「今週中 = 今週の金曜日まで」のような読み替えは、画面に出る行を勝手に狭めるのでやらない。
  - 件数欄の言い方も同じ表から自動で出る（`relativeDayNotes` が表を見ている。
    「今日中 = 2026年8月9日(日)」「来週中 = 2026年8月10日(月)〜8月16日(日)」と実測で確認）。
    表に語を足すだけで説明も増えるので、説明を書き写した場所を作り損ねない。
  - `公募` `募集` 単体は入れていない（`募集` 1 件 / `call` に寄せた先が画面に出る語ではない）。
    寄せ先が画面に出る語という不変条件を守る。
  - 検査を 1 本追加（1,996 件）。① 相対日の語が素の語と同じ展開先・同じ行になること
    ② 相対月も同じ暦月になること ③ 催し物の複合語が素の語と**同じ行の並び**になること
    ④ 件数欄に「原文の…」が出ること ⑤ fixture に素の語の行が無い語は数えないが、4 語未満なら
    失敗（空振り防止）⑥ てびきが同じ言い方を書いていること。
  - 改ざんで落ちることを 4 通り実測:
    - `今日中` を表から消す → `「今日中」が「今日」と同じ日に展開されていない: expected '' to be '今日中 = 2026年8月9日(日)'`
    - `ワークショップ提案` を消す → `「ワークショップ提案」が素の語「ワークショップ」の行に届かない: expected [] to deeply equal [ +0, 1, 14, 15, …(113) ]`
    - `今月中` を 3 か月後にずらす → `「今月中」が「今月」と同じ暦月に展開されていない: expected '2026年11月' to be '2026年8月'`
    - てびきの言い切りを落とす → `てびきに言い方の幅を書いていない`
  - **残っている計測済みの穴**: 相対**月**と相対**年**は件数欄に説明が出ない
    （`relativeDayNotes("今月")` は空文字。実測: `今日`・`今週` は出るが `今月`・`来月`・`来年` は出ない）。
    暦月の展開は「表に出る月語」へ向かうので行自体は正しく出るが、打ち主には読み方が見えない。
    次のラウンドで `relativeDayNotes` を相対月・相対年にも伸ばす。

- **推薦の内訳の説明が、マウスを乗せたときだけ出る注記（`title`）だけになっていた**（2026-08-09 生成ビルドで実測・第 233 回）。

  | 調べたこと（ビルド後の `app.js`） | 直し前 | 直し後 |
  | --- | --- | --- |
  | マークアップに書く `title="` | 2 箇所 | 0 箇所（ソースのコメントに書いた文字列だけが残る） |
  | 画面に出る「原表記」の行 | 2 箇所 | 3 箇所 |
  | 内訳の項目を組み立てる箇所 | 1 箇所 | 1 箇所（`reasonChipHtml`） |

  - 内訳は「一致評価 … ▾」を開いたときに出る 9 項目（分野の一致・会議名一致・採択論文一致・
    日本語一致・主題の一致・過去掲載先一致・同じ分野（掲載先から推定）・意味検索の候補・
    目立つ一致はない）で、項目ごとに「当たり方の説明」を持っていた。それが `title` にしか無く、
    **タッチ操作の端末では注記自体が出ない**（hover が無い）。キーボードフォーカスでも読まれず、
    読み上げも `title` を確実には読まない。説明を本文に出す。
  - 同じ行の詳細の中に**書き分けの間違い**が残っていた: 開催地は開催地を日本語に寄せたとき
    「原表記: …」を本文に出すのに、今後の会期は同じ情報を `title` に置いていた。開催地と同じ
    作法に揃える（同じ情報なのに片方だけ隠れる、という画面の噓）。
  - 項目と説明は同じ配列の 1 組なので、組み立ても `reasonChipHtml` 一か所にまとめた
    （2 箇所目があると説明の出し方がズレる。ビルド後の `class="reason-chip"` は 1 箇所だけ）。
  - CSS は `.reason-chips` を grid（1 項目 1 行）に変え、説明を `.reason-why` で項目の下に置く。
    角丸のチップ（`border-radius: 999px`）は 2 行に耐えないので 12px にした。
  - 検査を 1 本追加（1,995 件）。`reasonChipHtml` をビルド後の `app.js` から取り出して
    `new Function` で動かし、① 説明が出力に出ること ② `title=` を含まないこと
    ③ 順位などの実数（第 2 欄）を落とさないこと ④ 組み立てが一か所であること（`reasonChipHtml` の出現回数が定義込みで 2 回。
    面板で `chips.map` を直接組んだら 3 回以上になる。数で押さえているのは、最初
    `toContain('reasonChipHtml(chips) + "</div>"')` にしたところ、文字列をテンプレートリテラルに
    直した途端に落ちたから – 検査が実装の字面に依存していた）
    ⑤ 画面に出る「原表記」の行が 3 箇所であること ⑥ てびきが同じ説明を書くこと
    を見る。
  - 改ざんで落ちることを 3 通り実測:
    - 説明の `span` を消す → `当たり方の説明が画面に出ていない: expected '<span class="reason-chip"><b>分野の一致</b…' to contain '会議の分野と論文のキーワードが一致'`
    - 今後の会期の原表記を画面に出さないようにする → `原表記を画面に出す行が減っている（開催地・会期・今後の会期）: expected 2 to be 3`
    - てびきを「当たり方の名前だけを出します」に戻す → `てびきに内訳の説明が常に出ると書いていない`
    - 面板の中で `chips.map` を直接組んで説明を落とす → `内訳の組み立てが一か所に無い: expected 1 to be 2`
  - **残っている計測済みの同じ手の穴**（今回は触っていない）: 表のセルは `element.title = …` の
    形で注記を 12 箇所使っている（開催地の原表記、ランク、締切セルなどの説明）。列が狭く、
    本文に置くと行が読めなくなるので、置き場所を決めてから直す。セレクトの `<option>` に付けた
    注記はブラウザが表示しないことがある（実測を待って次ラウンドの候補）。

- **「ワークショップ」と打っても、会議名に `Workshop` と書く会が 52 件出ていなかった**（2026-08-09 生成ビルドで実測・第 232 回）。

  | 打ち方（ビルド後の検索で実測） | 直前 | 直し後 |
  | --- | --- | --- |
  | `ワークショップ` | 74 件 | **126 件** |
  | `workshop`（原文） | 126 件 | 126 件 |
  | `セッション` / `session` | 0 件 / 3 件 | 3 件 / 3 件 |
  | `学生` / `student` | 0 件 / 1 件 | 1 件 / 1 件 |

  - 当たっていた 74 件は、締切種別のラベルが日本語で「ワークショップ」と出ていた行だけだった。
    `The 3rd International Workshop on …` のように**会議名へ英語で書く行**が抜けていた。穴場
    ワークワークショップを探す人の主たる打ち方だったので、抜けている損が大きい。
  - 第 226 回で作った「原文の英文字も調べる」表（`UPSTREAM_TEXT_QUERY_SYNONYMS_JA`）に 4 語を足しただけの
    変更。寄せ先はいずれも画面の会議名・募集文にそのまま出る語（表の不変条件）。件数欄には
    「『ワークショップ』は原文の workshop という語で探しています」と出る（理由も出さずに
    英語名の行を並べない約束はそのまま）。
  - 展開は**和集合**で、打ち主が打った語も調べ続ける（`スパコン` が自分自身の語を含む行に当たることを
    実測で確認）。だから `ワークショップ` は 126 件になり、日本語で「ワークショップ」と書いた行を
    失わない。
  - `edge` を `knowledge` に寄せるなという第 226 回の教訓に従い、`セッション` → `session` が
    部分一致で別語を巻かないことを実測で確認した（`session` を含む行 3 件は、3 件とも語としての
    `session`。語として含まれる行 3 件と一致）。
  - **`パネル` → `panel` は入れていない**。収録で `panel` を書く行は 1 件（IFIP WG 11.9）で、
    テスト用の収録データには 0 件。既存の検査「データに在る概念を、日本語の言い方で引ける」は
    展開語が収録データで 1 件以上出ることを要求する（寄せた先が空の同義語を置かない約束）ので、
    そこで弾いた形跡を残すより、入れない側を選んだ（実データに 1 行ある程度の寄せは、0 件の壁を
    直す損が説明しきれない）。`panel` を書く会が増えてから足す。
  - 検査を 1 本追加（1,994 件）。① 日本語で打つと、原文の英文字で打った人が見る行を**すべて**
    含むこと（`toEqual(expect.arrayContaining(原文の行))`）② 件数欄に「原文の」と出る
    こと ③ fixture に寄せ先の行が無い語は数えないが、1 語も数えなかったら失敗（空振り防止）
    ④ てびきが同じ説明を引用していること。
  - 改ざんで落ちることを 3 通り実測:
    - `ワークショップ` の寄せを外す → `「ワークショップ」で打つと原文の workshop と書く行に届かない: expected [ 14, 17, 20, …(67) ] to deeply equal ArrayContaining{…}`
    - `セッション` の寄せ先を画面に出る語に向けない → `「セッション」で打つと原文の session と書く行に届かない: expected [] to deeply equal ArrayContaining [118, 119]`
  - 検査ハーネスの教訓: 差分を patch から復元したあとは `biome check --write` を掛け直す
    （復元した本体が未整形だと `npm run check` が `format` の 1 error で落ちる。実測:
    `tests/build_golden.test.ts:1 Formatter would have printed the following content`）。
    - てびきだけ説明を落とす → `てびきに催し物の語の寄せを書いていない`（ビルド後の index.html を見ている）

- **一覧の月の見出しが「何の月」を書かず、会期の月だと読み違えていた**（2026-08-09 生成ビルドで実測・第 231 回）。

  | 実測（ビルド後の `data.json` の投稿締切の行） | |
  | --- | --- |
  | 会期が分かる行 | 94 件 |
  | 見出しの月と会期の月が違う行 | **89 件（94.7%）** |
  | そのうち年まで違う行 | 30 件 |
  | 例 | `aila2027` は締切 2026-11-15 / 会期 2027-04 |

  - 表には締切の日時列と会期列の両方を並べていて、月の塊は締切の日付で区切っている。ところが
    見出しは「2026年11月（12 件）」だけで基準を書いておらず、会期の月だと読む形になっていた。
    てびきは「月でくくるのは締切の日付順のときだけ」と先に言っていたが、画面側が言っていなかった。
  - 見出しを `締切 2026年11月（12 件）` にした（`monthHeading` の 1 本）。**区切る月の基準は変えて
    いない** – `monthKey` は引き続き行の表示している暦日（第 202 回と同じ基準）を見る。語を足して
    読み違えを止めるだけの修正。
  - 検査を 1 本追加（1,993 件）。① 見出しが `締切 2026年11月（12 件）` になること ② 「締切」を
    含むこと ③ 区切る月が表示暦日（`r.tShown`）から決まること ④ 月見出しの行が `textContent =
    monthHeading(key, count)` で見出しの組み立てを見ていること ⑤ てびきが同じ語を引用していること。
    既存の「month headings appear only while browsing…」の固定語も新しい語に直した。
  - 改ざんで落ちることを 4 通り実測:
    - 見出しから「締切 」を落とす → `expected '2026年11月（12 件）' to be '締切 2026年11月（12 件）'`
    - `monthKey` の基準を表示暦日でなく締切の瞬間（`r.t`）にする → `月の基準が表示暦日でない: expected … to contain 'r.tShown'`
    - 見出しの行が `monthHeading` を呼ばずに月を組み直す → `月見出しが見出しの正本を見ていない: expected … to contain 'textContent = monthHeading(key, count)'`
    - てびきだけ基準の語を落とす → `てびきに月の基準を書いていない`（ビルド後の index.html を見ている）
  - ハーネスの落とし穴 3 つ（実測）:
    - テストを差し込む位置を 1 行誤ると、**前の検査の本文の中に `it` が入って入れ子になり、
      vitest は黙ってその検査を飛ばす**（総数は増えず `-t` の一致も 0 件になる）。今回の検査は
      1 本増えるはずが 341 件のまま残り、`-t` が 0 件を返して初めて気づいた。差し込み後は
      `it` が字下げになっていないかで確認する。
    - ソース固定の needle を `monthHeading(key, count)` にすると、**関数宣言の
      `function monthHeading(key, count)` にも当たって改ざんを検出できなかった**（実測: 通った）。
      呼び出しの形（`textContent = monthHeading(key, count)`）で見る。
    - てびきに会議キーを書こうとしてマークダウンの引用符（\`x\`）を使うと、
      「画面に出る文へ markdown の記号を混ぜない」検査に拾われた（実測）。てびきは `<code>` を使う。

- **分野チップの並びが、上流の分野表の項目順で、日本語で探す人に五十音順でなかった**（2026-08-09 生成ビルドで実測・第 230 回）。

  | 実測した並び（チップ 9 個） | |
  | --- | --- |
  | 直前（上流の項目順） | 高性能計算 / ネットワーク / システム / 人工知能 / セキュリティ / データベース / グラフィックス / 人間情報処理 / 計算理論 |
  | 直し後（日本語名の五十音順） | グラフィックス / システム / セキュリティ / データベース / ネットワーク / 計算理論 / 高性能計算 / 人間情報処理 / 人工知能 |

  - 並びは `src/merge.ts` が作る `categories` の項目順（＝上流の分野表の宣言順）がそのまま画面に
    出ていた（`Object.keys(DATA.categories)` をそのままチップにしていた）。上流の項目順が動くと
    画面の並びも動く。
  - 同じ画面の「会議」列は `localeCompare(..., "ja")` で五十音順に並ぶ（`conferenceNameCell` での
    2 箇所）ので、日本語の並びの約束が画面の中に二つあった。探している語を探す形になっていた。
  - 並びは `categoryChipKeys(categories)` の 1 本にまとめた。比較するのは**画面に出る語そのもの**
    （`categoryChipLabelJa` の英表記併記を含む形）で、表示と並びで別の語を見ないようにする。
    同じ分野名の行が並んだときのタイブレークはキー順（辞書順で決定的）。
  - 行に付く分野タグの順序は変えていない（チップは探すための欄、タグは行の情報。収録の分野順の
    ままで意味を持たせない）。
  - 検査を 1 本追加（1,992 件）。① 入力の並びを逆にしても同じ順に出ること（並び替え自体の証明。
    データ順がたまたま五十音順でも空振りしない）② チップから分野が 1 つも落ちないこと
    ③ 収録している分野でラベルが五十音順になっていること ④ チップの組み立てが
    `categoryChipKeys(DATA.categories)` を見ていること ⑤ てびきが同じ約束を書いていること。
  - 改ざんで落ちることを 4 通り実測:
    - 並び替えを外して `Object.keys(categories)` をそのまま返す → `入力の並び順で出ていて、並び替えていない: expected [ 'sec', 'ai', 'hpc' ] to deeply equal [ 'hpc', 'ai', 'sec' ]`
    - チップの組み立てを素の `Object.keys(DATA.categories)` に戻す → `チップの組み立てが並びの正本を見ていない`
    - 並びを表示語ではなく分野キーで決める（`la.localeCompare` を落として `a.localeCompare` だけ）→ `チップが五十音順に並んでいない: expected false to be true`
    - てびきの記述を別の約束に書き換える → `てびきにチップの並びを書いていない`（ビルド後の index.html を見ているので、文書だけがズレても落ちる）

- **CSV ボタンのラベルが、画面に並んでいない行を「表示中」と数えていた**（ビルド成果物で実測・第 229 回）。

  | 項目 | 実測 |
  | --- | --- |
  | 一覧が一度に並べる行数（`const PAGE`） | 40 件 |
  | 既定の一覧の件数欄 | 478 件 |
  | ボタンのラベル | 「表示中の 478 件を CSV でダウンロード」 |
  | したがい、画面に並んでいない行数 | 438 件（`さらに表示 (残り 438 件)` と一致） |

  - 書き出しの中身は正しかった（`shown` 全体＝絞り込み後の全行を `deadlinesToCsv` に渡す。
    SPEC §7 の約束どおり）。誤っていたのは語だけ – 「表示中の」は画面に並んでいる行を指す言い方なので、
    40 件しか見ていない画面で 478 件を表示中と言っていた。
  - 欠陥の痕跡は文書側に残っていた。てびきは「ページ送りで画面に出ている分ではなく、絞り込み後の
    全行です」と先に謝り、README も同じ補足を持っていた。語の誤りを文書の但し書きで覆っていた形。
  - ラベルは `exportCsvLabelJa(total)` の 1 本にまとめた（組み立てが `render` の中にインラインで
    書かれていて、数字の根拠を検査が抜き出せなかった）。語は「この一覧の N 件を CSV でダウンロード」。
    「この一覧」は件数欄（`N 件 / 全 M 件`）と同じ `shown.length` を指す語で、絞り込みを一切外して
    いない既定画面でも成り立つ（「絞り込んだ N 件」だと条件を触っていない人に誤解させる）。
  - 検査を 1 本追加（1,991 件）。① ラベルが `PAGE` より大きい総数で `この一覧の 478 件を CSV で
    ダウンロード` になること ② 「表示中」を含まないこと ③ `render` が `exportCsvLabelJa(shown.length)`
    を呼び、件数欄も `countJa(shown.length)` を見ていること（同じ数を二箇所で言う約束）
    ④ てびきがボタンと同じ語を引用していること（画面の語を文書で言い換えない）。
  - 改ざんで落ちることを 3 通り実測:
    - ラベルを「表示中の」に戻す → `件数欄と同じ数字が出ない: expected '表示中の 478 件を CSV でダウンロード' to be 'この一覧の 478 件を CSV でダウンロード'`
    - `render` で `shown.length` の代わりに `drawn`（描画済み）を渡す → `ボタンがラベルの組み立てを見ていない`
    - てびきだけ古いボタン名に戻す → `てびきの CSV の項がボタンの語とズレている`（ビルド後の
      index.html を見ているので、文書だけがズレても落ちる）

- **画面上部の「これからの30日間の締切」と、「30 日以内」の一覧が違う数を言っていた**（2026-08-09 生成ビルドで実測・第 228 回）。

  | 見立てた時刻 | 上の四つの数 | 「30 日以内」の一覧 | 食い違い |
  | --- | --- | --- | --- |
  | 2026-08-09T00:00Z | 176 件 | 176 件 | なし |
  | 2026-08-09T15:00Z | 176 件 | 177 件 | `pacificvis` |
  | 2026-08-09T21:00Z（JST 8/10 朝） | 176 件 | 177 件 | `pacificvis` |

  - 原因は「30 日間」の二重実装だった。上の数は `now + 30 * DAY`（経過 24 時間）、一覧の窓は
    `windowLimitMs`（JST の暦日の終わり際）。第 202 回に一覧を暦日へ揃えたとき、上の数が置き去りに
    なっていた。一覧は `pacificvis`（締切 JST 9/9 20:59）に「あと 30 日」と出すのに、上の数だけ
    その行を数えない。画面の上と下が同じ語について違う数を言うので、どちらを信じてよいか分からない。
  - 比較を 1 本にした。`rowShownDayMs`（表示している暦日）と `rowAfter`（その暦日が窓の上側を
    超えているか）を shared な関数にし、絞り込みの本体も上の数もそこを見る。絞り込み側にあった
    `shownDayMs` / `isAfter` のローカル実装は消した。
  - 四つの数は描画ごとに数え直するようにした（`renderSummaryStats`）。読み込み時に 1 回だけ数えると、
    日をまたいで開いたタブで上の数だけ前日の眺めになり、やはり一覧と食い違う。
  - 検査を 1 本追加（1,990 件）。上の数（`renderSummaryStats` をビルド成果物から抜いて実行）と
    「30 日以内」の絞り込み（`filter` を同じく抜いて実行）が**同じ行集合**を数えることを見る。
    行は 4 種類で、① 30 日後の JST 暦日の中の遅い時刻、② 31 日後の暦日、③ 推定、④ 投稿締切以外の
    種別、加えて「締切の瞬間は窓の中・表示暦日は 31 日後」の行を入れて、窓が表示暦日で切れている
    こと（第 202 回）も同時に押さえる。時計は 2026-08-09T21:00Z（食い違いが出る時刻）に固定し、
    経過 24 時間での数え方が 0 件になることまで検査に入れる（時計と行の組み合わせが検査を決めている
    ことの証明）。
  - 改ざんで落ちることを 4 通り実測:
    - `rowAfter` を `r.t` 比較に戻す → `窓の想定と違う行が出た: expected [ 'later-in-the-day', 'shown-later' ] to deeply equal [ 'later-in-the-day' ]`
    - 上の数を `nowMs + 30 * 86400000` に戻す → `上部 0 件・一覧 1 件で画面が自己矛盾している`
    - 窓の上側を経過 24 時間に戻す → `窓の想定と違う行が出た: expected [] to deeply equal [ 'later-in-the-day' ]`
    - 描画ごとの数え直しを外す → `四つの数を描画ごとに数え直していない`
  - 検査ハーネスでの落とし穴 2 つの実測メモ: 時計を止めた `Date` を `new Function` に渡さないと、
    絞り込みだけ現実の時刻で走って全行が「過ぎた」扱いになる（`一覧: []` で化けた）。
    また `FILTER_RUNTIME_STUBS` が `Recommender` を宣言するので、`deadlineRowIsPast` を足すのは
    そのうしろに回す必要がある（前に置くと `Identifier 'Recommender' has already been declared`）。

- **検索語を打っても 1 行も減らないときに、画面どこにも理由が出なかった**（2026-08-09 生成ビルドで実測・第 227 回）。

  | 打ち方 | 当たり | のぞけた行 | 件数欄の反応（直し前） |
  | --- | --- | --- | --- |
  | `月` | 863 / 863 行 | 0 行 | 何も言わない |
  | `日` | 863 / 863 行 | 0 行 | 何も言わない |
  | `年` | 863 / 863 行 | 0 行 | 何も言わない |
  | `25` | 105 行 | 758 行 | 絞れたが、狙った `25日`（94 行）とは別の集合 |

  - 1 打鍵で 478 行 → 478 行 と変わらないと、人は「この語では無かった」と誤読して検索をやめる。
    索引側では直せない（`月` を含まない行は収録に存在しない）ので、**絞れていないことをその場で言って
    打ち直させる**方を選んだ。
  - 実装は 1 本にした。検索語だけでのぞいた行数を絞り込みの本体（`filter`）が数え、0 のときだけ
    件数欄が `queryNarrowHintJa` の文を出す。UI 側に「当たった行数」の別計算を作らない。
  - 打ち直しの例は**打たれた語その物を例に書かない**（`セキュリティ` と打った人に
    「分野（`セキュリティ`）で絞れます」と言うのは役に立たない）。小文字化して照合して外す。
    例が全部消えたときは「会議の略称など、もっと具体的な語を足してください」に落ちる。
  - 数値だけの入力は暦日の単位を促す（`25` → 「`25日`・`8月`・`2027年` のように単位を付けてください」）。
    第 223 回で `5日` を「今月の 5 日」と読む決まりにしてあるので、その言い方に接続する。
  - 一覧が 5 行未満の画面では出さない（数行しか出ていないところで「絞れていません」と言うのは誤解）。
  - 検査を 1 本追加（1,989 件）。実データで `月`・`日`・`年` が 0 行ものぞかないこと、打ち直し方が
    空でないこと、`25` に単位のある打ち方が出ること、打った語を例に書かないこと、
    絞り込みの本体が検索語でのぞいた行数を数えていること（3 行の表で `月` → 0 行・`icde` → 2 行）、
    件数欄がのぞいた行数で門を絞っていることまで見る。
  - 改ざんで落ちることを実測:
    - 数え無くす → `検索語で落ちた行数が数えられていない: expected +0 to be 2`
    - 1 文字向けのおしらせを空にする → `「月」の打ち直し方が出ていない: expected '' not to be ''`
    - 門を外して常に出す形にする → `落ちた行数での絞り込みが無い（常に打ち直し方を出す実装）`
  - 検査ハーネスで `node -e` に渡すソースの作り方も直した。`vmSafeSource` の**関数の本体を本文に
    注入する**形にすると、そこに出る語で Node が ESM 判定をし、`new Function` の内側から最上位の
    `const Recommender` が見えなくなる（`ReferenceError: Recommender is not defined`）。
    適用済みの文字列をそのまま渡す形にした（§7 の同じ注記に実測を追記）。

- **主題の日本語を打つ人が 0 件に当たっていた**（2026-08-09 生成ビルドで実測・第 226 回）。収録の会議名は英語で書かれていて、推薦の照合には日本語→英語の対応表（`JP_EN`、122 語）があるのに、検索の側に同じ対応が無かった。

  | 打ち方 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `アルゴリズム` | 0 件 | 19 件（会議名に algorithm と書く会） |
  | `自動化` | 0 件 | 13 件 |
  | `ニューラル` | 0 件 | 7 件 |
  | `コンテナ` `ミドルウェア` `オーケストレーション` | 0 件 | 各 4 件（CANOPIE-HPC 2026 など） |
  | `異常検知` `マイクロアーキテクチャ` `ニューラルネットワーク` | 0 件 | 各 3 件（GeoAnomalies 2026 など） |
  | `メモリ` | 0 件 | 1 件（HMEM 2026） |
  | `エッジ` | 0 件 | 1 件（SLICE-2026） – `edge` ではなく `edge computing` に寄せた |

  - 「穴場ワークショップを探す」というこのサイトの主旨その物に効く。日本の研究者が口にする語
    （異常検知・コンテナ・オーケストレーション）で、ちょうどそういう名前の workshop が収録に
    ある。**0 件の壁の向こうに答えが置いてあった**。
  - 寄せは既存の `UPSTREAM_TEXT_QUERY_SYNONYMS_JA`（上流の原文にしか出ていない語を日本語で
    引けるようにする表）に足した。「そのままでは 1 行も当たらない語だけ寄せる」という §7 の
    規則は変えない（精密な語には寄せないので、既存の当たり方は一切変わらない）。
  - **`エッジ` には `edge` を寄せない**。`knowledge` の中に含まれるため、`edge` を含む行 30 件の
    うち 26 件が CIKM・KR・KSEM などの knowledge 由来だった（実測）。語として出る
    `edge computing`（1 件）だけに寄せる。第 220 回で会期の開催地を索引に入れなかったのと同じ
    「他の語を誤爆させる語は入れない」判断。
  - 対応表を 2 本書く形になるので、**検査が `JP_EN` と突合する**（組み込んだ語の寄せ先が
    `JP_EN` の値と違う語を向いていたら落ちる）。長音の書き方と複合語
    （`エッジコンピュティング`・`コンテナオーケストレーション`）は基準となる見出し語を
    検査側に書いて、同じ対応を見ることを確認する。
  - 検査を 1 本追加（1,988 件）。14 の語が 1 件以上出すこと、件数欄に「原文の … という語」が
    出ること（理由なしで英語名の行を並べない）、`エッジ` の当たり行に `knowledge` を含む行が
    無いこと、`JP_EN` との対応の一致を見る。しきい値は 1 件に留めた（収録は動くので生成時計で
    行数が変わる。直し前は全部 0 件なので空振りにはならない）。
  - 改ざんで落ちることを実測:
    - `異常検知` の寄せを外す → `「異常検知」が 0 件しかない（会議名に書かれた英語の語で行に辿れていない）`
    - `エッジ` を `edge` に戻す → `「エッジ」が edge computing に寄っていない: expected [ 'エッジ', 'edge' ] to include 'edge computing'`
    - 寄せ先を `JP_EN` と違う語にする → `「アルゴリズム」が 0 件しかない（…）`

- **過ぎた締切の行に、根拠なく「次回予定」と書いていた**（2026-08-09 生成ビルドで実測・第 225 回）。「過去の締切も表示」で並ぶ行には一律 `締切済み（次回予定）` の印を付けていたが、収録データで次回の確認できる行は极少数だった。

  | 過去行 77 件の内訳 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 会期がまだ来ていない行 | 76 件が「次回予定」と表示 | **76 件**が「締切済み（会期がこれから）」 |
  | 次の回が収録確認できる行 | 0 件（0 件なのに全員に「次回予定」） | 「締切済み（次回予定）」は確認できた行だけ |
  | 会期も過ぎて次の回が無い行 | 1 件が「次回予定」 | 1 件は「締切済み」 |

  - 「この会議の次回は出る」という情報は、次の回を狙う研究者の動作計画に直接効く。**データが
    持っていない約束を画面がしていた**（収録契約の「締切の推測はしない」とも矛盾する）。
  - 直しは判定を 1 本に寄せる形にした。`pastDeadlineTagJa`（recommender.js）が
    (1) 会期がまだ先 → 「締切済み（会期がこれから）」、(2) 同じ会議の次の回が
    `upcomingEditionsOf`（第 220 回でドロワーに入れた正本）に出る → 「締切済み（次回予定）」、
    (3) そうでなければ「締切済み」を返す。app.js は語を書き写さずこの関数を呼ぶ。
    行の「過ぎた」判定も `deadlineRowIsPast` に寄せ、app.js の `rowIsPast` はそれに寄った
    （幅を持つ行＝時刻未確認を「表示したより前に終わった可能性がある」うちに past と呼ばない
    規則は、画面の「不確か」と同じ）。
  - 検査を 1 本追加（1,987 件）。印が出る行と過去行が一致すること、形が三つしかないこと、
    **次回予定と書いた行は必ず行の詳細に今後の会期が並ぶこと**（中核）、会期がこれからの行を
    次回予定と呼ばないこと、合成行で三つの形と「幅の途中は past でない」こと、
    画面が語を写さず正本を呼ぶことを見る。収録データには次回の確認できる過去行が 0 件なので、
    その形は合成行でしか検査できない（実データだけだと空振りになる）。
  - `rowIsPast` を正本に寄せたことで、それを `node -e` に抜き出す 3 本の検査が
    `ReferenceError: Recommender is not defined` で落ちた（第 219 回と同じ罠）。抜き出し先の
    スコープに同じ 1 本を別名で置く（`const Recommender = Rec;`）形で直した – 規則を
    テスト側に書き写さない。
  - てびきに「過ぎた締切の印」の項を立て、三つの形の意味と「前は根拠なく次回予定としていた」ことを書いた。
  - 改ざんで落ちることを実測:
    - 会期がこれからの行を「次回予定」と呼ぶ形に戻す → `次回が確認できない行に「次回予定」と書いている: expected [ 'acm-sigcite-2026', …(2) ] to deeply equal []`
    - 印の語を app.js に書き写す → `行の印が正本の語を呼んでいない: expected 'import { loadPublishedRecommendation …' to contain 'Recommender.pastDeadlineTagJa(r, Date…'`

- **公式ページの差し替えで締切が動いた行の、前の日付がどこにも出ていなかった**（2026-08-09 生成ビルドで実測・第 224 回）。

  | 見る物 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 差し替え前の締切を持つ行 | 21 行（データには `superseded_deadlines` として残っている） | 同じ |
  | その日付を貼った当たり | **その行に出会えない**（`2026-09-27` は無関係な 2 件だけ） | 前に出ていた日付（ISO・日付+曜日）を貼ると必ずその行に出会う |
  | 「延長後」の印 | 締切名に Extended と付く行だけ（既定画面 9 行 / 収録全体 33 件 → 実測 12 行） | 後ろへ延びた行にも出て 既定画面 **12 行** / 収録全体 **36 件** |
  | 「延長」で引ける行 | 18 件 | 21 件（差し替え検知 3 行ぶん増） |
  | 「前倒し」で引ける行 | 0 件 | 15 件 |

  - kamiyobi は公式ページの差し替えを検知すると前の値を `superseded_deadlines` に持つが、画面にも
    検索にも出ていなかった。前に `2026-09-27` を見た人が一覧で `2027-01-08` を見ると、
    **サイトが古いのか会議が動いたのかを判定できない**（一覧の右端と同じくらい動作計画に効く）。
  - 直しは三箇所を 1 本の正本にまとめた。`deadlineShiftLineJa`（recommender.js）が行の詳細の
    「`前に出ていた締切: 2026-09-27(日) → 2027-01-08(金)（延長）`」を組み、同じ部品から検索の語を作る。
    「延長」「前倒し」は**表示していた日付同士の関係**として書き、会議が動作を動かしたのか
    こちらの以前の記録が弱かったのかは推測しない（「締切の推測はしない」という収録契約と同じ）。
  - 印（`延長後`）は延びた行だけ。前へ動いた行に「延長後」は付けない – 印・CSV の「状態」列・検索の語は
    `statusBadgeWords` が同じ表を見るので、`isExtendedDeadline` に差し替え検知を足すだけで三箇所が揃った。
  - **索引に入れたのは日付の語だけ**。行の詳細に並ぶ文をそのまま入れると、そこに混じる時刻が
    締切欄・公式表記欄の時刻の精度を落とした（実測: 「08:59」の当たり行が 57 → 58）。第 220 回で
    今後の会期の開催地を索引に入れなかったのと同じ判断で、`YYYY-MM-DD(曜)` の形の不変条件の
    表示側に「前に出ていた締切」の行を足して、当たり増分を「画面に出している行」に留めた。
  - てびきの「延長後」の項を書き換え（元の日付を上流が持たない行と、 kamiyobi が持つ行を分けて説明）、
    実測値の検査（既定画面 12 行 / 収録全体 36 件）も更新した。
  - 検査を 1 本追加（1,986 件）。前に出ていた日付の両形での再現、行の詳細の一行の日付でその行に
    戻れること、延びた行にだけ印が付くこと、前へ動いた行が「延長後」で引けないこと、
    索引に時刻が混ざらないこと、ドロワーが built の正本を呼ぶことを見る。
    行の鍵は締切の単位まで細かくした（同じ回の抄録と論文で鍵が潰れると、兄弟が当たって誤って通る）。
  - 改ざんで落ちることを実測:
    - 印の判定から差し替えを外す → `延びた行に「延長後」の印が出ていない: expected false to be true`
    - 一行その物を索引に入れる → `検索の語に時刻が混んでいる（他の欄の精度を落とす）: expected '前に出ていた締切: 2026-09-06(日) 20:59 → …' not to match /\d{1,2}:\d{2}/`
    - 索引から差し替えの語を外す → `前に出ていた日付を貼ってもその行に出会えない: …|paper|… ← 「2026-09-05」`

- **残り欄に並ぶ「あと 51 日」をそのまま貼ると 0 件だった**（2026-08-09 生成ビルドで実測・第 223 回）。

  | 打つ物 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 残り欄のセル `あと 51 日` | **0 件**（785 行がこの形に並ぶ） | その日数を表示している行に必ず出会う |
  | `51日後` / `51 日後` / `残り51日` | 0 件 | 同じ |
  | `N 日前に終了` の N を `5日前` として打つ | 0 件 | その日に表示している行に必ず出会う |
  | `本日終了` / `まもなく` | 0 件 | 今日の暦日語で引ける（`本日` と同じ扱い） |
  | 数値だけ `51` | 日付の途中で当たって 0 件または無関係（`20` なら 542 件） | 変えていない（数値だけを day 語に寄せるのはやめた） |
  | `5日` | 「今月の 5 日」として 12 か月語（68 件） | 同じ（**数値だけの日は日数の言い方に寄せない**） |

  - 残り欄は 863 行中 785 行で `あと N 日` に並ぶのに、その語を貼った人だけ行に出会えなかった。
    原因は第 215・217・219 回と同じ型で、**空格で `あと` `51` `日` の 3 語に割れて AND になる**
    （`51` を含む hay がそもそも少ない）。表示している値が検索できない – 表のいちばん右に
    並ぶいちばん使う欄だった。
  - 直しは打ち手（検索語）側。`あと N 日` / `N 日後` / `残り N 日` / `N 日前` を語が割ける前の
    文字列で `51日後` の 1 語に寄せ（`collapseRelativeDayPhrase`）、`relativeDayGroups` が
    `明日`・`今週` と同じ経路で暦日語へ展開する。数え方は一覧と同じ **JST の暦日**
    （`offsetCalendarDay` が正本。画面の残り欄と同じ `tShown` を見る規則とも揃う）。
    件数欄には `51日後 = 2026年9月29日(火)` と解決結果を出す（黙って条件を変えない約束）。
  - **当たり増分は許す**: 暦日で引く以上、会期がその日の行も当たる（`明日` を打ったときと
    同じで、第 223 回の実測では 51 日先が表示 2 行 / 当たり 6 行）。検査は「表示している行に
    必ず出会う」側だけを見る（足りない 0 件）。
  - **数値だけの `51` は寄せない**。`5日` は「今月の 5 日」の意味で既に 12 か月語へ展開されて
    いる（第 176 回）ので、そこに日数の意味を重ねると「5日に締切の会議」が引けなくなる。
    表計算の「残り日数」列も並べ替え用に数値のまま（`deadlinesToCsv` の側）。画面の語か
    `N日後` で引ける。
  - 検査を 1 本追加。残り欄に出る N を全部集めて 5 種の打ち方（`あと N 日` / `N日後` /
    `N 日後` / `残りN日` / `残り N 日`）で全行出会いを見るほか、`5日` の 12 か月展開が
    壊れていないこと、件数欄の解決結果、他の語との AND、年跨ぎ（12/28 に `10日後` = 翌年1/7）を
    見る。画面の残り欄は built の `remain` を時計だけ固定して再現している
    （`r.t` ではなく **`r.tShown`** を渡す – 第 216 回の規則。ここを間違えると測れない）。
  - 改ざんで落ちることを実測:
    - 語組での寄せを外す → `残り欄の語を貼ってもその日数の行に出会えない:
      「あと 52 日」← 表示 18 行のうち …`（1,667 件ぶん出る）
    - 数値だけの `5日` も day 語へ寄せる → `「5日」が 12 か月語でなくなった: expected 15 to be +12`

- **行の詳細に並ぶ「今後の会期」の日程が、どこにも引けなかった**（2026-08-09 生成ビルドで実測・第 220 回）。

  | 打つ物（行の詳細に並ぶとおり） | 直し前 | 直し後 |
  | --- | --- | --- |
  | 今後の会期の日程 `2026-11-05(木)〜11-06(金)` | **56 行すべて**でその行に出会えない | 0 行 |
  | 日程の先頭 `2026-11-05`（日付だけ） | その行に当たるのは 8 行だけ（当たった 8 行も別の会） | 56 行すべて |
  | 開催地の語 `京都` / `東京` | 2 件 / 11 件 | 同じ（会場名は索引に入れないので動かず） |
  | 曜日2文字以上 `月曜`〜`日曜` | 96 / 153 / 119 / 94 / 131 / 190 / 80 件 | 同じ（会期の曜日を語として足していない） |

  - 行の詳細は「今後の会期: 2026-11-05(木)〜11-06(金) ＠オンライン」のような形を 56 行に出す
    （行になっている回より後の回を持つ物。研究会が大半）。**その回はまだ行になっていない**ので、
    その日程は表のどこにも出ず、索引にも入っていなかった。画面に書いた日付が検索で引けない –
    「次は 11 月 5 日だ」と控えた人が、あとから同じ会に辿り着けない。
  - 型は第 215 回・第 217 回・第 219 回と同じ（画面に並ぶ形を索引が持っていない）。加えて
    会期の暦日表示 `meetingRangeJa()` と今後の会期の組み立て `upcomingEditionsOf()` が `app.ts` の
    中にあり、索引を作る `recommender.ts` から見えなかった（表示と索引で実装が 2 本に分かる形）。
    両方を `recommender.ts` へ移し、行の書き方は `laterEditionLineJa()` にまとめて、
    ドロワー・0 件の案内・索引が同じ 1 本を向くようにした（app.js 側の 2 本目は削除）。
  - 索引に入れるのは**日程だけ**。併記する会場名も載せて測ると、この行の開催地欄がヨーロッパの行が
    「南米」で 118 件当たり、「ハイブリッド」がオンライン参加の記載のない行を 3 件出し、
    「別表記の寄せ」の誤爆が 11 件増えた（既存の開催地・参加形式の検査がまとめて検出した。
    第 219 回の `プライバシー` と同じ型 – 索引に入れると、その語を**表示していない行**まで当たる）。
    行の詳細にだけ並ぶ会場名は、そのまま貼っても引けない（実測 0 件。その回が行になれば
    会期欄と開催地欄が対で出るので引ける）。
  - 索引は時計で絞らない（**この行の回以外の回**をすべて載せる）。画面は「これから先の回を
    最大 3 件」なので、その集合は必ず索引に含まれる。画面と同じく時計で絞ると、ビルド後の経過で
    索引が画面より古くなる。この行の回より前の回でも、まだ開いていなければ画面に出る
    （CHES の 2026 年回と 2027 年回の組み合わせで実測 – 索引を「後の回」に絞った作りでは 0 件のままだった）。
  - 検査は新しい物 1 本と既存 1 本の拡張。新しい検査は今後の会期を出す行すべてで「日程の形を貼ると
    その行に出会う」「日付だけでも出会う」ことを見、おまけに**行の詳細にだけ並ぶ会場名ではその行が
    当たらない**ことを、その語を実際に引いて確かめる（会場名を索引へ戻すと落ちる）。
    第 217 回の「日付+曜日の形は hit 件数 = その形を書く行数」は、表示側に**行の詳細の今後の会期**も
    数え入れた（当たり増分を「画面に出している行」に限定したまま保つための更新）。
  - 改ざんで落ちることを実測:
    - 索引から日程の語を外す → `今後の会期を貼ってもその行に出会えない例: 「2026-11-05(木)〜11-06(金)」
      （日程だけの形） / 「2026-11-05」（日付だけ） / …`（56 行ぶん出る）と
      `日付+曜日の語が表示と食い違った行がある: expected [ …(11) ] to deeply equal []`
    - 会場名を索引へ載せ直す → `南米の行がヨーロッパで当たっている: expected 118 to be +0`・
      `「ハイブリッド」がオンライン参加の記載のない行を出した: expected [ 'gecco@2027@abstract', …(2) ] to deeply equal []`・
      `別表記の寄せが誤爆している行がある: expected 11 to be +0`（いずれも第 220 回に実測した失敗）

- **分野チップに並ぶ語（日本語名＋英表記の併記）をそのまま検索欄に貼ると、その分野の行に届かなかった**（2026-08-09 生成ビルドで実測・第 219 回）。

  | 分野チップの語（画面に並ぶとおり） | その分野の行 | チップをそのまま貼った当たり数（直し前 → 直し後） | 日本語名だけ（直し前 = 直し後） |
  | --- | --- | --- | --- |
  | `システム（Systems, Architecture and Storage）` | 156 行 | 0 件 → **163 件** | 163 件 |
  | `データベース（Database and Data Mining）` | 118 行 | 0 件 → **118 件** | 118 件 |
  | `高性能計算（High Performance Computing）` | 102 行 | 13 件 → **102 件** | 102 件 |
  | `人工知能（AI and Machine Learning）` | 309 行 | 55 件 → **309 件** | 309 件 |
  | `セキュリティ（Security and Privacy）` | 149 行 | 24 件 → **149 件** | 149 件 |
  | `計算理論（Theory and Algorithms）` | 44 行 | 9 件 → **44 件** | 44 件 |
  | `グラフィックス（Graphics and Multimedia）` | 61 行 | 2 件 → **61 件** | 61 件 |
  | `人間情報処理（Human-Computer Interaction）` | 18 行 | 10 件 → **21 件** | 21 件 |
  | `ネットワーク`（英表記が内部の key と同じなので併記されない） | 75 行 | 75 件 → 75 件 | 75 件 |

  - 直し前は 8 分野（全 9 分野のうち英表記を併記する物すべて）で、チップの語をそのまま貼った人だけが
    行に出会えなかった。0 件の分野だけでなく、**一部の行にだけ当たる**（人工知能 55/309）ほうが
    噓が大きい – 当たり方が分野の意味と関係なく、英語の語を偶々含む行に寄る。
  - 原因: チップは `${日本語名}（${英表記}）` の形（`site/app.ts` の chip 生成）で描き、検索索引は
    日本語名と内部の key だけを持っていた。括弧は検索語の並べ語なので、チップの語は
    `システム` `systems` `architecture` `and` `storage` に割れ、**AND なので全語を含む行が消える**。
    第 215 回・第 216 回・第 217 回と同じ型（画面に並ぶ形を索引が持っていない）に見えるが、
    今回は索引側を直すと別の語を壊したので、打ち手側を直した（次項）。
  - **索引側（各行の検索語にチップの語を載せる）は却下した**。実際に作って測ったところ、
    `セキュリティ（Security and Privacy）` を 149 行の索引に載せた瞬間、`プライバシー` が
    てびきに実測値として書いた **16 件 → 78 件**に膨らんだ（実データでも 34 件 → 149 件）。
    既存の検査「案内文に書いた実測値が、ビルド成果物に対して今も合っている」が即座に検出した
    （`案内文の「プライバシー」は 16 件 と書いてあるが、いま 78`）。索引は全文一致の語彙なので、
    画面に出る語でも索引へ入れると**他の語の当たり方を広げる**。併記の英表記は分野の別名ではなく
    日本語名の但し書きなので、語として索引に置くべきではなかった。
  - 直し方: 打ち手（検索語）側に「**分野名に続く英文字だけの括弧書き**を落とす」寄せを
    `recommender.ts` の `queryTokenGroups` の先に入れた（`CATEGORY_CHIP_HEADS_JA` は
    `CATEGORY_LABELS_JA` の値から作る。第二の正本を作らない）。英文字に限るのは、
    `人工知能（チュートリアル）` や `ネットワーク（第1回）` のように**意図した絞り込みとして
    打たれた括弧**を消さないため（閉じ括弧が無い形はコピー途中なので受け取る）。
    直し後はチップの語の当たり数が日本語名だけの当たり数とぴったり等しい（表の最後列） –
    チップをコピーした損をさせない、が目標で、広くしすぎるのは目標ではない。
  - 描画側も `Recommender.categoryChipLabelJa(key, 英表記)` の 1 本を使った組み立てに直し、
    chip 生成側に式を書き写さないようにした（索引側をやめたので、この関数は表示の正本として残る）。
  - 追加した検査は 1 本（built の `recommender.js` と `app.js` を使う）。分野ごとに
    ① チップの語をそのまま打つと、その分野の行すべてに出会うこと、② チップの語の当たり数が
    日本語名だけの当たり数と等しいこと（コピーした損をしない）、③ `日本語名（第1回）` は
    日本語名より狭いこと（括弧の中身を消しすぎていない）、④ 常時受付の行でも分野のチップが
    引けること、⑤ 分野ラベルその物に括弧が入っていないこと、⑥ 描画が正本の関数を使うことを見る。
    改ざんで落ちることを実測:
    - 寄せ自体を消す（直し前の形）→
      `チップ「高性能計算（High Performance Computing）」で 90 行のうち 14 行にしか出会えない: expected 14 to be greater than or equal to 90`
    - 括弧の中が日本語でも落とす →
      `「高性能計算（第1回）」が「高性能計算」と同じ 90 件に広くなった（括弧の中身を消しすぎ）: expected 90 to be less than 90`
    - チップの描画を日本語名だけに直す（正本を使わなくなる）→
      `expected 'import { loadPublishedRecommendation …' to contain 'Recommender.categoryChipLabelJa'`
    - 分野ラベルの正本に括弧を混ぜる →
      `分野ラベルその物に括弧が入っている: ネットワーク（networking）: expected 'ネットワーク（networking）' not to contain '（'`
  - 同じ検査ハーネスの落とし穴（第 213 回と同じ）: 検索機構を built から抜き出して組み立てる検査が
    12 本、`ReferenceError: CATEGORY_CHIP_HEADS_JA is not defined` で落ちた。`SEARCH_CANON` の注入一覧は
    依存する定義を列挙する方式なので、`CATEGORY_LABELS_JA` → `CATEGORY_CHIP_HEADS_JA` →
    `CATEGORY_CHIP_TAIL` の順で 3 件を足した（定義順を守らないと初期化順で壊れる）。
    テスト本文に子スクリプトのコードを文字列で書くとき、`` `${ja}（第1回）` `` を素のまま
    二重引用符の中に入れると `lint/suspicious/noTemplateCurlyInString` が 1 件増える（連結に直した）。
  - 参考: 今回いっしょに調べて、次は大丈夫だったもの – 主題タグ（`機械学習` など 35 語・262 行）は
    一覧・詳細と同じ中黒で並べた語もタグ単独でも全行が引ける（不一致 0）。
    未修正として記録する物: 「残り日数」列の数値（`52` を貼ると 825/863 行で 0 件）、
    「締切済み（次回予定）」の 77 行、`月`・`日` を単独で打つと月日カウンタに化けて全件になる。

- **常時受付のジャーナルにだけ出る語を、0 件の案内が「収録データにありません」と言っていた**（2026-08-09 生成ビルドで実測・第 218 回）。

  | 打つ語 | 語の当たり数（直し前 → 直し後） | 読み上げの 0 件理由 |
  | --- | --- | --- |
  | `常時受付`（種別の表示語） | 0 件 → **22 件** | 「語「常時受付」は収録データにありません」→「検索語は収録の常時受付ジャーナル 22 件に当たります（「種別」で選べます）」 |
  | `学会誌`（同義語の一覧が寄せる語） | 0 件 → **22 件** | 上の同じ形 |
  | `ジャーナル` | 1 件 → **23 件**（候補行 1 + 常時受付 22） | 「収録で 1 件…」→「収録で 1 件と常時受付ジャーナル 22 件に当たりますが…」 |
  | `ネットワーク` | 75 件 → **84 件**（候補行 75 + 常時受付 9） | 「収録で 75 件…」→「収録で 75 件と常時受付ジャーナル 9 件に当たりますが…」 |
  | `存在しない会議名ZZZ` | 0 件のまま | 「収録データにありません」のまま（直しすぎの防止） |

  - 画面の 0 件案内も同じ噓を言っていた。`常時受付` を打つと案内は条件の並べ立てだけで、
    「検索語を短くする」と助言していた（常時受付の行は 22 件あるので、短くしても行は増えない）。
    直し後は「検索語「常時受付」は収録済みの行 22 件に当たります（いずれも常時受付のジャーナルで、
    表は投稿締切を出す既定なので、「種別」で常時受付を選ぶと出ます）」を出す。
  - 原因は**同じ数の数え上げが 2 か所にあり、片方だけが古い集合を見ていた**こと。収録全体の
    当たり数を出す `queryMatchCounts` は候補行 + 常時受付のジャーナル行を数えていたが、0 件案内が
    語ごとに使う `queryTermNotes` は候補行だけを数えていた（同じ語彙に表を 2 つ持つと必ず片方が
    古くなる – 第 215 回などと同じ判断）。同じ集合に直し、プールに既に入っている行があるので
    hay で寄せた（候補行 863 件 + 常時受付 22 件の重複を除いた数）。
  - 案内の文は候補行 0 件・ジャーナル N 件のときだけ別の形にする。「表は投稿締切でこれから先の
    ものだけを出す既定」という理由はジャーナルの行には当たらないので、そのまま書くと別の噓に
    なる。読み上げは画面と同じ内訳を言う（合計だけを数えると、同じ 0 件画面で画面と読み上げが
    別の数を言い、どちらも信じられなくなる）。
  - 検査を 1 本追加。ビルド後の `app.js` の `queryTermNotes` / `emptyDeadlineHint` /
    `zeroResultLiveNote` を実際に関数ごと実行して、実データで語の当たり数が候補行 +
    常時受付の行（重複を除く）と一致すること、ジャーナル側にだけ出る語と候補行側にだけ出る語が
    両方存在すること（どちらかが無いと検査が空振りする）、候補行 0 件・ジャーナル 1 件の小さな
    データで画面と読み上げの文を組み立て、ジャーナルの行数と「種別」での選び方を出ること、
    両方に当たる語では画面と読み上げが同じ内訳の数を言うこと、本当に無い語は今までどおり
    「収録データにありません」と言うことを見る。改ざんで落ちることを実測:
    - 語の当たり数を候補行だけで数える → `語「常時受付」の当たり数が候補行+ジャーナル行と違う: expected +0 to be 22`
    - 画面の案内が候補行だけを見る → `expected '該当する締切はありません。 多いのは 「締切まで」を「かまわない」に変更（…' to contain '常時受付'`
    - 読み上げが候補行だけを見る → `読み上げがジャーナルの行を数えていない: expected ' ｜ いまの条件では行がありません…' to contain 'ジャーナル 1 件'`
    - 読み上げの内訳を合計に戻す → `読み上げが候補行の数を言っていない: expected ' ｜ 検索語は収録で 2 件に当たりますが…' to contain '収録で 1 件と常時受付ジャーナル 1 件'`
  - 参考: 今回いっしょに調べて、次は大丈夫だったもの – CSV の 14 列を 863 行すべてについて
    **セル全文コピーでその行に出会うか**を調べ、**締切・公式表記・会議・分野・種別・ラウンド・
    CCF・CORE・THCPL・会期・開催地（677 行）・状態・URL は不一致 0 件**。残る不具合は
    **「残り日数」列だけ**（数値の `52` を貼ると 825 行で 0 件。画面は「あと 52 日」と出す派生値で、
    語に入れる設計になっていない）。調べる道具側の教訓: シェルのエスケープで CSV の引用欄を
    空に読むスクリプトだと、開催地が 45 行しか無いという誤った結論になった（実測 677 行）。
    検査は必ずファイルに書いて動かす。

- **会期欄のセルをコピーして検索欄に貼ると、677 行中 559 行で 0 件だった**（2026-08-09 生成ビルドで実測・第 217 回）。

  | 打つ物 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 会期欄のセル全文 `2026-12-03(木) 〜 2026-12-04(金)` | 559 行でその行に出会えない | **0 行** |
  | 締切欄のセル全文（日付だけの行 `2026-09-30(水)` を含む） | 0 行 | 0 行（同じ要求を検査に足した） |
  | `2026-12-03(木)` の形 230 種 | 表示と件数が食い違った | **230 種すべてで hit 件数 = その形を書く行数** |
  | 曜日2文字以上 `月曜`〜`日曜` | 96 / 153 / 119 / 94 / 131 / 190 / 80 件 | 同じ（**締切欄に `(X)` と書く行数と7つとも一致**） |
  | 曜日1文字 `火` `水` `木` `金` `土` | 153 / 119 / 94 / 131 / 190 件 | 274 / 203 / 248 / 398 / 249 件（会期欄の曜日が引けるようになった分） |
  | `JST` / `20:59` / `AoE` / `時刻未確認` / `来年` / `推定` | 679 / 508 / 487 / 184 / 435 / 71 件 | 同じ |

  - 原因は二つ重なっていた。**打つ側**: 括弧は並べ語（`JOIN_WORDS`）なので `2026-12-03(木)` が
    `2026-12-03` と `木` に割れ、立った組は AND なので、どの行の hay にも無い `木` が全体を
    0 件にしていた。**索引側**: 画面に並ぶ `2026-12-03(木)` という形その物を持っていなかった。
  - 直し方も二つ。**打つ側**は `weekdayTail` を足し、日付・時刻帯に続く括弧書きの曜日を
    **割らない**（第 213 回に時刻 `23:59` を割らなかったのと同じ手）。`queryTokens` が末尾の `)` を
    落とす（`2026-12-03(木` になる）ので、閉じ括弧が無くても受ける – 落ちた形は hay 側の
    `2026-12-03(木)` に部分一致で届く。**索引側**は `eventCellJa` と `csvJstInstant` の出力から
    **画面の形そのまま**を語に入れる（第 209・213・214・216 回と同じ判断）。日付だけの行の
    `2026-09-30(水)` も `deadlineCellSearchWords` の dateOnly 枝で同じ形を入れる。
  - 第 209 回の判断（**曜日を語として索引に入れない**）は活きている。曜日を単独の語
    （`金曜` の形）として入れたのが却下した案で、その誤爆はこの直しでも起きていない:
    2文字以上の `X曜` の件数は直し前とまったく同じで、締切欄に `(X)` と書く行数と7つとも一致する
    （会期欄の語は `2027-04-09(金)` なので `金曜` を含まない）。増えるのは**1文字だけの曜日**を
    単独で打ったときだけで（`金` 131 → 398 件）、そもそも `月` `日` は月日の漢字その物に化けて
    この変更よりも前、以前から 863 件＝全件（`月` `日` を打つ利用はほぼ無い）なので、1文字の曜日は曖昧な語として受け入れた。
  - 追加した検査は 1 本。会期欄・締切欄の**セル全文コピーがその行に出会う**ことを全行、
    日付+曜日の形 230 種の**hit 件数 = その形を表示する行数**（多よせも漏れも無い）、
    `X曜`（2文字以上）が締切欄に `(X)` と書く行数と一致し続けること（誤爆の防止）、
    実在の語が1組に割れていること（打つ側が割っていないこと）、既存語の回帰。
    会議名の回帰はビルドから取った名前で見る（fixtures に特定の名前があると限らない）。
  - 改ざんで落ちることを実測:
    - 打つ側で日付と曜日を割る形に戻す → `日付+曜日の語が表示と食い違った行がある: expected [ …(58) ] to deeply equal []`
    - 会期欄の形を索引から外す → `会期欄をコピーして貼ると出会えない行が 308 件（例: DL2 Workshop 2026 の
      「2026-12-03(木) 〜 2026-12-04(金)」）: expected 308 to be +0`
    - 曜日を `金曜` の語としても索引に入れる（第 209 回で却下した案）→
      `「月曜」の件数が締切の曜日行数と食い違った: expected 136 to be 59`
  - 同じビルドで未修正として記録する物: 「締切済み（次回予定）」の 77 行・分野チップの英表記込み
    （`システム（Systems, Architecture and Storage）` が 0 件で `システム` が 163 件 → **第 219 回で直した**）・
    **`月` や `日` を単独で打つと月日のカウンタに化けて全件（863 件）になる**実態
    （今回の変更前からそう。曜日語とぶつかるので、区切るのは別の判断として分けて記録する）。

- **締切欄のセルをコピーして検索欄に貼ると、0 件だった**（2026-08-09 生成ビルドで実測・第 216 回）。

  | 打つ物 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 締切欄のセル全文 `2026-08-22 03:00 JST(土)` | **659 行でその行に出会えない**（679 行がこの形所以外に書いている） | **0 行** |
  | `JST` | 20 件 | 679 件（締切欄に `JST(` と書く行とちょうど一致） |
  | 時刻の語 `20:59` / `23:59` | 508 / 502 件 | 508 / 502 件（第 213 回のとおり表示行数と一致を維持） |
  | `AoE` / `時刻未確認` / `来年` / `複数候補のため要確認` / `推定` | 487 / 184 / 435 / 375 / 71 件 | 同じ |

  - 原因は**表示と索引が別の式を読んでいた**こと。締切欄は `csvJstInstant` が
    **公式の zone 宣言が有る無しにかかわらず** `… JST(土)` の形で書く。一方 `zoneSearchWords` は
    公式の zone 宣言を読む関数なので、宣言が無い行と AoE 宣言の行（合わせて 659 行）に `JST` が
    入っていなかった（AoE 宣言行は締切欄に `JST`、公式表記欄に `AoE` と二つ並ぶ）。
    `20:59` の語を入れたとき（第 213 回）と同じで、**表示している列を組み立てる関数に語を聴く**。
  - `timeSearchWords` を `deadlineCellSearchWords` に改名し、締切欄・公式表記欄の表示式
    （`csvJstInstant` / `fmtAoEText`）から **時刻の語と時刻帯の語（`JST`・`AoE`）をまとめて**取る形にした。
    同じ欄から出る語を別の関数に分けたままにすると、また片方が古くなる（第 213 回で時刻を入れ、
    同じ欄の `JST` が抜けた。それが今回の欠陥その物）。`JST(土)` の曜日の語は `dayTermsJa` が
    既に入れているので二重に入れない。
  - 追加した検査は 1 本。**締切欄のセルをそのまま打つと その行に出会う**ことを全行、
    `JST` の件数が表示行数とちょうど一致、**公式表記欄に JST と書かない行**（zone 宣言なし・AoE 宣言）が
    1 行以上あること＝直したpopulationを実際に踏むこと、時刻の語の表示行数と件数の一致（同じ関数を
    作り直した回帰）、日付だけの行は `JST` でも出ないこと、既存語の回帰。
  - 改ざんで落ちることを実測:
    - 締切欄の `JST` を索引から外す（第 216 回の直し前と同じ）→
      `締切欄をコピーして貼ると出会えない行が 231 件（例: ACM SIGCITE 2026 の「2026-08-03 20:59 JST(月)」）: expected 231 to be +0`
    - 画面に出していない `JST` を日付だけの行に入れる →
      `「JST」の件数が表示行数と違う: expected 435 to be 251`
  - 同じビルドで未修正として記録する物（実測値つき）:
    - **会期欄のセル全文コピーは 559 行（677 行中）でその行に出会えない**。抜けている語は
      会期欄の曜日（`2026-12-03(木)` の `木`）。第 209 回で「曜日の語だけでは数百行が引けるので
      入れない」と判断したが、その判断は**曜日を日付から割る**かぎり正しい。日付と括弧の曜日を
      まとめた語（`2026-12-03(木)`）を `eventCellJa` の出力から入れ、打った側も割らないようにすれば
      （第 213 回の `timeLike` と同じ手）、誤爆を増やさずに直せる。参考の実測: 現状 `月` は 863 件・
      `日` は 863 件（月日という漢字その物に化ける）、`火` 153 / `水` 119 / `木` 94 / `金` 131 / `土` 190 件。
    - 「締切済み（次回予定）」の 77 行・分野チップの英表記込み
      （`システム（Systems, Architecture and Storage）` が 0 件で `システム` が 163 件 → 第 219 回で直した）。

- **一覧に並ぶとおりの会議名（年を後付けした形）が、そのままでは 0 件だった**（2026-08-09 生成ビルドで実測・第 215 回）。

  | 打った語 | 直し前 | 直し後 | 内訳 |
  | --- | --- | --- | --- |
  | `ACISP 2027` | 0 件 | 1 件 | 一覧の会議名どおり。`ACISP` は直し前も 1 件 |
  | `EuroS&P 2027` / `CAiSE 2027` / `DIMVA 2027` | 0 件 | 1 件 | 同じ形 |
  | 一覧に出る会議名 429 種（うち年を後付けした形 417 種） | **26 種・影響 35 行が 0 件** | **0 種** | 会期が未定の回居多し |
  | `2027`（裸の年） | 454 件 | 498 件 | 画面に「… 2027」と書く行が増えた分 |
  | `2028` / `来年` / `今年` | 0 / 435 / 780 件 | 0 / 435 / 780 件 | 変化なし（相対語は `YYYY年M月` の語に展開されるので、会議名の年と衝突しない） |

  - 原因は索引の側が **素の `conf.title`（年なし）しか持っていなかった**こと。画面・CSV は
    `titleWithYearJa`（第 205 回で CSV を寄せた正本）で年を後付けするが、索引は別の形のままだった。
    これらの回は会期も未定なので hay の中にその年の数字が無く、**画面に並ぶ語が索引に無い語**だった。
    会議名を貼るのは最も多い検索動作なので、表示語の正本を索引にも入れる（第 209・213・214 回と同じ）。
  - 直し方は `candidateRows` の `baseHay` に `titleWithYearJa(conf.title || conf.key || "", ed.year)`
    を 1 行足すだけ。年は回ごとなので editions のループの中で組む。**CSV 組み立てと同じ呼び出し**に
    なった（文字列も同一。作業中に `s.count(old) == 1` の検査が同じ行を 2 件見つけてくれ、CSV 側を
    書き換える事故を防いだ – 置換anchorは隣の行で絞る）。
  - 雑誌行（22 件）は同じ欠陥が無いことを確かめて変更していない（表示名どおりの検索で 0 件は 0 種）。
  - 追加した検査は 1 本。CSV の会議名が `titleWithYearJa` と同じ式になっていること（検査が読む
    「画面に出る名前」の前提）、**表示名をそのまま打つとその名前を書く行がぜんぶ出ること**を全名で、
    他の語とのかけ算（存在しない語を足すと 0 件）、既存語の回帰。**空振りガード**として
    「後付けした年がその行の他の欄にも書いていない名前」が 1 件以上あることを見る
    （そういう名前だけが、年を索引に入れていなければ本当に 0 件になる）。
  - 改ざんで落ちることを実測（いずれも
    `「…2027」を書く 1 行のうち 1 行が出ていない: expected 1 to be +0`）:
    - `baseHay` から `titleWithYearJa` の行を外す
    - 年を 1 ずらして索引に入れる（画面と違う年を索引に入れない検査にもなっている）
  - 同じビルドで未修正として記録する物: 会期欄のセル全文コピー（`2027-04-06(火) 〜 2027-04-09(金)`
    が 0 件）・「締切済み（次回予定）」の 77 行・分野チップの英表記込み
    （`システム（Systems, Architecture and Storage）` が 0 件で `システム` が 163 件 → 第 219 回で直した）。

- **公式表記欄に書く AoE の日付を打つと、その行に出会えなかった**（2026-08-09 生成ビルドで実測・第 214 回）。

  AoE 宣言の締切は、一覧の締切欄に JST、公式表記欄に AoE の値が出る（AoE 23:59 は JST では翌日の
  20:59）。**863 行中 486 行**で、二つの欄の日付が違う。画面に書いてある日付をそのまま打つと、
  その行が出ていなかった。

  | 打った語 | 直し前 | 直し後 | 内訳 |
  | --- | --- | --- | --- |
  | `2026-09-24` | 3 件 | 7 件 | その日を書く行は 7 行（公式表記欄に書く行が 4 行分抜けていた） |
  | `2026-11-30` / `11月30日` | 7 件 | 13 件 | AoE が月をまたぐ行（26 行）を含む |
  | `2026年12月` | 181 件 | 182 件 | 月をまたぐ行が 1 行増える |
  | `今年` | 779 件 | 780 件 | 締切欄では 2027 年、公式表記欄では 2026 年と書く行が 1 行ある |
  | `来年` | 435 件 | 435 件 | 変化なし |
  | 総点検（行ごとに「その欄に書く日付でその行が出るか」を ISO と和暦で数える） | 5,124 組のうち **486 行・330 語が漏れ** | **0 行・0 語** | 漏れはぜんぶ公式表記欄の AoE の日付 |

  - 原因は索引の側が **JST の instant から作った日付の語しか持っていなかった**こと。
    会期欄の日付（第 209 回）と同じで、画面に並ぶのに索引に無い語だった。
  - `officialDateSearchWords` を足した。語は**公式表記欄を組み立てる `fmtAoEText` の出力から**
    取り（表示と同じ式を使う – 第 209 回・第 213 回と同じ判断）、暦日その物に加えて
    「N月」「YYYY年」の語も同じ式から入れる。AoE は常に前日なので、月をまたぐ行が 26 行・
    年をまたぐ行が 1 行あり、暦日だけでは「11月30日」「2026年」がその行を拾えない。
    曜日は足さない（公式表記欄は曜日出さず、締切欄の曜日は JST のもの）。
  - 一覧の**月のまとめ・並び順・残り日数は JST の暦日のまま**（ここは変えない）。検索の語だけが
    画面に出る二つの日付を持つ。
  - 追加した検査は 1 本で、**行単位の総点検**を入れた（その欄に書く日付を ISO と和暦の両方で打ち、
    その行が出ることを全行で見る）。0 件で空振りしないよう、公式表記欄に別の日を書く行が
    1 行以上あることも見る。多よせも見ている（当たった行がぜんぶその日を書いていること）。
    改ざんで落ちることを実測:
    - hay から公式表記欄の日付を外す → `日付を書く行のうち 163 行がその日で出ていない: expected 163 to be +0`
    - 和暦の語を足さないと → 同じ検査が `expected 163 to be +0`
    - 表示していない前日を索引に入れる（一日ずらす）→ 同じ検査が `expected 163 to be +0`
  - 検査の書き方で直した 2 点（どちらも本作成中に自分が踏んだ）:
    - **欄ごとに日付を数えると二重に数える**。会期の開始日と終了日が同じ日などは 1 行で同じ日を
      二度書くので、直ったあとも「1 件残る」ように化けた（`2026-09-30: 26/27`）。行単位で
      重複を除いて数える形にした。
    - 回帰の点で固定の日付（`2026-12-25`）を書くと、収録にその日が無いビルドで 0 件になり、
      直っていないのに落ちる。検査が自分で見つけた行の日付を使う形にした。
  - 同じビルドで未修正として記録する物: 「締切済み（次回予定）」の 77 行・会期欄のセル全文コピー
    （`2027-04-06(火) 〜 2027-04-09(金)` が 0 件）・年を後付けした会議名（`ACISP 2027` が 0 件で
    `ACISP` が 1 件）・分野チップの英表記込み（`システム（Systems, Architecture and Storage）` が 0 件 → 第 219 回で直した）。

- **締切欄・公式表記欄に並ぶ時刻が、そのまま打つと 1 件も引けなかった**（2026-08-09 生成ビルドで実測・第 213 回）。

  | 打った語 | 直し前 | 直し後 | その語を出している行数 |
  | --- | --- | --- | --- |
  | `20:59` | 0 件 | 508 件 | 508 行 |
  | `23:59` | 0 件 | 502 件 | 502 行 |
  | `08:59` | 0 件 | 88 件 | 88 行 |
  | 画面に出る時刻の語 21 種 | ぜんぶ 0 件 | 21 種すべて表示行数と一致 | 679 行がどちらかの欄に時刻を出す |
  | `8:59`（零詰めなしで打つ） | 0 件 | 88 件（`08:59` と同じ） | – |
  | `20：59`（全角コロン） | 0 件 | 508 件（`20:59` と同じ） | – |
  | 回帰確認 | `推定` 71 / `時刻未確認` 184 / `来年` 435 / `今年` 779 / `2026-12-25` 1 / `12/25` 1 / `複数候補のため要確認` 375 / `確認済み` 25 | 同じ | 変化なし |

  - 原因は二つ重なっていた。**①検索用の語を作る側が時刻を hay に置いていない**、
    **②打った語を割る側がコロンで `23:59` を二つに割り、`59` を含む行が 1 件もないので
    全体が 0 件になる**（`queryTokenGroups("23:59")` が `[["23"],["59"]]` だった）。
    片方だけでは直らない（①だけ直すと零詰めの寄せが効かず、②だけ直すと hay に語が無く 0 件のまま）。
  - ①は `timeSearchWords` を足して **画面と同じ列を組み立てる `csvJstInstant` / `fmtAoEText`
    から語を取った**（表示語を手で書き写すと表示とズレる – 第 209 回の会期欄と同じ判断）。
    AoE 宣言の行は締切欄に JST の時刻・公式表記欄に AoE の時刻が並び（同じ行に二つの時刻が
    画面に出る）ので両方入れる。時刻未確認の行（日付しか確認できていない 184 行）は時刻を
    出さないので語を入れない – 実際にこの 184 行が時刻の語で 1 件も当たらないことを確かめた。
  - ②は `dateLike`（`2026-08-22` を割らない）と同じ判断を時刻に広げた `timeLike` を入れた。
    全角コロンも受ける（全角で打っても同じ結果になる、というのはてびきの約束）。
  - 零詰めしていない入力は**打った側を画面の形に寄せる**（画面に出る 21 種はすべて `08:59` の
    形所）。元の形を同じ組に残すと部分一致で化ける – `8:59` に `08:59` の 88 行へ
    締切欄が `2026-11-09 18:59 JST(月)` の NOMS 2027 が 1 件混んだ（実測）ので、組は組み替える
    （暦日の組と同じ作り方）。
  - てびきも実装に揃えた（案内と実装のズレ）。①第 212 回に検索できる語へ直した印について、
    てびきには **863 行中 375 行に出る語がどこにも書かれておらず**、見出しは「再確認待ち・要確認」の
    ままだったので、実際に出る語「複数候補のため要確認・再確認待ち」に見出しを直し、検索の語に
    なることを書いた。②検索の項に「画面に出ている語はそのまま打てる」と時刻の例を足した。
    てびきの `<summary>` が引用符でうたった語は本文に無ければ落ちる検査が既にあるので、
    見出しの語を足す側は壊していない。
  - 追加した検査は 1 本。画面（CSV 列）に出る語ごとに **表示行数と検索件数の一致**、逆方向
    （当たった行がその語を実際に出しているか）、零詰めと全角、他の語との AND、
    `queryTokenGroups` の割れ方、時刻未確認の行が時刻で当たらないこと、既存語の回帰を見る。
  - 改ざんで落ちることを実測:
    - hay から時刻の語を外す → `「23:59」を出している 181 行と違う件数になった: expected +0 to be 181`
    - コロンで割れるままに戻す → `expected 182 to be 181`（割れた語が別な行を拾う）
    - 零詰めた形を足すだけにして元の形を残す → `時刻の語がまだ割れている: expected [ [ '23:59', '23:59' ] ] to deeply equal [ [ '23:59' ] ]`
  - 検査側で直した書き方は 2 箇所。`forEach` の本体が値を返していた形（ lint で 2 errors）と、
    使っていない引数（警告が 1 増えた）で、どちらも本作成中に gate が動いて気づいた
    （直し前の gate は 35 warnings / 63 infos、現在も同じ）。
  - 同じビルドで未修正として記録する物（次以降の候補・実測値つき）:
    - **AoE 宣言行の公式表記欄の日付が引けない**。AoE 宣言行は 487 行あり、公式表記欄に並ぶ
      AoE の暦日 165 種のうち **39 語**で検索がその日を書く行をすべて拾えない（例: AAAI 2027 の
      公式表記は `2026-09-24 23:59 AoE` で締切欄は `2026-09-25 20:59 JST(金)` – `2026-09-24` を
      打つと 3 件で、その日を書く行は 4 行ある）。
    - 「締切済み（次回予定）」の 77 行・会期欄のセル全文コピー・年を後付けした会議名
      （`ACISP 2027`）・分野チップの英表記込み（`システム（Systems, Architecture and Storage）` → 第 219 回で直した）。
  - 参考（自分を混乱させた点）: `npx biome check site` はプロジェクトの gate ではなく、
    template.html の HTML 解析で 20 errors を出す（第 213 回の以前から同じ）。gate は
    `npm run check`（= `biome check src scripts site/*.ts tests`）で、そちらは 35 warnings /
    63 infos のまま。

- **一覧に出る検証状態の印が、そのまま打つと 1 件も引けなかった**（2026-08-09 生成ビルドで実測・第 212 回）。
  | 打った語 | 直し前（検索） | 直し後（検索） | CSV の「状態」列 | 実データの状態分布 |
  | --- | --- | --- | --- | --- |
  | `複数候補のため要確認` | 0 件 | 375 件 | 0 件 → 375 件 | `manual-required` 375 行 |
  | `要確認`（語の一部） | 0 件 | 375 件 | – | 同じ行に出会う |
  | `確認済み` | 0 件 | 25 件 | 0 件 → 25 件 | `verified` 25 行 |
  | `再確認待ち` | 0 件 | 2 件 | 0 件 → 2 件 | `pending` 2 行 |
  | `変更を検出` `公式ページ取得不能` `再試行待ち` | 0 件 | 0 件 | 0 件 | このビルドに該当 0 行（語は用意済み） |
  | 回帰確認 | `推定` 71 / `延長後` 18 / `時刻未確認` 184 / `国内` 38 / `未確認` 461 / `評価なし` 144 / `システム` 163 / `来年` 435 | 同じ | – | 変化なし |

  - 一覧は 863 行中 **375 行**に「複数候補のため要確認」の印を出す（既定画面では 222 行）。その語が
    検索でも CSV でも 0 件だった。`推定` 71 件・`延長後` 18 件・`時刻未確認` 184 件が正確に引けるのと
    同じ基準では欠陥。
  - 原因は一本の比較の形の違い。検索用の語を作る `statusBadgeWords` は
    `d.verification === "unverified"`（文字列）を見ていたが、実データは
    `{status: "manual-required"}` のオブジェクト（402 行がオブジェクト、461 行は欄その物が無い）。
    画面側は `verification.status` を見ていたので、**同じ欄の違う形を二箇所が別々に読んでいた**。
  - 直し方は正本を一つにすること。`VERIFICATION_STATUS_LABELS_JA`（verified=確認済み・
    pending=再確認待ち・retryable=再試行待ち・source-unreachable=公式ページ取得不能・
    manual-required / parser-failed=複数候補のため要確認・unverified=要確認）を `recommender.ts` に置き、
    **一覧の印・行の詳細の語彙・検索用の語・CSV の「状態」列・紙の但し書き**が同じ表を見る。
    `app.ts` では `KIND_LABEL` と同じく module 直下の定数に落としている（関数の中で
    `Recommender.…` を参照すると、ビルド成果物から単独で抜き出して動かす検査が
    `ReferenceError: Recommender is not defined` で落ちる – 実際に落として気づいた）。
  - 副次的に直った物（実測）:
    - **CSV の「状態」列に検証状態が入るようになった**（0 件 → 375 件 / 25 件 / 2 件）。表計算で
      「要確認の行だけ」を選べるようになった。
    - 紙の但し書きが印の意味を説明する（この用紙に刷られる語だけを並べるという規則は、既存の検査が
      「紙に 146 行刷られる語を但し書きが説明していない」と言って教えてくれた）。
    - 行の詳細は未知の検証状態を機械の語のまま出していた（`statusLabels[...] || verification.status`）
      ので、一覧の印と同じ「再確認待ち」に揃えた。
  - 追加した検査は 1 本。built の `app.js` から `verificationAlert` を抜き出して動かし、①状態の無い行と
    確認済みの行に印を出さないこと（ここを壊すと全行に印が出る）、②状態ごとの語、③未知の語を
    機械のまま出さないこと、④検索側の語彙表と画面の語が一致すること、⑤**その印を出している行だけが
    当たり、件数が印を出している行数と一致すること**（誤爆 0）を見る。検査側には語彙表を built の
    recommender から取り出す注入行（`verificationLabelsSource`）を 6 箇所に入れた – 上の等級順
    （`rankGradeOptionsSource`）と同じやり方で、テスト側に語を書き写さない。
  - 改ざんで落ちることを実測:
    - 検索用の語を古い文字列比較に戻す → `「複数候補のため要確認」を打った行数が印を出している行数と違う: expected +0 to be 172`
    - 画面側を検索側と違う表記に書き写す → `expected '要確認' to be '複数候補のため要確認'`
  - 規則の更新をひとつ記録する。推薦画面の語が締切一覧の印刷に混入するのを「候補」の二字で張っていた
    検査は、状態列に「複数候補のため要確認」が正しく入るようになったので見張り語を
    `候補 \d+ 件` に限定した（二字では張れなくなった）。
  - 「確認済み」は一覧の印には出さない語で、行の詳細に並ぶ語だが、画面に出る語は引けるという規則で
    検索語に入れた。このビルドに `変更を検出` などの行は 0 件なので、その語の件数は測れない。



  一覧は 863 行中 **375 行**に「複数候補のため要確認」の印を出している（既定画面では 222 行）。
  行の詳細は 25 行に「確認済み」、2 行に「再確認待ち」を出す。その語を打つと**ぜんぶ 0 件**だった。
  `推定` 71 件・`延長後` 18 件・`時刻未確認` 184 件が正確に引けるのと同じ基準では欠陥。

  | 打った語 | 直し前 | 直し後 | 実データの状態分布 |
  | --- | --- | --- | --- |
  | `複数候補のため要確認` | 0 件 | 375 件 | `manual-required` 375 行 |
  | `要確認`（語の一部） | 0 件 | 375 件 | 同じ行に出会う |
  | `確認済み` | 0 件 | 25 件 | `verified` 25 行 |
  | `再確認待ち` | 0 件 | 2 件 | `pending` 2 行 |
  | `変更を検出` `公式ページ取得不能` `再試行待ち` | 0 件 | 0 件 | このビルドに該当 0 行（語は用意済み） |
  | 回帰確認 | `推定` 71 / `延長後` 18 / `時刻未確認` 184 / `国内` 38 / `未確認` 461 / `評価なし` 144 / `システム` 163 / `来年` 435 | 同じ | 変化なし |

  - 原因は検索用の語を作る側の一本の比較だった。`recommender.ts` の `statusBadgeWords` が
    `d.verification === "unverified"` を見ていたのに対し、実データの形は
    `{status: "manual-required"}` のオブジェクト（402 行がオブジェクト、461 行は欄その物が無い）。
    画面側は `verification.status` を見ていたので、**画面と検索で同じ欄の違う形を見ていた**。
  - 直し方は正本を一本化すること。`VERIFICATION_STATUS_LABELS_JA`（verified=確認済み・
    pending=再確認待ち・retryable=再試行待ち・source-unreachable=公式ページ取得不能・
    manual-required/parser-failed=複数候補のため要確認・unverified=要確認）を `recommender.ts` に置き、
    **一覧の印（`app.ts` の `verificationAlert`）・行の詳細の語彙・検索用の語**の三箇所が同じ表を
    見るようにした。行の詳細は未知の状態を機械の語のまま出していた（`statusLabels[...] ||
    verification.status || "未確認"`）ので、ここも画面の印と同じ「再確認待ち」に揃えた。
  - 「確認済み」は一覧の印には出さない語だが、行の詳細に出る語なので検索語には入れる
    （画面に出る語が引けない状態を無くす、という規則側の判断）。
  - 追加した検査は 1 本。built の `app.js` から `verificationAlert` を抜き出して動かし、
    ①状態の無い行と確認済みの行に印を出さないこと（ここを壊すと全行に印が出る）、②状態ごとの語、
    ③未知の語のときに機械の語をそのまま出さないこと、④検索側の語彙表と画面の語が一致すること、
    ⑤**その印を出している行だけが当たり、件数が印を出している行数と一致すること**（誤爆 0）を見る。
    改ざんで落ちることを実測:
    - 検索用の語を古い文字列比較に戻す → `「複数候補のため要確認」を打った行数が印を出している行数と違う: expected +0 to be 172`
    - 画面側を検索側と違う表記に書き写す → `expected '要確認' to be '複数候補のため要確認'`
  - 参考: 同じビルドで未修正として記録してあった物のもう一箇所（締切欄の時刻の語・会期欄の
    セル全文コピー・年を後付けした会議名・分野チップの英表記）は、今回のラウンドでは直していない。

- **「ポスター募集」など、収録語に言い方を足した复合の検索語が 0 件だった**（2026-08-09 生成ビルドで実測・第 211 回）。

  表側の語そのもの（`ポスター`・`特集号`・`研究会`）は引けるのに、そこに「募集」「投稿」「発表」を
  足した言い方だけ表に無く、0 件になっていた。`ポスター発表` は表にあったので、**同じ形の言い方が
  抜けただけ**の箇所がある。

  | 打った語 | 直し前 | 直し後 | 寄せた先 |
  | --- | --- | --- | --- |
  | `ポスター募集` / `ポスター投稿` | 0 件 / 0 件 | 6 件 / 6 件 | 原文の poster（`ポスター` と同じ 6 件） |
  | `特集号募集` / `特集号投稿` | 0 件 / 0 件 | 15 件 / 15 件 | 会議名に出る『特集号』（`特集号` と同じ 15 件） |
  | `研究会発表` | 0 件 | 23 件 | 会議名に出る『研究会』（`研究会` と同じ 23 件） |
  | `学会誌` / `ジャーナル` | 0 件 / 1 件 | 一覧では 0 件・1 件（種別を「常時受付」にすると 22 件） | 種別ラベル「常時受付」 |

  - `学会誌` は一覧に並ぶ行を増やさない。常時受付の期刊は既定の一覧プールに入らないためで、
    0 件の画面には「常時受付のジャーナル N 件は『種別』で選べます」の案内が既に出る。
    件数欄には「『学会誌』は種別『常時受付』で探しています」が加わる。
  - **寄せないことを実測で決めた語**（寄せ先が画面に出ない語に化ける、または寄せても 0 件のため）:
    - `シンポジウム発表` – `シンポジウム` で当たる行の会議名は `SCIS 2027`・`IOTS 2026` で、
      画面に「シンポジウム」の語が出ない。表の不変条件（**画面に出す語へ寄せる**）に反する。
    - `学会誌` を原文の `journal` へ寄せるのも同じ理由でやめた（当たる行の会議名は `IJGCA 2026`）。
    - `テクニカルレポート`（`report` が 0 件）、`連合学習`・`説明可能AI`・`自動運転`（原文側の
      `federated`・`explainable` も 0 件）、`招待講演`・`査読付き`・`ベストペーパー`・`採択率`
      （原文側も 0 件）は収録に無い語なので寄せない。`自動運転` だけ `autonomous` が 10 件あるが、
      これは `Autonomous Agents and Multiagent Systems` のような別概念の語で、寄せると誤った行が出る。
  - 追加した検査は 1 本。复合の言い方が寄せ先の語と**同じ件数**を出すこと、学会誌・ジャーナルが
    常時受付の行（built の `journalRows`）で同じ件数になること、件数欄の「こう探しました」に語が
    出ること、そして**寄せ先が built の CSV の会議欄に実際に現れる語であること**（画面に出る語への
    寄せという不変条件を検査にする）を見る。改ざんで落ちることを実測:
    - `ポスター募集` の項を消す → `「ポスター募集」が 0 件のまま（寄せが効いていない）: expected 0 to be greater than 0`
    - 寄せ先を `特集号` から `journal` に書き換える → `「特集号募集」が寄せ先「特集号」と違う件数を出した: expected 6 to be 15`
  - 既存の言いゆれ吸収は動いていない（`スパコン` 87 件 ≥ 分野「高性能計算」81 件、`論文募集` 454 件 =
    種別「論文締切」454 件、`ポスター` 6 件・`特集号` 15 件・`研究会` 23 件は据え置き）。
  - 参考（同じビルドで読み取り専用の監査を約 6,900 ケース走らせ、**直っていない欠落を実測で特定した**。
    次の回の対象として記録する。いずれも自分で数え直した数字）:
    - 印の表示語が 1 件も引けない – `複数候補のため要確認` 0 件（375 行が出している）、`再確認待ち` 0 件（2 行）、
      `確認済み` 0 件（行の詳細で 25 行）、`締切済み（次回予定）` 0 件（77 行）。`推定` 71 件・`延長後` 18 件が
      正確に引けるのと同じ基準では欠陥で、hay 側の語を作る箇所が検証状態の形（`{status: "manual-required"}`）を
      文字列と比較しているため語が 1 つも入らないのが原因。
    - 締切欄・公式表記欄に出す時刻の語が 0 件（`20:59`・`23:59`・`08:59` など 21 語すべて 0 件、
      863 行中 679 行が表示）。加えて `23:59` が 2 桁の語に割れて年へ展開され、`59` が 0 件で消える。
    - 会期欄のセルをそのままコピーすると 0 件（`2027-04-06(火) 〜 2027-04-09(金)` → 0 件、日付だけなら 17 件）。
      曜日の 1 字が必須語になり、曜日の語が締切の日からしか作られないため。
    - 年を後付けした会議名が引けない行がある（`ACISP 2027` 0 件 / `ACISP` 1 件）。
    - 分野チップに併記する英表記込みの語が引けない（`システム（Systems, Architecture and Storage）` 0 件 /
      `システム` 163 件）。

- **一覧の会期欄に並んでいる日付をそのまま打つと、その日を表示している行が 1 行も出なかった**（2026-08-09 生成ビルドで実測・第 209 回）。

  会期欄は `2026-12-03(木) 〜 2026-12-04(金)` の形で ISO 日付を出している。built の
  `candidateRows` + `eventCellJa` + `searchMatcher` を実行して数えると、会期欄に並ぶ ISO 日付は
  延べ **1,214 箇所・230 種**で、そのうち **1,172 箇所は会期にその日を書く行自身が引けなかった**
  （ISO でも `12月3日` でも）。検索で残った行は、締切の日付がたまたま同じ日だっただけの 4 件。

  | 検索語 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `2026-12-03` | 4 件 | 6 件（3 件は締切が別の日の会期の行） |
  | `12月3日` | 4 件 | 6 件 |
  | `2027-04-06` | 0 件 | 17 件（17 件すべてが会期で当たった行） |
  | `2026年12月3日` | 4 件 | 6 件 |
  | `12月` | 181 件 | 181 件（会期の月語は入っていた） |
  | `金曜日` | 131 件 | 131 件（会期曜日は入れない – 下記） |

  月語は会期の開始・終了から hay に入っていた（`monthTermsJa`）が、**日付の語は締切の暦日から
  しか作っていなかった**（`dayTermsJa` の呼び出しが締切だけ。コメントにも「会期は締切ではないので
  足さない」とあった）。会期欄の日付は表に並ぶ語なので、表示と同じ `eventCellJa` から取り直す。

  - 直し方: `isoDayJa`（`calendarDateJa` を使った ISO 暦日の語）と `eventDaySearchWords`
    （会期開始日・終了日の `dayTermsJa` + ISO）を `recommender.ts` に足し、締切行の hay に
    加える。表示と同じ式から取る（表示と違う欄を索引に足すと、引ける語と見える語がまたズレる）。
  - **曜日は足さない**と決めた（表示は `2026-12-03(木) 〜 2026-12-04(金)` と曜日二つを出すが、
    会期終了日の曜日を検索語に入れると `金曜日` が **131 件 → 398 件**に膨らみ、締切の曜日で
    絞り込もうとする人が使えなくなる。締切の暦日が金曜の行は 131 件で、`金曜日` の件数と一致）。
    会期の日付で選びたい人は列の「会期」順で並べ替える道があるので、てびきにその書き方を書いた。
  - 追加した検査は 1 本。built の `candidateRows`・`eventCellJa`・`searchMatcher` を使い、
    ①会期欄の日付を ISO・`12月3日`・`2026年12月3日` の三形で打って、表示している行に当たるか
    （全箇所）②会期欄の日付を 400 箇所以上読めているか（空振り防止）③「会期でしか当たらない」
    行が 20 箇所以上あるか（締切の日付を足し直しているだけの偽りの直しを防ぐ）④`金曜日` の件数が
    締切の暦日が金曜の行数と一致するか（会期曜日の混ざり検出）を見る。
    改ざんで落ちることを実測:
    - 会期の日付を検索語から外す → `会期欄の日付が引けない箇所が 469 箇所有る: expected '2026-12-03（DL2 Workshop） / 2026-12-04…' to be ''`
    - 曜日も足す（却下した設計）→ `会期の日曜日が「金曜日」の検索に混ざった: expected 176 to be 67`
  - 私のミスの記録 2 件:
    1. `searchMatcher(語, now)` が返す関数は **hay 文字列**を受ける（行オブジェクトを渡すと
       `hpc` でも `3DV` でも 0 件になる）。最初はこの使い間違いで「会期の日付が全部 0 件」を
       含めて何もかも 0 件と誤計測し、締切の日付まで引けないと思い込んだ。当た語（`hpc` 108 件）を
       入れて検査の組み立てを直した。
    2. 改ざんの戻しで、同じ备份パスを 1 本目の復元に使い、`cp` した直後に `rm -f` で消していた。
       2 本目の改ざんを戻せず、曜日を足した行がファイルに残った（`grep` で発見して復旧）。
       改ざんごとに別の备份パスを使い、復元が済むまで消さない。
  - てびきの「検索」に、日付の引き方（三つの形・締切と会期の両方を見る）と、会期で選ぶときは
    「会期」順を使う書き方を追記した。

- **紙の但し書きが「公式表記」列を収録元の締切名の分類だと説明し、その読み方の人が行を 1 行も出せなかった**（2026-08-09 生成ビルドで実測・第 208 回）。

  第 182 回に紙へ載せた但し書きの 1 文が `「公式表記」は収録元がその締切に付けた呼び方そのもので、
  上の「種別」とは別の分類です` だった。列の実物（built の `deadlinesToCsv` を実行して数える）は
  ちがう物だった:

  | 公式表記列の値（日付・時刻を伏せて種類別） | 件数 |
  | --- | --- |
  | `2026-07-21 23:59 AoE` の形（公式がAoE宣言） | 487 件 |
  | `時刻未確認` | 184 件 |
  | `UTC` | 85 件 |
  | `PT ／ UTC`・`PDT ／ UTC`・`PST ／ UTC` | 31 / 12 件 |
  | `UTC-12 ／ UTC` | 22 件 |
  | `JST` | 20 件 |

  値は全部で 18 種、**中身はいつ締めるかの宣言**（SPEC §4 が「日時列の 2 段目は公式表記の注記とし
  `officialZone`（`tz_raw` の正本）で決める」と定めているとおり）。一方、収録元が締切に付けた名
  （`dl.label` の `Abstract registration`・`Submission deadline` など）は候補行 863 行すべてに
  入っているのに、**公式表記列には 1 行も入っておらず**、種別列の値（論文締切・概要締切など）との
  重なりも 0 だった。この説明を信じて表計算で「公式表記」を締切名の分類として絞り込んだ人は、
  探している行を 1 行も出せない。

  - 直し方: 但し書きの 1 文を列の実物に寄せた
    （`「公式表記」はいつ締めるかを収録元の宣言どおりに書いた列で、AoE や UTC などの宣言と、
    日付しか確認できていない行の「時刻未確認」が入ります。締切の種類は「種別」に出します`）。
    画面のてびきの「日時」は以前から「2 行目は公式ページの表記で」と正しく書いていたので、
    直したのは紙の側の 1 文だけ。
  - 追加した検査は 1 本。built の `printLegendJa` と `deadlinesToCsv` を実行し、①公式表記列の実値に
    見当たらない語を説明が挙げていないか（説明が列の実値に触れている語 2 つ以上）②種別列の値が
    公式表記列に 1 つも入らない前提が今も成立つか ③値の種類数が検査の空振りを防ぐ下限（公式表記 5 種・
    種別 3 種）以上かを見る。列の名前も語も検査に書き写さず、built から取る。
    改ざんで落ちることを実測: 古い 1 文に戻すと
    `但し書きの公式表記の説明が、列の実値（AoE・UTC・時刻未確認）のどれにも触れていない: expected 0 to be greater than or equal to 2`
  - 私のミスの記録: 1 回目の計測で CSV の行を `,` で素直に割ったため、開催地
    `"Alicante, スペイン / オンライン"` の読点で列がずれ、`状態` が ` スペイン / オンライン"` と化けて
    「863 行すべてが食い違い」と誤検出した。引用符の中で二重化される引用符を扱う解析に書き直して
    数え直した（第 202 回と同じ穴に再び落ちた）。
  - 第 182 回の監査表の「中身は収録元の呼び方そのまま」という行が、この噓の出発点だったので、
    そこに訂正の注記を入れた。

- **推薦画面の印刷物が「候補 20 件」と刷れて、残り 94 件が紙に無いことを分からなくしていた**（2026-08-09 生成ビルドで実測・第 204 回）。

  締切一覧の印刷は `beforeprint` で「もっと見る」を全部押して<strong>全行</strong>を紙に出す（てびきも
  そう書いている）。推薦画面の枝はそこで `return` していて、描画済みカードは 20 枚のまま。
  `fillPrintMeta` の推薦画面の枝は `#recommendationCards` の子要素数を数えるので、見出しは
  「候補 20 件」になる。画面の件数欄は「あなたの論文に合う投稿先 114 件（まず上位 20 件を表示）」。
   built の `fillPrintMeta` を組み立てて実測:

  | サンプル論文 | 画面の件数欄 | 直し前の紙の見出し | 直し後 |
  | --- | --- | --- | --- |
  | Deep Learning for Resource Scheduling…（候補 114 件） | 114 件（まず上位 20 件を表示） | **候補 20 件** | 候補 114 件（紙は 114 枚） |
  | HPC の論文（候補 55 件） | 55 件 | 候補 20 件 | 候補 55 件 |

  研究室の会議に紙を配った人が、候補が 20 件しかない（論文が合う場がそれだけ）と読む。

  - 直し方 2 手数:
    1. `beforeprint` の推薦画面の枝でも、候補が全部描画されるまで `drawMoreCards()` を回す
       （表の枝と同じ。`printExpanded` を立てるので `afterprint` の `render()` で画面は
       上位 20 件に戻る）。見出しは描画の<strong>うしろ</strong>に書かないと 20 枚を数える。
    2. `fillPrintMeta` は枚数と候補の総数がちがうとき両方を書く
       （`候補 114 件のうちこの用紙に 20 件（続きは画面の「さらに表示」）`）。上の処理が
       後で外されても紙が噓をつかないようにする保険。
  - 追加した検査は 2 本。1 本目は `fillPrintMeta` をビルド成果物から抜き出し、用紙に載る枚数と
    候補の総数を引数で変えて、①多いときは両方の数と「さらに表示」を書く ②全部載っているときは
    「この用紙に」を足さない ③枚数が違えば見出しも変わる（空振り防止）を見る。2 本目は
    `"beforeprint"` の処理本体を括弧対応で抜き、`drawMoreCards(` が有ること、それが
    `fillPrintMeta();` より前に有ることを見る。
    改ざんで落ちることを実測:
    - 見出しを枚数だけに戻す → `用紙に載る枚数より候補が多いのに、枚数だけを候補の数として書いている: expected '…候補 1 件 ／…' to contain '候補 3 件のうちこの用紙に 1 件'`
    - カードを足す処理を戻す → `印刷前に推薦のカードを足す処理が無い: expected '…' to contain 'drawMoreCards('`
  - 私のミスの記録: 検査で `Recommender` の最小スタブを渡したら `Recommender.unconfirmedLabelJa is not a function`
    （但し書きの組み立てが正本の語を使うので、スタブでは足りない）。built の `recommender.js` を
    読む形に直した。また検査の組み立てで `app.indexOf("beforeprint")` を使ったら、**私が書いた注釈の
    語**に当たって「処理にカードを足す行が無い」と誤検出した（引用符付き `"beforeprint"` を
    探すように直して正しく「有る」）。てびきの文も「候補 N 件」の説明しか無く、紙に候補が
    ぜんぶ載ることを書いていなかったので追記した。

- **「締切まで 7 日以内」を選ぶと、同じ画面が「あと 7 日」と出す行が窓から落ちた**（2026-08-09 生成ビルドで実測・第 203 回）。

  第 202 回で「残り」を JST の暦日に揃えたので、窓（`windowLimitMs`）との基準がずれた。窓は
  経過 24 時間（`now + N 日`）で切り、行の比較は `row.t`（表示している暦日ではない）を見ていた。

  | 「締切まで」の選択 | 修正前:「あと N 日」と出ているのに窓に並ばない行 | 修正後 | 窓の件数の変化（JST 09:00 の眺め・検索対象 863 行） |
  | --- | --- | --- | --- |
  | 7 日以内 | **10 件** | 0 件 | 41 件 → 51 件 |
  | 30 日以内 | 5 件 | 0 件 | 209 件 → 214 件 |
  | 90 日以内 | 2 件 | 0 件 | 537 件 → 539 件 |
  | 180 日以内 | 0 件 | 0 件 | 786 件 → 786 件 |

  漏れは見る時刻で動いた（JST 09:00 で 10 件、20:00 で 8 件、翌朝 06:00 で 5 件）。逆方向も在った:
  `row.t` が JST 2026-09-09 19:00 なのに締切欄には `2026-09-10` と出る行が 10 件あり、
  「30 日以内」に並びながら「あと 31 日」と出ていた（JST 06:00 の眺めで 9 件）。**一週間以内を
  見たい人が、一週間以内と書かれた行を見落とす**形。

  - 直し方 2 手数:
    1. 窓の上下の端を **JST の暦日**で切る（`windowLimitMs` は n 日後の暦日の終わり際、
       `windowFloorMs` は n 日前の暦日の始まり。「過去の締切も表示」と併用したときの前後の窓も
       同じ基準）。
    2. 窓の比較を、行が**表示している暦日**（`tShown`）でやる（`remain`・締切欄・CSV の残り列が
       そこを見ているので、`row.t` で比べると締切欄に書いた日付より 1 日早く窓から出る）。
  - 追加した検査は 2 本（`tests/build_golden.test.ts`）。1 本目は窓の式・「残り」・行の日付を
    ビルド成果物から抜き出し、4 時刻 × 4 窓 × 全行で「あと N 日以下の行が窓に並ぶ」「窓に並ぶ行は
    N 日以下」の両方が 0 件で無いことを確認する（直す前の式では窓の外だった行が在ること＝空振り
    防止も含める）。2 本目は窓の比較が表示暦日を使っていること（端を暦日にしても比較する値が
    `row.t` のままでは同じ噓が残るため）。
    改ざんで落ちることを実測:
    - 窓の端を経過 24 時間に戻す → `「あと 7 日」の CAFCW 2026 が「7 日以内」に並ばない: expected false to be true`
    - 比較を `row.t` に戻す → 2 本目が `窓の比較が行の表示暦日を使っていない` で失敗
  - 既存の 1,966 件はこの変更で落ちなかった（窓の件数を固定していた検査は無かった）。
  - 収録データ・締切日・CSV は変えていない。

- **一覧の「残り」だけが、同じ行の日付欄より 1 日少なく、見る時刻で動いていた**（2026-08-09 生成ビルドで実測・第 202 回）。

  過ぎた締切の日数は **JST の暦日差**で数える（第 91 回でそこを直し、`dataAgeNoteJa` も
  「残りは JST の暦日が正本」と書いている）。だがこれからの締切の日は数え方が別で、
  **経過 24 時間**の floor を出していた。締切の時刻が今の時刻より一日のうち早いと 1 日切り捨てられる。
  日付欄の暦日（`tShown` は表示している暦日の JST 正午）と突き合わせると:

  | 眺める時刻（JST） | 一覧に並ぶこれからの行 | 日付欄から数えた日数と「残り」が 1 日ずれる行 | 直し後 |
  | --- | --- | --- | --- |
  | 8/9 09:00 | 786 行 | 97 行 | 0 行 |
  | 8/9 20:00 | 785 行 | **320 行** | 0 行 |
  | 8/10 06:00 | 785 行 | 7 行 | 0 行 |

  締切の日付は動くはずが無いのに、数字だけ閲覧者の時計で動く。実例（JST 20:00 の眺め）:
  締切欄 `2026-08-25` の行が「あと 15 日」（暦日では 16 日）、`2026-09-30` の行が「あと 51 日」
  （暦日では 52 日）。**日付欄から今日を引いて逆算する人が 1 日損をする**形。

  - 直し方: `remain()` のこれからの枝を暦日差にした。ただし 24 時間未满の行はそのまま
    「まもなく」/「あと N 時間」に出す（暦日が 1 日違っていても「あと 2 時間」を「あと 1 日」と
    言わない。急ぎを過小に見せないためで、表計算の欄も 0 のまま）。
  - ダウンロード CSV の「残り日数」も同じ暦日差に揃えた（過ぎた側は既に揃っていて、先の側だけ
    経過時間の floor だった。CSV 側の実装コメントが「先の分は画面も経過時間の floor なので
    同じ式」と書いていた文が、画面の規則が変わったあとに残っていた）。
  - 追加した検査は 1 本（`tests/build_golden.test.ts`）。画面の `remain` をビルド成果物から
    抜き出し、同じ行を JST の朝・夕方・深夜の 3 時刻で眺めて、**「N 日」と出た全行が日付欄の
    暦日差と一致する**こと、時刻で出る行は 24 時間未满側だけのこと、そして直す前の数え方と
    実際に値が変わる行が在ること（空振り防止）を見る。時刻で出る枝は、いちばん近い締切の
    30 分前という時計を日付から作って通す（収録に 24 時間以内の行が無いビルドでも回る）。
    改ざんで落ちることを実測:
    - 画面だけ経過 24 時間に戻す → `ARTMAN 2026 の「あと 22 日」は JST の暦日 23 日とずれている: expected 22 to be 23`
    - CSV だけ経過 24 時間に戻す → 既存の検査が `画面と CSV の残り日数が食い違う行がある` で失敗
  - 検査を組み立てる間で私のミス 2 件: 時刻で出る行を要求したら収録に 24 時間以内の行が無く
    空振りした（時刻を出す枝が一度も通っていなかった）ので、時計を日付から作る形に直した。
    また検査関数を `async` に書き損ねて `error TS1308` が出た（`await import` を使うため必要）。
  - 収録データ・締切日・CSV の列構成は変えていない（`残り日数` は数値のままなので表計算での
    並べ替え・絞り込みはそのまま使える）。
- **「入力の例」が教えた掲載先が、候補の中から黙って消えていた**（2026-08-09 生成ビルドで実測・第 201 回）。

  画面が出している語をそのまま検索して 0 件になる物が無いか、built の成果物で網羅的に調べた
  （行の全ソース 911 行、画面の語 82 語）。0 件になった 49 語の内訳はボタン名・列の見出し・
  てびきの見出しなどで、検索の対象ではないものばかりだった（誤り無し）。ただ 1 語、推薦画面の
  「入力の例」が打ち込んでくれる**掲載先**が行に見当たらなかった。

  | 調べたこと | 実測 |
  | --- | --- |
  | 例の 1 件が指定する掲載先 | `IEEE RTSS` |
  | その掲載先が検索対象の行にあるか | 0 行（863 行の中に RTSS は無い） |
  | その例で出る候補の数 | 44 件（スコア 10 以上を通った数） |
  | 画面の状態 | 掲載先欄は `IEEE RTSS` のまま、候補リストには RTSS が無い |

  候補はタイトルとキーワードから別に出るので画面は動いており、**例どおりに押すと探している掲載先だけが
  音もなく消えた**。利用者は「推薦は役に立たない」「このサイトはリアルタイムシステムの会議を知らない」
  と読む。

  - 直し方: 判定を recommender に置いた（`unmatchedVenues`）。一致の見方は既存の
    `venueCategories` と同じ正本（会議の key・略称・正式名称）を使い、書き分けによるズレを防いだ。
    文も recommender に置いた（`venueLookupNoticeJa`。built の成果物から検査できるようにするためで、
    「評価なし」などの画面の語をこの文件が持っているのと同じ置き方）。件数欄はこうなる:
    `あなたの論文に合う投稿先 44 件（まず上位 20 件を表示） ｜ 掲載先に入れた「IEEE RTSS」は、いま締切が並んでいる会議に見当たりません（収録していないか、まだ締切が出ていません）。候補はタイトル・キーワードから出しています`
  - 「見当たりません」は**誤って言う側だけ厳しく**作った。名前の照合に当たらなくても、その語で行が
    引けるときは黙る（第 201 回の実測: 掲載先 `情報処理学会` 11 行 / `電子情報通信学会` 13 行 /
    `USENIX` 15 行 / `ACM` 140 行 / ` IPSJ ` 17 行 / `USENIX FAST` 4 行はいずれも黙る。
    入力の例 5 件でおしらせが出るのは `IEEE RTSS` の 1 件だけ）。
  - 追加した検査は 2 本。1 本目は入力の例の掲載先を built の `index.html` から拾い、
    「その語で行が引けるのに黙っている」「どの行にも当たらないのに黙っている」の両方を落とす
    （語も件数も書き写さない）。2 本目は UI の組み立てが繋がっていること（外れたら落ちる）。
    改ざんで落ちることを実測:
    - 常に空を返す → `掲載先「IEEE RTSS」はどの行にも当たらないのに黙っている: expected [] to deeply equal [ 'IEEE RTSS' ]`
    - 検索文の照合を外す → `その語で行が引けるのに「第1ラウンド」を「見当たりません」と出した`
    - 件数欄から外す → `built の app.js おしらせを件数欄に載せていない`
  - 私のミスの記録 3 件:
    1. `filter` を built から抜き出して実行する既存検査が、`Recommender` の欄を自前で持っており、
       新しい呼び出しで `TypeError: Rec.unmatchedVenues is not a function` を起こした。抜き出し検査の
       欄も同じ表面に合わせて足した（実装側を Defensive にして誤魔化さない）。
    2. 「必ず見当たらない語」の検査を、実在の会議名に語を足して作ったら名前の照合が「当たり」と
       判定して通らなかった（作り手の誤りで、実装は正しい）。検索でも名前でも当たらない語に作り直した。
    3. biome の警告を 1 本増やした（35 → 36）。`!venues || !venues.length` を長さの比較に直した。
  - 収録データ・CSV・締切日は変えていない。
- **収録されているのに、日本語の言い方で引けなかった概念**（2026-08-09 生成ビルドで実測・第 197 回）。

  検索対象 863 行で、修正前 → 修正後の件数:

  | 打ち込んだ語 | 修正前 | 修正後 | 寄せた先 |
  | --- | --- | --- | --- |
  | `ポスター` / `ポスター発表` | 0 件 | 6 件 | 原文の poster |
  | `デモ` / `デモ発表` | 0 件 | 7 件 | 原文の demo |
  | `チュートリアル` | 0 件 | 6 件 | 原文の tutorial |
  | `特別セッション` | 0 件 | 3 件 | 原文の special session |
  | `学生セッション` | 0 件 | 1 件 | 原文の student |
  | `論文募集` | 0 件 | 454 件 | 種別「論文締切」 |

  対照として同じ語列を修正前のビルドと突き合わせた結果、動いたのは上の 8 語だけで、
  `スパコン`・`機械学習`・`情報処理学会`・`概要締切`・`評価なし`・`nsdi27`・`抄録`・`会期` など
  18 語は件数が変わっていません。

  - 原因: 上流のラベルは `1st Round Poster Submission` のように英語で書かれ、画面の種別は
    「その他」しか出さない。行の検索文に日本語の「ポスター」が存在しないので、日本語で打った人だけ
    0 件になり「収録が無い」と読むしかなかった。
  - 直し方: 言い方の対応表 `QUERY_SYNONYMS_JA` は**展開語が列に出るラベルでなければならない**
    （別の検査がそれを見ている）ので、`poster` のような上流原文の語は載せられない。曜日の語と
    同じ理由で `UPSTREAM_TEXT_QUERY_SYNONYMS_JA` を分けて入れ、同じ入口で繋いだ。
    並べた語は収録データに実在する物だけに限る（実在しない語を寄せても 0 件のまま）。
  - `論文募集` を原文の `paper` に寄せない: 採否通知などのラベルにも出る語で、寄せ先として誤って
    いた（実測: 入れた形では 503 件出て、その中に種別「採否通知」の行が混ざった）。画面の種別の語
    「論文締切」だけに寄せて 454 件。
  - 件数欄のおしらせは寄せた語をそのまま言う（`「ポスター」は原文の poster という語で探しています`）。
    画面上に対応する語が無い寄せ方なので、原文の語だと書く。
  - 追加した検査は 2 本。表の語は built の `recommender.js` から正規表現で拾い、件数は built の行に
    対して数える（語も件数も書き写さない）。改ざんで落ちることを実測:
    新しい表を繋がないと `語「ポスター」が展開語「poster」と同じ行に出会えていない: expected 0 to be
    greater than or equal to 5`、`paper` を戻すと `語「論文募集」で出た行の種別が「論文締切」ではない:
    expected '採否通知' to be '論文締切'`。
  - 制限（このラウンドで解決していないこと）: 対応表に無い複合語（`ポスター募集` など）は
    引き続き 0 件。漢字で書かれた語をかなの読みで引く索引も作っていない（第 196 回に測ったとおり、
    それは画面が出している語形ではないので欠陥には数えない）。
  - 私のミスの記録 2 件:
    1. 「関係の無い語が動いていないか」の突き合わせで、修正前の件数を**記憶から並べて**しまい
       7 語が動いたと誤読した（実際に同じ語列を修正前のビルドで走らせると、動いたのは意図した 8 語
       だけだった）。以後はこの種の突き合わせを必ず同じスクリプトの A/B で取る。
    2. 検査の正規表現で寄せ先の語の末尾に空白を要求して 0 件になり、検査が空振りした
       （`built の JS は \uXXXX に化ける`という前提でコメントまで書いたが、実際は UTF-8 のまま
       出ていた。前提を実測せずに書いた）。正規表現とコメントを直した。
- **使えるべき操作が実は効いていない箇所が無いか、6つの疑いを測って潰した**（2026-08-09 生成ビルドで実測・第 196 回）。実装の変更は無く、確定した事実はこの節に留める（同じ疑いを次のラウンドで調べ直さないため）。

  | 疑い | 実測 | 結論 |
  | --- | --- | --- |
  | 半角カタカナで貼ると検索が効かない | 収録データに実在する濁点付きカタカナ語 7 語で、全角と半角の件数が一致（シンガポール 15 / ハンガリー 8 / ポルトガル 3 / ブルガリア 2 / キャンパス 3 / ハイパフォーマンスコンピューティング 3 / パターン 2 件） | 効いている（検索は両側を NFKC に寄せている） |
  | 画面が見せる 3 つ目の評価 THCPL が機械可読な表から抜けている | `data.csv` に列は無いが、`llms.txt` の利用上の注意に `comment・tags・thcpl ランクは列に無い。全情報が要るときは data.json を使う` と明記済み。ブラウザのダウンロード CSV には THCPL 列が在る（14 列: 締切・公式表記・残り日数・会議・分野・種別・ラウンド・CCF・CORE・THCPL・会期・開催地・状態・URL） | 案内と実装がズレていない |
  | 「もっと見る」で隠した行がダウンロードから落ちる | ダウンロードは `shown`（= 条件を通った全行）を使い、40 行ずつ増えているのは描画だけ | 全行出る |
  | 選択欄の選択肢に行を作れない物がある | 種別「ジャーナル/研究会」は行の作り手の分離（`journalRows`）が分かれていて 22 件出る（`kind` は `journal`）。ランクは A\* 156 / A 286 / B 260 / C 145 / 評価なし 144 件、締切までは 7 日 41 / 30 日 211 / 90 日 537 / 180 日 786 件（**第 203 回で窓を JST の暦日基準にしたので、同じ生成時刻で 51 / 214 / 539 / 786 件になる**）（検索対象 863 行） | 0 件になる選択肢は無い |
  | 「残り日数」が UTC で数えている | 画面の `remain` とダウンロード CSV の式が同じ（過ぎた行は JST の暦日差、これからの行は経過時間の floor で 0 のときは「あと N 時間」） | 画面と CSV のあいだは食い違い無し。ただし**この表の時点で「これからの行」の基準が日付欄とずれていた**（第 202 回で暦日差に統一。上の項目） |
  | URL に残る条件が漏れている | 読み取りも書き出しも `mode`・`q`・`kind`・`rank`・`win`・`est`・`domestic`・`online`・`past`・`cats`・`sort`・`dir`・`help`・`row` の 14 鍵で対応している | 抜け無し |

  - 半角カタカナの一致は、実装ではなく**検査に留めた**（半角カタカナで貼った人が全角で打ったのと同じ行に出会える）。
    検索の両側を NFKC に寄せる仕組みは以前から在るが、それを壊す変更（正規化の除去・部分的な打ち消し）を
    止める検査が無かった。検査は built の `recommender.js` を built の `catalog.json` に走らせ、
    調べる語は収録データの検索文から拾う（画面の語を書き写さない）。変換表は検査側に持つので、
    **半角へ直してから組み戻すと元の語になること**を本体の照合より前に見る。
  - 私のミスの記録: 最初の変換表は語の数が 1 つ足りず、そこに "undefined" が混ざった文字列で検索して
    0 件になり、「半角カタカナが効かない欠陥を見つけた」と読み違えた（実際には検査側の欠陥）。
    同じ読み違いをしないため、変換表の自己検査を検査本体に置いた。同じラウンドで、漢字で書かれた語を
    かなで打つと 0 件になることも測ったが、これは画面が出している語形ではないので欠陥に数えない
    （収録データの語をかな表記で検索できる、とは案内していない）。
  - このラウンドで README は変えていない（画面の振る舞いに変更が無い）。
- **等級を呼ぶ語で打った人が、0 件か、絞れていない一覧に突き当たっていた**（2026-08-09 生成ビルドで実測・第 195 回）。第 194 回の続きで、同じ語の残り穴を2つ塞いだ。検索の行集合 863 行での実測:

  | 打った語 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `ランクなし` | **0 件** | 144 件（画面の語 `評価なし` 144 件と同数） |
  | `ランクなし 機械学習` | **0 件** | 31 件（`評価なし 機械学習` 31 件と同数） |
  | `ランク` 単独 | 839 件の説明なし | 839 件＋おしらせ |
  | `評価` 単独 | 475 件の説明なし | 475 件＋おしらせ |

  - 一つ目の原因: 列の見出しは「ランク」、評価の無い行の表記は「評価なし」と、**同じものを別の語で**
    書いていたこと。見出しどおり `ランクなし` と打つと、その語は行の検索文に無いので 0 件だった。
    言い方の対応表 `QUERY_SYNONYMS_JA` に1行を足し、展開語は画面に出る表記 `評価なし` だけにした
    （表の約束で、展開語は列にそのまま出るラベルでなければならない）。
  - 二つ目の原因: 第 194 回で単独の「ランク」「評価」を検索語に入れたが、**この語だけは等級を絞らない**
    （839 / 863 行、475 / 863 行）ので、一覧が変わっても「絞れた」と読み違えられる。件数欄の
    「こう探しました」を出す `querySynonymNotes` に、等級の語が混ざっていないときだけ
    `「ランク」だけでは等級を絞れていません（A*ランク のように等級の語をいっしょに入れてください）`
    を足した。例の等級は `rankGradeOrderJa()` の先頭から組み立て、画面と同じ大文字で出す
    （照合には小文字形を使う）。
  - 検査（等級を呼ぶ語だけで打った人に、絞れていないことと別の言い方を与える）は built の
    `recommender.js` を built の `catalog.json` に走らせる。見出しの語は `index.html` の
    `<label for="rank">` から、評価の語の語幹は `rankUnratedLabelJa()` から、等級の例は
    `rankGradeOrderJa()` から取るので、画面の語を書き写さない。誤発火も見ている（`A*ランク`・
    `A* ランク`・`評価なし`・`一致評価` には出さない）。
  - 既存の言い方の表の検査が新しい行を2度弾いたので、その約束に合わせて直した。①説明文に
    「……」で画面の語を書くルール（説明を `画面の語「評価なし」` にした）②展開語は表示語の
    対応表に在る語でなければならないルール（ランクの列の語 `RANK_UNRATED_LABEL_JA` が
    並べ先に無く、追加した – `ランクなし` をそこへ寄せる言い方が増えるまで載っていなかった）。
  - 改ざんで落ちることを実測で分けて確認: 寄せだけ消すと `語「ランクなし」が画面の語と同集合を出さない`、
    おしらせだけ消すと `語「ランク」のおしらせが出ていない`、等級の判定を常に真に潰しても同じ理由で
    落ちる。最初の手順は二つ目の改ざんを掛け違えた（寄せを戻さずに実行し、同じ失敗理由しか出なかった）
    ので、分離してやり直した。
  - 関係の無い検索が無変化であることを実測で確認: `機械学習`・`A*`・`A*ランク`・`A* ランク`・
    `ccf a* ランク`・`12月`・`岡山`・`推定`・`抄録`・`概要締切`・`オンライン参加可`・`国内研究会`・
    `スパコン`・`第 2 ラウンド`・`NSDI 27`・`ネットワーク`・`評価なし` の 17 語は件数が同じ。
  - 私のミスの記録: 検査とコミット下書きの注釈に、中国語で「等級」に当たる語を書いてしまい、
    どちらも書き込み直前の自己検査で止めた（同種混入は第 189 回から 7 ラウンド続いている）。
    改ざん確認の最後に `git checkout -- site/recommender.ts` を掛けて、同じファイルの未コミットの
    変更ごと消した（パッチを組み直し、ビルド・実測・検査をやり直して元に戻った）。文書に書く件数は
    行そのものを数え直すことにした（行の識別子で畳んだ集計と混ざり、139 件と 144 件の差になって
    出ていた）。
- **画面が「ランク」と呼ぶ語で、検索が行に当たらなかった**（2026-08-09 生成ビルドで実測・第 194 回）。
  列の見出し・選択欄のラベル・早め絞り込みのボタンは等級を「ランク」と呼ぶ（ボタンは `A*ランク`）。
  その語どおり検索欄に打つと、表の行に出会えなかった。検索の行集合 863 行での実測:

  | 打った語 | 直す前 | 直した後 |
  | --- | --- | --- |
  | `A*` | 156 件 | 156 件（かわらず） |
  | `A*ランク`（ボタンの語のまま） | **0 件** | 156 件 |
  | `A* ランク`（半角スペースを挟む） | **0 件** | 156 件 |
  | `ランク A*`（語順を逆にする） | **0 件** | 156 件 |
  | `A*評価` | **0 件** | 156 件 |
  | `A* 評価` | 3 件 | 156 件（3 件は失われない。+153 / -0） |
  | `ccf a* ランク` | **0 件** | 156 件 |

  - 原因は検索語側ではなく、**行の検索文に画面の語を入れていなかった**こと。`rankSearchTerms` は
    「表に出すランクの語を検索語として受け付ける（表示している語で検索できる）」ことを不変条件に
    している関数で、等級の語（`a*`）と体系名+等級（`core a*`）は入れていたが、画面が書く
    「ランク」「評価」を添えた形が無かった（`評価なし` は入れていたので `評価なし` は 144 件で引けた）。
  - 直しは同じ関数に、等級を持つ行だけ `xランク`・`x評価` の接着形と、単独の「ランク」「評価」を
    足した。**評価の無い行まで単独の語は広げない**（広げると「ランク」で全件が返って語の意味が
    薄くなるため、これは意図した限定）。
  - 副作用も実測で書く。単独 `ランク` は 388 件 → 839 件、単独 `評価` は 144 件 → 475 件
    （863 行のうちランクの表示を持つ行は 475 行）。つまり**単独の語は実質的な絞り込みにならない**。
    「表に出す語で引ける」側の利得を取った結果で、件数欄で「その語だけでは絞れていない」と出す案は、
    ことばを増やす判断になるので今回は置いて残課題にした。
  - 関係の無い検索が無変化であることを実測で確認した。`機械学習`・`ネットワーク`・`岡山`・
    `国内研究会`・`推定`・`12月`・`第 2 ラウンド`・`NSDI 27`・`オンライン参加可`・`概要締切`・
    `抄録`・`A`・`B`・`C`・`評価なし`・`ランク未確認`・`A* 機械学習` の 17 語で追加 0 件・減少 0 件。
  - 検査（画面が「ランク」と呼ぶ語で、等級の行に実際に出会える）は built の `recommender.js` を
    built の `catalog.json` に走らせる。等級の並びは `rankGradeOrderJa()`、画面のボタン名は
    `index.html` の早め絞り込みから取り、正解の集合は行の `rankPairs` から組み立てる（`N` は
    画面が「評価なし」と出す語なので等級に数えない）。
    照合は「語 `Xランク` が出る行 ＝ その等級を表示している行」を全等級で見る形にし、ボタン名は
    語順を変えた 3 形（`A*ランク`・`A* ランク`・`ランク A*`）と `A*評価` が同じ行を出すことまで見た。
  - 改ざんで落ちることを実測: 直しを元に戻すと `語「Aランク」が表示している行と食い違う` で失敗する。
    最初に書いた検査は空振り防止の条件が実装側の実験に依存していて、直す前に
    `等級の語を一つも調べられていない` という見当違いの理由で落ちていた（ランク表記を持つ行が
    ビルドに有るかどうかという**データ側の条件**に組み直した）。
  - 私のミスの記録: 検査の注釈と失敗メッセージに、中国語で「等級」に当たる語と、フランス語の
    短い語を書いた（どちらも書き込み直前の自己検査で止まり、ファイルは変わっていない。中国語の
    同種混入は第 189 回から 6 ラウンド続いている）。`node --input-type=module -e` の呼び出しが
    終了コードも出さず何も表示しなかったため、判別の一部をファイルに書いて確かめ直した。
    行の識別子を（会議名・年・1 件目の締切）で作り、重複を畳んで件数を数えていたため、`A*` を
    45 件と過少に読んでいた（行そのものを数え直して 156 件と確認した）。
  - 同じラウンドで測って問題無かった点: 評価の選択欄の照合（`rankMatches`）は等級の完全一致で、
    `A` が `A*` を混ぜないことを実装と実測の両方で確認。てびきが引用的に括った語 163 本のうち、
    ビルド後の画面・実行時・てびきの外に 1 回も出ない語は 23 本あったが、**全部**実行時に組む語
    （`受付状況` + `未確認` など）か例示の数字で、てびきの実測値は固定時刻ビルドの成果物に
    対して毎回検査されている（案内の数字が古くなりにくい作りになっている）。
- **`llms.txt` の「出力一覧」が、ビルドが置くファイルの 10 件しか並べていなかった**（2026-08-09 生成ビルドで実測・第 193 回）。
  ビルドが出力先に置くファイルは **16 件**、索引に並んでいた名前は **10 件**で、次の 6 件にどこにも
  ふれが無かった。

  - `recommendation-core.js`・`publish.js`・`index.html`・`icon.svg`・`.nojekyll`・`llms.txt` 自身
  - とくに `recommendation-core.js` と `publish.js` は**画面が実際に読む部品**だった。ビルドした
    `app.js` の import 文を実測すると 1 行目が `./publish.js`、2 行目が `./recommendation-core.js`、
    3 行目が `./recommender.js`（`<script type="module" src="app.js">` の 1 本から始まる）。
    機械が読む索引が、公開 bundle の 4 割を説明せずに渡していた計算になる。
  - 第 192 回に「JavaScript が動かないときの案内」を直した直後に、同じ種類の穴がもう一箇所残っていた。
  - 直しは第 191 回の `data.csv` の列と同じ形にした。**名前はビルドが管理する一覧
    `MANAGED_OUTPUT_FILES` から生成**し、実装側に置くのは説明だけ（`LLMS_OUTPUT_NOTES_JA`）にした。
    手書きの 10 行をやめて生成に置き換えるので、公開物を増やしたときに索引だけが古くなる状態を作らない。
    `upcoming.md` の行だけは既存の設定からの生成（`site.upcoming_days`、既定 180）を生かして特別扱いにした。
  - 結果の索引は **17 件**。ビルド先の 16 件を全部載せ、载せたのにビルド先に無いのは
    `embeddings.json` だけで、その行が自分で「埋め込みを有効にしたビルドだけに出る
    （`--no-embeddings` では出ない）」と説明する形にした。
  - 他の索引との突合も実測した。`publish.json` の `artifacts` は **15 件**で、これは新しい索引の
    17 件から `publish.json` 自身と `embeddings.json` を引いた物とちょうど一致する。`.nojekyll` は
    0 バイトの空ファイルだと実測して書いた（データと取り違えないようにするため）。
  - 検査（llms.txt の出力一覧が、ビルドが置いたファイルを一つも漏らさない）はビルド先を数えて行う。
    ビルド先に実在する物が全部載っていること、説明が空欄でないこと、载せたのに無いファイルは
    その行が自分で「出ない」と説明していることを見た。**名前の書き写しはしていない**。
  - 改ざんで落ちることを二方向で実測: 生成側で 1 件落とすと
    `ビルドが置いた .nojekyll が出力一覧に無い`、説明を空欄にすると `説明が空欄: .nojekyll` で失敗する。
  - 私のミスの記録: 最初の注釈草案に中国語で「ここ」に当たる語を書いた（第 189 回から 5 ラウンド
    連続で同種の混入。書き込み直前の自己検査で止まり、ファイルは変わっていない）。改ざんの最初の
    実験では探索語が別名（`SITE_RUNTIME_FILES`）に当たり、`publish.js` 自体がビルドされなくなって
    索引と一致し、**検査が通ってしまった**（「通った」を成功と読み違えるところだった）。生成側で
    1 件落とす改ざんに作り直して、意図した失敗を確認した。
  - 同じラウンドで測って問題無かった点: `llms.txt` の `upcoming.md` の日数は設定から生成されていた
    （ハードコードでは無かった）。ビルドした `app.js` が呼ぶ推薦基盤の語 49 本は `recommender.js` の
    公開物にすべて在る（欠け 0 件）。印刷用の規則は案内どおり本文に URL を印字する規則を持つ。
    「`index.html` は `recommendation-core.js` を読まないのでは」という見立ては、import 文の実測で
    否定した（読む）。
- **JavaScript が動かないとき、画面が何も言わずに空だった**（2026-08-09 生成ビルドで実測・第 192 回）。
  一覧は JavaScript で組み立てるのに、使えないときに出る案内を**一つも置いていなかった**
  （`index.html` の中の該当する要素を数えて 0 件）。学内や端末側でスクリプトを止める運用は
  日本の研究機関でよくあるので、その人が見るのは次の画面である。

  - 静的な HTML には検索欄・早め絞り込みのボタン・条件クリア・表の骨格まで並んでいるので、
    **押せない訳ではない**。押せて、何も変わらない。上の件数も「--」のまま。理由を書く場所が
    画面のどこにも無かった（`<noscript>` の有無をビルド実測で数えて 0 件）。
  - 「見方のてびき」のアコーディオンは静的 HTML なので開ける – 効かないのは一覧・検索・絞り込みと
    件数だけ、という切り分けが読み手に伝わらなかった。
  - 案内をスキップリンクの直後（空の表より前）に置いた。読み替え先は同じ場所の
    `data.csv`（収録全部の平坦な表）と `upcoming.md`（直近の締切と会期）で、**リンクは相対パス**に
    した（配信先は `/kamiyobi/` の下。絶対パスにすると 404 になる）。両方ともビルド先に実在する
    ことを実測で確認した。
  - 同じ機会に、`data.csv` の文字コードの話も案内へ書いた。ビルド実測で `data.csv` の先頭 3 バイトは
    `key`（**BOM 無し**）で、ASCII 以外の文字を含む行は **3,235 行中 178 行**。一方、画面の
    「表示中の N 件を CSV でダウンロード」が出す CSV は BOM 付きで、てびきはそこで「Excel で開いても
    文字化けしないよう BOM を付けます」と書いている。同じサイトの中に 2 種類の CSV があるのに、
    公開している `data.csv` の側にその説明が無かった。
  - **BOM を `data.csv` 自体に足すかは、判断を残した**。`data.csv` は SPEC で
    「機械で読む成果物」と説明しており、BOM を付けると Python を `encoding="utf-8"` で開いたときに
    先頭の列名が壊れる（`key` が `'\ufeffkey'` になる）。Excel 側を助けるか機械側を助けるかの
    トレードオフなので、案内で差異を書いた時点で止めた。
  - 検査（JavaScript が動かないとき、index.html が理由と読み替え先を自分で言う）は built の
    `index.html` から読む。案内が 1 個あること、中のリンクがすべて相対パスで**しかもビルド先に
    実在**すること、空の表より前に出ることを見た。静的な HTML に 3 桁以上の「N 件」を書かない
    検査も兼ねる（収録数は生成のたびに動くので、静的な HTML に書くと必ず噓になる）。
  - 改ざんで落ちることを実測: 案内を消すと `expected +0 to be 1`、リンクを `/data.csv` にすると
    `絶対パスのリンクはサブパス配信で切れる: /data.csv` で失敗する。
  - 私のミスの記録: 案内文に中国語で「一つ」に当たる語を混ぜた（第 189 回以降 4 ラウンド連続で
    同じ種類の混入をしている）。説明文のコメントの中に該当要素の語を角括弧付きで書いたため、
    ビルド後の HTML で 2 個見つかり、個数の検査を付ける段階で気づいた（コメントなので描画はされないが、
    grep と検査を誤作動させる）。検査の「件数を書かない」は最初に「N 件」すべてを禁じる形で、
    「1 行 1 件」という形の話まで落とした（3 桁以上に緩めた）。
  - 同じラウンドで測って問題無かった点: 日の語の検索で「1日」が 11日・21日・31日を混ぜないことを、
    当たった行の**全締切**を数えて混入 0 件と確認（前のラウンドまでの私の検査は 1 件目の締切しか
    見ておらず、判定にならなかった）。`8月1日` の照らしも正しい – 月日の前ゼロを揃えずに比べたため
    9 件が不一致に見えたのは検査側のミス。`llms.txt` の「サイトの引き方」節の他の約束（月語・中黒の
    並べ語・県名・ひらがな入力）も実装と同じ。`index.html` の `meta` と `og:` の説明は実装と
    食い違っておらず、ICS の語は残っていない。
- **`data.csv` の 25 本ある列に、辞書が無かった**（2026-08-09 生成ビルドで実測・第 191 回）。
  `data.csv` は README でも入口に挙がる成果物（1 行 1 締切の平坦な表。2026-08-09 生成ビルドで **3,235 行・
  列 25 本**）なのに、列の名前と値の意味を書いた公開文書がどこにも無かった。`llms.txt` には
  `data.json` のスキーマ要約があるのに `data.csv` の節が無く、**25 本のうち 7 本
  （`rank_ccf`・`rank_core`・`edition_id`・`deadline_utc`・`deadline_aoe`・`estimate_window_start`・
  `estimate_window_end`）は `llms.txt` のどこにも出てこなかった**。Excel で開いた人がいちばん知りたい
  「空欄と値 `N` の違い」を確かめられない。

  - `llms.txt` に「## data.csv の列」節を追加した。**列名はビルドの列定義 `CSV_COLUMNS` から書き出し**、
    実装側に置くのは説明だけ（列を足したときに名前だけが古くなる状態を作らない）。
    「この順で N 本」の本数も `CSV_COLUMNS.length` から出す。
  - 説明に書いた語彙は全部、ビルドした `data.csv` を数えて確かめた（2026-08-09 生成ビルド実測）。
    `kind` は 10 種のみ（`paper` 1,972・`abstract` 660・`notification` 242・`camera_ready` 149・
    `rebuttal_end` 61・`other` 43・`rebuttal_start` 37・`review_release` 32・`registration` 24・
    `supplementary` 15。画面の「種別」で選べる概要・論文以外の種別もこの表には入る）。
    `deadline_precision` は `exact` 3,047 / `date-only` 188 で、`date-only` の行は `deadline_utc`・
    `deadline_aoe`・`tz_raw` が空欄になり `deadline_local_date` だけ入る（`tz_raw` の空欄 188 件は
    `date-only` の数とちょうど一致）。`rank_ccf` は B 990・A 861・C 707・空欄 450・`N` 227、
    `rank_core` は A* 941・A 802・B 504・空欄 455・`N` 364・C 169（空欄は未評価、`N` は上流でランク
    無しの番兵で等級ではない）。`estimated` は `false` 3,101 / `true` 134、`estimate_window_*` が
    入るのは 134 行だけ（推定版の数と一致）。`categories` と `sources` は `;` 連結（例 `ai;db`、
    `aideadlines;ccfddl`）。`event_start`・`event_end` は 264 行が空欄、`place` 253 行、`date_text`
    252 行、`label`・`link`・`full_name` は空欄 0 件。`year` は 2019–2028。
  - `place` は上流の原文のままで、画面と `upcoming.md` に入れている日本語化（県名の補完・国名の変換）が
    この列には施されていないことを説明に書いた。この列を「日本」で grep すると画面より少ない行に当たる
    理由が、読む人側に立つと必要だからである。
  - 検査（`llms.txt` が `data.csv` の列をビルドの列定義どおりに載せる）は列名を書き写さない。ビルドした
    `data.csv` のヘッダー行を正として、節が同じ名前を同じ順で・空欄でない説明付きで載せることと、
    本数宣言が実数と一致することを見る。
  - 改ざんで落ちることを実測: 列を 1 本足して説明を忘れると
    `列「inserted_probe」の説明が空欄: expected '' not to be ''` で失敗する。
  - 私のミスの記録: 但し書きの行を組み替えたとき `' + ' + String(CSV_COLUMNS.length) + '` が実装に
    そのまま残り、ビルド出来たので実測の出力で気づいた（テンプレートリテラルに直した）。改ざんスクリプトの
    探索語が 3 箇所に当たって自分で入れた検査で止まり、改ざんされないまま「テストが通った」と読み違える
    ところだった（単一ヒットする列名にアンカーを作り直して成功させた）。説明を 1 行だけ敬体で書いていた
    ので節に合わせて直した。それにこのラウンドでもう一度、中国語で「ソースコード」を意味する同じ 1 語を
    ドキュメントの草案に書いていた（第 190 回は修正の注釈で、第 189 回はコミットメッセージの直前で止めた）。
    今回はファイルに書いたあと、コミット直前の点検スキャンで 3 箇所を見つけて「実装」に書き換えた。
    注釈・草案・コミットメッセージのどれに書くときも、同じ語を混ぜる癖が続いている。
  - 同じラウンドで測って問題無かった点: 「条件クリア」は `state` の条件（検索語・分野・種別・ランク・
    早め絞り込み・推定・国内・オンライン・過去の締切）をすべて外し、画面の切り替え（mode）だけ保つ
    （てびきの「条件を一切外さない一覧が欲しいときは条件クリアを押す」が守れている）。並び替えは
    `aria-sort`（見出し）と `aria-pressed`（狭い画面のバー）に分かれており、読み上げ欄にも
    「並び順: … 昇順」が出る。
- **`upcoming.md` の会期行が、日本の朝に読むと一日古かった**（2026-08-10 と 2026-08-12 の 08:30 JST 生成で実測・第 190 回）。
  「本日開催」「開催中(残り N 日)」「N 日後」を決める 今日 を `dateOnly(safeNow)` で **UTC の暦日**から
  取っていた。この表の日付は会期そのもの（時刻を持たない暦日）で、サイトの一覧は JST 固定なのに、
  ここだけ UTC 基準だった。

  - 実測（2026-08-10 08:30 JST 生成）: 前日 08-09 に終わった WISA 2026（会期 2026-08-07〜08-09）が
    「開催中(残り1日)」として載っていた（1 件）。終わっている催しを開催中と出すのがいちばん悪い。
  - 実測（2026-08-12 08:30 JST 生成）: その日に始まる CCCG 2026 と USENIX Security 2026 の 2 件が
    「1日」＝明日扱いだった。
  - 今日を JST の暦日に直した。同じ生成時刻で確かめ直し、WISA 2026 の行は載らなくなり、上の 2 件は
    「本日開催」になった。会期 2026-08-09〜08-13 の KDD 2026 は、08-10 時点で「残り4日」、08-12 時点で
    「残り2日」と、暦日として正しい数を数える。
  - 影響の範囲: UTC 15:00〜23:59（JST 0:00〜8:59）に生成されたビルドだけ。Pages への配信は main への
    反映時に走る（`deploy.yml`）ので、その時刻がこの帯に入ると、日本の午前 9 時になるまで一日古い表が
    載り続ける。`nightly.yml` は 03:00 UTC（12:00 JST）で帯の外、`update-data.yml` は 20:17 UTC
    （05:17 JST）で帯の中。
  - 検査（`upcoming.md` の会期行の「残り」が、JST の同じ日なら同じ読みになる）は画面の語を書き写さない。
    生成時刻の 30 分前と 90 分後（JST では同じ日、UTC では別の日）で 2 通作り、会期行の載る集合と
    「残り」の読みが同じかを比べる。締切行は比べない – 締切の残りは経過時間で決まり、2 通のあいだで
    正当に変わるため。
  - 改ざんで落ちることを実測: 今日を UTC の暦日に戻すと、JST の同じ日に「残り」の読みが変わる会期が
    4 件出て失敗する。
  - 私のミスの記録: 修正の注釈に中国語の 1 語を混ぜ、ファイルに書く直前の自己点検で止めた（第 189 回でも
    同じことをしている）。また検査の最初は締切行も同じ比較に入れる作りで、経過時間の差で正当に変わる行を
    道連れに落とす組み立てだった（会期行に絞って解決）。
  - 同じラウンドで測って問題無かった点: 「今日」を UTC の暦日から取る別の箇所が `src/build.ts` に無いことを
    実測で確かめた。締切行の「残り」は瞬間から数えていてこの帯でも変わらない。`upcoming.md` の日付に添えた
    曜日 1,304 件は食い違い 0 件のまま。
- **`health.md` の「出力ファイル」表が、載せない3件を黙っていた**（2026-08-09 生成ビルドで実測・第 189 回）。
  見出しは「出力ファイル」なのに、並んでいるのは書き終わっていた分だけだった。2026-08-09 生成のビルドで
  実測: 配付先に置くファイルは **16 件**、この表は **13 件**。除く 3 件は `health.json`・`health.md`・
  `publish.json` で、**そのことは本文のどこにも書いていなかった**。収録を確かめる人は「このサイトに
  載る物は 13 件」と読み、ハッシュを突き合わせる機械は `publish.json` の行き先を失う。

  - 表の直前に但し書きを置き、載らない物と理由（`health.json` と `health.md` はこの表のうしろに書き出す
    ので自分自身のハッシュをここへ書けない。`publish.json` は後段の公開手順が書く）を出し、完全な一覧の
    所在（`publish.json` の `artifacts`。2026-08-09 実測で 15 件を載せ、自分自身の `publish.json` を
    除くすべてを覆っていた）へ案内した。
  - 載らない物の名前は呼び出し側の実際の書き出し一覧から計算して出す（実装に書き写すと、書き出し順が
    変わったときに但し書きが噓をつく）。
  - 検査を追加（`health.md` の出力ファイル表が、載せないファイルを自分で言い切っている）: ビルド後の
    実ファイル一覧と表の対応を取り、(1) 表に載らないファイルはすべて但し書きに名前で挙がっていること、
    (2) 但し書きが案内する `publish.json` の `artifacts` が実ファイルを漏れなく載せていること（自分を
    除く）、(3) 除かれているのが自分自身のファイルであることを見た。載らない物が0件なら但し書きを
    出させないことも確認する。
  - 改ざんで落ちることを実測: 但し書きを渡さなくすると
    `但し書きが「health.json」にふれていない: expected '## 出力ファイル\n' to contain '`health.json`'`
    で失敗する。
  - 私のミスの記録: 検査のコメントに「要りようが」という無い語を書いて書き直した。但し書きの行を
    手で長く書いて `npm run check` の整形エラーを自分で作り、`npx biome check --write src/build.ts`
    （対象を絞る）で戻した。別の検査コマンドで `.venv/`（git 無視の局所ファイル）をスキャンして
    1 件のエラーを出し、リポジトリの欠落と取り違えそうになった（`npm run check` は 76 件只看ている）。
    同じラウンドの別の調査で、`undefined` が `Array.prototype.join` で空文字になるため、プリセットボタンが
    検索語を消しているかのように誤読した（作り直して実測し直し、実装は正しいと確かめた）。
  - 同じラウンドで測って問題無かった点: `upcoming.md` の日付に添えた曜日は 1,304 件で食い違い 0 件。
    `health.md` の数の表は 8 項目すべて `data.json` から数え直して一致（「確定 603 + 日付のみ 181 = 784」の
    検算も通る）。早め絞り込みの 5 ボタンは担当する条件だけを出し入れし、入力済みの検索語・他の条件を
    消さない（ボタンの説明どおり。2 回押しで元に戻る）。タグの日本語語は行数と一致（「穴場」44 行・
    「ワークショップ」74 行・「特集」15 行で、タグの行数 44・74・14 を覆う）。「穴場ワークショップ」は
    10 行を出すが、それは 穴場∩ワークショップ の候補行 10 件と一致する（and 検索として正しい）。
    CSV は `shown`（絞り込み後の全行）を書き出していて、てびきの約束と一致。URL の書き出しと読み取りは
    14 の引数で対称。
- **`upcoming.md` が「1分」と書いた行の実際の残り時間は 0 秒だった**（2026-08-09 生成ビルドで実測・第 187 回）。
  「残り」欄は日・時間・分はいずれも切り下げで書く欄なのに、分の欄だけ `Math.max(1, …)` で 1 に
  切り上げていた。生成時刻ちょうどに締まる行（EDBT 2027 の採否通知。`2026-08-09(日) 00:00:00 UTC`）
  が「1分」になり、**同じ行の画面は「まもなく」**を出す。「まだ 1 分ある」と読んだ人が、締まり切った
  行を眺めていた。ビルド中の該当行は 1 件だけだった（「1分」で数える行の実測 1 件）。

  - 1 分を切った行は画面と同じ「まもなく」を出すようにした。分数その物は切り下げのままなので、
    45 分残っている行はこれまでどおり「45分」と出る（そこは噓ではない）。
  - 検査（`upcoming.md` の「残り」が、実在しない猶予を約束していない）は 2 方向。
    (1) 通常のビルドの表から日付欄の時刻を復元（UTC / JST / AoE の表記を読み、AoE は UTC-12、
    JST は UTC+9 でInstantに戻す）し、書いた猶予が実在し、次の単位に届いていないことを全行見る
    （2026-08-09 生成ビルドで読み取れた行 524 件、うち猶予欄を読んだ行 524 件。523 件が「N日」、
    1 件が「まもなく」）。(2) 分の欄は通常のビルドでは踏まえないので、表に載る最も早い締切の
    30 秒前に生成時刻を置いたビルドを別途作り、そこを通す。
  - 改ざんで落ちることを実測: 切り上げに戻すと
    `「1分」の実残り 0分 2026-08-10(月) 23:59:00 UTC ／ [WSCE 2026](…)` で失敗する。
  - 私のミスの記録: 初版の検査はハーネスのビルドだけを見ていて、分の欄を一度も通らず、
    **切り上げを元に戻しても合格した**（空虚な検査）。30 秒前のビルドを作る検査に作り直して塞いだ。
    テスト本文を差し替えるスクリプトで、閉じ括弧を数えて末尾を探した位置がずれて 1 度失敗した
    （単純な文字列探索に直した）。同じ差し替えの途中で使わない変数を混ぜ、書き直しで消した。
  - 同じラウンドで測って問題無かった点: 画面の「残り」（`remain`）は 1 時間未満を「まもなく」と
    出しており、今回の `upcoming.md` の語と揃った。日・時間の欄は切り下げで実残りと矛盾しない
    （上記 524 件で違反 0 件）。てびきと `llms.txt` は `upcoming.md` の「残り」欄の書き方を
    説明していないので、直すべき案内は無かった。
- **書き出した CSV の残り日数が、画面の「残り」より 1 日大きい行が 279 件あった**（2026-08-09 生成ビルドで実測・第 186 回）。
  表計算で並び替える人は、画面の「残り」を確かめてから CSV を開く。両方の数が違えば、どちらを
  信じるか分からなくなる。てびきは「CSV の残り日数は、表示している暦日で決まります」と約束していた。

  | 比較 | 実測 |
  | --- | --- |
  | 過ぎた行 2,317 件 | **279 件**が 1 日ずれる（画面「2019 日前に終了」→ CSV「-2020」） |
  | 先の行 918 件 | ずれ 0 件 |
  | ずれ方の形 | 必ず CSV ほうが 1 大きい（経過時間の floor は、締切の時刻が今の時刻より前のとき 1 日余分にする） |

  - 原因は数え方の基準。画面 `remain()` は過ぎた分を **JST の暦日差**で数える（第 91 回でそこを
    直した）。CSV の過去側は経過毫秒の floor を使っていて、基準が分裂していた。CSV の実装内の
    コメント自体が「画面と同じ暦日から数える」と書いていた。
  - 過ぎた側を画面と同じ暦日差に直した（先の側は画面も経過時間の floor なので同じ式 → **先の側を暦日差に揃えたのは第 202 回**）。
    数値のままなのは表計算での並べ替え・絞り込みに使うためで、そこは変えない
    （`残り日数は数値で、経過は負の数になる` の検査もそのまま通る）。
  - 修正後の実測: 候補行 3,235 件を全行比べて **食い違い 0 件**（修正前の 279 件は、同じ検査器で
    前のビルドに対して再測して裏を取った）。
  - 検査（`書き出した CSV の残り日数が、画面の「残り」の数と全行で一致する`）は、ビルドした
    `app.js` から画面の `remain` をそのまま抜き出し（`DAY` と時刻を引数で渡す）、CSV の数と
    1 行ずつ突き合わせる。画面の語（「N 日前に終了」「あと N 日」「本日終了」「まもなく」）を
    検査側で組み立てて比べるので、実装の語を書き写さない。閾値は行数の固定値にしない
    （ハーネスのビルドは候補行 510 件で、配信ビルドの 3,235 件と違う）。
    「比較から漏れた行 0 件」「画面の語を読み解けなかった行 0 件」「『N 日前に終了』の行が存在する」
    も見て、空振りを防ぐ。
  - 改ざんで落ちることを実測: 修正を戻すと
    `画面「8 日前に終了」 -> CSV「-9」 EUDAT Conference 2026` などで失敗する。
  - てびきの「CSV」の項に、画面の「N 日前に終了」が `-N` であることと、ずれていた実測を載せた。
  - 私のミスの記録: 検査のコメントにハングルを 1 語混ぜた（書き込み前に自己点検で検出して書き直した）。
    Python で注入スクリプトの行を作るとき引用符を壊して 1 度書き損じた。ハーネスのビルド行数
    （510 件）を頭に入れずに「1,000 件以上比較できたこと」という閾値を置き、それ自体が失敗原因に
    なった（全行比較の条件に替えて解決）。
  - 同じラウンドで測って問題無かった点: 期刊行の残り列は空欄（画面も数を出さない）で一致。
    画面の横線「―」は候補行 3,235 件で 0 件（第 184 回の実測どおり）。CSV の見出し 14 列は
    第 184 回の実測と同じ。
- **AI に読ませる案内が、`来月` を実装と違う月に決めていた**（2026-08-09 生成ビルドで実測・第 185 回）。
  `llms.txt` は画面を見ないまま AI が引用する文書なので、ここが間違っていても利用者に直接伝わる。
  2026-08-09 生成のビルドで実装が返す値は次のとおりで、文書は `来月 = 2026年10月` と書いていた。

  | 語 | 実装の答え | 文書の説明 |
  | --- | --- | --- |
  | 今月 | 2026年8月 | （例の記載なし） |
  | 来月 | **2026年9月** | 2026年10月（＝実装では再来月の値） |
  | 再来月 | 2026年10月 | （例の記載なし） |
  | 先月 | 2026年7月 | （例の記載なし） |

  同じ種類の欠陥（固定の日付を例に書く）は、画面のてびきでは先に直して「打った語 = 解決した
  西暦月」の形にしていた。その方針が生成物の側の文に残っていなかったのが根本。

  - `llms.txt` の該当文から固定の月を落とし、画面と同じ「打った語 = 解決した西暦月」の形と、
    語のずれ分（`今月` = 生成日の暦月、`来月` = 1 ヶ月後、`再来月` = 2 ヶ月後、`先月` = 1 ヶ月前）で
    書くようにした。生成日が動いても実装と食い違わない記述にする。
  - 検査（``llms.txt` が、月の相対語を実装と違う月に決めていない`）は 4 方向。
    (1) ずれ分の説明が実装の展開結果と一致すること（ビルドした `recommender.js` と `data.json` の
    生成時刻から計算）。(2) 固定の月を書く箇所があれば、その月は実装の答えと一致すること –
    現在のビルドでは該当 0 件。(3) 件数欄と同じ形の名称が載っていること。(4) 四つの語すべてに
    説明が付いていること。
  - 改ざんで落ちることを実測で確認: 文書に `来月 = 2026年10月` を戻すと
    `案内が \`来月 = 2026年10月\` と書いているが、実装は 2026年9月 と読む（生成日からずれている）`、
    `先月` の説明を落とすと `案内に 先月 の説明が無い` となる。
  - 同じラウンドで測って `llms.txt` と一致していた記述（ほかは問題なし）: `NSDI 27` は 6 行、
    `人工知能・データベース` は 150 行、`岡山` は 2 行、`おきなわ` は 5 行、
    `第 2 ラウンド` と `R2` は同じ 378 行、`1日` は 179 行で `11日`（120 行）と別、`8月 27` は 67 行。
    「時刻未確認」という語も画面に実在する（ビルドした `app.js` に 8 箇所、`index.html` に 4 箇所。
    CSV に 0 箇所なのは、この語が画面の説明用だから）。
  - 私のミスの記録: 注入するスクリプトで `.map(` を閉じ忘れ、失敗が `[eval]` の構文エラーに化けた
    （ハーネスの常。閉じ括弧を直して解決）。配列に文字列化していない JS 文を混ぜるミスを今回も
    1 度踏んだ。検査のコメントに簡体字の語を 1 語混ぜた（自分で見つけて修正）。lint の基線を
    警告 +1・情報 +2 だけ増やしてしまい、原因は素の文字列に書いた `${…}` と文字列連結
    （`useTemplate` / `noTemplateCurlyInString`）だったので、書き直して 35 警告・63 情報に戻した。
- **第 182 回の紙の但し書きが、紙に現れない語を説明していた**（2026-08-09 実測・第 184 回）。
  前回自分で入れた但し書きを、紙に出る語として洗い直した。説明していた語のうち 2 つが紙に
  現れず、逆に紙に刷る列が説明されていなかった。

  | 但し書きの項目 | 実測した事実 |
  | --- | --- |
  | 「原表記:」 | 行の詳細（`#drawer`）は `@media print` で `display: none`。表の列にも無い語なので、**紙に刷られない** |
  | 残り欄の横線「―」 | `remain()` は時刻が数えられない行でしか出さず、候補行 3,235 件と期刊行 22 件の CSV で **0 件**（実装のコメントも「本来通らない」と書いていた） |
  | 「公式表記」の列 | 478 行すべてに入り、**説明が無かった**。ここで「中身は収録元の呼び方そのまま」と書いたのが誤りで、列はいつ締めるかの宣言を持っていた（第 208 回で但し書きを訂正） |
  | CCF・CORE・THCPL | 既定の印刷対象 478 行のうち **280 行が空欄**。空欄の行と「ランク未確認」の行は完全に一致（両方 280 / 空欄のみ 0 / 語のみ 0） |
  | 「状態」の列 | 478 行のうち **189 行が空欄**。その 189 行はランク・会期・開催地にも空欄が無かった（他項目に空欄あり 0 行） |

  - 但し書きから紙に刷られない 2 項目を落とし、紙に刷る「公式表記」「CCF・CORE・THCPL の空欄」
    「状態の空欄」の説明に置き換えた。本文は 274 字 → 324 字。
  - 「状態」が空欄の意味は推測せず、実測で確かめた（189 行すべてが他項目も無傷）ので
    「この行に注記がない行です」と書ける。
  - てびきの「印刷」の項も同じ列名に追従させた（列名・語はすべてビルド成果物から取る）。
  - 検査（`紙に刷られない語を、紙の但し書きが説明していない`）は 3 方向。
    (1) 但し書きが「」で説明する語・先頭で並べる語は、印刷しうる CSV の見出しか値に実在すること。
    (2) 既定の印刷対象で 2 割以上が空欄になる列（実測 CCF・CORE・THCPL・会期・開催地・状態の 6 列）は、
    列名か「<列名>未確認」の形で説明されていること。(3) 「公式表記」と「種別」の値が重なって
    いなければ（実測 0 件）両方の列名を説明に載せること。加えて、但し書きが名指しで説明する列は
    てびきも同じ名前で案内していることを見る。
  - 改ざんで落ちることを両方向で確認: 「公式表記」の説明に「原表記:」を戻すと
    `紙に刷られない語「原表記:」を但し書きが説明している`、三列の名指しを削ると
    `印刷行の 2 割以上で「CCF」が空欄なのに…（説明済み: 会期・開催地）` となる。
  - 私の検査ミスの記録（今回 3 件）: 注入するスクリプトの配列に、文字列に包まない生の JS 文を
    2 度混ぜた（型検査が即座に検出）。検査のコメントに簡体字の語を 1 語混ぜ（自分で見つけて
    修正）。「2 割以上空欄の列を名指しで説明せよ」の初版は、部分文字列で当たって「開催地未確認」で
    説明済みの列にも列名を要求し、てびき側が失敗した。未確認の形での説明を別扱いにして解決。
  - 同じラウンドで測って問題無かった点（正直記録として残す）: てびきの数値説明はすべて現在の
    ビルドと一致（既定 478 行 / 「Submission deadline」267 行 / 「発表申込締切」19 行 /
    「人工知能」182 行 / 「A*」61 行 / URL 貼付 6 行 / 候補行 3,235 件 / 「7 日以内」39 行 /
    「オンライン参加可」15 行 / 開催地未確認 110 行 / 曜日の語で引けない行 0 件）。
    種別「常時受付」は窓 7・30・90・180 日・すべてで 22 件を返す（選択欄に出す種別は
    選べば結果が返る物だけ、という案内どおり）。狭い画面の並べ替えボタンは 5 列ぶん揃っており、
    押している列の矢印も更新される。推薦カードの「まず上位 20 件を表示」は実際の描画数と一致。
- **印刷した紙が、画面の語の説明を一切持っていなかった**（2026-08-09 実測・第 182 回）。
  てびき（`#helpPanel`）は `@media print` で隠れる。ところが紙には画面と同じ語がそのまま刷られる。
  既定の印刷対象で状態の語を数えると、こうなる。

  | 紙に刷られる語 | 行数（既定の印刷対象 478 行） |
  | --- | --- |
  | ランク未確認 | 280 行（6 割） |
  | 会期未確認 | 114 行 |
  | 開催地未確認 | 110 行 |
  | 延長後 | 9 行 |

  最多の語が全体の 6 割に出ているのに、紙のうえにはその意味がどこにも書かれていない。
  「研究室に貼る・会議で回覧する」用途（てびきが自分で書いている用途）では、受け取った人が
  画面を開かないと読めない。紙側の但し書きが無かったのが根本。

  - 印刷帯（`.print-meta`）に但し書きを載せた。画面の条件の書き下ろしと同じ箱なので、紙にだけ
    出て画面では出ない、という既存の振る舞いをそのまま使える。締切一覧でも「投稿先を探す」でも
    載せる（後者の紙にも「評価なし」等は出る）。
  - **語は正本から組み立てる**（`Recommender.unconfirmedLabelJa()` / `rankUnratedLabelJa()` /
    `extendedLabelJa()` / `notApplicableLabelJa()`）。説明文を手で写すと画面の語とズレる。
    本文は 272 字で、9pt の帯に収まる程度。
  - てびきの「印刷」の項に、紙の側に但し書きが刷られることと、その見出しの語
    （`この用紙の表記:`）を追記した。
  - 検査（`印刷した紙が、紙に出る語を紙の説明だけで読ませる`）は 4 方向。
    (1) 印刷行の 2 割以上に付く状態の語（実測 3 語）が 但し書きに載っていること – 語はビルドした
    CSV から数え上げる。(2) 但し書きが使う語は「紙に刷られる値」か「画面に見える文」に実在する
    こと。(3) `.print-meta` が画面で `display: none`・印刷で `display: block !important` で、
    しかも印刷でてびきが消えること（紙の説明が二つにならない）。(4) てびきが、紙の見出しの語を
    そのまま使っていること。
  - 検査が実際には効いていなかった（正直記録）: (2) の照合先にビルドした `app.js` のソース全体を
    入れていたため、但し書きに無い語を 1 語足しても通った（説明文ではなく IME のコメントに同じ語が
    あたった）。照合先を CSV の値と HTML の可視文に絞ったうえで、改ざんが落ちることを再確認した。
  - 検査が見つけた別の欠陥: てびきの「キーボードで一覧を動かす」の項で、
    「（Tab で … 見出しか、…ボタンまで移動し、…）」の括弧が閉じられておらず、**その語句から文末まで
    が括弧内として読める**状態だった（6 開 / 5 閉）。閉じ括弧を打ち、「見出しか、」も「見出しから、」に
    直した（「A まで移動し」と対になる形）。てびき全項を洗う検査を同じ検査に入れて、いまは不釣り合い 0 件。
  - 私の点検ミスの記録: 先に手で括弧を数えたときは正規表現が項をまたいで切れ、犯人を「印刷」の項と
    誤った。検査は `<dd>` 単位で正しく切り、犯人はキーボードの項だった。
  - 自分の書き込みミスの記録: 新しいコメントに簡体字の語を 1 語混ぜ、既存の検査（日本語の案内に
    中国語の略語を混ぜない）が拾って落ちた。第 179 回で同じミスを記録したばかりで、コメントも
    ビルド後に残るので画面と同じ扱いで検出される。なお、このとき「物がない」の表記も疑ったが、
    検査が落ちた原因ではなく（原因は簡体字の語だけ）、表記を揃える意図で平仮名に直しただけ。
  - ハーネス側の修正: 印刷の検査は `Recommender` を自作のスタブにしていたので、但し書きが使う
    語の関数をビルドした本体へ delegate した（検査に語を書き写さない）。既存の印刷検査 2 箇所に
    `printLegendJa` の注入も足した。
  - このラウンドで測って無罪だった点: 検索欄の案内の例語、参考論文欄の書式、表の語と検索の
    パリティは第 181 回で確認済み。日付語は `2026-12-25` / `2026/12/25` / `2026.12.25` /
    `12/25` / `2026年12月25日` のすべてが同じ 1 行に当たり、表計算が書き出す形でも引ける
    （第 181 回の右端変更での回帰も無し: `2026-12` は 77 行のまま）。
- **`R1` と打つと 10・11・12 周目の行が混ざっていた**（2026-08-09 実測・第 181 回）。
  検索は英字語を「語頭が英数字でつながっていない位置」で当たり、右側は開けておく
  （`robot` → `robots`、`crypto` → `cryptography` を利かせるため）。周目の語 `r1` は
  2 文字だが、短語の判定は英字のみ（`^[a-z]{1,2}$`）なので数字を含む `r1` は「その他の英字語」に
  落ち、右を開けたままだった。結果として **右に数字が続いても打ち切れない**。

  | 引いた語 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `R1`（既定画面） | 426 行 | **420 行**（= 1 周目の行数と完全一致） |
  | `R1`（収録全体） | 2,686 行 | 2,662 行（10・11・12 周目の 24 行が外れた） |
  | `R10` / `R11` / `R12` | 各 8 行 | 各 8 行（そのまま引ける） |
  | `第 1 ラウンド` | 420 行 | 420 行（変更前から和語の形は正しかった） |
  | `robot` / `crypto` | 語頭を開けた利き | 同じ（語尾が英字の語はそのまま） |

  - 混ざった 6 行（既定画面）は同じ会議の 10・11・12 周目でした。てびきは「ラウンドは画面に
    出ている書き方のまま引けます（＝ CSV に書く `R2`）」と書いていたので、表計算で `R1` を
    絞ってから画面に戻った人が、見落としが出る形になっていた。
  - 直しは一致規則の側に置く。**末尾が数字の語だけ右端も要求する**（`termEndsInDigit`）。
    語その物を変えないので、収録側の表記も CSV もそのまま。
  - てびきの検索の項に、**1 周目の行は表にラウンドを添えない**こと（既定が 1 回だけなので情報に
    ならない）と、それでも `第 1 ラウンド` / `R1` で引けること（どちらも同じ 420 行）を追記した。
    変更前に 426 行出ていたことも、恒久的な約束ではなく、実測値として添えた。
  - 検査（`ラウンドの R 表記が、別の周目の行を混ぜない`）は 2 層。規則その物は**合成した行**に
    当てる（`r1` / `r10` / `r1b` / `r100` と、英字語の `cryptography` / `robotics`）。実データ側は
    収録されている**すべての周目**をループし、`R<周目>` がその周目の行数と一致し別の周目を
    混ぜず、和語の形とも同じ行数であることを見る。stash での非空虚性を確認済み（直し前は
    「R1 が 10 周目の行をまだ返す」で落ちる）。
  - 検査の作り直し（正直記録）: 初版は `R10` が 1 件以上返すことを実データで要求した。テスト用
    ビルドの収録は本番より小さく 10 周目以上の行を持たず、**規則が正しくても空振り**した。収録
    依存の検査をやめて合成行へ移し、実データは周目ごとの全数照合にした。途中で空振りその物の
    Assertion（`>= 0`）を 1 本入れてしまい、自分で除いた。
  - ハーネス側の修正: 検索の関数はビルド成果物から名前付きで抜き出している（`jsFunction` の
    一覧）ので、新しい `termEndsInDigit` を一覧に足した（足さないと `ReferenceError:
    termEndsInDigit is not defined`）。
  - このラウンドで測って無罪だった点（正直記録）:
    - 検索欄の案内が掲げる例語は 4 つとも既定画面で当たった（`NSDI` 2 行 / `ネットワーク` 39 行 /
      `おきなわ` 4 行 / `国内` 29 行）。
    - 参考論文欄の書式案内（`タイトル | キーワード | 掲載先`）は実装どおり（3 欄で掲載先が抜け、
      2 欄・1 欄でも壊れない）。
    - 表に出る語と検索のパリティ: 既定画面で `延長後` 9/9、`未確認` 288/288、`評価なし` 53/53、
      常時受付で `該当なし` 22/22。
    - 「残り」の語は未来の 24 時間以内が `あと N 時間` / `まもなく` で、`本日終了` は過ぎた側だけ。
    - てびきはラウンドを検索の項で説明していた（種別の項ではない）。私が種別の項だけ読んで
      「説明が無い」と思ったのが間違いだった。
    - 私が `該当なし` を 0 行と読んだのは、母集団を既定画面で見ていたため（常時受付では 22/22）。
- **ファイルを選んだときも、同じ黙った上書きが起きていた**（2026-08-09 実測・第 180 回）。
  第 179 回で「入力の例」のボタンを直したとき、同じ型の欠陥がもう 1 箇所に残っていた。
  PDF・TXT を選ぶ欄のハンドラは、読み取れた論文を欄に流し込むところで `setPrimaryRecord` と
  参考論文欄の無条件上書きをしていた。

  | やったこと | 直し前 | 直し後 |
  | --- | --- | --- |
  | 欄に打ち込んでからファイルを選ぶ | 打ち込んだ物が消える。戻せない | 差し替え前を保持。「直前の入力に戻す」で戻せる |
  | 3 件選んだあと、もう 1 件選ぶ | 先の 3 件がまとめて消える | 同じボタンで戻せる |
  | 1 件も打ち込んでいない | 選ぶだけ | 変わらない（戻す物がないのでボタンは出ない） |

  - 欄には「投稿予定の論文を選ぶ（PDF / TXT・**複数可**。1件目が投稿予定、残りは参考論文）」と
    あり、複数Selectできることは書いてある。ただ 2 回目に選んだ物が 1 回目を置き換えることは
    書いて無く、画面にも取り消しが無かった。
  - 直し方は規則を共通化すること。第 179 回で作った `paperInputWithSample` に通し、ボタン名を
    「サンプル前の入力に戻す」→「**直前の入力に戻す**」に変えた（例のボタンとファイル選択の
    両方が通るので、「サンプル前」では正確ではなくなる）。てびきの項にも、ファイルを選んだときの
    差し替えも同じボタンで戻せること、新しく選んだ物で入れ替わることを追記した。
  - 検査: 規則を使う場所が **定義込みで 3 箇所**（例のボタン・ファイル選択・定義）有ることを
    見る。1 本でも規則を通らない道が残れば落ちる。実際にファイル側の差し替えを 1 行の直接書き込みに
    戻して検査が落ちること（`expected 2 to be greater than or equal to 3`）を確かめ、元に戻した。
    ボタン名はビルドした HTML から取っててびきの記述と突き合わせる（語を検査に写さない）。
  - 調べて無罪だった点（正直記録）: 1 回の選択の中で 1 件目が投稿予定・残りが参考論文という
    挙動は、欄に書いてある説明どおりだった。読み取りに失敗したときはラベルが失敗の語に
    入れ替わり、取り消しボタン（`cancelPdf`）は作業を中止する。選択の末尾で input の値を空にして
    あるので、同じファイルをもう一度選んでも反応する（これはコードを読んでの確認）。
- **「入力の例」のボタンが、打ち込んだ論文を告げずに消していた**（2026-08-09 実測・第 179 回）。
  「投稿先を探す」の論文欄の下に並ぶ例のボタン（以前の群ラベルは「動作確認用サンプル」）は、
  押すと欄をその例で上書きする。しかも空のときの画面は「上のサンプルボタンで入力の形を
  確かめられます」と**押すことを勧めていた**。ハンドラは無条件に
  `setPrimaryRecord` と参考論文欄のクリアを呼ぶだけで、差し替え前の入力をどこにも残さなかった。

  | 押す前の状態 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 空 | 例が入る | 変わらない |
  | タイトル・概要を打ち込み済み | 消える。元に戻せない | 例が入る。「サンプル前の入力に戻す」で戻せる |
  | 本文欄は空で、参考論文だけ挙げ済み | 参考論文が消える | 同じく戻せる |
  | 空白だけ入っている | 消える（戻す物がないのに等しい） | 取り消しは出さない |

  - 差し替えの規則（保持するか / 何を next にするか）は純粋な関数 `paperInputWithSample` に置いた。
    画面を読み書きする側と分けたので、検査は画面を作らずに規則だけ実行できる。
  - 「論文の入力を消す」を押したときは取り消しの入口も閉じる（消したい意思とぶつかるため）。
  - 群ラベルの開発向けな語も直した。「動作確認用サンプル」は、利用者が押して良い物か分からない
    語だった。→「入力の例（押すと欄の中身を入れ替えます）」。不自然な「日本語 分散システム」も
    「日本語の例（分散システム）」にした。
  - てびきの欄の末尾に「論文の入力とサンプル」の項を足し、押すと欄を入れ替えること・戻せること・
    押すと検索も走ることを、画面のボタン名そのもので書いた。
  - 検査: `paperInputWithSample` をビルドした `app.js` から取り出して 4 形で実行し、
    空と空白では戻す物を出さないこと、打ち込み済みではタイトル・長い概要・参考論文がそのまま
    残ること、例の方が次の入力になることを見る。取り消しボタンの語をビルドした HTML から取って
    てびきが同じ語で説明していることも見る。stash での非空虚性を確認済み（直し前は規則の関数が
    無く、てびきの項も無い）。
  - 測って無罪だった点（正直記録）: 例のボタンは 5 つとも、ビルドした収録で実際に候補を返す
    （TSN 32 件 / 分散ストレージ 32 件 / K8s 8 件 / SGX 18 件 / 日本語の例 5 件。いずれも
    しきいを超える候補があり、押して空振りする例はなかった）。ボタンは再計算（`apply` と
    意味検索の予約）まで正しく呼んでいた。画面に出る語の開発寄り語を洗って「カタログ」以外の
    目立つ物は無かった。
  - 自分の書き込みミス（記録）: 追加したコメントに簡体字の語を 1 語混ぜ、検査（日本語の案内に
    中国語の略語を混ぜない）が拾って落ちた。検査がビルド後のファイルを見るので、コメントの誤りも
    画面と同じ扱いで検出された。
- **「過去の締切」の読み込みを、同じ画面で二つの名前と一つの開発語で出していた**（2026-08-09 実測・第 178 回）。
  「過去の締切も表示」にチェックすると、同じ 1 回の読み込みについて件数欄と状態欄の両方に語が
  出る。ところが両者は別の名前で書いていた。

  | 場所 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 件数欄（読み込み中） | 全履歴を読み込み中… | 過去の締切を読み込み中… |
  | 状態欄（読み込み中） | 過去の締切を読み込んでいます… | 変わらない |
  | 件数欄（失敗） | 全履歴を読み込めませんでした | 過去の締切の読み込みに失敗 |
  | 状態欄（失敗） | 全履歴を読み込めませんでした。表示中の**カタログ**は利用できます。 | 過去の締切の読み込みに失敗しました。いま表示している一覧は使えます。 |
  | ボタン | 過去の締切を再試行 | 変わらない（名詞は合っていた） |

  - 害: チェックした直後に「全履歴」と「過去の締切」が同時に並び、別々の読み込みが始まったように
    読める。過去の行が揃うのを待つかどうかの判断が付けない。
  - 「表示中のカタログ」は開発寄りの語で、**画面に出る語としてはこの 1 箇所だけ**だった（てびき
    を含めて他所に無い）。失敗時の語を「いま表示している一覧」に直したので、画面から無くなった。
  - 直し方は名詞を 1 箇所に置く（`HISTORY_NOUN_JA`）。件数欄の短い形も状態欄の長い形もそこから
    作り、読み込み状態の語を 4 つの定義にまとめた。てびきの「過去の締切も表示」の項にも、
    読み込みが始まること・失敗しても見ている一覧は使えること・ボタン名「過去の締切を再試行」で
    もう一度読めることを、画面と同じ語で追記した（項の側の「全履歴」も同じ名前に寄せた）。
  - 検査: 定義をビルドした `app.js` から取り出して**実行し**、四つの形が同じ名詞で始まることを
    見る（語を検査に写さない）。件数欄と状態欄が同じ定義を参照していること、画面に出る文字列に
    別名が残っていないこと、てびきが画面の語とボタン名で説明していることも見る。stash での
    非空虚性を確認済み（直し前は単一の名前の定義が無く、別名も残っている）。
  - 同じラウンドで測って無罪だった点（正直記録）: README の「更新は日次の運用」という記述は
    `.github/workflows` の cron 2 本（毎日 03:00 と 20:17）と一致していた。読み込みに失敗したとき
    件数欄が失敗その物を出しており、揃わなかった過去の行を全かのように見せていなかった。
    「履歴」という語は端末保存を連想させるが、この画面は `localStorage`・`sessionStorage`・
    `indexedDB` を 1 度も使っておらず（ビルドした `app.ts` の実測 0 件）、「この端末に残る」と
    嘘をつく箇所も無い。
- **てびきの「来月」の例が、再来月の値を書いていた**（2026-08-09 実測・第 177 回）。
  見方のてびきの検索の項は「『今月』『来月』『再来月』『先月』は日本時間の暦月として解決し、
  件数欄に展開結果（例: 来月 = 2026年10月）を出す」と書いていた。ビルドした `recommender.js` の
  `expandRelativeMonths` を固定時計（2026-08-09）で実行すると:

  | 打った語 | 実装の展開 | てびきの例 |
  | --- | --- | --- |
  | 今月 | 2026年8月 | –（例なし） |
  | 来月 | **2026年9月** | 2026年10月（= 再来月の値） |
  | 再来月 | 2026年10月 | –（例なし） |
  | 先月 | 2026年7月 | –（例なし） |

  - 展開結果を件数欄に出すという記述自体は正しい（`filter` が展開後の語を作り、その語を
    `relativeMonthNote` が「打った語 = 解決した月」の形にして件数欄に足している）。違ったのは
    静的な文に書いた例の値だけで、これは**再来月の値**だった。「来月」は 2 ヶ月先だと受け取った
    人は、出張や応募の月をひと月間違える。
  - 直し方: 項から固定の日付の例を外し、「打った語 = 解決した西暦月」の形で見せる、という
    記述に変えた（同じ項にあった「来週 = 2026年8月10日(月)〜8月16日(日)」も、書いた日にちを
    過ぎた読者には画面と食い違う同じ性質の例なので、暦日を同じ欄に出す、という形にまとめた）。
    誤りの有った事実は残す（日本時間の暦月で解決する／週は月曜始まり／展開結果を件数欄に出す）。
  - 同じ誤った例は `site/app.ts` のコメントにもあった（`relativeMonthNote` の説明）。ビルド後の
    `app.js` にもコメントは残るので、こちらも日付の例を書かない形に直した。
  - 検査: てびきの欄に「打った語 = 20XX…」の形（画面で古くなる展開例）を書かないことを
    8つの語について見る。展開規則は、検査が固定した時計から独立に作った期待値と突き合わせる
    （実装の月加算を写さない。ずらす月数はてびきに書いた意味そのもの）。件数欄に出す語は
    ビルドした `relativeMonthNote` を実際に呼んで確かめる。stash での非空虚性も確認済み
    （直し前は「来月」の例が引っかかる）。
  - 同じラウンドで測って無罪だった点（正直記録）: CSV の状態列は日本語の語だけ（「ランク未確認」
    「延長後」「推定」など）で、内部の語は混ざらない。「評価なし」（評価一覧に載るが評価が
    付いていない）と「ランク未確認」（そもそも一覧に載らない）は**同じ行で両方出す行が 0 件**で、
    語の使い分けが壊れていない。印刷は条件の書き下ろしと URL を紙に残している。月を表す語は
    検索語の文字列に入っていて、既定画面 478 行のうち「2026年8月」で 133 行が引ける。
  - 自分の測定ミス（記録）: 検索の一致式に行その物を渡して「8月」が 0 件と読んだ（正しくは
    行の検索語の文字列を渡す。直し後は 150 行）。CSV も素のカンマ分割で割って列のズレを
    作った（引用符の中のカンマでずれる。本来の読み方で直すと無罪）。
- **「評価なし」で絞り込んで印刷すると、紙に `ランク: N` と出ていた**（2026-08-09 実測・第 176 回）。
  ランクの選択欄は、値 `N`（データ内部の番兵）を「評価なし」と日本語で出す。実装のコメントは
  「見出しは日本語に出す – 『Rank N』は内部トークンそのもので、読み手には意味が伝わらない」と
  まで書いていた。ところが印刷物の条件の書き下ろし（`describeFilters`）は同じ値をそのまま
  書いていた。

  | 場所 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 選択欄の表示 | 評価なし | 評価なし（変わらない） |
  | 印刷物の但し書き | `この印刷物: 検索語「HPC」 ／ ランク: N ／ …` | `… ／ ランク: 評価なし ／ …` |
  | URL に書く値 | `rank=N` | `rank=N`（変わらない – 機械が読む所は正典の値のままでよい） |

  紙を配った人にだけ意味が読めない語なので、選択欄と同じ式を条件の書き下ろしにも使った
  （`rankFilterLabelJa` を 1 本作り、選択肢の生成と印刷の両方から呼ぶ。語は正本である
  `recommender.js` の `rankUnratedLabelJa()` から取るので、画面と紙で「評価なし」が別々に
  なる余地を消した）。
  - 見逃されていた理由（根本原因は検査側）: 条件の書き下ろしの検査には、もうコメントで
    「ランクは画面に出る等級そのものを書く（内部の番兵を書かない）」と書いてあった。なのに
    試行が `rank: 'A*'` だけで、`N` を渡したことが無かった。意図はあって事例が無く、検査は
    緑のままだった。今回の検査は `fillPrintMeta`・`describeFilters`・`rankFilterLabelJa` の
    3 本を実際に繋いで紙の文字列を作り、`ランク: 評価なし` が出ることと `ランク: N` が
    出ないことを見る（選択肢の語も正本 `rankUnratedLabelJa()` と比べる）。stash で非空虚性を
    確認済み（直し前は `この印刷物: 検索語「HPC」 ／ ランク: N ／ …` で落ちる）。
  - 印刷検査の一方（但し書きの文言を見る物）は `describeFilters` をスタブにしているため、
    新しい関数の名前だけ注入した（1 行。語その物は注入しない – 語は注入済みの `Recommender`
    側が正本なので、スタブで二重化しない）。
  - 同じラウンドで測って無罪だった点（正直記録）: 分野キーは taxonomy と収録データで対応が
    取れている（最初の測定で「taxonomy に無いキー 0,1,2,3,4」と出たのは、配列をオブジェクトとして
    走査した自分の測定の間違い）。CSV の評価 3 列は画面と同じ語（`A*`・`A`・`B`・`C`・
    「評価なし」・空）で、これも末尾にずれた値が出たのは簡易的なカンマ分割を使った自分の
    測定の副産物だった。行の詳細の「今後の会期」はてびきに説明が有る。
- **内訳から外したはずの `+数字` が、三箇所に残っていた**（2026-08-09 実測・第 175 回）。
  てびきは「内訳は当たった要素の名前だけで、スコア（点）はこの内訳を足した値ではありません」
  と書いている。が、ビルドした `app.js` には足して読む形の数字が 10 項目残っていた。この数字は
  手作業で決めた信号重みで、画面のスコアとは別の計算なので、併記したままだと数字を足した人に
  だけ嘘が見える（2026-08-09 実測: 内訳を持つ候補 29 件の**すべて**で内訳の和とスコアが違った。
  スコア 58 点 / 内訳の和 45、52 点 / 15、51 点 / 15）。

  | 場所 | 直し前 | 直し後 |
  | --- | --- | --- |
  | カードの「選定理由: …」（毎回見える） | `分野の一致 +18 / 会議名一致 +9` | `分野の一致 / 会議名一致` |
  | 「一致評価 …▾」チップの説明（載せると出る） | `採択論文一致 +21 ／ 日本語一致 +6` | `採択論文一致 ／ 日本語一致` |
  | 行の詳細で開く内訳（1 論文ずつ） | `分野 +18 ・ 会議名 +9` | `分野 ・ 会議名` |
  | 残る数字 | – | 「意味の近さ 30点」「意味検索順位 3」だけ（点・順位と明記された値で、てびきも説明済み） |

  - 数字が戻っていた理由: 内訳から数字を外したとき、検査は**ラベル無しで `+値` を繋ぐ古い形
    だけを禁じていた**（`not.toMatch` の正規表現が「ラベルの直後に値を繋ぐ一形」にしか当たら
    なかった）。のちに「ラベル + 値」の形へ書き換わったため、検査は緑のまま数字が復活して
    いた。検査を「内訳を出す 3 つの関数（`makeRow`・`makeDetailRow`・`makeRecommendationCard`）に、
    値を足す形が 1 つも入っていないこと」へ一般化し、書き方を変えても落ちるようにした
    （stash で非空虚性を確認: 直し前は `makeRow` が持って落ちてくる）。
  - 自分の書き込みミス（記録）: 追加したコメントに禁止された列その物を書いたら、**ビルド後も
     コメントが残る**ため検査が自分の説明に反応して 2 件落ちた（うち 1 件は関数を括弧の
     数で取り出す検査で、コメントの中の波括弧が数えに混ざった）。説明は形の引用をやめて書き直した。
- **点検結果を一度きりで終わらせず、検査に格上げた**（2026-08-09 実測・第 174 回）。
  第 167 回・第 169 回・第 170 回・第 172 回の欠陥は、どれも「別の場所が同じ値・同じ語を
  出しているか」の検査が有ればもっと早く落ちた。今回は画面の噓を探してビルドした成果物を
  機械的に照らしたが、噓は見つからなかった。見つからなかったという事実には検査が無かったので、
  点検内容をそのまま検査に残した（画面のコードは変えていない。変更はこの検査 1 本だけ）。

  | 調べたこと | 実測 | 結果 |
  | --- | --- | --- |
  | CSV の全マスの値 | 45,290 マスで `undefined`・`NaN`・`Invalid Date`・`null`・`Infinity` **0 件** | 問題なし |
  | CSV と候補行の対応 | 3,235 行 × 14 列 = 45,290 マス（1:1） | 問題なし |
  | 狭い画面のカード化 | 表の見出し 7 語と `data-label` 7 語が一致（列名が消える列なし） | 問題なし |
  | てびきの「並び順」の項 | 実装の並び替え可能な 5 列（残り・日時・会期・会議・ランク）と一致 | 問題なし |
  | 印刷 | `beforeprint` で描画済み行を全部描いてから刷る（既定は 40 行だけ描く） | 実装済み |
  | 共有 URL | 書き出し・読み込みがともに `URLSearchParams`（`C++` のような語も対称） | 問題なし |
  | 「次回確認予定」 | `next_check_at` 2,549 件のうち現在より前の物が 0 件（過去の日付を「予定」と出さない） | 問題なし |
  | 「既定画面の行はすべて原表記を持つ」（てびきの全称主張） | 既定 478 行のうち公式表記の空欄 0 件 | 主張は正しい |
  | てびきに書いた検索の実測値 | 「Submission deadline」267 行・「発表申込締切」19 行 | 一致 |
  | 常時受付の 22 行 | 会議名が空の行 0 件、会期・開催地は 22/22 が「該当なし」 | 問題なし |

  - 測って**潰した**誤解（正直記録）: 推薦画面に出る成熟度の語（確立・成長中・新規）と
    「掲載終了」「活動休止」のタグは、てびきに 1 度も出てこない。ただしビルドした `data.json` の
    `recommendation_axes` を持つ会議は 680 会議中 0 件で、成熟度の語は今このビルドで画面に
    出ない（タグも掲載終了 2・活動休止 1 の 3 会議だけ）。到達できない語を欠陥とは主張しない
    （第 164 回・第 167 回・第 172 回と同じ罠）。
  - 助詞の重複・読点の重複・半角記号の混在を可視文章から探したが、出たのはタグを剥がした
    ことによる空白の重複など検査側の副産物だけで、実際の文の乱れは 0 件だった。
  - 追加した検査: ビルドした `index.html` の見出しから語を導いてカード化の `data-label` と突き
    合わせ、並び替え可能な列をてびきの項と突き合わせ、CSV を全マス走査する。語も数も実装から
    導く（書き写さない）。検出自体が死んでいると「0 件」が空振りになるので、わざと壊した
    1 マスを同じ検査で拾えることの自查も中に入れた。
- **常時受付の行だけが公式ページの URL を持っていなかった**（2026-08-09 実測・第 172 回）。
  種別で「常時受付」を選ぶと、締切を持たないジャーナルをその場で行に組み立てる
  （`journalRows`）。この経路だけが会議レコードを `normalizeConference` を通して作っており、
  その正規化は `link` を持っていなかった（`ConferenceRecord` の型にも無い）。画面は
  `ed.link || conf.link` でリンクを出すので、常時受付の行だけリンクが引けない形になっていた。

  | 状態 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 常時受付の行 | 22 行 | 22 行 |
  | そのうち公式 URL を持つ行 | **0 行** | **22 行** |
  | 収録データの `conference.link` に URL が有る件数 | 22 件 | 22 件（変わらない） |
  | CSV の URL 欄が空の常時受付行 | 22 行 | 0 行 |
  | 通常の締切行（3,235 行）のリンク欠け | 0 行 | 0 行（無変更） |

  常に投稿できる掲載先を探している人なので、URL が無い行はその場で手が止まる。表のリンク・
  行の詳細の「公式サイトを開く」・CSV の URL 欄の三つすべてが空だった。直し方は正規化で
  `link` を引き継ぐこと（画面側の式は変えない）。URL は収録データに有る物を移すだけで、
  こちらで作り込んでいないことを検査で確かめた（締切と同じで推測しない）。
  - 最初の測定の間違い（正直記録）: `candidateRows` の種別別件数を見たところ `journal` が 0 件で、
    「選択欄に有って 0 件しか返さない死んだ選択肢だ」と思った。実際の画面経路は
    `state.kind === "journal"` のときに `pool` へ `journalRows` を足しており、22 件出ていた。
    てびきの「選べば結果が返る種別」という記述は正しかった（第 164 回・第 167 回と同じ罠。
    到達経路を見ずに画面の噓を断定しない）。
  - 同じラウンドで測って無罪だった点: CSV 45,290 マスを走査して `undefined`・`NaN`・
    `Invalid Date`・`null`・`Infinity`・前後空白を 0 件、画面側ラベル（開催地・種別・状態・分野）
    も同じ、ビルドした `index.html` に `undefined`/`NaN` 無し。狭い画面のカード化は 7 列すべてに
    `data-label` が出ていた。並び順のてびきの項は実装の 5 列（残り・日時・会期・会議・ランク）と
    一致。常時受付の 22 行は会議名が揃っていて（空 0 件）、会期・開催地も 22/22 が「該当なし」で
    「未確認」になっていなかった。
  - 検査: ビルドした `recommender.js` で `journalRows` を走らせ、`ed.link || conf.link` が全行で
    空でないこと、`http`/`https` であること、収録データの `conference.link` と同じ値であること
    （作り込み検出）、CSV の URL 欄が 1:1 で埋まることを見た。画面側はビルドした `app.js` が
    `safeExternalUrl(r.ed.link || r.conf.link)` を実際に呼んでいることを確認（持たせても、画面が読まなければ意味がない）。stash で非空虚性を確認（直し前は 22 行欠けて落ちる）。
- **`upcoming.md` へのリンクが「ブラウザでは文章で開きます」と嘘を書いていた**（2026-08-09 実測・第 171 回）。
  締切が未定で会期だけ決まっている会は表に載らず、`upcoming.md` にしか載らない。その
  ファイルへ画面・てびきから計 3 箇所リンクしており、てびきの 2 箇所の説明が「このサイトの
  同じ場所にあるファイルです（ブラウザでは文章で開きます）」だった。実測:

  | 調べたこと | 実測 |
  | --- | --- |
  | 配信先の `content-type` | `text/markdown; charset=utf-8`（`curl -sI https://ten82e.github.io/kamiyobi/upcoming.md`） |
  | ビルドした `upcoming.md` の表組み行 | 1,117 行が `\|` を並べたマークダウンの表 |
  | 会議名が `[名前](URL)` の記号のままの行 | 1,115 行 |
  | ブラウザでの描画 | `text/markdown` を表として描画するブラウザは無い。記号が並んだ文章で見えるか、ダウンロードされる |

  つまり「文章で開きます」は噓で、しかも押した人がいちばん欲しがっている物（会期だけ確定の
  会の表）を見つけられない。直し方は実態を書くこと。てびきの 2 箇所の説明を
  「マークダウンで書いた表なので、ブラウザでは表に整形されず、記号が並んだ文章として開くか、
  そのままダウンロードされます（開き方はブラウザで違います）。表が見たいだけならこのページの
  締切の一覧が早い。締切が未定で会期だけ決まっている会は、このファイルにしか載りません」に
  変えた。`title` はマウスを載せたときだけ出るので、**触る端末でも読めるよう てびきの本文にも
  同じ文を一行添えた**。画面の中のリンク（0 件・会期だけ確定の案内が作る `upcoming.md` リンク）
  にも同じ説明を `title` で付けた（見出し文を長くして読み上げで同じ語を二度読ませないため）。
  - 調査中に確かめて無罪だった点（正直記録）: `upcoming.md` の「推定」列は 1,114 行中 1,043 行が
    空だったが、残り 71 行が実際に「推定」を出していて、死んだ列ではなかった。同じラウンドで
    CSV 45,290 マスと画面側ラベルを走査して `undefined`・`NaN`・`Invalid Date`・前後空白を
    探したが 0 件（画面の語の品質はこの点は問題なし）。
  - **やっていないこと（判断が要る残課題）**: 会期だけ確定の会を表として見せるには、
    `upcoming.html` のような静的な HTML を書き出す手がある。新しい成果物とビルドの変更が
    要るので、今回は噓を直して行き先を明示するところまでに留めた。
  - 検査: ビルドした `index.html` の `href="upcoming.md"` を持つすべてのリンクが
    「マークダウン」「ダウンロード」を含み「文章で開きます」を含まないこと、てびきの本文も
    同じであること、ビルドした `app.js` の画面内リンクが `upcoming.title` で同じことを言うこと、
    根拠としてビルドした `upcoming.md` が本当に `# ` 始まりのマークダウンで `[..](http..)` を
    含むことを見た。stash で非空虚性を確認（直し前は「文章で開きます」で落ちる）。
- **CSV の会議名だけが開催年を足さない別実装だった**（2026-08-09 実測・第 170 回）。
  画面の一覧・行の詳細は会議名を「タイトル + 開催年」で出す（`3DV 2024`）。CSV だけはこの
  組み立て式を持たず、素の `conf.title` を書いていた。CSV には年の列が無いので、表計算で
  画面で見た名前や西暦から絞り込もうとすると 0 行になり、同じ会議の別回も一つの語に潰れて
  分離できなかった。ビルドしたコードで実測:

  | 状態 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 候補行 | 3,235 行 | 3,235 行 |
  | 画面と CSV の会議名が違う行 | **2,996 行**（既定画面の 478 行中 422 行） | **0 行** |
  | CSV 側で年が添わている行 | 0 行 | 画面と同じ行すべて |
  | `title` が空の行（画面は key を出す／CSV は空欄） | 0 行 | 0 行（該当なし） |
  | CSV と候補行の対応 | 未確認 | 1:1（3,235/3,235）と実測して位置で照合 |

  直し方は組み立て式を 1 本にしたこと。`site/recommender.ts` に `titleWithYearJa` を追加し、
  CSV と、md・ページを作る `src/build.ts` をそこに寄せた（`src/build.ts` は従来この式を
  持っており、サイト側にも写しが 1 本あった）。タイトルに既に年（`CANOPIE-HPC 2026`）や
  短縮年（`SC '26`・`SC ’26`）が入っているときは二重に付けない。CSV 側は画面に合わせて
  `title` が無ければ `key` に落ちる形にもした（今日は 0 行なので実害は無い将来向け）。
  - **site/app.ts の写しは残した**（正直記録）。最初はそこも正本へ委譲したが、表の並び順を
    調べる検査がビルドした `app.js` の `titleWithYear` を単独で実行しており、委譲すると
    検査の `Recommender` スタブ 6 箇所に正本を注入し直すはめになった（注入した途端、検査が
    正本ではなく注入物を走らせることになる）。ここでは 2 本目を許容し、**一覧と CSV が違う
    語を書いた瞬間に落ちる検査**（ビルドした `conferenceNameCell` と CSV の会議列を全行
    位置で突き合わせる）で実質的な担保にした。
  - 検査: ビルドした `app.js` の `titleWithYear` と `conferenceNameCell` をその場で実行し、
    `deadlinesToCsv` の会議列と 1:1 で位置照合して全行一致を見た。空き振り防止に「年が添わって
    いる行が候補行の 1 割超」も要求する（stash で非空虚性を確認: 直し前は 0 行で落ちる）。
    既存の RFC4180 エスケープ検査は、セルの中身が年を帯びたことで通らなくなった（エスケープ自体は
    正しく `"Workshop, ""Edge"" Cases 2027"` の形）。引用符の扱いを見るという本来の意図どおり、
    年を許す形へ更新した。
  - 自分の書き込みミス（記録）: 追加したコメントに簡体字の語を 1 語混ぜた。コミット前の自查で
    見つけて直した（リポジトリ側の検査も同じ語を弾く列表を持っていた）。
- **会期の書き方が一覧・行の詳細・CSV で 3 通りだった**（2026-08-09 実測・第 169 回）。
  会期列は「ISO + JST の曜日」にローカライズ済みだったが、行の詳細（ドロワー）は
  `date_text ||` の順で公式ページの原文を先に出していた。そのため同じ行を開いても書き方が
  違い、しかも詳細のほうが英語のままだった。ビルドした `candidateRows` で実測:

  | 状態 | 直し前 | 直し後 |
  | --- | --- | --- |
  | 会期に ISO を持つ行 | 2,971 行 | 2,971 行 |
  | うち行の詳細だけ英語原文（`March 18-21, 2024`） | **2,933 行**（既定画面 338 行） | **0 行** |
  | 一覧と詳細で会期の文字列が違う行 | 2,983 行（既定画面 370 行） | 0 行 |
  | ISO が無く原文だけ（`TBD 2027`） | 一覧=未確認 / CSV=原文 | 一覧・詳細・CSV すべて原文 |
  | 会期情報が全く無い行 | 252 行=未確認 | 252 行=未確認（そのまま） |
  | CSV の会期列が画面と同じ式 | 不明（式が別） | 2,389/2,389 行が一致 |

  直し方は式を 1 本にしたこと。`recommender.ts` に `eventCellJa(row)` を追加して
  （ISO が読めるなら `2026-12-03(木) 〜 2026-12-04(金)`、1日だけなら期間を書かない、
  ISO が無い行だけ原文）、一覧・行の詳細・CSV の 3 箇所をそこに寄せた。行の詳細では公式表記を
  消さず「原表記」として下に添える（開催地と同じ作法）。`site/template.html` のてびきに
  「会期」の項を足し、曜日を添える理由・原表記を出す理由・**会期そのものは検索語にできない**
  こと（検索に入るのは締切の暦日と会期の「何月」まで）を書いた。
  - 案内とのずれ: てびきの「日時」は以前から「表と詳細で同じ式を使う」と書いていた。会期が
    その案内どおりに動いていなかった。
  - ISO が無い 12 行の扱いが変わる（一覧が「未確認」→「TBD 2027」）。「 kamiyobi が未確認」では
    なく「公式側で日付がまだ決まっていない」ので、決めていないことを正直に伝える原文のほうがいい。
    CSV はもともとこの挙動だった（画面だけが違っていた）。
  - **同じ実測で別に出た未修正の欠陥（正直記録）**: 一覧の会期列に出る ISO 文字列が検索で
    引けない。会期に ISO を持つ 2,971 行のうち、その語をそのまま打って**自分の行に当たるのは
    47 行だけ**（2,924 行は当たらない。`2026-12-03` は別行が 4 件ヒットするだけ）。会期の日語は
    締切と違い意図的に索引へ入れていない（表は締切で並び締切で絞るため）が、「画面に出る語は
    引ける」という site の約束とはズレている。まずはてびきに「会期そのものは引けない」と明記し、
    索引へ入れるかは別のラウンドで扱う。
  - 検査: ビルドしたコードで (1) 会期に ISO がある行が英語原文を主語にしないこと（直し前は
    該当 2,729 行>0 で非空虚）、(2) ISO が無い行の原文フォールバックが生きていること、
    (3) 1日だけの行が期間を書かないこと、(4) CSV の会期列が画面の式と全行一致すること、
    (5) ドロワーが `eventCellJa` を呼び `date_text ||` を主語に戻していないこと、を見た。
    既存の曜日表示検査は、会期の式が共有関数へ移ったことに合わせて、`eventCellJa` の出力その物が
    4 タイムゾーンで一致することの実測へ置き換えた（実装の形を見る検査より強い）。
  - 自分の検証ミス（記録）: ①検査に渡す文字列に `\b` と書き、TypeScript の文字列リテラル内で
    不可視の**バックスペース 1 文字**になっていた（正規表現が 1 件も当てず「壊れていた行 0 件」に
    なった）。空振り検査を弾くために置いてあった `wasEnglish > 0` 相当の検査がこれを見つけた。
    判定は「ASCII の字母を含むか」に替え、エスケープに依存しなくした。②閾値を検査用ビルドの
    実測値（3,235 行）で書いたが、ハーネスのビルドは自分自身の固定時刻で走るため候補行が
    **510 行**しか無く、割合で書く必要があった（割合にして、ビルドの時刻が動いても壊れないようにした）。
    ③テストのコメントに韓国語を 1 語混ぜた。自查では見落として、それを弾く既存検査（第 97 回で作られた物）に検出された。この検査が有って助かった。
- **論文の貼り付け欄が英語の項目名しか読まなかった**（2026-08-09 実測・第 168 回）。
  投稿先を探す画面の構造化パーサ `parseStructuredPapers` は `title:` / `abstract:` /
  `keywords:` / `venue:` の英語の項目名しか見ておらず、日本語で書いた項目名を見ていなかった。
  この画面は日本語で「タイトルと概要を下の欄に貼り付けてください」と言い、参考論文欄も
  「1行1件: タイトル | キーワード | 掲載先」と日本語ラベルを載せているので、日本語の項目名が
  来ない理由がない。ビルドした `parsePaperLines` で実測:

  | 貼り付けた内容（同じ論文） | 直し前 | 直し後 |
  | --- | --- | --- |
  | `Title:` / `Abstract:` / `Keywords:`（英語） | 1 論文（正） | 1 論文 |
  | `タイトル:` / `概要:` / `キーワード:` / `掲載先:`（日本語） | **4 論文に分裂**、各 title にラベルが混入 | 1 論文（正） |
  | `タイトル：…`（全角コロン） | 分裂 | 1 論文 |
  | `概要:` の値が複数行（継続行） | — | 継続行を概要に結合 |
  | 参考論文欄のパイプ書式 `SC 2026 \| hpc \| SC` | 1 論文（正） | 1 論文（維持） |
  | ラベル無し 1 行 | 1 論文 title=その行 | 維持 |

  直し方は項目名の**別名**として日本語を受けただけ（タイトル/表題/標題/題目/論文名 → title、
  概要/抄録/要旨/アブストラクト → abstract、キーワード/検索語 → keywords、掲載先/投稿先/
  掲載学会/ベニュー/会議名 → venue）。コロンは半角 `:` と全角 `：` の両方。ゲートは「タイトル行が
  1 つでもある」の条件を英語・日本語のどちらの表記でも満たす形にし、タイトル行の無い入力は
  従来どおり構造化しない（各行に落ちる）。
  - **正直な到達性**: 画面の主要入力は個別の欄（投稿予定タイトル/概要/キーワード）と PDF・TXT
    アップロードで、これらは JSON や `textPaperRecord` 経由なので本質的には壊れていない。
    壊れていた経路は (1) 可視の**参考論文欄**に日本語ラベル付きのブロックを貼った場合と
    (2) **ラベル付きの `.txt` をアップロード**した場合で、英語ラベルなら直っていたのに日本語
    ラベルだと壊れる非対称があった。今回はその非対称を無くす一致・頑健化で、画面の表示文は
    変えていない（パイプ書式の案内はそのまま主経路）。
  - 既存検査 1 本が私の修正で落ちた（正直記録・重要）: 「内訳の項目に、足して読むように見える
    数字を出さない」は、入力の論文を**日本語ラベル**で書いていた。そのため直し前は 3 論文に
    分裂した入力で推薦を作り、`checked` と `differs` が偶然すべて一致していた。直して 1 論文に
    なると推薦される行の組みが変わり、`checked=26` のうち 1 行（30 点の行）で内訳の重みの合計が
    スコアと一致した。`differs === checked`（＝全行で不一致）は設計上の保証ではなく、スコアが
    これらの信号から計算される以上、低い点の行で合計がたまたま一致することは起きる。過半が
    一致しないことへ緩めた（利用者への実際の約束は上の変側の `+<数>` を作らない検査と、てびきの
    「スコア（点）はこの内訳を足した値ではありません」が持っていて、そちらは変えていない）。
    **別の検査の前提に、パーサの壊れ方が紛れ込んでいた**好例。
  - 検査: ビルドした `parsePaperLines` で、日本語ラベル（半角・全角）が 1 論文にまとまりラベルが
    title に混ざらないこと、抄録/検索語の別名が効くこと、英語ラベルとパイプ書式とラベル無し 1 行の
    従来動作を壊していないこと、タイトル行の無い入力を 1 論文に潰さないことを見た。stash で
    非空虚性を確認（直し前に戻すと日本語ラベルが 4 に分裂して落ちる）。
- **`deadlinesToCsv` だけが種別の古いラベル表を別に持っていた**（2026-08-09 実測・第 167 回）。
  `deadlinesToCsv` は 3 件だけの `KIND_LABELS_JA`（abstract/paper/journal）で種別を訳し、
  それ以外 `kindLabelJa`（正本・`KIND_LABEL_JA` の 11 件）で英字の内部表記をそのまま返していた。
  分野列が直上に `categoryLabelJa` を使い、ビルドが書く `data.csv`（全収録のフラット表）が
  正本の `kindLabelTable` を使うのに、この経路だけが古い表を別で持っていた。同じ語彙に表を
  2 つ持つと必ず片方が古くなる、というこのサイトが繰り返してきた失敗と同じ形なので、
  古い表を捨てて `kindLabelJa` に揃えた。
  - **正直な到達性（重要）**: 収録の `notification` / `camera_ready` / `rebuttal_end` /
    `other` / `rebuttal_start` / `review_release` / `registration` / `supplementary` の行は
    一覧に出さない種別（`SELECTABLE_KINDS` は abstract/paper/journal のみ）で、画面の CSV
    （`exportShownCsv`）は `shown` を渡す。**よって現時点で利用者が英字の入った CSV を
    得る経路は無い**（画面から得る CSV の種別列は 3 語のみで、すべて元の表にも入っていて
    正しかった）。ビルドの `data.csv` も正本表を使い元から正しい。これは地雷の除去であり、
    画面の表示が変わる欠陥ではない。
  - **自分が誤かけた計測**: 初測で `deadlinesToCsv(candidateRows(...))`（画面の種別絞り込みを
    通していない全 3,235 行）を流し「563 行が英字のまま。一覧では『採否通知』等と出ていて
    画面の語を CSV で探せない」と書きかけた。これは**噓**だった（その 563 行は画面に出ない
    種別で、実 CSV には入らない）。`exportShownCsv` が `shown` を渡すこと、`SELECTABLE_KINDS`
    が 3 種であることを読んで気づき、検査と記録を「関数の契約（既知の種別なら内部表記を書かない）」
    の形で書き直した。第 164 回の「評価保留」到達不能と同じ轍を、今回も一度踏んだ。
  - 検査: ビルドした `deadlinesToCsv` に全収録を通し、(1) 種別列の語がすべて画面のラベル表
    `kindLabelTable` の語であること、(2) 日本語を含まない（英字内部表記の）セルが 0 本、
    (3) 各行の `dl.kind` から引いたラベルと一致、(4) 3 件の古い表では訳せなかった種別の行が
    実データに有る（空振り防止）、を見た。stash で非空虚性も確認（直し前に戻すと (1) が落ちる）。
  - 案内は変えない: 画面から出る CSV の種別列は 3 語のみで元から日本語のため、「種別列も
    画面と同じ語」と書くと「一覧に採否通知の行が出るのか」と誤解させる。てびきの「種別」項は
    現状（表は概要・論文・常時受付のみ）が正しく、触らない。
  - 失敗: 追加した検査のアサーション文で文字列連結を使い、`npm run check` の `useTemplate` が
    54→55 に増えた（ビジュアル差分で `npx biome check .` では出ず、`npm run check` は
    `src scripts site/*.ts tests --files-ignore-unknown=false` という別ファイル集合を見る
    ため気づけた）。テンプレートリテラルに直して 54 に戻した。
- **データ生成からの「N 日前」を経過 24 時間で数えていた**（2026-08-09 実測・第 166 回）。
  ヘッダーの「データ生成」の直後に付く「データは N 日前に生成されたものです」の N が
  `Math.floor((now - at) / 86400000)`（経過 24 時間）だった。この画面は生成時刻も一覧の日時も
  JST で出し、一覧の「残り」も JST の暦日が正本なので、隣に並ぶ「N 日前」だけ別単位で数えると
  横に書いた日時と合わない。ビルドした `dataAgeNoteJa` に JST で境界時刻を流し込み実測:

  | 生成 JST 8/6 23:00 に対する閲覧時刻 | 経過 24 時間 | JST 暦日 | 直し前の画面 | 直し後の画面 |
  | --- | --- | --- | --- | --- |
  | JST 8/9 01:00 | 2 日 | 3 日 | （閾値 3 に届かず何も言わない） | 「データは 3 日前に生成されたものです」 |
  | JST 8/10 00:30 | 3 日 | 4 日 | 「データは 3 日前…」 | 「データは 4 日前…」 |

  閾値 `DATA_STALE_DAYS_JA`（3 日）に暦日で届かないと警告が遅くとも約一日遅れて届く。更新が
  止まった古い一覧を最新と誤るのがこの画面で最も悪い失敗なので、暦日に揃えた。
  - 直し方: `dataAgeNoteJa` の日数を `jstDay(now) - jstDay(at)`（JST オフセットはインライン、
    月見出しと `remain` と同じ）に変えた。てびきの「経過の日数は表示している端末の時計で
    測ります」を「日数の数え方は一覧の『残り』と同じで、JST の暦日です」に書き換えた
    （生成時刻も JST なので隣の日時とずれない、時計自体がずれていればその分ずれる、と補足）。
  - 検査: ビルドした `dataAgeNoteJa` で、生成 JST 8/6 23:00 に対し JST 8/9 01:00 閲覧で
    「データは 3 日前」が出る（経過 24 時間で数えたら空になる）こと、JST 8/10 00:30 閲覧で
    「4 日前」が出て「3 日前」ではないこと、生成 JST 当日は何も言わないこと、閾値 3
    （実装の正本から読む）、てびきが「JST の暦日」を宣言していることを見た。
  - 正直な否定: 既存検査「古いデータを開いた人に…」（生成を UTC 00:00 ＝ JST 09:00、閲覧も
    整数日刻みで動かす）は、生成も閲覧も JST の同一時刻帯に載るので経過日数と暦日一致が
    変わらず、直し前後でそのまま通った（暦日境界を跨ぐ入力が無かっただけで、この検査自体は
    妥当）。ズレる境界を押す検査を上記の新規で追加した。
  - 失敗: 新規検査の「生成当日」ケースを JST 8/6 15:00（＝暦日 1 日後）に置いてコメントと
    食い違っていたので、JST 8/6 23:30（暦日 0 日）に直した。てびきの強調を markdown の
    `**…**` で書いてしまい、既存検査「画面に出る文へ markdown の記号を混ぜない」が正しく
    拾った（ビルド HTML は markdown を通さないので `<strong>` に直した）。
- **キーボードで効いている操作が、画面の案内にてびきのどちらにも無かった**（2026-08-09 実測・第 165 回）。
  ビルド後の `onKeydown` が受け取っているキーは 8 種あったが、画面のショートカット案内に
  出ていたのは 6 種だった。

  | 受け取っているキー（ビルド後の `onKeydown` から抽出） | 画面の案内 | てびきのキーボードの項 |
  | --- | --- | --- |
  | `j` / `k` | 有る | 有る |
  | `ArrowDown` / `ArrowUp`（選択行の移動） | **無い** | 有る（`↓` / `↑`） |
  | `Enter`（公式ページ） / `d`（詳細） / `Escape`（閉じる） / `/`（検索欄） | 有る | 有る |
  | 列見出しの `Enter` / `スペース`（並び替え） | 有る（見出しは `tabindex="0"`） | **無い**（マウスで「押す」話しか書いていなかった） |

  見出しによる並び替えは実装があって（5 列すべて `tabindex="0"`、`e.key === "Enter" || e.key === " "`
  で `preventDefault` + `stopPropagation` して世界の `Enter`（選択行を開く）に渡さない）
  キーボードだけの研究者に導線が届いていなかった。てびきのキーボードの項は
  「条件のチェックや並び替えのボタンを押した直後も、そのまま打てます」と書くので、
  並び替えのボタンが有ること自体は伝わるが、たどり着き方が書かれていなかった
  （touch 端末では `.only-keyboard` が隠れるので、この項はキーボードを使う人に出る）。
  - 直し方: 画面の案内に `↓` / `↑` を足した（`j`/`k`・`↓`/`↑` 選択）。てびきのキーボードの項に
    `Tab` で見出し（残り・日時（JST）・会期・会議・ランク）か狭い画面の並べ替えボタンまで
    移動して `Enter`（またはスペース）を押すこと、押している列が `↑` / `↓` で他は `↕`
    であることを書いた。
  - 検査: 受け取るキーの集合をビルド後の `onKeydown` から抽出して (1) 想定した 8 種であること
    （増えたら案内も直させる）、(2) 画面の案内が全部を載せていること（`ArrowUp`→`↑`・
    `ArrowDown`→`↓`・`Escape`→`Esc` の読み方の対応表を置いて照合）、(3) `th[data-sort]` が
    すべて `tabindex="0"` であること、(4) 見出しの `Enter` / `スペース` の分岐がビルド後に
    残っていること、(5) てびきのキーボードの項に `Tab`・見出し・並び替え・スペース・`↑`・`↓` があること、(6) `SORTABLE_KEYS` と見出しの `data-sort` が一致することを見た。
  - 既存検査を 1 本緩めた（正直記録）: 「site template localized shortcuts label」が案内の
    文字列を完全一致で固定していて、`↓` / `↑` を足すと落ちた。キーの並びは新しい検査が
    ビルド後のコードから正本を取るため、この検査は「読み上げ欄にショートカット案内が有るか」
    だけを見る形に変えた（二重に固定しない）。
  - 今回点検して欠陥が無かった事柄（次の回のための記録）:
    (1) 早め絞り込みのボタン 5 種（`7d`・`a_star`・`hpc_sys`・`domestic`・`online`）を、他の条件を
    入れた状態から 2 回押す検査をした。各自の条件以外を変えない（検索語・種別・推定などは
    無傷）ことをビルドした `presetNextSelection` / `presetIsActive` で確認した。`hpc_sys` は
    担当する分野が複数あるので、どれか入っているときに押すと残りも入れて点き、もう一度押すと
    担当分をまとめて外す（外れる先は「条件なし」で、`7d` も同じ。押す前の窓を復元はしない）。
    案内の「その条件だけを出し入れします」と矛盾しない範囲と判断した。
    (2) 会議名・主題の日本語検索: 「電子情報通信学会」14 件・「情報処理学会」11 件・
    「研究会」24 件など引ける一方で、「人工知能学会」「計算科学」「全国大会」「マルチエージェント」は
    0 件（収録側の表記に無い語）。てびきは「収録側の表記に無い語順の語は寄せません」と
    決めて書いているので、同義語表を勝手に増やすのは前回の判断を変える話（収録側の判断）。
    (3) 画面に出る日本語文字列 308 本を機械looking の語で洗ったが、該当はコメントの中の
    「あと NaN 日」（第 140 回の注記）だけだった。
  - 失敗: 検査用スクリプトに型注記を残して `SyntaxError`、オブジェクトの鍵を数字始めにして
    `SyntaxError`、ボタンの `data-preset` の値を推測で書いて空振り（ビルド後の HTML から
    読むべきだった）。ビルド後の HTML を `siteRuntime("index.html")` で読もうとして型検査で
    落ちた（このヘルパーはランタイム JS 専用で、HTML は `readFileSync(join(site, "index.html"))`）。
- **投稿先を探す画面で、順位が無い行を横棒の記号にしていた**（2026-08-09 実測・第 164 回）。
  内訳の chip と比較文が `r._semanticRank || "—"` / `r._lexicalRank || "—"` だった。順位は
  上位の候補にだけ付く（語彙検索の順位は語彙の点が 0 より大きい行にだけ、意味検索の順位は
  `topN`（既定 200）までしか付かない）ので、点は有るのに順位が無い行は珍しくない。ビルドした
  `venueRecommendations` に鍵から決まる意味検索の点を与えて、画面と同じ
  `fit.score >= 10` で 200 件出すと:

  | 状態 | 直し前 | 件数（固定時計の offline ビルド / 実時計のビルド） | 直し後 |
  | --- | --- | --- | --- |
  | 点があるが意味検索の順位が無い行 | 「順位 —」 | 44 / 47 | 「順位は出ていません」 |
  | 意味検索の順位は有るが語彙検索の順位が無い行 | 「言葉の一致（語彙検索）で — 位」 | 3 / 3 | 「言葉の一致（語彙検索）では 0 点で順位は無く」（点はその行の実数を書く） |
  | ラベル欠落（`fit.label` が空） | 「評価保留」 | 0 / 0（到達不能） | 変更しない（死んだ既定値のまま） |

  横棒は支援技術で読まれず、値が壊れたのか順位が無いのかの利用者には判別できない。このサイトは
  「分からない」を 未確認 / 該当なし / 評価なし の語で出すことにしていて（「-」などの記号では
  出さないとはじめて書く場面がここだった）、行の詳細の「数えられない」の `―`（U+2500）とも
  別の記号が増えていた（直し後、ビルド後の `app.js` で横棒 U+2014 はコメントの中にしか無い）。
  - 例（`cade`）: 語彙 0 点・意味の近さ 0.899 で意味検索 1 位。意味検索で見つかる行は語彙の
    点が 0 になりうる（意味検索の目的その物）ので、この状態は例外ではない。
  - 検査: ビルド後の `makeDetailRow` を抜き出し、値としての横棒（`"—"` / `"―"`）が残って
    いないこと、語に切り替わったことを見た。加えて全体の文字列リテラルに横棒だけを値にした
    箇所が 0 本であることを確認。上の文が噓にならない条件もビルドした検索で見た:
    語彙検索の順位が欠ける行は語彙の点が 0 の行と一致すること（`lexMismatch` = 0）、
    `topN` を 3 にすると点は有るのに順位が無い行が必ず生まれること（収録の大きさに依存しない）。
  - 案内: 「一致評価の出し方（投稿先を探す）」の項に、順位が上位の候補にだけ付くことと、
    無いときに語で書くことを書いた。
  - 失敗（重要）: 検査用に `--no-embeddings` の**online**ビルドを `--out /tmp/…` で実行した
    ら、`data/snapshot.json` と `data/source-snapshots/*.json` が書き換わった（`--out` が
    作業用でも正典のデータファイルは更新される）。これで 2 件の検査が落ちた（既定画面が
    478 行 → 495 行）ので、`git checkout -- data/` で戻した。AGENTS.md の
    「offline ビルドは snapshot を書かない」は守られていて、書くのは online ビルドのほう
    （以前から「online ビルドに正典データを書かせない防御が無い」は未決の課題としていたが、
    作業用の出力先でも起きることを実測で確認した）。**検査用のビルドは必ず `--offline` を
    付ける**。
  - その他の失敗: 検査の注入スクリプトで文字列リテラルを改行で割って構文エラーにした、
    コメントに英語を 1 語混入させた、`topN` 既定 200 の状態だと実時計のビルドでは
    順位欠落が 0 件になって検査が環境依存になった（`topN: 3` を渡して決定的にした）。
- **共有リンクの行が検索語で落ちているとき、種別のせいにしていた**（2026-08-09 実測・第 163 回）。
  `restoreDrawerFromUrl` は、リンクの行が目印の一覧に無い理由を「過ぎた締切」「推定」
  「表に出さない種別」の三つでしか見ていなかった。`?q=…&row=…` のように検索語と行の目印を
  同時に含む URL では、表に出る `paper` の行まで三つ目に落ちて、次の文を読んでいた。
  ビルドした `restoreDrawerFromUrl` をスタブ（`toForm` / `render` / `openDrawer` と、画面と同じ
  条件で `shown` を組み直す `redraw`）付きで抜き出して実測:

  | 場面 | 直し前の件数のうしろ | 直し後 |
  | --- | --- | --- |
  | 未来の論文締切の行 + 当たらない検索語 | 「その行は表に出さない種別（採否通知・カメラレディなど）なので、行を開いて中身を出します。」 | 「その行を開くために、リンクについていた条件を自分から外しました（検索語）。一覧はリンクの条件と違う範囲になっています。」 |
  | 過ぎた論文締切の行 + 同じ検索語 | 「共有された行はこの収録に見当たりません。データの更新で無くなった可能性があります。」（収録にある行を無いと言っている） | 同じ文（`過去の締切も表示` はチェック欄に入る） |
  | 表に出さない種別（採否通知など）の行 | 種別について書く（正しい） | 変更なし |
  | 収録に無い行の目印 | 「この収録に見当たりません」 | 変更なし |

  直し前の二行は、直す前の版本を同じ条件でビルドし直し（`node src/cli.ts build --offline …`）、同じ抜き出し・同じ `redraw` 付きのスタブで実行して得た値である（表に出ない行として開いたため、直し前は選択の目印も付いていなかった – 呼び出しは `open` だけだった）。

  送った人の画面ではその行が出ていたので、受け取った側で「見つかりません」と言うのが
  いちばん困る（第 156 回で過ぎた締切について決めた方針の続き）。
  - 直し方: 種別の判定を `SELECTABLE_KINDS`（セレクトの選択肢の正本）で行い、三つの理由に
    当たらない行は `loosenSharedRowConditions` に落とす。これは条件を 1 つ緩めるたびに
    描き直して行が出るかを見、出たところでやめる（まとめて全部外すと、関係の無い条件まで
    外れた画面になる）。緩めた項目は画面の語で戻し、件数のうしろに並べる。チェック欄の
    項目は「過去の締切を隠す条件」「推定の行を隠す条件」という語にして、「条件を
    外しました」に並べて筋が通るようにした。
  - 条件をすべて緩めても一覧に出ない行（会期だけの研究会など）は、従来は「この収録に
    見当たりません」を読んでいた（行は収録にあるので噓）。収録にあるのだからと
    「いまの一覧に出さない行なので、行を開いて中身を出します」に変え、緩めた条件があれば
    それも同じ文に添える。
  - 検査: 未来の行と過ぎた行の二場面を同じビルドで実行し、(1) 種別のせいにしない、
    (2) 「収録に無い」と言わない、(3) 緩めた条件（検索語）を名指しで書く、(4) 本当に一覧へ
    戻って選択の目印が付く（`draw` と `select` が呼ばれる）、(5) 推定の行まで外さない
    最小限であること、(6) 過ぎた行では「過去の締切も表示」が入り、未来の行では入らないこと
    を見た。直し前の検査は `loosenSharedRowConditions` が無いので実行できず、上表の直し前の
    値は新しい関数を入れずに測った別実行（同じ抜き出し・同じスタブ）から持ってきた。
  - 案内: 「画面を共有する」の項に、検索語や絞り込みで行が落ちているときの外し方と、
    直す前の筋違いの案内、条件を緩めても出ない行の扱いを書いた。
  - 失敗: 抜き出した関数の自由変数（`pendingDrawerKey`・`state`）を検査の下のスコープに
    置くのを忘れて `ReferenceError` になった（第 143 回と同じ失敗）。第 156 回の検査の
    ハーネスにも `SELECTABLE_KINDS` と新しい関数を足さなかった（同じ理由で落ちる）。
    説明文に中国語の字と英単語を 1 つずつ混入させ、コミット前に直した。
  - 今回点検して欠陥が無かった事柄（次の回のための記録）: 第 158 回の語の区切りの変更のあとで、
    てびきに書いた実測値 20 種（「Submission deadline」267 行、既定画面 478 行、
    「人工知能」182 行、「A*」61 行、「7 日以内」39 行、「カンクン」23 行、「延長」33 件、
    「推定」134 件、「オンライン」117 件、「第2ラウンド」378 行、中黒の分野表記 397 行 など）
    をビルドした `searchMatcher` と既定画面の組み立てで数え直し、全部が案内どおりだった。
    並び替えの導線も点検した: `SORTABLE_KEYS`（5 種）と列見出し `th[data-sort]`（5 個）と
    狭い画面の並べ替えボタン（5 個）が一致し、見出しはすべて `tabindex="0"`、ボタンは
    ネイティブなので `Enter` / `スペース` が効く。`keyBlockedByTarget` が `BUTTON` 上の
    `Enter` / `スペース` を世界に渡さないので、並び替えボタンで選択行の公式ページが
    開くこともない。件数を出さない早め絞り込みのボタンに誤解する数字は無く、
    `[data-sort]` の目印（`↑`/`↓`/`↕`）は見出しとボタンに共通で入る。
- **CSV のファイル名の日も、端末の時刻合わせで出ていた**（2026-08-09 実測・第 161 回の続き）。
  `exportShownCsv` の日付の組み立てが `new Date()` のローカル日付（`getFullYear` /
  `getMonth` / `getDate`）だった。このサイトは「日時は JST で出しています」と宣言し、
  一覧の日時も JST 固定で計算しているので、書き出したファイルの名前だけ人によってズレる。
  ビルドした `exportShownCsv` をスタブ（`Blob` / `URL.createObjectURL` /
  `document.createElement` の `download` 取り込み）付きで抜き出し、保存の瞬間を
  `2026-08-09T15:30:00Z`（JST では 8/10 0:30）に固定して `TZ` を変えて実行した:

  | 利用者のTZ | 保存されるファイル名（直し前） | 直し後 |
  | --- | --- | --- |
  | UTC | `kamiyobi-deadlines-20260809.csv` | `kamiyobi-deadlines-20260810.csv` |
  | Asia/Tokyo | `kamiyobi-deadlines-20260810.csv` | `kamiyobi-deadlines-20260810.csv` |
  | America/Los_Angeles | `kamiyobi-deadlines-20260809.csv` | `kamiyobi-deadlines-20260810.csv` |

  夜に締切をまとめる、出張先で端末を現地に合わせる、といった操作で日付が一日ずれる
  （同じ日に保存したファイルを人と交換したときに名前の日が合わない）。
  - 直し方: `Date.now() + 9 * 3600000` からの `getUTC*` で組む（`remain`・`fmtJst` と
    同じオフセット inline の流儀。この関数もビルド成果物から抜き出して検査する）。
  - 検査: 同じビルドを 3 つの `TZ` で実行してファイル名が揃うこと、名前の日が JST の日付で
    あり UTC の日付ではないことを見た。基準の瞬間が JST と UTC で違う日であること自体も
    検査に含めた（空振り防止）。
  - 案内: 「CSV」の項に、ファイル名の YYYYMMDD が JST の日付であることと、直す前の実測値を
    書いた。
  - 今回確認して欠陥が無かった事柄（次の回のための記録）:
    (1) てびきの「分からない」の語彙（未確認 / 該当なし / 評価なし）と画面の語 –
    「受付状況未確認」「次回締切の日付が未確認」は連結で組み立てていたので、ビルド後の
    字面検索では見つからなかった（実装はある）。
    (2) 「CCF 評価なし」も連結語で存在する（`ccf:N` → `CCF 評価なし`）。
    (3) 「締切まで 7 日以内」などの早め絞り込みボタンは件数を出さないので、誤解させる数字は無い。
    (4) 月別の出し入れは利用者の操作ではなく並び順から決まる（`shouldGroupMonths`）ので、
    URL に状態を入れる必要が無い。
    (5) 推薦画面では CSV ボタン自体を出さない（`exportBtn.hidden = recMode || !shown.length`）。
    (6) CSV の「残り日数」列は小数にならず、過ぎた行は負の整数（実測で -2633〜-2184 など、
    小数は 0 種）。「0」の行も 1 件で、これは本日到達の意味と合っている。
    (7) `next_check_at` がデータ生成時点で過ぎている行は 0 件（「次回確認予定」が過去の日時に
    なるケースは現在の収録に無い）。
  - 失敗: 検査の注入スクリプトでテンプレート相当の記号を文字列の中に書いたままにして、
    警告が 1 件増えた（連結に直して基準の 35 件へ戻した）。不要な補助関数の行を 1 行
    残してしまった（消した）。
- **行の詳細の公式確認の時刻だけが、利用者の端末の時刻合わせで出ていた**（2026-08-09 実測）。
  表の日時は `fmtJst` が +09:00 固定で計算し、ヘッダーにも「締切の一覧（日時は JST で
  出しています）」と書き、てびきの「日時」の項は「**表と詳細で同じ式を使う**」と書いていた。
  なのに公式確認の欄（公式ページを見直した時刻 `last_verified_at` と `次回確認予定`）だけが
  `new Date(...).toLocaleString("ja-JP")` を使っていた – これはブラウザの時刻合わせで出る
  値が変わる。ビルドした `verificationSummary` を関数ごと抜き出して、同じ入力
  （`last_verified_at: 2026-08-01T18:30:00Z` / `next_check_at: 2026-08-09T21:00:00Z`）で
  `TZ` を変えて実行した:

  | 利用者のTZ | 公式確認 | 次回確認予定 |
  | --- | --- | --- |
  | UTC | `2026/8/1 18:30:00` | `2026/8/9 21:00:00` |
  | Asia/Tokyo | `2026/8/2 3:30:00` | `2026/8/10 6:00:00` |
  | America/Los_Angeles | `2026/8/1 11:30:00` | `2026/8/9 14:00:00` |

  **次回確認予定は日付その物が一日違う**（8/9 と 8/10）。会議への出張先で端末の時計を現地に
  合わせる日本人研究者は珍しくなく、その状況で同じ行の表（JST 固定）と行の詳細（端末依存）が
  違う日時を書く。`toLocaleString` は数の区切りでも既に避けることにしてある
  （`countJa` の comment 「環境の実装差に左右される」）ので、この 2 箇所が取りこぼしだった
  （`site/app.ts` 全体を数えると同じ種の呼び出しは 0 になった）。
  - 直し方: `verificationSummary` の内側に `jstStamp` を置き、`fmtJst` と同じ式
    （`2026-08-02(日) 03:30 JST`）で出すようにした。内側に置いたのは、検査がこの関数だけを
    `new Function` で抜き出して実行できる形を保つため（第 159 回で語彙表を外に置いて
    検査が切れたのと同じ判断）。値が読めないときは噓の日付を作らず
    `読み取り不能（原文: …）` を出す（`generatedAtLabel` と同じ約束）。
  - 実測: 直し後は UTC / Asia/Tokyo / America/Los_Angeles の 3 通りで
    `2026-08-02(日) 03:30 JST` と `2026-08-10(月) 06:00 JST` が揃った。
    収録の実データの全タイムスタンプ（再現可能なビルドの実測で 2,576 件 – 見直し時刻 27 件と
    次回確認予定 2,549 件）で `fmtJst` の計算と
    結果が一致することも見た（内側への書き写しがズレていないことの確認）。
  - 検査: 同じビルドを `TZ` を変えて 3 回実行し、出る日時が変わらないこと、一覧と同じ形
    （`-` 区切りの日付 + 曜日 + 時刻 + 「JST」）であること、`fmtJst` と全件一致することを見た。
  - 案内: てびきの「日時」の項に、公式確認の日時も同じ JST であることと、直前まで端末設定で
    変わっていた実測値を書いた（「表と詳細で同じ式を使う」と書いてあったのに実装が
    守っていなかったので、案内と実装のズレ自体が欠陥だった）。
  - 失敗: 案内に閉じ損ねた `<code>` を 1 つ書いた（`3:30:00》` – 全角の閉じ括弧を打っていた）。
    ビルド後のタグ対応（`<code>` 173 / `</code>` 173）で確認して直した。検査の注入スクリプトで
    `fmtJst` が `pad` と `WEEKDAY_JA` を参照するのに気づかず 2 回落ちた（ビルド成果から
    両方を取り込んで入れるようにした）。`WEEKDAY_JA` の注入行は正規化の結果を二重に置いて
    構文エラーになった。文字列連結が lint の `useTemplate` を 1 件増やしたので
    テンプレートリテラルに直した（基準の 6 件 / 48 件・警告 35 件へ復帰）。
- **第 159 回で入れた「不明」が、画面の語彙の約束を破っていた**（2026-08-09 実測・自分の修正の
  副作用）。この画面は「分からない」を出すとき `未確認` / `該当なし` / `評価なし` の 3 語に
  揃えると決めていて、その約束は `recommendationAvailability` の comment と てびきの
  「未確認」の項に書いてある。**同じ種類の欠陥は 2026-09-23 にも記録済み**で、そのときは
  推薦カードだけが「受付状況不明」と出していた（てびきに無い語だったので直している）。
  第 159 回では公式確認の確認元が収録データに記録されていない行（`source_class: unknown`）の
  語を、その記録を調べずに `不明` と書いた。
  - 実測: ビルド後の `app.js` で利用者に出る「不明」は私の入れた 1 箇所だけだった
    （残りは comment）。ビルドした `verificationSummary` を関数ごと抜き出して収録全件
    （2,549 件）に実行すると、確認元は `公式CFP 26 件` `集約サイト 2,284 件`
    `出版社ページ 3 件` `未確認 236 件` になり、機械の表記も「不明」も出ない。
  - 直し方: `unknown: 未確認` に変え、てびきの「未確認」の項に、行の詳細の公式確認の欄でも
    同じ語を使うことを書いた（画面に新しい語を出すとき、てびきに語を足さないと同じ欠陥が
    再発する – 2026-09-23 の記録と同じ教訓）。
  - 検査: 確認欄が `不明` を出さないこと、てびきの「未確認」の項が確認元のケースを
    載せていること（画面の語が案内に有る）を確認に足した。
  - 検査環境と実測値がズレる件（正直な注記）: この検査群のビルドは `--no-embeddings` だけで
    実行しており（`--offline` と固定の時刻を付けない online ビルド・実行時刻も実時刻）、
    同じ語彙の検査でも `unknown` の行が **167 件**になった。てびきと SPEC に書いた
    236 件は再現可能な offline ビルド（`--offline --now 2026-08-09T00:00:00Z`）の実測で、
    CI が public/ を作るときと同じ組み立て方側の数。検査は件数を見ていない
    （`不明` が 0 件であることと、`未確認` が 1 件以上出ることだけを見ている）。
  - 教訓: 語を選ぶとき、収録データの値だけを見て決めず、**その欄の他の語とてびきの語彙を
    先に数える**（同じ画面の中に「分からない」の語が何通りあるかを測る）。
- **行の詳細の「公式確認」欄が、収録データの内部表記をそのまま出していた**（2026-08-09 実測）。
  ビルド後の `data.json` を数えると、確認付きの締切 2,549 件のうち

  | 欄 | 出ていた語 | 件数 | いま |
  | --- | --- | --- | --- |
  | 確認元 | `unknown` | 236 | 不明 |
  | 確認範囲 | `date・kind・round` | 15 | 日付・種別・ラウンド |
  | 確認範囲 | `date` | 8 | 日付 |
  | 確認範囲 | `date・kind` | 5 | 日付・種別 |
  | 確認範囲 | `date・kind・round・track` | 2 | 日付・種別・ラウンド・トラック |
  | 確認範囲 | `date・time・timezone・kind・round・track` | 2 | 日付・時刻・タイムゾーン・種別・ラウンド・トラック |
  | 確認範囲 | `date・time・timezone` | 1 | 日付・時刻・タイムゾーン（既定値と同じ語に寄った） |

  確認元は `official-cfp`（公式CFP）等の写し表があったのに `unknown` だけ抜けていた。
  確認範囲は、項目その物が無い行（2,516 件）は「日付・時刻・タイムゾーン」と日本語で出る
  設計だったので、**同じ欄の中で日本語と機械の表記が混ざっていた**。
  - 直し方: 語彙表を関数の内側にまとめる（抜き出して実行できる形を保つため – 外に置くと
    検査の `new Function` で参照が切れる。実際に第 159 回で既存検査が
    `ReferenceError: verificationFieldsJa is not defined` で落ちた）。
    確認元に `unknown: 不明` を足した（中身を推測して「記録なし」とは書かない）。
    項目名は日付・時刻・タイムゾーン・種別・ラウンド・トラック・締切へ訳す。
  - **知らない語は翻訳しない**（`mystery_field` → `日付・mystery_field`、
    `mystery-source` → そのまま）。中身を推測して日本語を作るほうが悪い。
  - `selector_or_field`（公式ページのどこを読んだかを示す機械の判定名）は確認範囲では
    ないので、訳せる 2 種類（`deadline-text-window` 3 件・`table-row:deadline` 2 件）は
    「本文中の締切の記述（公式ページの読み取り箇所）」のように言い換え、知らない判定名は
    `機械の判定名のまま: <語>` と出す。ただし実測ではこの 5 件はいずれも `verifiedFields` を
    持っていたので、この枝は現在の収録では通らない（防御として置く）。
  - 実測（ビルドした `verificationSummary` を関数ごと抜き出して、収録全件 2,549 件に実行）:
    確認元 `unknown` 236 件 → 0 件（「不明」 236 件）・集約サイト 2,284 件と公式CFP 26 件と
    出版社ページ 3 件は不変。確認範囲の内部表記 33 件 → 0 件（日本語へ）。
    「英文字だけの語を残さない」検査を足した（`公式CFP` のような和英混在は許す）。
  - 既存検査の更新: 「normal deadline drawer includes verification details」は
    `date・time・timezone` の表示を見ていたので、`日付・時刻・タイムゾーン` を見る形に直し、
    内部表記のまま出ていないかの確認を足した（既定値と同じ語になるため、正向の検査だけでは
    翻訳を証明できない）。
  - 案内: 「再確認待ち・要確認」の項に、確認元・確認範囲を日本語で出すことと、実測の
    数値（236 件・15 件）を書いた。
  - 失敗: 語彙表を関数の外に置いた版で既存検査が落ちた（上のとおり）。python での差し替えが
    残した空行でフォーマッタが 1 件エラーを出し（`npm run check` の終了コードが 1 に）、
    対象を絞って整形して戻した。検査で `map["unknown"]` の書き方が lint の指摘を 1 件増やした
    （別関数経由の参照にして解消）。
- **語に付いた疑問符・括弧だけで検索が 0 件になっていた**（2026-08-09 実測）。一覧の表記は
  `Lodz, Po (Poland)` や種別セルの `(AoE)` のように括弧・句読点を含むので、照合側はそれらを
  語の成分として扱うと困る。検索語側も同じ扱いだったため、文末に疑問符を打ちただけで
  当たり行が消えた:

  | 検索語 | 直し前 | 直し後 |
  | --- | --- | --- |
  | `ICDE` | 18 行 | 18 行 |
  | `ICDE？` / `ICDE?` | **0 行** | 18 行 |
  | `ICDE（2027）` / `ICDE (2027)` | **0 行** | 6 行 |
  | `sigcomm.` | **0 行** | 37 行 |
  | `(online)` | 3 行 | 19 行 |

  しかも 0 件案内は収録されているのに `語「icde？」は収録データにありません` と出し、
  検索の仕方が悪いと誤解させていた。逆に記号が行の一部に当たる絞りは効いていた
  （`-` は 3,123 行、`（）` は 504 行、`＋` は 85 行）ため、同じ種類の入力が
  「全件」「一部」「0 件」の三通りに割れていた。
  - 直し方: 検索語の分解だけを整えた（収録データ側は触らない）。
    (1) 全角の括弧・句読点・疑問符・引用符も並べ語と同じ区切りとして扱う
    （日本語は語間にスペースを入れないので `ICDE（2027）` が 1 語になっていた）。
    (2) 語の端に付いた同じ種類の記号を落とす（`sigcomm.` `ICDE?`）。
    (3) 文字も数字も含まない成分は語にしない（記号だけの検索語は「何も打っていない」と
    同じ＝全件）。上の `middleParts` が並べ語だけで語を作らないのと同じ判断の一般化。
  - `+` と `-` は端にあっても削らない。削ると `C++` が `c` に化けて、実測で 0 行のはずが
    745 行に化けた（`saint-malo` の表記も同じ理由で割らない）。`dateLike`（`2026-08-22`
    を割らない）と同じ系列の判断。
  - 実測（修正前後のビルドを作り、同じ検索語を `searchMatcher` に通した。上の表以外）:
    従来の検索語は不変 – 機械学習 494、networking 270、福岡 1、第2ラウンド 378、
    `第 2 ラウンド` 378、`8/27` 5、`2026-08-22` 10、`ai/ml` 4、サン・マロ 6、saint-malo 6、
    国内 46、推定 134、SC 46、online 19、オンライン 117、sigcomm 37、米国 778、延長 33、
    週末 1013、金曜 609、db 456、hpc 214、セキュリティ 526、ML 4、並列処理 220、IoT 7、
    `HPC 欧州` 38、`c++` 0 行（不変）。記号だけの入力は `-` `（）` `()` `...` `＋` `？`
    `?` `；` `～` のすべてが 3,235 行（全件）で揃った。
  - 0 件案内への影響: 記号だけから語を作らなくなったので、`語「（）」は収録データに
    ありません` のような案内は出ない（`queryTermCounts` が 0 語になる）。疑問符を付けた
    語の数え上げは、疑問符の無い語の名前でする（実測で `international？` → `international`）。
  - 案内: 「検索」の項に、語の前後の記号は無視すること・記号だけの検索語は何も打って
    いないときと同じことを書いた。
  - 検査: 収録データから語を取り出して、その前後に記号を付けた形（疑問符・全角/半角の
    括弧・句点・終止符）すべてで同じ行が引けること、記号だけの入力が全部同じ件数（全件）に
    なること、`+` が削られないこと（`c++` と `c` の件数が違うこと）を見ている。検査に注入する
    スクリプトの中でテンプレートリテラルの `${...}` を文字列として書いたため、警告が 2 件増えた
    （連結に直して基準の 35 件へ戻した）。
- **行の詳細を開いたまま「投稿先を探す」に切り替えると、`?row=` が推薦画面の URL に残った**
  （2026-08-09 実測）。`setMode` にはドロワーを閉じる箇所が無く、`writeUrl` は
  `drawerRow` をモードも見ずに `row` として書き出す。推薦画面では表を描かないので
  （`render` の `shown = recMode && !recommendationData ? [] : filter()`）、その URL を
  受け取った人は行を探しようがなく、**収録されている行なのに**第 156 回が入れた文
  `共有された行はこの収録に見当たりません。データの更新で無くなった可能性があります` を
  読まされた。データを消えたと噓になる文面なので、そのまま置けない。条件
  （「過去の締切も表示」）を勝手に外してもいた（推薦画面では条件欄自体が隠れているので、
  外れたことも見えない）。
  - 直し方 (1): `setMode` の先で `if (drawerRow) closeDrawer();` し、フォーカスの戻し先も
    消す。モードを変えると表が消えるのだから、開いていた行の詳細も閉じるのが実態に合う
    （`?row=` を引きずらない）。
  - 直し方 (2): `restoreDrawerFromUrl` の先で画面モードを見て、締切の一覧以外なら
    条件を外さず `リンクに行の詳細が含まれていますが、投稿先を探す画面では行を開きません。
    締切の一覧に戻すと開けます` を件数のうしろに出す（手作業で組み合わせた URL と、直す前の
    版本が作った URL で受け取る。理由を言うので、操作を止めない）。
  - 実測（ビルド成果物から `restoreDrawerFromUrl` を抜き出して実行）: 収録済みの行のキーを
    `mode=recommend` で渡すと、修正前は `toForm` → `render` が走って「この収録に
    当たりません」が流れ、「過去の締切も表示」が true になっていた（検査の revert でも
    同じ文が出ることを確認）。修正後は呼び出し 0 件・条件のまま・件数のうしろには
    「投稿先を探す画面では行を開きません。締切一覧に戻すと開けます」が出る。
    締切の一覧の画面での動作（条件を外して開く）は第 156 回の検査で不変を確認した。
  - 案内: 「共有」の項に、モードを切り替えたら行を閉じること（表の無い画面に URL を
    引きずらない）と、手元で組み合わせた URL を開いたときに理由を書くことを足した。
  - ハーネス: 第 156 回の検査が `state` の形を `toEqual` で見ていたので、画面モードの値が
    入った分を直した。モード変更時にドロワーを閉む呼び出しは、ビルド後の整形で改行が
    入るため文字列一致ではなく形で見るようにした。自分の混入として、コメントに英語の語を
    1 つそのまま書いた（日本語に直した）。
- **既定の一覧に出ていない行の共有リンクを踏むと、何も起きなかった**（2026-08-09 時点の収録で実測）。
  行の詳細のURL（`?row=`）を受け取った側は `restoreDrawerFromUrl` が `shown`（いまの一覧）から
  行を探し、見当たらないときは `return` するだけだった。ビルド後のデータで共有キーを数えると
  **3,207 件のうち既定の一覧に出るのは 475 件**で、残り **2,732 件**（過ぎた締切 2,295 件・
  推定 134 件・表に出さない種別 303 件）へのリンクを踏んでも、画面はただ既定の一覧を出すだけだった。
  論文のメモやスライドに去年の締切のリンクが残っていることはふつうにあり、リンクが壊れているのか
  収録が消えたのか利用者には区別できない。
  - 直し方: 行の分類を `sharedRowState`（`past` / `est` / `other` / `missing`）として立て、
    既定で隠している条件は**その行のために自分で外す**。過ぎた締切なら `state.past`、推定なら
    `state.est` を立てて `toForm()` で条件欄のチェックも書き直す（外れたことが画面に出ないと
    「なぜ過去の行が並んでいるのか」が読めない）。そのうえで `render()` を通して一覧を作り直し、
    行を見つけたら従来どおり目印を付けてから詳細を開く。
  - 表に出さない種別（採否通知・カメラレディ・反論期間・補足資料など 303 キー）は絞り込みの問題
    ではないので、条件を触らず**その行だけを開き**、件数のうしろに「表に出さない種別なので行を
    開いて中身を出します」と書く。当初は「上の絞り込みを確認してください」と書く案だったが、
    それは噓なのでやめた。
  - 収録に無いキーのときは黙ったままにせず「共有された行はこの収録に見当たりません。データの
    更新で無くなった可能性があります」を `#countLive` に出す（`render()` が同じ場所を書き直すので、
    呼び出しは render の後。0 件案内と同じ 「 ｜ 」 の形に揃えた）。
  - 実測（修正後。ビルド成果物から `sharedRowState` と `restoreDrawerFromUrl` を抜き出して実行）:
    全 3,235 行について分類は画面の「過ぎた締切」判定（`rowIsPast`）と食い違い 0 件。過ぎた締切の
    リンクでは `state.past` だけが入り（`est` は入らない）`toForm` → `render` → 目印 → 詳細を開く、の
    順で該当行が開く。推定のリンクでは `state.est` だけが入る。表に出さない種別では条件が変わらず
    行が開き、件数のうしろに種別の話が出る。存在しないキーでは開かず、その旨がそのまま出る。
    一覧の作り直し（`render`）は検査側で画面と同じ規則（推定を含まない・表に出す種別だけ・過ぎた
    締切はチェックがオンのときだけ）で再現し、判定その物はビルド済みの `rowIsPast` を使った。
  - 案内: 「共有」の項に、リンク先の行が既定の一覧に出ていないときの振る舞い（条件を自分から
    外すこと・チェック欄に出ること・表に出さない種別で行を開くこと・収録に無ければそれを書くこと）
    を書き直した。従来は「相手も同じ条件で開かないと同じ行が見つからないことがあります」という
    注意書きだけで、実際には何も起きなかった。
  - ハーネス: 第 152 回の検査は `restoreDrawerFromUrl` の手順を 1 か所ずつ読んでいたが、`render()` が
    分岐の中に 2 つ、`openDrawer` も 2 か所になったため読み方を直した（最後に走る `render` が
    選択より前であること、末尾で詳細を開く手順の順、を見る）。自分の混入として、コメントに中国語の字を
    1 つ（関数の書き方）書いた – リポジトリ側の語彙の検査が捕まえた。追加した検査の文字列連結で
    info が 8 件増え、テンプレートリテラルに直して基準へ戻した。
- **0 件案内の画面側だけが URL を「語」と呼んでいた**（2026-09-23 実測）。第 154 回は読み上げ側
  （`zeroResultLiveNote`）だけを直した。画面に出る 0 件案内（`emptyDeadlineHint`）は URL を知らず
  検索語その物を引用するので、ビルド後の関数に
  `https://warwick.ac.uk/fac/sci/dcs/aamas2027/` を渡すと
  `検索語「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」は収録済みで 6 件に当たります` と出し、
  同じ画面の読み上げは「収録に見当たりません」と言っていた。**同じ画面の中で目の字と読み上げが
  逆のことを言う**状態だった。収録に無い URL には
  `検索語のうち「example-university」は収録データにも見当たりません。その語を外すと増えます` が
  出ていたが、URL に外せる語は無いので実行不能な案内である。
  - 直し方: `emptyDeadlineHint` にも `urlQuery` を渡す（0 件案内のオブジェクトは両方の案内で共通なので、
    判定の呼び出しは 1 か所のまま）。画面側に同じ URL 用の文を立てる。ドメインが収録に
    当たっているとき（`queryMatch.catalog > 0`）は「収録に無い」とは言わないので、引用の形だけ
    `その URL のドメインは収録済みで N 件に当たります` に直す（数十文字のアドレスを引用しない）。
    URL のときは語ごとの内訳（`検索語のうち「〜」は…見当たりません`）を立てない。
  - 読み上げ側の顺序も直した：第 154 回の枝を `queryMatch.catalog === 0` のときに限定した。
    限定しないと、共有ホスト（github.io など）の URL を貼って条件で 0 件になった人に
    「収録に見当たりません」と噓を言う（実測で `urlPresent` のケースの読み上げがそうなっていた）。
  - 実測（ビルド成果物から `emptyDeadlineHint` と `zeroResultLiveNote` を抜き出して実行）:
    - 収録に無い URL: 画面・読み上げとも `検索語の URL の会議は収録に見当たりません…` で、
      「その語を外すと増えます」は消える。
    - 収録済みのドメイン: 画面 `その URL のドメインは収録済みで 6 件に当たります（…）`、
      読み上げ `検索語は収録で 6 件に当たりますが、いまの条件では 0 件です`。どちらも
      「収録に見当たりません」を言わない。
    - 語の検索語（`機械学習 福岡 GPU`）: 画面 `検索語のうち「GPU」は収録データにも見当たりません。
      その語を外すと増えます`、読み上げ `語「GPU」は収録データにありません` で不変。
  - 同じ画面の二つの案内が同じ判定を読むようにしたので、検査は両方の案内関数に `filter.urlQuery` が
    入っていることまで見ている（片方だけ直す状態を残さない）。
  - 検査の言葉づかい: 追加した検査で文字列連結を使い、ファイル別のカウントが検査ファイルで
    48 → 50 に増えた（荒い集計では 67 → 74 と見えたが、ファイル別の内訳が正しい）。
    テンプレートリテラルに直して HEAD と同じ 48 / 6 に戻した。
- **URL で引いて 0 件の人に「語が無い」と言っていた**（2026-09-23 実測）。第 153 回で URL 検索を
  通したので、URL を貼って 0 件になるのは「その会議が収録に無い」という意味になった。ところが
  0 件案内は従来どおり `語「〜」は収録データにありません` の形で、長い URL を「語」と呼んで
  読み上げに流していた。収録の中心（ランク付けの一覧に載る会議と国内研究会）が伝わらず、自分の
  検索の仕方が悪いと誤解されて終わりになる。
  - 直し方: 照合側と同じ判定（`urlLikeQueryTerms` を使う `looksLikeUrlQuery` – recommender から
    呼び出せる形にした）で検索語が URL の形かを見て、0 件案内の分岐を URL 用に別に置く。
    言う内容は (1) 何を引いたのか（URL の会議）(2) 収録に見当たらない (3) 収録の中心 (4) 次に打つ
    もの（会議名）の四つ。既存の「下に外せる条件も書いてあります」の言い回しはそのまま使う。
    データその物が無いときは、URL でも従来どおりそれを先に言う（分岐の顺序をその順にした）。
  - 実測（ビルド成果物から `looksLikeUrlQuery` と `zeroResultLiveNote` を抜き出して実行）:
    `https://www.example-university.edu/symposium-2027/cfp` と `example.ac.jp/workshop27`
    （スキーム無し・パス付き）は URL と見分け、新しい文が出る。`機械学習` / `ICDE 2026` /
    `3/5` / `研究会` / 空文字は URL 扱いせず、従来の `語「機械学習」は収録データにありません` のまま。
    件数その物が 0 のときは `｜ 締切のデータが入っていません` が先に出る。
  - 副産物として、数え上げ側（`queryTermCounts`）は `queryTokenGroups` を通るので URL の正規化が
    既に効いていた（実測で語の分解はホストの構成要素になり、照合と数え上げがズレていないことを
    確認した – 直すべき箇所ではなかった）。
  - 案内: 「検索」の項に、URL で引いて出てこないときは収録していないこと、収録の中心、
    会議名のほうが当たりやすい場合があることを書いた。
  - 検査の言葉づかい: 検査メッセージに、日本語の代わりに英語の動詞を 1 つ混ぜた。日本語に直した。
    検査に注入するスクリプトの文字列末尾にカンマを残して構文エラーにしたのも 1 回
    （`const x = […],` の形で次行の `const` と繋がった）。
- **公式ページの URL を検索欄に貼ると「収録に無い」と誤解させていた**（2026-09-23 実測）。
  メーリングリストで CFP のリンクを受け取った人が、このサイトに収録されているか・締切はいつかを
  確認するのに URL を貼る。会議の検索語（`hay`）に URL は入っておらず、照合側も URL をそのまま
  語に分解するので `https` やパスの語（`fac`・`sci`・`index`）まで AND 条件にはいって必ず 0 件
  になった。0 件案内は「条件を緩めてください」と言うだけで、収録有無の話ではないのに収録欠落と
  誤解される。
  - 直し方: 締切行・会期だけの行の検索語に、公式ページの**ホスト名の構成要素**を足した
    （`linkSearchTerms`）。パスの語は他の語と衝突するだけで入れない。照合側も検索語が URL /
    ホスト名の形をしていると検出した時点でホストの構成要素に直す（`urlLikeQueryTerms` –
    `queryTokenGroups` の入口）。`https://` が無い形（チャットからコピーした形）と、ポート番号・
    パス付きにも対応する。
  - 2 文字以下の構成要素（`ac`・`uk`・`jp`・`www`）は入れない。どの会議のドメインにも出る語なので、
    入れたとたんに短い略称の検索が誤爆する（実測で `www` と 2 文字以下を入れた版は「SC」が
    45 行 → 47 行になった）。除いた現在は 45 行 → 46 行で、増えた 1 行は公式ページが
    `sc-protools-workshop.github.io` の研究会（`sc` が語頭にある）で、**ゼロにはできない**ため
    実測値のまま残す（ドメインを検索語から完全に外すと、共有ホスト（github.io・easychair.org など）
    の URL を貼った人がその会議にたどり着けなくなる。そちらのほうが大きい不利益）。
  - 実測（修正前のビルドと修正後のビルドを作り、同じ検索語を `searchMatcher` に通した）:
    「https://icsoc2026.it.p.lodz.pl/」0 行 → 3 行（該当会議 0 → 1 件）、「warwick.ac.uk」
    0 行 → 6 行、「asiaccs2027.cityu.edu.mo/index.html」0 行 → 12 行（スキーム無し・パス付きも可）。
    従来の検索語への影響は「機械学習」494 → 494、「networking」270 → 270、「db」456 → 456、
    「米国」778 → 778、「延長」33 → 33、「研究会」24 → 24、「hpc」214 → 214、「セキュリティ」
    526 → 526、「推定」134 → 134 で不変（前掲の「SC」だけ +1）。
  - 案内: 「検索」の項に、URL をそのまま貼れること・スキーム無しでもパス付きでも同じことを書いた。
  - 型: `EditionRecord` に `link` を足した（上流のデータは回ごとに公式ページを持っており、
    従来のコードは `ed as { link?: string }` の書き換えで読んでいた）。
  - ハーネスの手当て: 検索の関数群を抜き出している検査（12 本）が `urlLikeQueryTerms is not
    defined` で落ちた（抜く関数の一覧に新しい 4 つを足した）。検査で文字列連結を使ったら
    `useTemplate` の info が 3 件増え、テンプレートリテラルに直して基準（67 件）へ戻した。
    説明文の中で「warwick ac uk」と期待値を自分で書き換える奇妙な書き方をして自分で直した。
- **キーボードで選んだ行が、描いていない行を指していた**（2026-09-23 実測）。選択は `shown`
  （絞り込み後の全行）まで進むが、表に描いてある行は `drawn` 行だけ（既定の PAGE は 40 行）。
  `j` を 40 回押すと、ハイライトとフォーカスは 40 行目に残ったまま内部の選択だけ 41 行目以降へ
  進んだ。`d` を押すと**画面に出ていない行の詳細が開く**。支援技術では読める行と開く行が違い、
  キーが効かなくなったようにも見える。第 148 回の共有リンクの受け取り側も同じ状態で、行番号が
  40 を越えると描かれていない行の詳細が開いた。
  - 直し方: `ensureRowsDrawn(index)` を増やし、選択が描画範囲を越えそうならその場で
    `drawMore()` を呼んで足りない分を描く（マウスなら「さらに表示」を自分で押せるが、
    キーボードだけで操作する人にその入口を探させるのは無理がある）。`j` / ↓ と `d`、
    共有リンクの復元から呼ぶ。`drawn < shown.length` で止まるので末尾で無限には回らない
    （呼び出し回数が変わらないことも検査で見る）。
  - 副次的に直った点: `render()` は本体の先頭で `drawn = 0` と `selectedIndex = -1` に戻す
    （実測）ので、第 148 回の復元は `render()` の前に選択を置いていて、**受け取った側の画面で
    開いた行に目印が付いていなかった**。描き終えた後に選択を置いて目印を付ける順序に直した
    （render → 選択 → 描画 → 目印 → 詳細）。
  - 実測（ビルド成果物から `ensureRowsDrawn` を抜き出して実行・40 行ずつ描く見立て）:
    index 5 → 40 行を描く（1 回）、41 → 80 行、94 → 95 行（全行）、同じ index を再度頼んでも
    描き足さない（3 回のまま）、総数より遠い index（500）を頼んでも 95 行で止まる。
    復元の手順はビルド後の `restoreDrawerFromUrl` 内で render() < 選択 < 描画 < 目印 < 詳細 の順
    （位置 216 < 441 < 470 < 500 < 530）になっていることを確認。
  - 検査: `render` の本体に `drawn = 0;` と `selectedIndex = -1;` があること（順序の要求の
    根拠）、`j` の枝が `ensureRowsDrawn` を `updateRowSelection` より前に呼ぶこと、`d` の枝も
    呼ぶこと、復元の順序、上の実行検証を見る。
  - ハーネスの fallout（正直に記載）: `onKeydown` を抜いていた検査が 4 本 `ensureRowsDrawn is
    not defined` で落ちた。共通 helper にスタブを足して 3 本を救い、helper を使わない 1 本は
    仮引数を増やした。ここで `new Function(p1, …, pN, body)` の **最後の引数が関数本体**である
    ことを忘れてパラメータを末尾に足し、`safeExternalUrl` に渡していた実引数が 1 つずれて
    Enter の検査が落ちた（`site/app.ts` を戻しても同じ失敗をすることを確認し、実装でなく
    検査側の誤りと切り分けた。仮引数は対応する実引数の位置に足す）。検査の文字列注入で
    スクリプトを壊して検査が 1 件も走らない状態にしたのも 1 回（行単位で書き直して和した）。
- **「条件クリア」が、名前の範囲を超えて打ち込んだ論文の概要まで消していた**（2026-09-23
  実測）。`#reset` の中に `paperText`・`paperReferences`・`paperPrimaryTitle` 等への代入と
  選んだファイルの解除が残っていた。絞り込みをまとめ直す目的で押す人が、Confirmation も
  Undo も無く長文の概要を失う。この目的はてびき自身が案内している（「条件を一切外さない一覧が
  欲しいときは『条件クリア』を押してから書き出してください」）ので、CSV を出すためだけに
  押す人まで概要を失っていた。
  - 直し方: 条件クリアは名前の通り条件だけを外す。論文の入力をまとめて消す操作は、そう書かれた
    新しいボタン「論文の入力を消す」（`#paperReset`・投稿先を探す画面にだけ出る）へ寄せた。
    両方に共通する消し込みは `clearPaperInput()` にまとめる（条件クリア側からは呼び出さない）。
    条件クリア側は `invalidateSemantic()` をそのまま残す（意味検索のキャッシュを無効化しても
    再計算されるだけで誤りはなく、削って他の経路と差を作るより安全なため）。
  - 実測（ビルド成果物から `clearPaperInput` と `setPrimaryRecord` を抜き出して実行）:
    `paperText` / タイトル / 概要 / キーワード / 参考論文の五つが白紙になり、PDF から取った
    掲載先の想定（`paperPrimaryVenue`）も白紙、選んだファイルの解除表示は「未選択」、
    意味検索の無効化が 1 回走る。条件クリアの節にこれらの欄名が残っていないことも検査で見る
    （節の範囲は自分自身の `addEventListener("click"` を飛ばして切る – そこで切ると
    `$("reset").` だけの範囲になり検査が空振りした）。
  - 案内: 「一致評価の出し方（投稿先を探す）」の項に、条件クリアは条件だけを外すこと、
    論文の入力を消すのはその名前のボタンであることを書いた（ボタンの語はビルド後の HTML から
    取って同じ語で照合する）。
  - 検査の語の注意: コメントに簡体字が 1 文字混ざり（五）、本文の言い直しで動詞の形が壊れた語を 1 回作った。ビルド後に自分で読んで直した。
- **Word のファイルを渡すと「あなたの PDF は読めない」と言っていた**（2026-09-23 実測）。
  「投稿先を探す」の論文を選ぶ欄は `accept=".pdf,.txt"` だが、ピッカーは「すべてのファイル」に
  切り替えられるので他の形式も運ばれてくる。従来は拡張子を見ておらず、`.docx` も PDF として
  pdf.js に渡していた。pdf.js は `Invalid PDF structure.` を落とし、画面は
  「PDF から文字を読み取れませんでした（文字が入っていない PDF や、パスワード付きは読めません）」
  と言う。日本語の論文の下書きは Word や一太郎の場合があり、自分の PDF の文字化けを疑って
  直せない方向へ探させる案内になっていた。
  - 直し方: 非対応の文書形式（doc / docx / odt / rtf / pages / wps / ppt / pptx / odp / key /
    epub / zip）を名前で検出して、PDF として読まずに断る。断り文は拡張子を実名で出し、
    対応形式（PDF と TXT）と次の行動（TXT に保存し直す・下の欄へ貼る）を書く。
    `pdfFailureMessageJa` の「タイトルと概要を下の欄に貼り付けてください」をそのまま使う
    （案内の語を二重化しない）。読み取りに行く前に止めるので、TXT と非対応形式だけのときに
    pdf.js の部品を取りに行かない。拡張子の無いファイルは従来どおり PDF として読む
    （従来の動作を壊さない）。
  - 実測（ビルド成果物から `unsupportedPaperFormatJa` と `pdfFailureMessageJa` を抜き出して実行）:
    `.docx` → 「.docx はこの欄で読めません（対応しているのは PDF と TXT です）。Word などは
    TXT に保存し直すか、タイトルと概要を下の欄に貼り付けてください」、`.odp` / `.key` / `.rtf` /
    `.wps` / `.epub` も同じ形で拡張子だけ変わる、大文字の `.ODP` も捕まえる。
    `notes.txt` / `paper.pdf` / `paper.PDF` / 拡張子無しは従来どおり読み取り側へ通る。
    本物の PDF 失敗（`Invalid PDF structure.`）の文とキャンセルの文は変わっていない。
  - 欄の注記にも「Word などの文書形式は読めません」を添えた（押す前に分かるようにする）。
  - 検査: 弾く側の文言が「PDF が読み取れない」と言わないこと、対応形式を名指しすること、
    TXT / PDF / 拡張子無しを弾かないこと、既存の PDF 失敗の文が生きていること、
    名前を見る場所（`readPaperFile` の中）に判定があること、注記がビルド後のページにあることを見る。
  - 検査の言葉づかい: コメントに書いた二字の語（中国語でも使う形）が、中国語の略語を混ぜない
    検査に部分一致で引っかかった（日本語の文中あっても同じなので、捕まった語を検査や説明文に
    書き写せない）。コメントを言い換えた。
- **行の文字を選んだ離す（コピーしたかった）にもドロワーが開いていた**（2026-09-23 実測）。
  `tr.onclick` はリンク（`A`）と一致評価の目印（`.match-trigger`）以外では必ず開く書き方で、
  選択の確認をしていなかった（`getSelection` の参照はビルド成果物に 1 件も無い）。会議名・会場・
  公式ページの名前をドラッグで選んで離すと、選んだ物がドロワーと背景に隠れて消える。締切の
  情報を人に転記する操作では毎回踏む。
  - 直し方: 選択が行の内側にあるときは開かないようにした。判定は 3 条件で、(1) 選択が畳まれて
    いない、(2) 選択の中身が空白だけではない、(3) 選択の起点がこの行のなかにある。
    (3) を入れたのは、他所に残った選択を理由に**いま押した行を開かない**のが別の不親切だから
    （行の外に残った選択は無視して開く）。(2) は、空いた場所をドラッグしてクリックしただけの
    場合に開いてよいようにするため。
  - 実測（ビルド後の `makeRow` を見立て DOM で動かし、`openDrawer` の呼ばれた回数で見る）:
    選択なしの行クリック → 開く、行内を選択して離す → 開かない、空白だけの選択 → 開く、
    他所に残った選択 → 開く。修正前は 4 回すべてで開いていた（`[1,2,3,4]` → `[1,1,2,3]`）。
  - てびきの「行の詳細」の項に、選んだときは開かないことを書いた（コピーしたい人がどこで
    知るか分からないと、操作が消えたと誤解されるため）。
  - 検査の手当て: 表を描くハーネスの見立ての要素に `contains` が無く（部分木の走査を足した）、
    `window` は空オブジェクト、`openDrawer` は空のスタブだったので、選択の注入と開閉の記録を
    追記した。`tr.onclick` は `event.target instanceof HTMLElement` で絞っているので、
    見立てにも `HTMLElement` と同じ判定を通るクリック事件を作った。
- **共有リンクに「この締切」が入っておらず、送られた側は表のなかから同じ行を探していた**
  （2026-09-23 実測）。絞り込み・並び順・てびきの開閉（第 99 回・第 140 回）は URL に残るが、
  行の詳細（ドロワー）を開いた状態はどこにも残らなかった。ビルド成果物の `writeUrl` に
  行に関する引数が 1 つも無いことを確認した。締切の共有は「この行を見て」という形ですることが
  多く、送った人の画面と別物になるのはこの機能いちばんの使いどころで起きていた。
  - 直し方: 開いている行を `?row=` に載せた。行の鍵は `rowShareKeyJa(r)` で、同じ一覧の中でも
    区別が要る（同じ会議が概要締切と論文締切で別行になり、同じ種別でも第 1・第 2 ラウンドが
    並ぶ）ので、会議の鍵に年・種別・締切時刻を添える。開いた時・閉じた時に `writeUrl()` を
    呼ぶので、コピーするのは開いた直後という順路で URL が揃う。リンクを開いた側は
    `render()` の後（`shown` が揃う前では行を探せない）に、該当行を選択行として開く。
  - 実測（ビルド成果物から実行）: 鍵は `SC|2026|paper|1794883140000` の形で、同じ行なら一致、
    種別がちがえば別、年がちがえば別。情報の無い行は例外にせず `|||`（照合にしか使わない）。
    `writeUrl` の出力は `?mode=deadlines&row=SC%7C2026%7Cpaper%7C1794883140000` ✓
    詳細を閉じて送ると `row=` は付かない（幽霊の詳細を残さない）。
  - 同じデータの生成日で開かないと同じ行が見つからないことがある。そのときは**黙って表だけ**
    出す（存在しない行を開くより、開かないほうがマシな誤解で済む。てびきに「相手も同じ条件・
    同じデータの生成日で開かないと同じ行が見つからない」と書いた）。件数欄へ注意を足さないと
    決めたのは、行の有り無しと無関係な読み上げを増やしたくないためで、第 140 回の
    `?help=1` と同じ判断を踏襲した。
  - 検査: 既存の「画面を共有する」の復元ハーネスに行の往復を足した（送った URL に `row=` が
    残り、開いた側で復元された鍵が元の行の鍵と一致し、閉じて送ると付かない）。追加の検査では
    書き出しと読み取りが対であること、`readUrl()` → 描き込み → 復元 の順になっていること、
    鍵が種別と年で区別できること、てびきに `?row=` が書いてあることを見る。
  - ハーネスの不具合（正直に記載）: `openDrawer` / `closeDrawer` が URL を書き換えるようにした
    ので、その関数を抜いていた 6 本が `writeUrl is not defined` で落ちた（仮引数と実引数を
    同じ回で足して和した。1 本は `new Function` を使わず関数ソースを直接埋め込む形だったので、
    `node -e` が厳格モードであることにより、代入される `drawerRow` の宣言も必要だった）。
    起動順を見る検査を 2 スペースインデントの文字列検索で書いたが、ビルド後は 4 スペースに
    整形されており空振りした（正規表現で行の並びを見る書き方に直した）。検査への追記で
    分解側だけ先に書き込んで tuple の型と突き合わせが合わなくなった（emit・型・検査を同じ回の
    置換で揃えて和した）。`rowShareKeyJa` の書き方で新しい lint 警告が 1 件増えたため
    optional chaining に直し、警告数 35 の基準へ戻した。
- **「投稿先を探す」画面で印刷すると、紙の但し書きが中身と違うことを書いていた**
  （2026-09-23 実測）。印刷物の先頭に置く `#printMeta` は表用の文を常時組み立てていたため、
  候補のカードが並んだ紙に
  `この印刷物: 投稿締切（概要・論文）／締切まで 30 日以内 ／ 表示 0 件 ／ …`
  と刷れていた。推薦画面では `shown` が空になる（`render` の
  `shown = recMode && !recommendationData ? [] : filter()`）ので、枚数も条件も紙のうえで噓に
  なっていた。紙は画面と違って後日ひとりでに意味を持つ（研究室で回覧される）ので、ここが
  食い違うのは許容できない。
  - 直し方: 推薦画面では別の文を立て、「モードの実物（ボタンの語）＋候補 N 件＋印刷した日時＋
    データ生成」だけにした。候補の数は `#recommendationCards` の子要素数から数える
    （画面に並んでいる物その物を数える）。締切一覧側の文は従来どおり。
  - 実測（ビルド成果物から `fillPrintMeta` を抜き出して実行）:
    推薦画面・候補3 → `この印刷物: 投稿先探す画面 ／ 候補 3 件 ／ 印刷した日時 2026-08-09 (日)
    09:00 JST ／ …`（モードの語は検査で画面のボタンから取っているので、実際の出力は
    「投稿先を探す画面」）、候補0 → `候補 0 件`、締切一覧・10行 → `… ／ 表示 10 件`
    （従来どおりで、候補の語は出ない）。
  - 同じ画面の別の穴: 印刷時に公式ページのURLを括弧で併記する規則が `#tbody a[href^="http"]`
    限定で、候補のカードはアドレス無しで刷れていた。紙では URL を押せない（この規則自体の
    趣旨）ので、`#recommendationCards` も対象へ加えた。
  - 検査: 画面のモード名はビルド後のボタンから取り、印刷文にその語と候補数が入ること、
    推薦画面で「表示 0 件」が出ないこと、締切一覧側で「候補」の語が出ないこと、印刷規則が
    候補のカードを隠していないこと、両方の `::after` 併記があること、てびきに同じ事実が
    書いてあることを見る。
  - 自分の実装ミス（正直に記載）: selector 展開の編集で `::after` を落としてしまい、URL が
    併記されない規則になっていた（ビルド後の CSS を見て発見、戻した）。案内の `</dd>` を
    今ラウンドでもう一度落としており、個数の対応を見る既存検査が同じ回で再び捕まえた
    （2回連続の同じ失敗。ビルド後の HTML を読む検査が入っていないと危なかった）。
    また検査本文に死んだコード（使わない `script` 配列）を残して片付け、その削除で
    `app` の宣言まで消して型エラーにした（戻した）。
- **収録元の締切名が、無印で種別欄に並んでいた**（2026-09-23 実測）。表の種別セルは本筋が
  「概要締切」「論文締切」だが、その下に収録元がその締切に付けた名前（`dl.label`）を小さく
  併記している。既定画面 478 行は**すべて**原表記を持ち、印も無く並んでいた。いちばん多いのは
  「Submission deadline」の 129 行で、「Paper submission」56 行、「Submission」34 行、
  「Abstract submission」28 行と続く（国内分は「発表申込締切」13 行など日本語）。
  英字の断片が分類のように同じ列に並ぶため、画面の種別ともう一つ別の分類があるように
  見えていた。
  - 直し方: 会期（`upcoming.md`）の項で既に使っている「**原表記**」の語をここでも使い、
    「原表記: Paper submission」の形にした。第 N ラウンドとの併記は従来どおり
    「第 2 ラウンド / 原表記: …」。表のセルと行の詳細で**同じ式**になるよう
    `kindDetailJa(round, label)` に寄せた（式が二つあると片方だけ直す – 第 128 回の教訓）。
    第 1 ラウンドは書かない、空白だけのラベルは落とす、数値が文字列で来ても壊さない。
  - 実測（ビルド成果物から `kindDetailJa` を抜き出して実行）:
    `(2, "Paper submission") → 第 2 ラウンド / 原表記: Paper submission`、
    `(1, "Submission deadline") → 原表記: Submission deadline`、
    `(null, "発表申込締切") → 原表記: 発表申込締切`、`(3, "   ") → 第 3 ラウンド`、
    `(null, null) → （空）`、`("2", "Abstract registration") → 第 2 ラウンド / 原表記: …`。
    呼び出し箇所は定義を含めて 3（表・ドロワー・定義）であることを検査で見る。
  - てびきの「種別」の項に、この語が収録元の呼び方その物であることと、**その語でも検索が
    引ける**ことを書いた（実測: 検索語「Submission deadline」で 267 行、「発表申込締切」で
    19 行当たる。画面に出る語を検索しても出ない、という食い違いにはなっていない）。
  - 自分の計測ミス（正直に記載）: 検索の当たり数を最初に測ったとき、`searchMatcher(q, now)` の
    戻り値を行オブジェクトに対して呼び、英字の語がすべて 0 行と出た（戻り値は hay 文字列を
    受ける関数）。正しい呼び方で測り直して 267 行等で確認したので、「引けない」という報告は
    出さずに済んだ。
  - 検査の手当て: `makeRow` / `openDrawer` を抜く既存ハーネス 5 本が新しい関数を知らないため
    `kindDetailJa is not defined` で落ちた。抽出済みの関数を並べる行・`new Function` の仮引数と
    実引数を同じ回で増やして直した（4 箇所は仮引数の追加だけでは実引数が後ろへズレるため、
    行番号指定で直した）。案内の `</dd>` を 1 つ落としましたが、既存の
    「`<dd>` と `</dd>` の個数が揃う」検査が即座に捕まえた。
- **狭い窓を開いた人だけ、キー操作が生きているのに案内が消えていた**（2026-09-23 実測）。
  件数欄のショートカットの注記（`.count-kbd`）と、てびきの「キーボードで一覧を動かす」の項
  （`.only-keyboard`）は、`@media (max-width: 640px)` の中に閉じ込めて隠していた。しかし
  `j` / `k` / `d` / `/` の処理に幅の判定は一切無い（`onKeydown` に `innerWidth` 等の参照が
  無いことを検査で確認済み）。パソコンの窓を左右に分割して 640px 未満にした人は、
  **キーは動くのに案内だけが消えた画面**を開くことになった（案内と実装のズレ）。
  - 直し方: 「幅」ではなく「操作手段」で分けた。この 2 つの規則だけを
    `@media (hover: none), (pointer: coarse)` に移し、狙って押せない操作手段（タッチだけ）の
    端末で隠す。第 85 回・第 103 回の判断（狭い画面＝ほぼスマホで誤導しない）は、幅という
    代替指標を使っていた点が誤りで、意図はそのまま残る。照合子の説明:
    MDN の `pointer` / `hover` のメディア機能（https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer ）。
  - 検査: ビルド後の `index.html` の `<style>` から、規則がどの `@media` ブロックに入るを読む
    （コメントは実装と同じく先に落としてから読む – コメントに URL を書いたとき自分の検査が
    誤読したため。CSS 側のコメントには URL を置かない）。`.count-kbd` と `.only-keyboard` を
    隠す条件が `(pointer|hover)` を含むこと、`max-width` のブロックに混ざっていないこと、
    `onKeydown` に幅の判定が無いことを見る。
  - 第 103 回の検査が旧方針（幅で隠す）をピンしていたので、**意図（見出しと説明を対で閉じる）を
    保ったまま**、照合する条件を操作手段のブロックへ移した。幅のブロックに混ざっていないことの検査に
    置き換えている。
  - 余談（実害の無い自分の失敗）: 検査の `@media` 解析で、条件にカンマが入る
    `@media (hover: none), (pointer: coarse)` を読めない正規表現を書いて一時スルーし、
    「規則が見当たらない」と誤表示した（コメント除去と合わせて直した）。
- **同じ数が画面と案内で二つの形になっていた**（2026-09-23 実測）。件数欄は
  「478 件 / 全 3235 件」、0 件の案内は「過去の締切 2317 件」と素の数値を出していたが、
  てびきは同じ数を「全 3,235 件」と書いていた。4 桁以上の数を見比べたときに桁の大きさが
  取り出しにくく、何より案内と画面の表記が食い違う。
  - 直し方: `countJa(n)` を置いて 4 桁目から 3 桁ごとに区切った（`toLocaleString` は環境で
    区切り文字が変わるので自前で書く。符号は壊さない – 残り日数でも使う）。
    画面の「… 件」を出す 25 箇所をすべて `countJa` 経由に揃え、**素の補間が残っていないかを
    ビルド成果物から洗う検査**を足した（1 箇所でも漏れるとその欄だけ区切りの無い数になる）。
  - 実測（ビルド成果物から `countJa` を抜き出して実行）: `478 → 478`、`999 → 999`、
    `1000 → 1,000`、`2317 → 2,317`、`3235 → 3,235`、`1234567 → 1,234,567`、`-5 → -5`、
    `0 → 0`。てびきの「全 3,235 件」は実行結果と同じ形になった（案内と画面を結ぶ検査を足した）。
  - ヘッダーの四つの数（収録している会議など）は 680 / 111 などで 3 桁のため影響なし
    （実測: `DATA.conferences` 680 件、このうち `tags` に `niche` を持つ穴場は 63 件 –
    穴場の欄が 0 になる不具合を疑ったが、測り間違いで値は出ていた）。
  - 検査の手入れで手間取った: 共有の関数を足したので既存ハーネス 7 本に同じ関数の宣言を
    入れる必要があった（抜くと `ReferenceError: countJa is not defined`）。最初の注入スクリプトが
    `it(` の行を 2 本重複させてファイルを壊し（`'}' expected`）、`it` の個数を検査して
    気づいた（正しく `^it(` の前で切る・挿入数を検査する書き方に直して元和し、検査で
    落ちる箇所を 1 本ずつ直した）。ピンしていた文言 6 本（「過ぎた締切 … 件は下に
    まとめました」等）と、レンダリング結果を見る 1 本（「過去の締切 1231 件」→
    「1,231 件」）を新しい形へ更新した。
- **画面に出る文へ折り返し形式の指定（markdown の記号）がそのまま残っていた**
  （2026-09-23 実測。ビルド済み `index.html` の可視テキストにバッククォートが 6 個 = 3 か所）。
  - てびきの本文に `NSDI 2027` / `cryptography` / `Tokyo, 日本` の形で書かれた行が有った。
    てびきの他の項目は `<code>` で囲む書き方になっていて（ビルド後 157 箇所）、この 3 か所だけ
    記号がそのまま画面に出ていた。HTML では `<code>` に直した。
  - 「評価なし」の吹き出し（`title`）は「この会議はその評価一覧に載っていますが、評価が
    付いていません（ kamiyobi の内部表記では `N`）。」だった。`title` は単文なので形式指定は
    効かず、記号がそのまま出る。加えて「内部表記」という語は画面のどこにも出てこないので、
    見た人が手がかりにできない。評価が付いていないことと、 kamiyobi が公式で裏を
    取れていないこと（「未確認」）は別に出している、という区別に書き換えた（てびきの
    「空欄の出し方」と同じ向き）。
  - 実測: 可視テキストのバッククォートは 6 → **0**、`<code>` は 154 → **157**。
  - 検査: 第 139 回の「markdown の記号を混ぜない」検査を拡張した。当時は `**` だけを見て
    おり、バッククォートと `__`、`[text](url)` の形を素通りしていた。表示される本文だけを
    見る（CSS・スクリプト・HTML コメントは除く。`<code>` の中は画面に出るので残す）方針は
    そのまま。吹き出しの宣言文も同じ検査に入れ、記号と開発寄りの語を見せないこと、
    吹き出しが使う「…」の中の語がてびきにも在ることを見る。
  - 検査に掛ける文字列の洗い出しで出た別の混入も直した: テストのコメントに「項」の簡体字
    表記を 2 箇所（自分の記入）残していたので日本語に直し、**その一字を検査の語彙に足した**
    （以後は検査が落とす。この項目その物に該当する字を書くと検査が自分の文書で落ちる
    ので、書き写さない）。
- **推薦のカードだけが「不明」という語を出していた**（2026-09-23 実測: 受付状況の欄が
  「受付状況不明」）。この画面の「分からない」は **未確認 / 該当なし / 評価なし** の三語に
  揃えてあり、てびきの「空欄の出し方」に同じ約束を書いてある。カードの語はてびきにも
  載っていなかったので、画面で見た人が意味を引けない語だった。
  - 直し方: `recommendationAvailability` の二箇所を、共有の語（`Recommender.unconfirmedLabelJa()`
    由来の `UNCONFIRMED_JA`）から組み立てる形にして「受付状況未確認」にした。もう一つ、
    `status === "open"` で次回の日付も時刻も出ていない行が同じ「不明」に落ちいていた。
    受け付けていること自体は分かっているので、分からない部分だけを書いて
    「次回締切の日付が未確認」に分けた。
  - 実測（ビルド成果物の `venueRecommendations` をプール 3,257 行で実行）。推薦カードの
    `availability.status` の内訳は **open 53 件・past 10 件・ongoing 4 件**（検索語
    「分散 GPU 環境での科学計算ジョブスケジューリングの性能評価」、時計 2026-08-09）。
    「常時受付」は `ongoing` の 4 件で実際に出る（はじめ到達不能を疑ったが、
    `candidateRows` だけ渡した測り間違いだった – ジャーナル行を足すと出た。てびきの
    「常時受付」は噓ではなかった）。
  - てびきの「空欄の出し方」に、カードでも同じ語を使うことと二つの言いぶりを追記した
    （閉じたてびきの語はページ内検索にかからないが、画面の語として引ける形にしておく）。
  - 検査: 既存のカードのハーネス（`recommendationAvailability` を正本で動かす）に
    「受付状況未確認」「次回締切の日付が未確認」「常時受付」の分岐を追加し、その語が
    ビルド成果物のてびきにも在ることを見る。共有の語はテスト側へ書き写さず、
    recommender の `const UNCONFIRMED_LABEL_JA` の宣言から取る。表示文に「不明」を戻さない
    検査（文字列リテラルだけ見る。コメントには出てよい）も同じ検査に足した。
  - ハーネスで踏んだ穴: 「未確認」の語を関数ごと抜き出して呼ぶと、関数は宣言済みの語を
    返すだけで `UNCONFIRMED_LABEL_JA is not defined` になる（既存の曜日の配列と同じく、
    宣言ごと取りに出す）。ガードの条件を `&&` で書いて空振りしかけた（`||` が正しい）。
  - 同時に測って問題がなかったもの（正直に記録）: 会期の開始が終了より後の行 0 件、
    締切が会期終了より後の行 0 件、2031 年より後の会期 0 件。「オンライン参加可のみ」で
    残るのは 3,235 行中 117 件で、開催地以外にオンラインの記載があるのに落ちる行は 1 件だけ
    （「KSIR Virtual Conference Center」という**会場名**で、正しく落ちている）。
    エクスポート CSV の「状態」列は既定画面 478 行中 189 行が空で、残りは「ランク未確認」など
    画面と同じ語。ボタン名は「表示中の N 件を CSV でダウンロード」と件数つきで正直。
    検索欄の複数語（すべて含む）もてびきに書いてある。文書の head も
    og:title / og:description / og:url / theme-color / `color-scheme` まで揃っていた。
- **0 件の読み上げが、画面に出ている案内の存在を言わず、緩められない画面では噓を言った**
  （2026-09-23 実測: 件数の読み上げは 「 ｜ いまの条件では行がありません。条件を緩めると出ます」
  だけだった）。0 件画面の下には「外せる条件」を並べるが、長い内訳を aria-live に流すと
  1 打鍵ごとに数十語になるため流していない（上の `countLive` の注記と同じ判断）。その結果、
  支援技術では 0 件と短い理由だけ聞こえ、下に見直し方があることを知らずにやめる。
  逆に、外せる条件が残っていない画面で「緩めると出ます」と言うのは画面の噓だった。
  - 直し方: 読み上げの末尾に「下に外せる条件も書いてあります」を添える（外せる条件が
    1 つでも残っているときだけ。数え合わせは 0 件案内と同じ `filtersClearable` を使う –
    第 136・137 回で揃えた同じ正本）。緩める条件が無いときは、その事実を言う。
  - 分岐の実測（ビルド成果物から `zeroResultLiveNote` を抜き出して実行。かっこの二重化も
    同時に潰した）:
    - 窓で絞った 0 件（**今日は実際に踏める形**）:
      「 ｜ いまの条件では行がありません。下に外せる条件も書いてあります」
    - 種別の語に当たった 0 件: 「 ｜ 検索語は「採否通知」の種別に当たります（表に出さない
      種別です）。下に外せる条件も書いてあります」
    - 何も絞っていないのに過去行だけ出ない: 「 ｜ 収録の締切はすべて過ぎています。
      「過去の締切も表示」で出ます」
    - 過去も表示し終えて 0 件: 「 ｜ 収録にいま以降の締切が残っていません。データ更新を
      お待ちください」
    - データその物が無い: 「 ｜ 締切のデータが入っていません」（従来どおり先に言う）。
  - 上の 3 番目・4 番目は 2026-09-23 の収録では踏めない（今後より後の締切が多数ある）。
    収録が古くなった日に効く防御であり、その旨を検査コメントにも書いた。
  - 検査: `zeroResultLiveNote` をビルド成果物から抜き出して 6 分岐を照合。「緩められない画面で
    緩めろと言わない」「かっこの二重化」も見る。呼び出し側が `clearable: filtersClearable(...)`
    と `pastShown: state.past` を渡していることの検査も足した。
  - 抜き出し関数のハーネスで同じ穴を再度踏んだ: 抜き出したソースを `JSON.stringify` して
    `const f = …` に代入すると**文字列**になり `is not a function` になる（式として入れる）。
    追加したガード節が lint 警告 3 件（`useOptionalChain`）を増やしたので、`?.` を使って
    基準の 35 件に戻した。
- **てびきが閉じたままでは、中身にたどり着けない場合があった**。`site/template.html` の
  「見方のてびき」は `<details>` で畳んで出しており、**閉じた `<details>` の中はブラウザの
  ページ内検索（Ctrl+F）にかからない**（ベンダー既知の制限として報告されている –
  WebKit bug 239940 https://bugs.webkit.org/show_bug.cgi?id=239940 、閉じた中身を自動で
  広げる仕様はまだ無効）。 「このページに書いてあるはずなのに見つからない」は、探している人を
  その場で止めさせる。
  - 直し方: てびきを開いている状態を URL で引き継ぐ `?help=1` を足した（`readUrl` /
    `writeUrl` の既存の条件と同じ流儀で、開いているときだけ載せる）。開閉したときは
    `toggle` を聞いて URL を揃える。これで「てびきを開いた画面ごと」をリンクで渡せる。
  - 見出し（summary）も直した。旧見出しは「JST・AoE・『推定』の意味」と**専門語を並べていた**が、
    AoE を知らない人ほどてびきを必要とする語だったので、画面に出る語そのもの（「推定」「未確認」
    「該当なし」・過去の締切の見方・CSV と印刷）に書き換えた。閉じた見出しだけが常に読める
    案内になるので、うたった語が中身に有るかを見る検査を足す（見出しの引用符の中身を
    そのまま本文と照合するので、見出しだけ語を足す変更は落ちる）。
  - てびきは画面の絞り込みではないので、`?help=maybe` のような値でも件数欄に注意を出さない
    （本当に外れた条件の案内が埋れる。チェック欄と同じ「チェックは入りませんでした」も
    ここでは不通）。
  - 検査: 既存の URL 往復ハーネス（readUrl / writeUrl を正本で動かす）に `?help=1` の往復を
    追加。`writeUrl` が `$("helpPanel")` を読むようになったので、ハーネスにも `$` の見立てを
    入れた（入れないと `ReferenceError: $ is not defined`）。ガード節を増やして検査の警告が
    1 増えたので、`$` が要素の欠落時に例外を投げる実装であることを確認したうえで見直し、
    警告数 35 の基準に戻した。
- **推薦の内訳に、足して読むように見える数字が出ていた**（2026-09-23 実測）。行の詳細を
  開くと「分野の一致 +18」「会議名一致 +9」のような項目が並び、同じカードには
  「一致スコア 65点」が出ていた。内訳の数字を足すと 27 で、65 にならない。
  63 点的な行は合計 21、59 点的な行は合計 57（検査で全表示行を数え、合計がスコアと
  違うことを実測で確認している）。
  - 原因は単位の違い。内訳の数字は手作業で決めた信号重み、画面のスコアは
    それぞれの項目の順位の融合 + 会議名一致 + 分野推定（0-100 に正規化）で、**別の計算**だった。
    てびきが「どの要素でどれだけ合ったか」と書いていたため、説明文が噓に協力していた。
  - 直し方: 内訳の項目は**当たった要素の名前だけ**を出す（順位など実数の項目はそのまま値を
    出す – 「意味検索の候補 順位 N 位」は本当の順位なので残した）。見出しを
    「この会議で当たった要素」に変え、てびきに「スコア（点）はこの内訳を足した値ではない
    こと」を書いた。空の値の `<em>` は空白の塊に見えるので出さない。
  - 副次的に、内訳に直書きしていた `+10`（分野推定の重み）も画面から消えた。 recommender 側の 10 とアプリ側の 10 が別々にあっても壊れない形になった。
- **画面に出る文へ markdown の強調記号が混じっていた**（2026-09-23 実測: 「残り」の項に
  `**日数は JST の暦日**` がそのまま表示されていた）。`site/template.html` は HTML なので
  強調は `<strong>` で書く。CSS・スクリプト・HTML コメントの中は画面に出ないので許し、
  **表示される本文だけ**を見て `**` を弾く検査を足した（今回の内訳の説明でも同じ失敗を
  しかけており、自前では気づかず検査で出た）。
- **投稿先を探すモードのカードに、論文の入力不足と読める語がほぼ全行に出ていた**
  （2026-09-23 実測: 概要・キーワードまで書いた入力で、画面に出る 25 件のうち 23 件が
  「情報不足」。意味検索の得点を合成した場合も 122 件のうち 120 件が同じ語だった）。
  実装を見ると原因は明らかで、ラベルは `max(言葉の一致, 意味検索の近さ)` が閾値に届かない
  行に出る（同じ会議群の証拠強度は語彙だけで 17 前後・閾値 40）うえ、`sufficient` 側は
  精度保証が取れるまで無効なので、**ラベルは常に出る**状態になっていた。常に出る警告風の語は
  利用者を足踏みさせる（「自分の文章が足りないなら書き足すまで意味がない」と受け取られる）。
  - 直し方: 語を実体に合わせて「重なりうすい」に変えた（一覧の別の案内がすでに
    「この論文の語と重なる投稿先が見つかりませんでした」という語を使っており、語彙を揃えた）。
    「候補」（いちばん近い会議との差が小さいこと）とあわせ、てびきの「一致評価の出し方」に
    両方の語の意味と「語彙検索だけだとほとんどがこれになる」ことを書いた。
  - 検査: カードに出る語を**実装から集めて**（ビルド成果物の `venueRecommendations` を
    論文 2 通で実行し、`fit.label` を収集）、その語がすべて画面の説明文中に有るかを見る。
    一番多く出る語の説明には実測の数字を添えることも要求する。ラベルをテストに書き写して
    いないので、実装だけ語を変えると検査が落ちる。
  - 副産物として「ラベルが 1 種類しかない」「推薦行が 1 も出ない」状態を空振りとして弾く。
  - 正直な制約: 上の実測はオフラインビルド（意味検索の重みが合成値）での値である。ブラウザでは
    意味検索が走るため分布は変わるが、どの設定でも（近さ 0.4 〜 0.9 を合成した 4 通り）
    表示行の 97 % 前後が同じ語だった点は変わらない。
- **列をまたぐ行の列数を 3 箇所に直書きしていた**（2026-09-23 実測: ビルド成果物に
  `colSpan = 7` が 3 件 – 月見出し・過ぎた締切の見出し・行の詳細）。同じ 7 は表の見出し
  （`site/template.html` の `<th>` 7 個）と行のラベル（`data-label` を付ける `<td>` 7 個）にも
  出ていた。列を 1 つ増やした日に見出しの跨ぎが足りなくなると、画面では見出しの右に列が
  余って「表示が欠けた」ように見え、支援技術では見出しが列に紐づかない。今日は直っている
  ので目に見えないが、同じ数を 3 箇所に持つ理由はない。
  - 直し方: `TABLE_COLUMNS_JA` に一本化し、検査で見出しの `<th>` 数・行のラベル数と突き合わせた
    （3 者とも 7 であることを実測で確認 – 見出し 7 / ラベル 7 / 定数 7）。
  - 同じ型のもう 1 件: **「条件をまとめて外す」が出る条件の数え上げに、推定が入っていなかった**
    （`filtersClearable` が `est` を見ていなかった）。第 136 回の 0 件案内は推定を
    「外せる条件」として並べるので、数え上げを揃えないと「案内は外せるというのにボタンが
    出ない」が起こりうる。2026-09-23 の収録では推定だけを入れて 0 件になるケースが起きない
    ため、今日は画面で踏めない（正直なところ、先行する防御）。案内と数え上げのズレを
    放置しないほうを選んだ。
  - 検査: 見出しは `<th\b` で洗う（`<th[^>]*>` は `<thead>` を抓到してしまう – 実際 4 個と
    誤読した。閉じタグを書く列と書かない列が混在しているので、その点も見る）。抜き出した
    関数を `node -e` で叩くとき、`JSON.stringify` したソースを `const f = …` に代入すると
    **文字列**になって `f is not a function` になる（式として入れる）。
  - 取り違えそうになった点（記録）: 「評価なし」が画面に出ず検索だけ、「常時受付」がてびきに
    無い、という2件を疑って測ったが、どちらも**誤り**だった。ランク欄は実際には
    `rankPairLabelJa("core:N")` → `CORE 評価なし` を 847 行に出しており（第一引数だけ渡して
    `CCF` と測ったのが間違い）、てびきも「常時受付」を種別の項で説明していた。
    簡便な語彙監査（文字列包含）は偽陽性を出すので、表示関数を実行して確かめる必要がある。
- **0 件の案内が、条件の名前だけ並べて数字を書かなかった**（2026-09-23 実測: 窓を 7 日・
  評価を A* に絞った 0 件画面の案内は「外せる条件: 「締切まで」を「かまわない」に変更 /
  「過去の締切も表示」をオン / …」の羅列だけだった）。同じ画面上の件数欄は、同じ条件で
  消えた行数を内訳として書いている（実測: 収録 3,235 行のうち推定 134 件・過去の締切
  2,317 件・投稿締切以外の種別 603 件）ので、案内の側だけ数字が無いのが不揃いだった。
  6 項目を並べても、どれから外す価値があるか読めない。
  - 直し方: `zeroFilter` に `est` と `hidden: hiddenDeadlineCounts()` を渡し、案内の各項目に
    件数欄と同じ名前の同じ数字を添える（「外せば増える」という約束ではなく「いまこの条件で
    隠れている行数」なので、そのように書く）。
  - **隠している行数が 0 の条件は勧めない**（同じ変更で自然に出る帰結。`past` 1,200 件・
    `window` 0 件の画面で「過去の締切も表示」を勧めるのは打ち直しの回数を増やすだけ）。
    これにより、種別だけの理由で 0 件になった画面に他の説明文が混ざらなくなった
    （既存検査「原因が特定できたときは他の文を足さない」が、この形で初めて成立した）。
  - 実測（ビルド成果物の `emptyDeadlineHint` を抜き出して実行）:
    「該当する締切はありません。 多いのは 「締切まで」を「かまわない」に変更（「締切まで
    7 日以内」を超える 438 件） / 「過去の締切も表示」をオン（過去の締切 1231 件） /
    「推定締切を含める」をオン（推定 134 件） / ランクを「すべて」に変更（評価「A*」を
    持たない行 416 件）。…」 内訳が無い画面では括弧も項目も出ない。
  - 既存検査 2 本の更新: ① 案内の見立てが `hidden` を渡していなかったので渡した
    （渡さないと呼び出し側の実装と違う見立てになる）。② 「案内が `KIND_ALL_LABEL_JA` を
    読む」検査が `tips.push(...)` という**呼び出し形**をピンしており、`tip(...)` 経由に
    したことで割れた。見たいのは定数を読んでいることなので、式そのものを見る形に緩めた
    （呼び出し形の実装ピンは、形を変えただけで誤検出する）。
  - 案内の項目名は選択肢の実ラベルのまま（「かまわない」「すべて」等の旧名読み替えを避ける）
    のを引き続き守る。
- **画面をクリックするたびに快捷键が死んでいた**（2026-09-23 実測: 完成した画面の
  `onKeydown` をビルド成果物から抜き出して叩いた – 「過去の締切も表示」のボタンを
  クリックした直後、`/` は検索欄にフォーカスを移さず、`j` は行を動かさなかった。
  どちらも飲み込まれることも無く無反応だった）。入力の受け皿になる欄
  （`INPUT` / `SELECT` / `TEXTAREA` / 編集できる欄）と **`BUTTON` をまとめて
  「すべてのキーを止める」対象にしていた**ためで、`j` / `k` を打つ人はボタンを踏んだ
  直後であることが多い（条件のチェック・並び替え・ページ送りのどれを踏んでも死んだ）。
  - 直し方: `keyBlockedByTarget(tag, key, contentEditable)` に切り出し、欄はすべてのキーを
    欄へ渡す（論文の本文に `/` が打てる）、**ボタンは Enter と Space だけ**ボタンに残して
    他はショートカットに渡す。`Esc` は従来どおり欄・ボタンから抜ける操作として先に扱う
    （検索欄から `Esc` で出て選んでいた行に返す動きは変えていない）。
  - 実測（ビルド成果物から `keyBlockedByTarget` と `onKeydown` を抜き出して実行）:
    ボタン上で `/` → 検索欄にフォーカスが移る ✓ `j` → 行が動く ✓ `Enter` / `Space` →
    飲み込まない（ボタン自身の操作に渡る）✓ 論文欄での `/` → 飲み込まない ✓
    検索欄の `Esc` → 欄を出て選んでいた行に返る ✓
  - 検査: ビルド成果物から 2 つの関数を抜き出し、画面と同じ外部の値（`$`・`state`・`shown` …）を
    引数で注入して `onKeydown` を実際に叩く。表としても `keyBlockedByTarget` の組み合わせを
    見る。てびきに「ボタンを押した直後も、そのまま打てる」と書いた（画面の挙動と案内を
    ズレさせないため、この語も検査にする）。
  - **自分の実装で踏んだ穴（記録）**: 抜き出した関数は独立していないので、新しい関数を
    増やすと `onKeydown` を抜く既存ハーネス 4 箇所がすべて `ReferenceError` で落ちた
    （第 127 / 130 / 131 回と同じ穴をまた踏んだ）。今回は同じ失敗を繰り返さないため、
    テスト側に `keydownWithBlockers(src)`（`keyBlockedByTarget` と `onKeydown` を結合して
    返す）を追加し、4 箇所をそこへ寄せた。ただし helper 化の途中で
    `const src = ${keydownWithBlockers(runtime)};` と **`JSON.stringify` を落とした**ため、
    生成される検査スクリプトに生の関数定義が埋め込まれ `onKeydown is not defined` に化けた
    （`ReferenceError` の場所が見立てスクリプトの内側だったので、原因がエスケープだと
    気づくまで一手多かった）。検査用のコメントに簡体字の表記を二度混ぜ、自前の検査に
    捕まった（この検査は `SPEC.md` も見るので、捕まった語を書き写して説明できない）。
- **CSV に書いた語を、画面の検索欄で打つと 0 件になった**（前項の直後点検。2026-09-23 実測:
  常時受付の行で `会期該当なし` が 0 件、`ランク未確認` も 0 件 – 画面のセルには出ているのに）。
  検索語（行の `hay`）に載せる語は `unconfirmedSearchTerms(ed, rankPairs)` が項目ごとに
  こしらえており、**「該当なし」を知らなかった**（第 129 回の語が検索に届いていなかった）。
  常時受付の行は `baseHay` に裸の「該当なし」を入れていたが、CSV は `会期該当なし` と書く。
 SPEC §2 の「画面に出る語は検索でも引ける」が、書き出し側で破れていた。
  - 直し方: 検索語も `unconfirmedFieldsJa(row)` から作る `unconfirmedHayJa(row)` に一本化し、
    項目別の旧実装は削除した。常時受付の行の `hay` にも同じ語を入れる（ランクが空の
    常時受付の行は `ランク未確認` として引ける。裸の「未確認」は、セルにそのまま出る語なので
    項目が一つでも未確認のときに入れる）。
  - 実測: CSV の状態の列に書いた語を、その行の `hay` に対して `searchMatcher` で引き返す
    プロパティ検査を作り、800 行で不一致 0 件。`会期該当なし` は 22 件（すべて常時受付。
    締切行は 0 件）、`会期未確認` は 264 件（会期が未知の締切行の件数と一致。常時受付は 0 件）、
    `ランク未確認` は締切 450 件＋常時受付 22 件。`該当なし` が締切行に効かないことも見る。
  - 検査で踏んだミス（記録）: ① ハーネスの `csv.split(/\\r?\\n/)` と二重エスケープして
    行が割れ、状態の列を 1 マスも検査できていなかった（`checked` が 0 で空振りに気づけた）。
    ② 静的検査を `app.js` に向けていた（検索語も CSV も `recommender.js` の側で作る）。
    ③ 検索語を作る部分のコメントに、つくりの違う同義語（中国語の表記）を混ぜ、自前の検査
    （中国語の略語を混ぜない）に捕まった。この検査は `SPEC.md` も見るので、捕まった語を
    そのまま書き写して説明することもできない（表記を伏せて書く）。
- **CSV に書き出すと、「未確認」「該当なし」が消えていた**（2026-09-23 実測: 会期が未知の
  締切行では 状態・会期・開催地の各列がすべて空。常時受付の行も、画面は「該当なし」と読むのに
  CSV では同じ空欄）。一覧のセルは空欄を作らないので状態の語が出るが、`deadlinesToCsv` の
  状態の列は `statusBadgeWords`（推定・延長・再確認待ち・要確認）しか入れていなかった。
  表計算に持ち出した人が「収録が無いのか、まだ確認できていないのか」を区別できない。
  - 直し方: `recommender.ts` に `unconfirmedFieldsJa(row)` を置き、画面のセルを作る条件と
    同じ判定（`fieldNotApplicableJa` も通す）で `会期未確認` / `開催地未確認` / `ランク未確認` /
    `会期該当なし` … の一覧を返す。**列は増やさず**、既にある状態の列が引き受ける –
    値の列（会期・開催地・ランク）は空のままなので、表計算では値で並べ替えてから、
    空・未確認・該当なしの区別を状態の列で読める。
  - 実測: 会期が未知の締切行 264 件のうち 264 件が `会期未確認` を持つ（= 区別が消えない）。
    常時受付 22 件はすべて `会期該当なし` を持ち、`会期未確認` は 0 件（第 129 回の区別が
    書き出し後も保つ）。会期が既知で開催地だけが未知の行は `開催地未確認` だけを出す。
    ランクは常時受付にも付き得るので `ランク該当なし` にはならない（0 件であることを検査にする）。
  - 検査: CSV は実物を書き出して列名で見出しから洗い、ミニパーサ（引用符・二重引用符を
    扱う）で状態・会期・種別の各マスを読む。件数は行の値からその場で作り、数字を書き写さない。
    壊れた行（`null` など）で落ちないことも見る。実装を一時的に戻して落ちることを確認済み。
  - 検査を作るとき二度ミスを踏んだ: ① `csv.split('\\n')` と二重エスケープして行が
    割れず、締切行が 0 件になった（改行は CRLF の可能性もあるので `/\r?\n/` にした）
    ② 「常時受付の行の状態に未確認を含めない」検査を `not.toContain("未確認")` で書いたが、
    `ランク未確認` が正当に出るので誤り（会期・開催地の未確認を見ていないと化ける）。
  - 既存検査 1 本が 状態の列を `,推定,` の一語でピンしていたので、語を中黒で並べる形に
    合わせて `/,推定(?:・[^,]*)?,/` に直した。
- **`upcoming.md` の列の意味が、表のうえで分からなかった**（2026-09-23 実測: 見出しが
  `| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |` で、**「R」が何かどこにも書いていない**。
  値は `R1`・`R2`・`-`。会期行の「残り」が「本日開催」「開催中(残り1日)」になることも、
  種別「開催」が締切ではないことも、表のうえでは説明が無かった）。この表は条件欄もてびきも
  ない単体のファイルとして読まれる（チャットに貼る・grep する・他ツールに食わせる）ので、
  表より上の数行で列の意味を確定できる必要がある。
  - 直し方: 見出しを `R` → **`ラウンド`**（一覧の列名と同じ語）に変え、表の上に列の凡例を
    足した（「残り」の数え方、種別「開催」は締切ではなく会期そのものであること、
    ラウンドの `R1`・`R2` と会期行の `-`、「推定」が前年までの実績から機械的に置いた
    未確認の値であること – 画面側と同じ説明）。
  - 検査: 見出し行から列名を割り出して洗い、**一文字だけのラテン文字見出しを失敗させる**
    （`R` が残っていると検査が落ちることを、実装を一時的に戻して確認した）。凡例が
    実際に表へ出る語（`本日開催`・`開催中`・`推定`・`残り`・`ラウンド`）で説明していること、
    種別「開催」が会期そのものだと書くこと、区切りの列数と見出しの列数が揃うことも見る。
  - 検討してやらなかったこと: `開催中(残り1日)` の半角括弧を全角に揃える話。表示は変わるが
    利用上の利点が薄く、既存のピン 2 件を壊すだけになるので送った。
- **同じ問題を、チェック欄とモードに広げていなかった**（前項の直後点検。2026-09-23 実測:
  `?past=true` と `?past=maybe` はどちらも黙って入りなしになった。読み側が
  `p.get("past") === "1"` だったため、`1` 以外の書き方を画面は説明しなかった）。
  - 直し方: `urlFlagJa(raw)` を追い、空・`0`・`false` は入りなし、`1`・`true`（大文字も可）は
    入り、それ以外は「読めない」として入りなし＋理由を出す。ラベルは画面に出る語そのもの
    （推定締切を含める・国内研究会・国内シンポジウムのみ・オンライン参加可のみ・過去の締切も
    表示）を使い、「チェックは入りませんでした」と書く。モードも同じで、読めない値のときは
    「締切の一覧を開きました」と、実際に何を開いたかを書く。
  - **自分の実装で実際に踏んだ2件**:
    1. `urlNotices = []` の初期化をモードの項より後ろに置いたため、モードの案内だけが
       无声で消えた（検査が捕まえた。案内は読み取りの冒頭で作り直す）。
    2. チェック欄を配列ループに直したら、既存の照合検査
       （「URL に書く条件は、URL から読みもする」が `p.get("…")` の鍵名を両方の関数から
       洗って突き合わせる作り）が `est` を読めないとして落ちた。この検査は正しい –
       鍵名を隠したほうの実装が悪いので、4 つの鍵を直書きに戻した（配列のほうが短いが、
       鍵名を検査から隠す実装は選ばない）。
  - 検査: 既存の抜き出しハーネス（正本をそのまま動かす）に `?past=true&est=TRUE` /
    `?past=0&domestic=false` / `?online=maybe` / `?mode=posts` / `?mode=deadlines` を足し、
    効く・黙って解除・理由が出る・既定画面を開いたことを対で見る。静的に古い
    `p.get("x") === "1"` を見ていた 3 検査は、新しい形に更新した（実装の形を検査側に
    書き写さないため、鍵を読む文と状態の代入の 2 文で見る）。
- **共有リンクの使えない値を、黙って落としていた**（2026-09-23 実測: `readUrl` は
  `?rank=B++` を空に、`?win=7d!` を `all` に、未知の分野鍵を除外するのに、いずれも画面に
  何も出さなかった。種別だけ `droppedKindNotice` で理由を残していた）。送った人は自分が見て
  いた画面を信じてURLを共有するので、受け取った人が「送られた意図より広い一覧」を
  開いているのが分からない。全分野の鍵が未知なら、そもそも絞り込んでいない画面になる。
  - 直し方: 通知の受け口を `urlNotices: string[]` に広げ（種別専用の `droppedKindNotice` は
    その1文をそのまま流用）、`readUrl` でランク・締切まで・分野・並び順の順受けも同じ口へ
    流し込んだ。件数欄のうしろに「リンクのランク「B++」はこの一覧で使えない値なので、
    ランクの絞り込みは外れています」のように、**もらった値とどうしたか**をそのまま出す。
    分野は、一部だけ外れたとき（その部分だけ外しました）と、全部未知で絞り込み自体が
    外れたときを分ける。
  - 知らない分野鍵はラベルの引きようが無いので、URL に書いたとおりの文字列で見せる
    （送った人が打った / 得た値が分からないと直せない）。
  - `dir` は受け付けを厳しくしなかった（未知の値は既定の昇順に寄る。URL は
    `writeUrl` が書く限り `asc|desc` しか乗らず、人が叩いても列の向きが戻るだけなので、
    警告を出すほどのことではないと判断した）。
  - 検査: 既存の `readUrl` / `writeUrl` の抜き出しハーネス（正本をそのまま動かす）に、
    ランク・締切まで・分野（部分 / 全部）・並び順の各ケースと、「正しい値だけでは何も
    言わない」ケースを足した。てびきの案内と実装の文言がズレないことを、両方に共通して
    入る断片（「はこの一覧で使えない値なので、」）を見る形で確認する。
  - 実装中に一度、`readUrl` の抜き出しハーネスが `Recommender` を注入しておらず
    `ReferenceError` になった（共有関数を増やさないほうが単純、と未知鍵は素の値を
    出す形に直した）。
- **常時受付の行の会期・開催地を「未確認」と出していた**（2026-09-23 実測:
  実データで常時受付の行は 22 件あり、その会期・開催地は表・行の詳細ともに「未確認」）。てびきは
  「未確認」を *kamiyobi が公式で裏を取れていない* 意味だと説明している一方、ジャーナルには
  会期も会場も**そもそも存在しない**。同じ語を当てると、読者は公式の発表を待つ情報だと誤って
  追跡させられる。
  - 直し方: `recommender.ts` に `notApplicableLabelJa()`（「該当なし」）と
    `fieldNotApplicableJa(row)`（常時受付の行か）、`notApplicableTitleJa(field)` を置き、表の
    会期・開催地セル、行の詳細の会期・開催地を切り替えた。理由（「常時受付のジャーナルには
    会期がありません」）は `title` に出す。知らない欄には空を返す（でたらめな理由を書かない）。
  - **画面に出す語は検索でも引ける**約束に従い、常時受付の行の検索語に「該当なし」を入れた
    （実測: 検索「該当なし」→ 22 件で常時受付の行と一致。締切行 3,235 件では 0 件）。
  - 置き換えすぎないことも検査する: 締切行に「該当なし」が出ないこと（誤って出すと、確認待ちの
    情報を消してしまう）、会期が未知の締切行が残っていること（「未確認」の出番が消えると
    検査が無意味になる）、`null` や空の行で落ちないこと。
  - 既存検査 1 本がドロワーの文字列を静的なまま見ていたため、新しい式に更新した
    （`placeNa ? NOT_APPLICABLE_JA : UNCONFIRMED_JA` と、ドロワー 2 箇所の出現数）。
  - 追加の検査は実データで動かす（件数を写さず `journalRows` の値と突き合わせる）。`node -e` に
    `require` とトップレベル await を同時に置いて失敗し、`await import('node:fs')` に直した
    （AGENTS.md に書いた落とし穴どおり）。検査を実装中に一度、自分自身の計測ミスをしかけた——
    常時受付の行は `candidateRows` ではなく `journalRows` が別に出すため、`candidateRows` だけで
    数えると 0 件に見える（実データ 22 件の確認は両方を合わせて行った）。
- **古いデータを開いた人に、それが何日前なのか伝わらなかった**（2026-09-23 実測:
  ヘッダーは「データ生成: 2026-08-09(日) 09:00 JST」と出すだけで、経過日数も更新が
  止まっている可能性も言わなかった）。更新は日次の運用（`.github/workflows/update-data.yml`
  の cron `17 20 * * *`）なので、数日経ったままなら止まっている。締切のサイトで古い一覧を
  最新と誤って使い、投稿の機会を逃すのが一番悪い失敗。
  - 直し方: `recommender.ts` に `dataAgeNoteJa(generatedAt, nowMs)` を置き、生成からの日数が
    **3 日以上**のときだけ「データは N 日前に生成されたものです。日次で更新する運用なので、
    更新が止まっている可能性があります。投稿前に公式サイトの募集要項を確認してください。」を
    返す。ヘッダーの「データ生成」の下に `class="stale"`（`var(--warn)`）で出す – 色だけでは
    なく本文で言う。閾値は実装の正本（`dataStaleDaysJa`）として持ち、てびき・検査はそこから
    読む（数字を書き写さない）。
  - 出さない条件を先に決めた。① 生成より過去（閲覧側の時計がずれている）→ 出さない
    ② 生成時刻が空・読めない値 → 出さない（その場合は「データ生成: 未確認」が別経路で
    出ていますで、二重に言わない）③ 経過時刻が計算できない → 出さない。根拠の無い警告を
    出さないことが先。
  - これは**締切の日付を推測する話ではなく、表示しているデータの生成時刻の話**である
    （収録契約の「締切の推測はしない」と衝突しない）。
  - 検査: 生成時刻を固定して閲覧側の時刻だけ動かし、2 日までは黙る / 3 日で出る /
    11 日で「11 日前」と実際の数字が出る、公式確認の依頼で締める、時計が過去・値が壊れて
    いる・現在時刻が計算できないでは空、を対で見る。実画面への配線（`dataAgeNoteJa(DATA.generated_at,
    Date.now())` とクラス）、CSS の色、てびきの説明も静的に確認する。検査側で一度、生成時刻も
    一緒にずらして経過が 0 になるミスを踏んだ（生成を固定し直した）。
  - テンプレートのコメントに残っていた英単語 1 箇所（単位を「each」ラベルに書く）も直した。
    画面には出ないが、このリポジトリの注釈は日本語で書く運用。
- **印刷物に、並び順が残っていなかった**（2026-09-23 実測: 印刷時に紙へ出る書き下ろしは
  「条件・表示件数・印刷した日時・データ生成日時」で、`describeFilters` は絞り込みしか
  知らなかった）。第 126 回で会期順が増えたので、「会期順で印刷して研究室に貼った」が紙で
  分からない – 日付が締切順と違う理由を読み手が確かめられない。並び順は絞り込みではないが、
  同じ一覧を並べ替えて配る用途では条件と同じくらい必要な情報。
  - 直し方: `describeFilters` に `sort` と列名の引き手を増やし、条件のうしろに
    「／ 並び順: 会期 昇順」を足した（既定の並びでも書く – 「締切の新しい順で印刷した」が
    分からないと同じ問題が残る）。列名は新しい `sortColumnLabel` が**画面の見出しから**取る
    （見出しは目印の矢印まで書き換えるので `↑↓↕` を落として語だけ出す。`sortNoteJa`
    （読み上げ）と同じ引き手を使い、列の名前を二箇所に書かない）。見出しに見当たらない鍵の
    ときは並び順を書かない（噓の列名を紙に残さない）。
  - 検査: ① 抜き出した `describeFilters` に並べ替えの鍵を通し、「並び順: 会期 昇順」
    「日時（JST） 降順」が出る、既定でも残る、見出しに無い鍵では書かない ②
    `sortColumnLabel` を見出しの実物に近い形（「会期 ↕」）で動かし、矢印が落ちる
    ③ 呼び出し側が `{ key: sortKey, asc: sortAsc }` を実際に渡していることを静的に確認する
    （抜き出し検査だけでは実画面は変わらない）。④ 「並び替えの状態は読み上げに伝わる」検査が
    `sortNoteJa` だけ切り出していたので、`sortColumnLabel` も注入する形に直した
    （共有した関数を増やすと、単位切り出しの検査が壊れるという同じ話）。
  - 検査名も実態に合わせて変えた（「条件・件数・日時」→「条件・並び順・件数・日時」）。
  - 同じ項の中で同じ操作を二度書いていた案内も直した。「キーボードで一覧を動かす」で
    `/`（検索欄へ飛ぶ）と `Esc` の説明が二回あり、読者が同じ操作を指すのか別々の操作なのか
    確かめられなかった。繰り返さないことを検査に入れた（同じ `<dd>` の中で同じ言い回しが
    1 回だけ出ることを数える形）。
- **表示している「会期」の列が並べ替えできなかった**（2026-09-23 実測: `SORTABLE_KEYS =
  ["rem", "date", "conf", "rank"]` で、見出しも 4 列だけが押せた）。出張の計画は「いつ
  開かれるか」順に見ることが多く、締切順のままでは会期が飛び飛びになる。既定画面 478 行を
  締切順に並べた状態で会期の昇順を数えると **707 箇所の逆転**があった（＝会期順が見えない）。
  - 直し方: 行に会期開始の instant `tEvent` を持たせた（会期は時刻を持たないので、画面と
    同じ暦日の JST 正午に置く。決まっていない行は `NaN`）。比較は `compareEventRows`。
    **会期が未確認の行は、昇順・降順のどちらでも末尾**に置く – 画面で「未確認」と読める行が
    先頭に来るのは噓になる（時刻未確認の行を末尾に置くのと同じ約束）。同じ会期の行は締切の
    基準で揃える。
  - 入口は三つを対で増やした: 見出し `th[data-sort="event"]`（`title` に未確認が末尾と
    明記）、狭い画面の並び替えバーのボタン、実装の鍵。どれか一つ欠けると「表示されているのに
    押せない列」か「押せない鍵を URL が受け付ける」ことになる。並び順の読み上げと
    `aria-sort` は見出しの語から自動で出る（書き写していない）。URL の読み書きも対
    （`?sort=event`。既定の向きなら `dir` を付けない）。
  - **月のまとめ見出しは会期順では出さない**（`shouldGroupMonths`）。月でくくるのは締切の
    日付順の意味なので、会期順に出すと見出しと行の日が食い違う。てびきにもそう書いた。
  - 検査: ① `compareEventRows` をビルド成果物から抜き出し、昇順・降順で未確認が常に末尾、
    同じ会期は締切順 ② `shouldGroupMonths` が date では true / event では false
    ③ 見出しの数を実装の `SORTABLE_KEYS` の数と一致させる（どちらか一方だけ増える事故を
    防ぐ。第 126 回で既存の「ソート可能 4 ヘッダー」の書写が壊れる形で判明した – 数字の
    書写をやめた）④ 実データで、会期が決まっている行 364 / 未確認 114 が両方在ること、
    並び替え後の逆転が 0 件、並べる前は 707 件（空振りでないこと）。
- **意味検索が使えない理由が、画面で英語だった**（2026-09-23 実測）。論文から投稿先を
  探しているときの件数の欄は「意味検索は利用不可（語彙検索のみ・原因:
  `embeddings unavailable`）」のように、失敗の識別子をそのまま日本語の文に挟んでいた。
  識別子は #711（8 通りの失敗が 1 文言に潰れて原因追跡不能になっていた）で入れたもの
  なので捨てられないが、読み手は日本人研究者である。
  - 直し方: 識別子 → 日本語の理由の変換表を `recommender.ts` に正本として置き、画面に
    出す文はそこから引いた。「モデル側が返す自由文」など未知の値は「その他の問題」に
    寄せるが、日本語で書かれた説明を英語扱いで潰さない（日本語を含む値はそのまま通す）。
    値が欠けているときは「原因を特定できませんでした」（空欄を出さない）。識別子は
    件数の欄の `data-semantic-reason` 属性に残す – 画面には出さないが、報告を受けた側が
    開発者ツールで読める。描き換えのたびに消す（前の理由が残り続けない）。
  - 実装側の語も画面から出した。このリポジトリは可見の文字列に「埋め込み」等の
    開発用語を出さない検査を持っている（第 84 回）が、新しいラベルがそこに引っ掛かった
    （`埋め込みデータが読み込めませんでした`）。画面では「意味検索のデータ」と書く
    （利用者は埋め込みという言い方を知らない – 同じ検査がそれを守っている）。
  - 検査: ① ラベル表が全部日本語（英字を一文字も含まない）こと ② **ビルド成果物の
    `app.js` / `publish.js` から識別子を正規表現で拾い、ラベルの無い識別子が無いこと**
    （ラベル表は人が写した表なので、実装が新しい失敗を足したときにここで気づく。
    12 個が実際に拾えていることも確認済み – 空振りではない）。③ 未知の値は「その他の
    問題」、日本語の値はそのまま、欠けている値は「原因を特定できませんでした」
    ④ 画面の文に識別子を混ぜていないこと、属性では残していること。
  - 既存検査も一つ直した。`tests/recommender.test.ts` が「原因: ${semanticReason ||
    \"unknown\"}」という組み立て式そのものを要求していた（#711 の要件を保つため）。
    要求を「識別子を捨てていない（画面は日本語・識別子は属性）」に更新した。
  - てびきに「意味検索が使えないとき」の項を足した。画面に出る語
    （「意味検索は利用不可（語彙検索のみ…）」）を、てびきが説明していなかった。
    候補も一覧もそのまま使えること、時間を置いて再読み込みすると戻ることがあることを書く。
    開発者ツールの属性の扱いはてびきには書かない（利用者に読ませない）。
- **締切のデータが入っていない画面が、「条件を緩めると出ます」と言った**（2026-09-23
  実測）。データが差し込まれていない HTML を開いたとき、画面は「該当する締切はありません。
  多いのは『過去の締切も表示』をオン / 検索語を短くする…」を出す。緩めても何も増えないので、
  的外れの案内になる。同じ状態でヘッダーの「データ生成」も壊れる – 実測で、空文字なら
  「データ生成: 」と語だけ、`undefined` ではその英字がそのまま、`null` では
  **1970-01-01 がデータ生成日時として**出ていた（締切のサイトで間違った日付を見せるのが
  いちばん悪い）。
  - 直し方（二つ）。① 収録会議が 0 件のときは、条件の説明より先に
    「締切のデータが入っていません。ページの読み込みに失敗している可能性があります…」を
    出す（読み上げには短い形 「｜ 締切のデータが入っていません」）。② 「データ生成」は、
    値が欠けていれば「未確認」、読めるのに日付でない値（運営が置く「未取得」などの印字）は
    そのまま書く。危険なのは空欄と、読めるのに間違った日付を見ることだけなので、そこを止めた。
  - 抽出検査の形にも効いた。`emptyDeadlineHint` と `zeroResultLiveNote` は検査で単位
    切り出しして動かすので、新しい欄 **`catalogConferences` を必須の型として**足した
    （省略すると「データが無い」と誤読する形になるので、呼び出し側・検査の作り手の両方に
    気付かせないといけない）。既存の検査 4 件の偽の入力に「データは入っている」前提の値を
    入れる必要があった。
  - 検査: `generatedAtLabel` に四类（空欄・`undefined`・`null`・読めない印字）を通して、
    空欄・英字・1970 年を出さないこと、印字は潰さないことを見る。`emptyDeadlineHint` と
    `zeroResultLiveNote` に、収録 0 件と 12 件を通し、0 件のときは条件を緩める案内を
    出さないこと、12 件のときは従来の案内（原因の語の名指しまで）が生きていることを対で見る。
    呼び出し側が収録件数を通していることも静的に見る（上だけ見ていても実画面は変わらない）。
  - 検査側の失敗を三つ書く。① 新しい欄を挿入する機械的な追記が、配列リテラルの途中
    （`termCounts: [` の直後）に混入して構文を壊した（取り除いて個別に直した）。
    ② 同じ型宣言に同じ欄を二重に足して `Duplicate identifier` になった。③ 「日付として
    読めない値はそのまま書く」と決めた後、自分の検査のループが四类全部に「未確認」を
    要求したままだった。実装を後から緩めたのは、既存の検査が「未取得」の印字を
    認めていたことに気づいたためで、その検査も直している。
- **選んだ行が、視覚の目印でしか分からなかった**（2026-09-23 実測: ビルド成果物に
  `aria-current`・`aria-selected` は 1 箇所も無く、`selected` クラスの切り替えだけだった）。
  第 110 回でフォーカスは選んだ行へ移るようにしたが、`j` / `k` で何行目を選んでいるかを
  示す意味的な印が無かった。クラスは色と枠でしか伝わらない。
  - 直し方: 同じ切り替えの場所で `aria-current="row"` を付け外しした（表の行に付ける
    属性）。選び直した行からは消す – 付けっぱなしだと二行が「今選んでいる行」になる。
    再描画時は選択が解かれる（`render()` が `selectedIndex = -1` にする）ので、描き換えの
    たびに消える。展開用の行・月見出し行は対応表から除外されているので、そこにも付けない。
  - 長い説明を `aria-live` で毎打鍵読み上げる案は取らない（第 91 回の方針 – 長文を
    ライブ領域に入れない）。フォーカスが行に移るので本文は読める。足りないのは
    「どれが選んだ行か」の意味だけだった。
  - 検査: `updateRowSelection` をビルド成果物から抜き出して動かし、① 選んだ行だけが
    `aria-current="row"` を持つ ② 選び直すと前の行の宣言が消える（二行が同時に
    「今選んでいる行」にならない）③ 未選択（再描画直後）は宣言が残らない
    ④ 展開行・月見出し行は印を付けない – を見る。実物のビルド成果物に属性の操作が
    入っていることも対で見る（抜き出し検査の空振り防止）。
  - 既存の偽の行（フォーカス移動などの検査で使う三箇所）に `setAttribute` /
    `removeAttribute` を足す必要があった（本物の DOM も持っている API なので検査側を
    現実の形に寄せた）。検査側の失敗を二つ書く。① クラスの付き方を写す場所を
    `run(2)` の後で計算していて、「選んだ行が選んでいない行になる」見かけの失敗に
    なった（写す場所を `run(1)` の直後へ移した）。② 偽の行が `classList` とは別の
    配列の写しを持っていたので、切り替えが反映されなかった（同じ配列を見るようにした）。
- **印刷した紙に「どんな条件で絞った一覧か」が残らなかった**（2026-09-23 実測: 印刷時に
  条件を書く箇所はどこにも無かった）。印刷は「研究室に貼る・グループ会議で回覧する」用途
  （スタイルのコメントに書いた需要そのもの）で、画面の絞り込み欄・チェック欄は印刷では
  落ちる。データ生成の日時だけがヘッダーに残るので「いつの物か」は分かるが、
  「国内研究会のみ・30 日以内・検索語 研究会」みたいな条件が落ちた 478 行の紙は、
  収録全体の一覧と取り違えられる。件数欄は出るが、そこには件数しか書いていない。
  - 直し方: 表の直前に **印刷のときだけ出る見出し**を入れた（画面では `display: none` –
    支援技術からもタブ順序からも消える。同じ情報が画面の絞り込み欄に出るので二重に
    読ませない）。中身は条件の書き下ろし ／ 表示件数 ／ 印刷した日時（JST） ／
    データ生成日時（JST）。条件の語は画面のチェック欄・セレクトから取る（別の名前を
    付けない。期間の語はセレクトの選択肢そのものを読む）。何も絞っていないときは
    「絞り込みなし（収録全体の一覧）」と書く – 空欄だと、絞ったのに漏れたのか読めない。
    `beforeprint` に入れて `afterprint` で消す（画面の DOM に古い条件を残さない）。
  - 検査: 条件の書き下ろしをビルド成果物から切り出して動かし、① 何も絞っていないとき
    ② 打つ途中の空欄を検索語にしないこと ③ 各条件が画面と同じ語で並ぶこと
  - ランクの等級も画面に出る物を書く。画面の条件の語を てびき/チェック欄から探して
    照合する（書き写した語が変わったら落ちる）。CSS は幅解決の補助関数が print を
    見ないので、節を直接読んで「画面では `display: none`・印刷では `display: block`」を
    対で見る。見出しが表より前にあること、印刷の前に入れる／後で消すことも見る。
  - 同じ検査を直していて、**点検語の検査自体が黙っている穴**を見つけた（2026-09-23 実測）。
    案内とコメントに中国語系の語が 2 箇所残っていたのに、指摘されても検査は緑だった。
    原因は、点検語を文字番号（エスケープ）で書いている際に**二字目の文字番号を間違えて
    いた**こと – 意図した語と違う語を点検していて、実物は通っていた。直した上で、
    点検語ごとに文字番号から組み立てた見本の文が実際に検出されることを確かめる検査を
    足した（語列表に有っても読み方が違えば落ちない。ここが通って初めて検査が効いて
    いると言える）。
  - 検査側の失敗を二つ: ① 抜き出した関数を `const F = <declaration>` と受け取って
    `TypeError: DESCRIBE is not a function`（他の検査と同じ `new Function` の包み方に
    直した）。② 失敗メッセージに「時」の中華語の略字が混入した。**これは既存の禁止語
    リストが既に拾っていた** – 自分の機械点検がその一覧を見ていなかっただけで、
    リストに重複を足さずに直した。
- **幅を持つ行（時刻未確認）の「残り」「日時順」「月まとめ」が、同じ行の日付欄と
  食い違っていた**（2026-09-23 実測）。これらの行は `t` が「最も早く締切る瞬間」
  （UTC+14 の始まり – 上流が `earliest_utc` を持たないので計算した幅の始点）だった。
  既定画面 478 行で、日時順に並べたときに**表示している暦日が戻る隣接ペアが 27 件**
  （例: `2026-08-15(土)` の次に `2026-08-14(金)` が来る）。収録全体の時刻未確認 188 行のうち
  **13 行が前の月のグループに落ちていた**（例: 表示 `2026-09-01` の行が「2026年8月」）。
  **CSV の残り列は、既定画面の時刻未確認 175 行すべてで日付欄より 1 日少ない値**だった
  （収録全体では 188 行すべて。例: 日付欄 `2026-09-30` に対して `51` – 暦日では 52 日後）。
  - 初出の節では「画面の残りも日付欄より 1 日少ない行が 231 件」と書いたが、**実測の作り方
    が悪かったので直し込む**。画面の「残り」は時刻未確認の行では数値を出さず
    「時刻未確認」の語を出す（別の検査がその表示を固定している）ので、画面にずれは出て
    いなかった。231 という数は、時刻の確定している行についても `floor((t − now)/日)` と
    暦日差を単純に比べた値で、後者は時刻の刻みで当然にずれる。実際に利用者に見えていた
    ずれは **CSV の残り列**（上）、**並び順**、**月まとめ**の三つだった。
  - 区別が足りなかったのは「**表示している暦日で決まる物**」と「**幅で決まる物**」だった。
    前者（残り・並び・月のまとめ・CSV の残り列）は新しい基準 `tShown`
    （表示している暦日の JST 正午 = UTC 03:00）を使うようにした。時刻未確認の行は画面の
    「残り」に数値を出さないので、基準を揃えたことが効くのは並び・月まとめ・CSV の残り列
    になる（時刻の確定している行は `tShown` と `t` が同じ値で、見え方は変わらない –
    同じ行に二つの基準を持たせないために揃えた）。後者
    （すでに終わったか・「締切まで N 日」の窓・「まだ終わっていない可能性」）は
    従来の幅 `t` / `tLast` のまま – 「表示した日より前に終わっている可能性がある」という
    約束はそこが担っているので、そこを動かさない。
  - 基準の正は recommender の行に持たせ、画面・CSV・並びの比較・月まとめはそれを読む
    （書き写さない）。`tShown` が読めない行（古い呼び出し側・検査が組んだ行）は `t` に
    寄せて、末尾に落としたり `NaN` を出したりしない。
  - ついでに「残り」を防御した: 締切の瞬間が読めない値が渡ったときは `あと NaN 日` の
    代わりに横線を出す（組み立て時点で落ちるはずの値なので本来通らないが、画面に
    `NaN` を出すのがいちばん悪い）。
  - てびきの「時刻未確認」の項に、上の区別を書いた（並びと残りは表示している暦日、
    終了判定は幅）。
  - 検査: ビルド後の行で、① 日時順に表示暦日が戻る場所が 0 件（**従来の基準では 27 件
    戻ることを対で持つ** – 空振りを防ぐ）② 時刻未確認の行の残りの基準が日付欄の暦日と
    一致 ③ 月のまとめが日付欄の月に入る（従来の基準では狂っていることも対で見る）
    ④ 幅の両端は従来どおり `t < tShown <= tLast`、および終了判定の行が幅を見ていること
    ⑤ CSV の残り列が日付欄から数えた日数と一致。加えて比較関数をビルド成果物から
    抜き出し、昇順・降順の向き、`tShown` を持たない行が末尾に落ちないこと、月まとめが
    常時受付を除外したままなこと、残りが `NaN` を出さないことを見る。
  - 検査側の失敗を二つ書く。① 比較関数の検査で「従来の基準なら幅の行が先」という前提を
    逆向きに書いていて、前提の検査（空振りを防ぐためのもの）が先に落ちた。② 実データで
    画面の行を作る検査を vitest 側で書こうとして `Recommender` を持込めなかった
    （この検査ファイルはビルド後の recommender を `node -e` の中で import するのが決まり）。
    ノードスクリプトに書き直したら通った。
- **`/` で検索欄に飛んだ人が、`Esc` で「元の場所」に戻れなかった**（2026-09-23 実測）。
  打ち終わって `j` / `k` を打ちたい、というのが実際の動きだった（入力欄にいる間の
  `j` / `k` は文字入力になる）。`Esc` 自体は入力欄を出るために効いていたが、
  フォーカスが body に落ちるだけだった。行の詳細を閉じるときは開く前の要素へ戻して
  いたので、そこだけ不揃いだった。支援技術では「どこを読めばいいのか」分からない。
  - 直し方: **検索欄に限って**、`Esc` で欄を出たあと選択行があればそこへフォーカスを
    返した（`updateRowSelection()` を呼ぶ – 第 110 回で入った「選んだ行にフォーカスを
    移す」処理をそのまま使う）。他の入力欄（論文の本文・ファイル選択など）では表の行を
    奪わない。検索語は消さない（消すと打ち直しが発生して却って困る）。行が未選択のときは
    何もしない。
  - てびきも直した。`/`（検索欄へ飛ぶ）と `Esc`（欄を出る・行の詳細を閉じる）は、
    件数欄の短い一覧にしか無く、てびきの「キーボードで一覧を動かす」の項に書かれて
    いなかった。
  - 検査: ビルド後の `onKeydown` と `updateRowSelection` をそのまま使い、四つを実際に
    動かす。① 検索欄で `Esc` → 欄を出て選択行にフォーカスが戻る ② 他の入力欄で `Esc` →
    欄は出るが表の行を奪わない ③ 行が未選択ならフォーカスを移さない ④ 他の鍵は入力欄では
    素通り。てびきが二つの導線を説明していることも見る。
  - 外れた仮説を二つ記録する。調べる前に「行の詳細を閉じたときフォーカスが戻らないでは
    ないか」「`Esc` では入力欄を出られないのではないか」と立てたが、**どちらも実装済みで
    正しかった**。前者は実装があり、後者は blur していた（ただしフォーカスの行き先が
    無かったのが上記の欠陥）。仮説をそのまま直さないよう、コードを読んでから直した。
  - 検査のコメントに英語が混入した（自分で見つけて直した）。
- **OS の「視差効果を減らす」設定を、スタイルが見ていなかった**（2026-09-23 実測:
  `prefers-reduced-motion` の扱いがスタイル内に 0 箇所）。遷移は 6 箇所あり、行の詳細
  （ドロワー）は 0.25 秒の反発風の曲線で滑り込む。第 110 回で JS のスクロール
  （`scrollIntoView`）はこの設定を見たので、**JS だけ守って CSS が守らない**半止まりの
  状態だった。
  - 直し方: `@media (prefers-reduced-motion: reduce)` で要素全体の遷移・アニメーションの
    長さを 0.01ms、遅延を 0、`scroll-behavior` を auto にした。`none` にしないのは、
    遷移終了を待つコードが入ったときに処理が止まらないようにするため（実測で待ち受けは
    無いが、将来に対して安全な側を選ぶ）。
  - 開閉そのものは `.drawer-backdrop.active` の宣言（`visibility` と `.drawer` の `right`）で
    決まり、遷移の完了に依存しない。動きを消しても「開く」「閉じる」はそのまま効く
    （下の検査で宣言そのものを見る）。非可視化の 0.2 秒遅延も 0 になるので、閉じた状態が
    表示に残らない。
  - 検査: その節の有無、`*` への指定であること、0.01ms であること（`none` になっていない
    こと）。**通常時の動きを潰していないこと**（`.drawer` は 0.25 秒、`.drawer-backdrop` は
    0.2 秒のまま）を対で見る。加えて JS 側も同じ設定を見ていること。
  - 検査の限界を一つ書いておく: CSS を解決する検査の補助関数（`effectiveCss`）は
    メディアクエリの条件を「幅」としてしか見ず、`prefers-reduced-motion` の真偽は評価
    しない。なので、その節が効いていることはセレクタ・宣言・メディア文字列を直接読んで
    確認した（解決関数だけを見る検査は空振りしうる）。
- **一覧に出している曜日が、検索で引けなかった**（2026-09-23 実測）。
  日付欄は JST の暦日と曜日を `2026-09-12(土)` の形で行っている（既定画面 478 行は
  すべて曜日付き。月 55・火 76・水 69・木 59・金 69・土 99・日 51）。なのに「金曜日」は
  **0 件**、「週末」も 0 件だった。画面に出る語は検索でも引ける、という規則そのものの
  抜けだった。
  - 直し方: `weekdaySearchTerms()` を recommender に置き、行の検索用文字列に
    「土曜 土曜日」を足した。暦日の読み方は月日・日の語と同じ `calendarDateJa` を再利用し、
    **表示と同じ基準日**を使う（時刻未確認の行は公式の暦日 `local_date`、それ以外は締切の
    瞬間 – 行の詳細・一覧がそれぞれどちらの暦日を表示しているかに合わせた）。
    会期だけが確定している会（行の詳細の暦日を出す）にも同じ語を入れた。
  - **一文字（`土`）は入れていない**。「土木」「地球」といった表記を曜日で誤爆させるため
    （実測: `土木` は 0 件のまま）。一覧の一文字表記をそのまま打ちたい人には届かないが、
    誤爆のほうが害が大きいので、てびきに「『金曜』の形で受ける」と書いた。
  - 「週末」「平日」も受ける（「週末に締めたい」という探し方をする人は多い）。寄せたことは
    件数欄に「『週末』は土曜日の行と日曜日の行で探しています」と出る（語を増やしたことを
    隠さない既存の仕組み）。
  - 曜日の寄せ語は `QUERY_SYNONYMS_JA` には**混ぜない**。あの表の展開語は「列にそのまま
    出るラベル」でなければならない（分野・種別・タグの対応表にあることを別の検査が
    見ていて、曜日の語はそこに存在しない）。なので `querySynonymMap()` の中に別の表を
    持たせ、おしらせだけ同じ仕組みを使う。
  - 検査: 七つの曜日の語の当たり数の**合計が既定画面の行数と一致**すること（漏れも
    重複もないことの検査）。`週末` = 土曜 + 日曜、`平日` = 全体 − 週末、`土木` は 0 件、
    時刻未確認の行は表示している暦日の曜日で引けること、おしらせの文面、てびきの説明。
  - 検査側・実装側の失敗（4つ）。① 寄せ語を既存の表に足したら「分野の言い方は、画面に
    出る語だけを指す」検査が落ちた。**検査を緩めず**、曜日の表を分けた。② 表を
    モジュール級の定数にしたら、関数単位で切り出す既存の検査が `ReferenceError` になった
    （ハーネスの要求を増やさない方針で、関数内に移した）。③ `forEach` の戻り値で
    lint error。④ コメントにハングルが 1 語混入した（自分で見つけて直した – 検査は
    ハングル範囲を見ている）。`-t` の語に正規表現の「または」を書いて該当 0 件を 2 回
    踏んでいる。
- **会期だけが確定している会は、表に行が出ている人と完全に縁が切れていた**（2026-09-23 実測）。
  その存在は「表が 0 件」ときの案内にしか出ていなかった。だから表に 1 行でも出た人は
  「これで全部だ」と受け取る。収録 74 会（会期のみ確定）を測ると:

  | 検索語 | 表に出る | 会期だけで画面に出ない |
  |---|---|---|
  | `研究会` | 16 件 | **28 件** |
  | `ネットワーク` | 39 件 | **31 件** |
  | `人工知能` | 182 件 | 19 件 |
  | `セキュリティ` | 78 件 | 7 件 |

  - 直し方: 件数欄に「同じ条件で会期だけが確定している会 N 件（締切は未定）」を出した。
    条件（検索語・分野・国内・オンライン・締切までの窓）は表と同じ目盛りで掛ける。
    読み上げにも同じ語を流す（短い一文なので長い説明文の流し込みには当たらない）。
  - 数え上げ `scheduleOnlyMatches()` を分けて、0 件の案内（`renderNextMeetingNote`）と
    **同じ判定を使い回す**（1 回のビルド描画で同じ絞り込みを二箇所に書かない）。
    形の typedef（`ScheduleOnlyMatch`）も一つにまとめた（三箇所に同じ形を書いていた）。
  - てびきの「会期のみ・締切未定」の項に、一覧だけが全部ではないことを書いた。
  - 検査: 合成データで (a) 過去の回は数えない（表と同じ「これからの会」）、(b) 検索語で
    絞れる、(c) 国内チェックが掛かる、(d)「締切まで」の窓が掛かる、の四つを実際に動かして
    見る。加えてビルド後のコードが (e) 表に行が有るときだけ出す条件を持つこと、
    (f) 読み上げにも足していること。
  - 検査側の失敗を二つ記録する。① 検査機の日付が 2026-09 以降なので、時計を止めずに
    書いた窓の検査が実際の日付で走って空振りした（`Date.now = () => now;` で止めた –
    擬似 `class FakeDate` では `Date.now()` は置き換わらない）。② 語の切り替え忘れで
    `searchQuery` を残したまま次の呼び出しをしてしまい、国内の検査が 0 件になった
    （検査の側の誤り – 実行の実態は正しかった）。
- **手引きが名指すファイルに、画面から辿れなかった**（2026-09-23 実測: リンク 0 本）。
  てびきは「採否通知・開催案内などは `upcoming.md` に載せます」「締切の無い回は
  `upcoming.md` に会期を載せます」と書き、0 件の注記も同じファイル名を出す。ところが
  ビルドすると `public/upcoming.md` として同じサイトに出るのに、**ファイル名を書くだけ**で
  押せなかった（URL を手で打ち込むしかない – 画面を読む人には打てない）。
  - 直し方: てびきの 2 か所と 0 件の注記を、同じサイト内へのリンクにした
    （`href="upcoming.md"` – 配置先が変わっても付いていく相対指定）。
  - 注記側は文字列に埋め込んでいた文を「文章 + リンク + 文章」の組み立てに変えた
    （`innerHTML` は使わない – 会議名など収録由来の語を HTML に流さない）。外側の文章は
    そのままなので、同じ語を二度読ませることにはならない。
  - リンク先は Markdown の描画はされず文章で開かれるので、そこを `title` に書いた
    （噓の期待を作らない）。
  - 検査: てびきでファイルを名指す箇所の数と、押せる形の数が一致すること（書き写した
     語ではなく実物の文字列で数える）、ビルド後のコードが `upcoming.md` へのリンクを
     組み立てること、旧い文字列埋め込みが消えていること、指す先がビルド成果物として
     出ていること（リンク切れを防ぐ）。
  - 検査側の失敗: 印刷時にリンクの URL を併記する仕組みがある前提の検査を書いたが、
    そんな仕組みは存在しなかった（実在しない要求を検査に書いた – 撤回した。リンクの
    文字がそのままファイル名なので、印刷でも名前は残る）。
- **0 件の理由を、画面にだけ出して読み上げに出していなかった**（2026-09-23 実測）。
  前回の訂正で 0 件の理由（どの語が足りなかったか）を表の場所に出るようにしたが、その文は
  `#emptyText` に書くだけで、読み上げ専用の欄は件数だけを言っていた。支援技術では
  「0 件 / 全 3,235 件」としか読まれない ✗
  - 長い説明文をそのまま aria-live に流すのは避ける（第 88 回で 1 打鍵ごとに数十語が
    読まれる問題を実際に起こしている）。なので `zeroResultLiveNote()` で**同じ原因を短い
    形**にして読み上げに足す（画面に出す長い文とは別物として持つ）。
  - 優先順位は画面と同じ理屈: 収録データに無い語 → 表に出さない種別 → 収録では当たるが
    いまの条件で 0 件 → 条件を緩める案内。どの枝も 60 字以内（1 打鍵ごとに読まれる）。
  - 判定（`zeroFilter`）は件数欄より前に組み、表の場所に出す長い文と同じ材料を使い回す
    （同じ判定を二箇所に書かない）。**表が出て 0 件のときだけ**走らせるので、推薦の
    カード画面では数え上げず、打鍵ごとの当たりの数え上げも増えない。
  - 画面に出す件数欄には足さない（画面はすでに同じ理由を表の下に書いている – 二重に
    読ませない）。
  - 検査: 四つの枝それぞれの文面（語の名指し・種別・収録の件数・受け皿）、60 字以内、
    読み上げの欄にだけ入れること（`cnt +=` していないこと）、発火条件が
    「推薦でなく・表が 0 件」であること（検査が空振りしないように見る）。
- **語を並べた検索で 0 件のとき、原因の語を画面が言わなかった**（2026-09-23 実測）。
  収録 3,235 行で測ると:

  | 検索語 | 全体 | 語別 | 出ていた案内 |
  |---|---|---|---|
  | `ネットワーク 福岡 GPU` | 0 件 | 258 / 1 / **0** | 「検索語を短くする」だけ |
  | `人工知能 だけ` | 0 件 | 1060 / **0** |同上 |
  | `機械学習 のみ` | 0 件 | 494 / 1 | 同上 |

  語を並べる人は多い（てびきも「スペースで複数語を並べると」と書いている）のに、
  1 語が収録データに無ても、語が全部当たって組み合わせが空でも、案内は同じ一文でした。
  チェックボックスの実物（「国内研究会・国内シンポジウムのみ」）をそのまま貼ると
  「のみ」の語で 0 件になるのも、同じ構造だった。
  - 直し方: `queryTermCounts()` を recommender に置いた（正本）。語の組ごとに、展開後の
    語で収録データの当たり数を数える（`queryTokenGroups` の組は中が OR なので、
    組の単位で数えないと「九州」のように漢字が会場地名に無い語を「無い」と誤らせる）。
    0 件案内は (a) 収録データに無い語を名指す（その語を待っても行は増えない）、
    (b) 語が全部当たっているなら語ごとの件数を示して「いずれかを外す」と導く。
    原因が特定できたときは既存の方針どおり「検索語を短くする」を出さない。
  - 0 件のときだけ走らせる（打鍵ごとのコストにしない）。手引きの「検索」にも書いた。
  - 検査: 実データで `GPU` が 0 件・他の語が 1 件以上であること（前提が変わったら
    分かる）、`九州` は展開後の語で数えて 0 件にならないこと、文面の分岐（収録に無い語の
    名指し／全語が当たる場合の件数表示）、1 語だけの検索では出さないこと。
  - 検査側の失敗: 抽出した `emptyDeadlineHint` の引数に `termCounts` が必須になったので、
    既存の検査の `clear` にも同じ欄を足した（型を optional に逃げず、実装と同じ必須に
    してある – 無いと実装が落とす欄を検査だけ通るのは嘘になる）。
- **前回の訂正で書いた手引きの数が、実測と合っていなかった**（2026-09-23 実測）。
  「延長後」の項に「収録で 30 行（このうち将来の締切 15 行）」と書いたが、
  - 30 という数は、上流のラベルを英字 `extend` だけで洗った数（日本語の締切名に「延長」と
    書く 3 件が抜けていた – 判定関数は 33 件を返す）。
  - 15 という数は、種別を見ていない数の数え上げだった。一覧は投稿締切（概要・論文）だけと
    種別を絞っているので、既定の一覧（478 行）に出る延長の目印は **9 行**（収録全体では 33 件、
    採否通知・登録締切など表に出さない種別を含む）。
  - 直し方: 手引きを実測に合わせ、**数の基準を語で書いた**（「既定の一覧（478 行）に出る
    延長の目印は 9 行、収録全体では 33 件」）。同じ二つの数を
    「案内文に書いた実測値が、ビルド成果物に対して今も合っている」検査の項目に足したので、
    収録や実装が動いてズレたら検査が落ちる（この検査は 2026-09-23 に 7 か所のズレを
    実際に見つけている）。
- **自分の書いたコメント・検査のタイトル・設計仕様に中華語の字が 4 か所残っていた**
  （「迷う」と書く所に別の字）。検査のタイトルに入っていたのが一番たちが悪い（画面の
  日本語ではなくても、リポジトリの日本語として誤り）。該当の字を禁止語に追加した。
  - 検査側の失敗: 生成する配列リテラルで要素のカンマを落として構文エラー、`-t` の語を
    実際のタイトルと違って該当 0 件（同じ失敗をこのラウンドでも 2 回している –
    語はタイトルから写す）。
- **締切が延びていたことが、画面にも検索にも出ていなかった**（2026-09-23 実測）。
  上流の締切名に "Extended"（延長）と付く行が収録 3,235 行のうち 33 行（将来締切 15 行）あり、
  ラベルの例は `Paper Submission (extended)` です。その事実は画面のどこにも出ておらず、
  一覧では他の行と区別がありません。検索も英語でしか引けず、「extended」31 件に対し
  「延長」は 3 件（偶然日本語の締切名を持っていた行だけ）でした。締切が延びたかどうかは
  動作計画に直結するので、表示・検索・表計算のどれでも同じ語にします。
  - 判定と語の正本を `site/recommender.ts` に置いた（`isExtendedDeadline` と
    `EXTENDED_LABEL_JA` = 「延長後」）。一覧のチップ（「推定」などと同じ場所）、CSV の
    取得状態（`statusBadgeWords` 経由）、検索語（`hay` は同じ関数を使う）が一本になります。
  - 表示する日付は**延長後の締切そのもの**です（元の日付は上流も保持していない）。てびきの
    「延長後」の項にそう書き、元日付の復元や「何日から延びたか」は出さない（締切の推測を
    しない）。
  - 上流の英語ラベル自体をそのまま出す欄（行の詳細・種別の内訳）は意図して原表記を
    残している別物なので、チップの語だけを日本語にそろえた。
  - 検査: `makeRow` のハーネス（実 `recommender.js` を import している）で、延長行だけに
    チップが出ることを語そのもの（テスト側では書かない）で確かめる。他の行に混ざらないこと、
    てびきが同じ語を説明していること、実データで「延長」が33行を引いて延長していない行が
    1 行も混ざらないこと、CSV の取得状態に同じ語が出ることを見る。
  - 検査側の失敗: 「上流の英語ラベルを画面に出さない」という検査を書いて落ちたが、
    それは意図して原表記を出す欄があるので**検査のほうが誤り**だった（チップの語が
    日本語であることを見る検査に差し替えた）。自分のコメントに中華語の語が 1 件混入
    （第 108 回で一字目を増やしたが二字目の語が抜けていた – 同じ語を検査に追加した）。
    テストの生成スクリプトの文字列・エスケープで 4 回落ちている。
- **キーボードで選んだ行が、支援技術に読まれていなかった**（2026-09-23 実測）。
  `j` / `k`（`↓` / `↑`）は行のクラス目印（`.selected`）を作り直して `scrollIntoView` するだけで、
  フォーカスは動かさない。行は `tabIndex = -1` でフォーカスを受けられるのに使っていなかった。
  てびきは「キーボードで一覧を動かす」と案内しているので、**案内している操作が支援技術には
  無音**というズレになる（視覚利用者はハイライトだけで分かるが、選んだ行の内容は読まれない）。
  - 直し方: 選んだ行へ `focus({ preventScroll: true })` してから `scrollIntoView` する
    （`preventScroll` を付けないと、なめらかスクロールとフォーカスの二重移動になる）。
    フォーカスの枠は既存の `[tabindex]:focus-visible` がそのまま効く（ CSS を増やさない）。
    `updateRowSelection` を呼ぶのは `j` / `k` の分岐だけなので、検索欄に入力中にフォーカスが
    飛ぶことはない（てびきどおり、入力欄の中ではこれらのキーは文字として扱う）。
  - 併発: `behavior: "smooth"` は「動きを抑える」設定を自動では見ない。1 打鍵ごとに
    なめらかスクロールを続ける形だったので、設定があれば瞬間移動に変えた。
  - 検査: 展開行と月見出し行を交えた行一覧で、選んだ行**だけ**にフォーカスが当たること
    （除外を数え誤ると 1 行ズレる）、`preventScroll` を付けること、設定の有無で
    `smooth` / `auto` が分かれること、てびきに読み上げの説明を書くこと。
  - 検査側の失敗: 合成した行の引数名を誤った、生成スクリプトの文字列を閉じ損ねた、
    差し替え時に `mkWindow` を消して undefined と呼んだ、JSON を受けた配列の暗黙の any が
    5 件（第 107 回と同じ失敗で、型を寄せて `toBeDefined()` の守りも足した）。
- **一覧の 2 行目に出す公式表記の語が、検索で引けなかった**（2026-09-23 実測）。
  固定時刻 2026-08-09 の収録 3,235 行（将来 917 行）で測ると:

  | 画面に出る語 | その語を出す行 | てびきのとおりに打つと |
  |---|---|---|
  | 時刻未確認 | 188 行（将来 181） | **0 件** |
  | AoE（「公式 AoE …」） | 1,908 行（将来 524） | **2 件**（上流の締切名に偶々入っていた物だけ） |
  | JST（「公式 JST 締切」） | 29 行 | **0 件** |

  AoE 締切を探すと AoE 締切が 1 件も出ず、時刻の未確認な締切を探すと 0 件になる。
 「表示されている語で検索できる」状態（§2）が、行の本体（会議名・分野・開催地・月・日・
 ラウンド・ランク・推定）だけを対象にしていたため、2 行目の語が抜け落ちていた。
  - 直し方: `zoneSearchWords()` を新設して行の検索要素に足した。日付だけの行は
    「時刻未確認」、AoE 宣言の行は「AoE」、JST 宣言の行は「JST」、それ以外の宣言は表が
    「公式 CEST ／ … UTC」の形で出すので両方の語を入れる。**AoE は AoE 宣言の行だけ**に
    入れる（表示で AoE を出さない行に入れても、実在しない AoE 締切を探したことになり、
    表示の向きとズレる）。「時刻未確認」の語は CSV と同じ定数を使った。
  - 全行に出る「公式」の二字は入れていない。入れても何も絞れず、絞れたと誤信させる
    （「確認できたものだけ」はチェックボックスの側で絞る）。検査にも 0 件であることを
    書いて、この決定を遺す。
  - 検査: 一覧の badge の語はビルド成果物から取る（表示の語をテスト側に書き写さない）。
    日付だけの行がその語で全部引けること、AoE 宣言の行が全部引けて JST 宣言の行が
    混ざらないこと、JST 宣言の行が「JST」で引けること。収録が変わって対象 0 行に
    なったら空振りするので、そのことも検査する。
  - 検査側の失敗: `CandidateRow` に `key` は無く失敗メッセージが型で落ちた（`hay` の
    先頭で代用）。自分の説明コメントに英語の語が 1 語混入した（第 97 回以降の繰り返し）。
- **コメントに中華語の語が混じっていた**（2026-09-23 実測）。第 97 回から検査で語を抑えて
  いたが、抑えていたのは第 97 回に実際に混入した画面側の語中心で、**コードのコメントに混じる語**が
  抜けていた。`site/app.ts` の `writeUrl` の説明に「既定の並びなら（日本語でいう引数にあたる語）を足さない」
  （日本語なら「引数」）が残っていて、SPEC と検査のコメントにも同じ語が有った（計 3 か所）。
  - 日本語の「引数」に直した（この記録にも語そのものを書かない）。検査には、①簡体字専用の一字目 36 字（日本語の新字体・
    共用漢字と字形が別な物だけ。日本語の「状態」の状や「文章」は正常な日本語なので
    入れていない – 誤検出を出すとその検査ごと信用できなくなる）②同じ字を使うが日本語として
    成り立たない二字以上の語（上の語など）を追加した。
  - 照合対象は README / SPEC / テンプレート / ランタイム / 主要テストの 7 ファイルで、
    バッククォート内の引用は抜く（過去の混入を記録した文はそのまま置ける）。
- **URL に書く条件と読む条件の対称性を検査で固定した**。`writeUrl` は 12 種類の条件を
  URL に書く。読み側 `readUrl` が 1 つでも忘れていると、共有した相手の画面でその条件だけ
  黙って外れる（今回の照合では対称で、欠けは無かった。将来の片側だけの追加を止める）。
  両関数からキー名を洗って照合するので、キーをテスト側に書き写さない。
  - 検査側の失敗（2件、どちらも自分）: 生成した配列にカンマだけの行が混ざり、空素変
    （`undefined`）が入って「undefined が混入」という意味不明な失敗になった。
    エスケープを二重バックスラッシュで書いたため、語が文字でなく 6 文字の列になり、
    **検査ファイル自身が自分の検索語を持っていた**（第 97 回の自己言及と同じ形）。
  - 追記の失敗として、**この訂正を説明する文の中に捕まる語を書いて 3 回落ちた**
    （「引数に直した」と書く文・「などの語を追加した」と書く文・引用の形）。検査の語を
    説明文に書かない、をこの節の約束として遺す。
- **並び替えの状態が、支援技術に何も読まれていなかった**（2026-09-23 実測）。
  並び順は見出しの語尾の矢印（↑ / ↓ / ↕）にしか出ていない。キーボードでヘッダーを押して
  並びが変わっても、件数は変わらないので読み上げ専用欄（`#countLive`）も同じ文のまま = 無音。
  「過ぎた締切 N 件は下にまとめました」を件数欄に書く（黙って並びを変えない）方針と揃わない。
  - `sortNoteJa()` を新設し、読み上げ欄にだけ ` ｜ 並び順: 残り 昇順` を足した。画面の件数欄は
    混むので変えない（読み上げ欄を分けた第 89 回の仕組みを使う）。列の語は**見出し自身の
    文字**から取り、語尾の矢印を落として使う（てびき・ソートバー・テストに書き写さない）。
    表が出ていないとき（推薦のカード）は見出しが消えているので出さない。
  - てびきの「並び順」の項に、支援技術にはこの形で読まれることを書いた（画面の説明と
    読み上げの語が三者でズレないようにする。検査もそれを要求する）。

- **検査のタイトルが、検査の実態を越えていた**（2026-09-23 確認）。
  `sortable headers are keyboard-operable and expose sort state (aria-sort)` という検査が
  有ったが、中身は `tabindex` / `aria-sort` / 語尾の矢印の有無を見るだけで、**キーを一度も
  押していなかった**。実装は `th` に keydown を張っていて Enter・Space が効くので
  画面の不具合ではなかった（最初に「押せないはず」と推測して直しにかからず、実装を読んで
  撤回した）。検査が画面の挙動を語った形に残ると、次に張りが外れても緑のままなので、
  実際の handler をビルド成果物から抜き出して `Enter` / `Space` / `j` を打つ検査を新設した。
  - 検査: Enter と Space の両方が押した列の `toggleSort` を呼ぶこと（Space 抜けは多い）、
    `j`（選択行を動かすキー）を止めていないこと、Enter は `preventDefault` +
    `stopPropagation` してから処理すること（グローバルの「Enter = 選択行の公式ページを
    開く」に奪われると二重に動く）。古い検査はタイトルを実態（目印の有無）に合わせ、
    キー操作は別の検査に見に行くと書いた。
  - 検査側の失敗: 生成スクリプトの行をダブル引用符で書き、中の二重引用符のエスケープで
    文字列が閉じて構文エラー（内側が素の `"` で済むテンプレートリテラルにした）、
    JSON を受けた配列の暗黙の any と `find()` の undefined（型を寄せて守りの検査を足す）、
    `-t` の語を実際のタイトルと違った（該当 0 件で「通った」に見える。前に同じ失敗をして
    いるので、語はタイトルから写す）。
- **本文へ跳ぶ導線も、表の名前も無かった**（2026-09-23 実測）。
  - 画面の先頭から `<table>` まで、検索欄・5つのプリセット・分野チップ…を **Tab で全部
    辿らないと届かなかった**。キーボードと支援技術には本文への入口が要る（WCAG 2.4.1 の
    定石）が、`<body>` 直後の跳ぶ導線が無かった。
  - `<table>` に名前が無く（`<caption>` も `aria-label` も `aria-labelledby` も無し）、
    支援技術には「表が始まる」ことしか伝わらなかった。結果のまとまり（表・推薦のカード・
    0件の案内・さらに表示）を示すランドマークも無い。
  - 直し方: `<body>` 直後に「締切の一覧へ進む」を置き、飛び先は結果のまとまりを括った
    `<main id="results" tabindex="-1">` にした（`tabindex="-1"` が無いと飛んでも読み上げが
    追従しない）。表には `<caption class="only-sr">締切の一覧（日時は JST で出しています）` を
    置いた。**隠し方は `display: none` にしない**（読み上げ自体が消える）。画面外へ置く
    基準＋`:focus` で左上に出す、の二つで書く。印刷時は `display: none` で消す。
  - 検査: 本文の最初の操作可能要素が `<a>` であること、跳ぶ導線の `href` の飛び先が実在し
    `tabindex="-1"` を持つこと、`main` が重複しないこと、`<caption>` に表の名前が有ること、
    `.only-sr` と `.skip-link` の基準の style が `display: none` を使っていないこと、
    `:focus` で画面内に戻ること（`left: -9999px` のままでないこと）。
  - 検査側の失敗: CSS 挿入のアンカーが2か所に当たって assert で止まった（ファイルは
    書かれていないので無傷）。`<body>` 直後の要素を見る検査は `class="skip-link"` までで
    切ると `<a>` 自身を拾って空振りする（最初の `<a|button|input|select>` タグで判定する）。
  - 同じ見回りで、**自分のコメントに中国語の簡体字が2件混じっていた**のを直した
    （`劳苦` →「手間」、`发生过` →「起きた」）。第 97 回の検査は語で持っていたが
    簡体字専用の一字目（日本語の新字体とは別コードの物）が無かったので追加した。
    もちろんこの説明文自体にも書かない（第 97 回は自分の書き方が検査に捕まった）。
- **推薦のカードの締切だけが UTC 主表記で、しかも同じ値を二行出していた**（2026-09-23 実測）。
  表の日時列は第 65 回から `fmtJst`（JST + 曜日）を主表記にし、公式の表記を副にしている
  （AoE 23:59 締切は JST では翌日の夜になるので、UTC 優先だと日本で何時までに出せば
  よいか分からない、という趣旨のコメントが `makeRow` に有る）。ところが推薦のカードの
  受付状況は `fmtDate(ts) + " UTC / " + fmtAoE(ts)` で、UTC が主だった。同じ締切に対して
  表は「2026-10-06(火) 08:59 JST」、カードは「次回締切: 2026-10-05 23:59 UTC /
  2026-10-05 15:59 AoE」が並ぶ。加えてカードは同じ `recommendationAvailability(r)` を
  「締切:」の行でもう一度出しており、**「締切: 次回締切: …」という二重のラベル**になっていた。
  - `recommendationAvailability` を表と同じ向きに直した（主 = `fmtJst`、公式表記を副、
    AoE 併記は AoE 宣言の会議だけ。JST 宣言の締切に AoE を見せると実在しない AoE 締切が
    あると誤解させる、という表と同じ理由）。暦日だけが分かっている締切も曜日を添える。
  - カードの「締切と種別」の行は **種別だけ**にした（締切の日時はカードの頭のチップが
    唯一の表示。同じ値を二か所に出すこと自体が余計で、第 104 回と同じ形）。
  - 検査: 表で使う関数をビルド成果物からそのまま抜き出して流す（`fmtJst` / `fmtDate` /
    `fmtAoE` / `pad` / 曜日の配列の宣言まで正本から。自作すると書式がズレる）。
    ①JST（曜日付き）が先頭で、表と同じ文字列を含むこと ②AoE 併記は AoE 宣言だけ、
    JST 宣言には出ないこと ③暦日だけの締切も曜日を添えること ④カード内で
    `recommendationAvailability(r)` は 1 回だけで「締切: 次回締切」の形が無いこと。
  - 検査側の失敗（4件、すべて検査が生産側の誤りも拾った）: ①`pad` を自作して `pad` が無く落ちた（正本を抽出する）②`fmtJst` の自由変数 `WEEKDAY_JA` を
    渡さなかった ③`Recommender.weekdayJaFromDate` は**暦日の文字列**を受けるのに
    生産側で `new Date(...)` を渡していた（表は `localDate: string` を渡していた。
    検査が「暦日だけの締切に曜日が無い」として捕まえた）④生成スクリプトの変数名を
    書き間違えた（`FMTJST` と `FMTJST_SRC`）·
    検査の守りの行を宣言より前に置いた。
- **推薦のカードで、同じ評価値に二つの名前を付けていた**（2026-09-23 実測）。
  カードの頭のチップは「**一致評価** X」、その下の行は「**研究適合度**: X（順位評価）」。
  どちらも `r._fitLabel` の同じ値だった。第 95 回・第 101 回と同じ「同じ物に二つの名前」。
  加えて、てびきは「判断材料を4行並べます」と書いていたが、実際は 5 行あり、
  そのうちの 1 行（「締切と種別」）はてびきに載っていなかった。
  - 同じ値が二か所に出ること自体が余計なので、行の側を削った（値はカードの頭のチップに一度だけ出る）。
    「順位評価であって確率ではない」という型は、チップの語とてびきの既存説明
    （「数値は並べ替えるための目安であり、採択される可能性の予測ではありません」）で保つ。
    第 84 回相当の検査 `labels research fit as an ordinal assessment rather than a
    probability` は、語を「一致評価」に寄せて意図（確率で出さない・二つ目の名前を作らない）を
    そのまま引き継いだ。
  - 案内は実際の 4 行（会議の続いている年数／締切と種別／締切の確認状況／取得状態）を
    全て名乗り、一致評価が行として数えないことを書く形に直した。
  - 検査: **カードの行のラベルをビルド成果物から洗って**（語も件数もテスト側に書き写さない）
    ①てびきが数えている行数と実装の行数が合うこと ②実装の各行の語がてびきに有ること
    ③「研究適合度」がテンプレートにもランタイムにも無いこと。第 100 回のキー操作と
    同じ型の、案内と実装の相互検査である。
  - 検査側の失敗: ①ラベル抽出の正規表現が行頭のコロンまで拾って「締切の確認状況: 日付」に
    なった（最初のコロンで切る）②変数の宣言より前のアサーションで参照した
    ③ビルド成果物 `public/index.html` を読んだ（CI はテスト後にビルドするので読まない）。
    ④案内の語を直した直後に、同じ文の中で「論文との合い方（この論文との合い方を…）」と
    言い直していた（書き直し）。
- **狭い画面で、キー操作の案内が説明だけ残っていた**（2026-09-23 実測）。
  方針は「狭い画面（ほぼスマホ）ではショートカットが使えないので、誤導する案内も消す」で、
  第 85 回に一度そこを直した記録がある。しかし消していたのは `.only-keyboard` を付けた
  **見出しだけ**で、直後の `<dd>`（`j` / `k` / `d` / `Esc` の書き方そのもの）はそのまま出ていた。
  用語集は見出しと説明が対なので、クラスを見出しに付けた時点で説明が取り残される形だった。
  - CSS を `.only-keyboard, .only-keyboard + dd { display: none }` にした（用語集の対を
    まとめて閉じる）。`<code>` 入りの説明が電話に出るのを止める。
  - 第 100 回で自分が書いた「行の詳細」の説明も、キーの部分だけ
    `<span class="only-keyboard">` に括り直した（押す／✕ で閉じる、は常に残す）。
    画面に書く語は実物の字で書く（ボタンに写るのは「✕」で、「閉じる」は支援技術向けの
    名前なので「右上にある ✕（閉じる）」と書いた）。
  - 検査: ①640px 以下のメディアクエリに `.only-keyboard + dd` を含んだ
    `display: none` があること（第 86 回の並び替え検査に入っている文字列ピンは、
    古い単一セレクタの形を戻さないよう正規化して要求する）②キーの項は説明が直後に
    有ること ③「行の詳細」では、キー操作が `only-keyboard` の括弧の中にあり、
    括弧の外に「押す」「✕」が残ること。
  - 検査側の失敗: 自分自身の見直しで、画面に出ていない語（「閉じる」ボタン）を案内に
    書いていた（その場で ✕ を書く形に直した）。既存の並び替え検査が古い CSS の
    文字列ピンを持っていたので、要求を新しい形に更新した。
- **PDF 読み込みの失敗が、内部の英語文字列そのままだった**（2026-09-23 実測）。
  失敗時の表示が `PDF 読込に失敗しました: ${error.message}` で、中身は実装語のまま。
  実際に出る文言は `pdfjs unavailable`（CDN が呼べない状況。学内のプロキシで起きやすい
  一番よくある失敗）、`file is too large`、`PDF has too many pages`、
  `PDF extraction timed out`、pdf.js 由来の `Invalid PDF structure.` など。
  日本語の利用者は何が起きたか直せない。
  - `pdfFailureMessageJa()` を新設（独立関数で、既存の抽出検査の自由変数には触れない）。
    原因の心当たり + **打ち手**（タイトルと概要を下の欄に貼る / TXT に書き出す /
    キャンセルした旨）を出す。上限値（20 MB・100 ページ）はメッセージに定数を埋め込んで
    書き写しを防ぐ（検査も同じ定数から検証する）。分からない失敗にも日本語で出す。
  - 未発表の論文を預ける操作なので、**選んだファイルは送信しない**ことを入力欄のそばに
    書いた（読み取りは端末の中。PDF を読む部品だけ初回は外部から取りにいく、と正直に書く。
    部品が呼べない失敗が上の `pdfjs unavailable` なので、その説明と繋がっている）。
  - 検査: `pdfFailureMessageJa` をビルド成果物から抜いて 6 種類の失敗を流し、
    ①日本語であること ②内部の英語文字列を写していないこと ③打ち手を含むこと
    ④上限値が実装の定数から出ること（20 MB / 100 ページ）⑤キャンセルの文言 ⑥画面に
    「送信しません」が書かれていること。
  - 検査側の失敗: 生成スクリプトの行を TS の文字列連結で組んだら biome が整形して
    配列の要素が割れた（連結せず、値は生成側の変数に置く）。打ち手の判定語が狭くて
    「TXT にして貼るか」「書き出して貼ってください」を打ち手なしと誤検出した（語を緩める）。
- **画面の切り替えボタンと案内で、同じ画面の呼び方が割れていた**（2026-09-23 実測）。
  ボタンは「投稿先を探す」／「締切を検索」。ところがてびきに「**論文から探す**」が 3 か所
  （見出しの「一致評価の出し方（論文から探す）」・CSV の項・キーボードの項）あり、README に
  も 4 か所あった。案内を読んだ人がどのボタンか特定できない。第 94 回の収録状況、
  第 95 回の早め絞り込みと同じ型なので、**ボタンの語を正本**にして案内・README を寄せ、
  検査で「ボタンに無い画面名を案内に書かない」ことを見る（語はテスト側に書き写さず、
  `id="modeRecommend"` から取る）。
  - 「締切を検索」側は既定の画面で、案内は表その物を指す語（「一覧」「締切一覧」）を
    使っているので画面名の一致は要求しない（誤りではない）。CSS と過去分の §7 記述は
    そのままで、今日の画面説明に使う語だけ揃えた。
- **キー操作の案内と実装がズレる余地を、検査で塞いだ**（2026-09-23）。
  直接の引き金は第 98 回の自分の記述誤り。私は SPEC に「j/k + Enter がドロワーを開く」と
  書いたが、実装もてびきも **`Enter` は公式ページ、`d` は行の詳細**だった（両方を 2026-09-23 に実測して訂正した（第 98 回の項に訂正を遺す）。てびきのキーの項は実在したが、
  「そのキーで何が起きるか」までの検査は無かった（押すキーの名前を挙げているかどうかすらない）。
  - 検査を新設: ①ビルド成果物の `onKeydown` から `e.key === "..."` を洗って**実際に扱うキー**
    を作り（テスト側にキー名を書き写さない）、てびきのキーの項が全て挙げていること。
    ②`d` を押すと行の詳細が開き公式ページは開かない、`Enter` は逆に公式ページを開き
    行の詳細を開かない、をビルド成果物の `onKeydown` で動かして確認する。
    ③てびきの記述が同じ対応になっていること（`<code>Enter</code>` … 公式ページ /
    `<code>d</code>` … 行の詳細）。案内側と実装側の**両方**を見るので、どちらかだけ変わっても落ちる。
  - 画面に出る語の調査で、**行の詳細に項が無かった**ことも補った（`dt` を追加）。開き方
    （行を押す / `j`・`k` + `d`）と閉じ方（`Esc`・「閉じる」）、中身（公式ページへのリンク、
    開催地と会期を JST と曜日、分野、評価、締切の確認状況と次回確認の予定、日付のみの
    締切のただし書き、同じ研究会のこれからの回）を書く。一覧に出ない情報はこの欄にしか
    無く、しかも「押すと出る」ことがどこにも書かれていなかった。
  - 検査側の失敗: `Enter` 後の `window.open` 回数を累計で数え間違えた（期待 2 / 実際 1）。
    偽 `onKeydown` の依存に `safeExternalUrl` と `$("tbody").querySelectorAll` が要ることも
    既存検査が `d` しか押していなかったため現れなかった（押すキーを増やすと依存も増える）。
- **閉じた行の詳細（ドロワー）が、支援技術とタブ順序に残っていた**（2026-09-23 実測）。
  隠し方が `.drawer-backdrop { opacity: 0; pointer-events: none }` と `.drawer { right: -480px }`
  だけだった。
  - `pointer-events: none` はマウス用の指定で、**Tab は素通りしない**。閉じている状態でも
    「閉じる」ボタンがタブ順序に残り、画面のどこにも見えない箇所にフォーカスが飛ぶ。
  - 中身は `role="dialog" aria-modal="true"` なので、閉じたままアクセシビリティツリーに
    乗ると「ページ全体が背景」と扱う支援技術がある（閉じた状態のダイアログをツリーに
    残す典型的な誤り）。前回チップに `aria-expanded` を足した作業中に見つけた。
  - 直し方: 閉じた側へ `visibility: hidden` を足し、`.active` で `visibility: visible` に
    戻す。`visibility` はタブ順序からも外れる。フェードアウトを潰さないため、
    閉じる規則は `visibility 0s linear 0.2s`（遷移の後に隠す）、開く規則は `visibility 0s`
    （即時）にする。JS は従来どおり `.active` の付け外しだけで閉じられる。
  - 検査: 閉／開の両規則に `visibility` が入っていること、遅延の向きが合っていること
    （閉じる側だけ 0.2s おくれ）、ドロワーの後ろに閉じた状態で残る操作が無いこと、
    `role="dialog"` / `aria-modal="true"` を保っていること、`closeDrawer` が `.active` を
    外すだけで閉じる形のままなこと（CSS の可視性が効く前提）。
  - 実測で確認したのは CSS の状態まで。**Tab 順から消えることと支援技術の扱い自体は
    `visibility: hidden` の仕様に基づくもの**で、実際の支援技術での動作確認はしていない
    （この節の他の項目と同じく、できる範囲を書いて区別する）。
  - 検査側の失敗: 追記する説明文を TS の文字列リテラル途中で改行して構文エラー、
    ドロワーが本文の後ろ（`</footer>` の後）に有ることを忘れ、`</footer>` までで切って
    空振り（検査が「閉じる手段が無い」で落ちた。空振りを検出できてよかった）。
- **一致評価の行内展開が、マウスでしか開けなかった**（2026-09-23 実測）。
  「一致評価 … ▾」のチップは `<span>` + `onclick` で `tabIndex` も持たない。表のキーボードは
  `j`/`k` が選択行の移動、`Enter` が**公式ページ**を開く、`d` が**行の詳細**（ドロワー）で
  （実装とてびきの両方で 2026-09-23 に確認した。私は当初ここを「j/k + Enter がドロワーを
  開く」と誤記したので、訂正をここに遺す）。どちらも行の内部ではないので、行の中の
  理由の内訳（一致評価の展開）に鍵盤で到達できない。
  ビルド成果物に `aria-expanded` は **1 箇所も無く**、支援技術には「押せる物」「今開いて
  いる物」として伝わっていなかった。
  - トリガを `<button type="button">` にした（Enter・Space が click になり、行のクリック
    委譲の `match-trigger` 判別をそのまま通す。`type` を書かないとブラウザは提出ボタンに
    することもある）。`toggleDetail` で開いたとき `aria-expanded="true"`、閉じるとき
    `"false"` をトリガに書く。
  - 見た目を揃えるため `button.tag { appearance: none; line-height: 1.4; text-align: left }` を
    足した（`font` 短縮形は書かない。`.tag` 側が字体・サイズを出し、特定度の高い短縮形が
    それを消すため）。`focus-visible` の輪郭はサイト共通の物が効く。
  - てびきの「一致評価の出し方」に**開き方**を書いていなかった（「行を展開すると」としか
    書かず、何を押すのか・鍵盤で開けるのかが分からない）。チップの語と Tab / Enter / Space を
    明記した。その項に `</dd>` の余分な閉じタグがあって、追記した文章が最初の `</dd>` の
    後ろにぶら下がっていたので、二つの説明（一覧のチップ / 推薦カード）に分けて整形した。
    てびきの `dt` に対する `dd` の数も検査で見る（余分な閉じタグが混入しないようにする）。
  - 検査: ①行を作る偽 DOM ハーネスで、チップが `BUTTON`（`type="button"`・
    `aria-expanded="false"`・語に `match-trigger` を含む）であることを見る。
    ②ビルド成果物の `toggleDetail` を偽の行で動かし、閉→開→閉で `aria-expanded` が
    false→true→false と動き、行内展開が実際に挿さり閉じることを見る。
    ③てびきが開き方を書き、CSS のリセットが入っていることを見る。
  - 検査側の失敗を 3 件（すべてハーネス側）: ①配列要素の文字列の末尾 `",` を落として構文エラー
    ②**文字列リテラルの中へ TS の行コメントを書き込んだ**（1 要素 1 行の約束を破って構文エラー。
    内側のスクリプトのコメントは文字列の中に書く）③偽 DOM は `tagName` を渡したまま入れるので
    `"BUTTON"` 期待は不一致（実 DOM は大文字。比較側で正規化した）。
  - 混入語の点検: CSS のコメントに中国語の指示語を 1 語混入させた（その場で直し、点検語に追加）。
- **データ源の行が、内部の実装語と誤解を招くライセンス表記になっていた**（2026-09-23 実測）。
  表示は `ccfddl (ccfddl/ccf-deadlines, MIT) / aideadlines (huggingface/ai-deadlines, MIT) /
  local (data/extra.yaml, MIT)`。
  - `local` はこのサイト自身の入力のことで、内部ファイル名 `data/extra.yaml` を画面に出して
    いた（§7「内部キー・実装語を画面に出さない」に反する）。
  - 同じ欄に自前の入力へ「MIT」が並び、上流配布物のライセンス表記と見分けがつかない。
  - 名前がリンクでなく、出典の一次資料に飛べない（この画面から検証できない）。
  - てびき 26 項目の中に「データ源」の説明が無く、この語だけ引けなかった。
  - 直し方: `dataSourceLabels()` を新設。上流は `ccfddl（ccfddl/ccf-deadlines、MIT）` の形で
    **リンク**にし、自分の入力は「このサイトで収録した分（上流に無いもの）」と出します
    （ライセンスは書かない。上流配布物のライセンスとは別の話なので）。`safeExternalUrl` が
    通した URL だけ `<a>` にするので、`javascript:` などはリンクにしません。
    ※ 関数名は `verificationSummary` 内の地域変数 `sourceLabels` と衝突するので別にしました。
  - てびきに「データ源」を追加（リンクの意味、自分の入力の意味とライセンスを書かない理由、
    評価の出典でもあること、鮮度は「データ更新」を見よ）。
  - 検査: ビルド成果物から `dataSourceLabels` を抜いて動かし、①上流は名前・配布物・
    ライセンスが残ること ②自分の入力に内部ファイル名とライセンスが出ないこと
    ③https 以外はリンクにならないこと ④てびきが画面の語そのままを挙げていることを抑える。
    実ビルドの成果物で `data/extra.yaml` はコードの注釈にしか出ないことを確認した。
  - 検査側の失敗: ハーネスの括弧を一括多く書いて `SyntaxError`（`]))` → `]);`）。
- **自分の案内文に韓国語・中国語の語を混入させていた**（第 97 回で発見）。
  点検検査（「日本語の案内に中国語の略語を混ぜない」）の語列表が 4 語だけで、実際に
  自分が書いた混入語を拾えていなかった。
  - 語列表に、これまで実際に混入させた語（中国語の簡体字表記・過去/問題/表示/変量/関数/已経
    に当たる語）を足し、加えて**ハングルを文字範囲で禁止**した（日本語の案内に韓国語が
    出る用事が無い。会議名は日本語か現地表記で、データ側は点検対象外）。
  - 副産物: SPEC の古い記述 1 行に韓国語の動詞の活用形が混入していた（日本語で書くべき箇所に
    ハングルが 1 語）。長年検査を潜っていた（語列表に入っていませんでした）。語をここに
    引用すると点検が自分自身で落ちるので、書き写さない。
  - 検査側の失敗: 点検語をコメントで引用すると**検査が自分自身で落ちる**。語列表は
    同じファイルも点検するので、該当語は引用せず説明だけ書く（2 回踏んだ）。
- **ヘッダの「データ生成」が UTC の `...Z` をそのまま出していた**（2026-09-23 実測）。
  `データ生成: 2026-08-09T00:00:00Z` のような文字列で、一覧が JST + 曜日を単位にしているのに
  この欄だけ別単位だった。夜ビルド（UTC 8/8 20:00 = JST 8/9 05:00）では**日付その物が一日
  戻る**。データの鮮度を読む欄なので、ここは JST に揃える。
  - `generatedAtLabel()` を新設し、既存の `fmtJst()`（`YYYY-MM-DD(曜) HH:MM JST`）を再利用した。
    新しい独立関数なので、ビルド成果物から抜き出す既存検査の自由変数には触れない（第 91 回）。
  - 値が日時として読めないときは原文を残す（`データ生成: 未取得` など）。嘘の日付を作らない。
  - てびきは「右上の更新時刻までが公開済み」とだけ書いていた。実際の語は「データ生成」で、
    単位も出ていなかった。画面に出る語その物と単位を書いて、その場で引けるようにした。
    「右上」自体は偽りでないことを確かめた（`.brand-row { justify-content: space-between }` の
    右端に `#genat` がある）。
  - 検査: ビルド成果物から `pad` / `fmtJst` / `generatedAtLabel` を抜いて動かし、
    UTC 8/8 20:00 → `2026-08-09(日) 05:00 JST`（元の日付を含まない）と、
    読めない値が原文のまま出ることを抑える。実ビルドの値では
    `データ生成: 2026-08-09(日) 09:00 JST` になる（`generated_at` は `2026-08-09T00:00:00Z`）。
  - 検査側の失敗を 2 件: ①抽出した関数本体をテンプレートリテラルに素で埋めると引用符が壊れた
    （`JSON.stringify` で別変数に置く。第 93 回と同じ型）②てびきの語を書き換えた自分の編集で
    自分の検査が落ちた（想定内。画面の語・単位・位置の三つを引く形に強めた）。
  - 調べたが缺陷でなかったもの: 「さらに表示」は既に「さらに表示 (残り N 件)」で件数を出す。
    「条件クリア」は検索語・分野・種別・ランク・期間・推定・国内・オンライン・過去を
    過不足なく戻す（ソートは条件ではないので残す）。検索欄の例示語（NSDI・ネットワーク・
    おきなわ・国内）はすべて既定画面で 1 件以上出る。動作確認用サンプル 5 件はすべて
    推薦が 8 件以上出る（日本語のサンプルも最高得点 100 で出る）。
- **早め絞り込みのボタンの語が、同じ条件を出す欄と割れていた**（2026-09-23 実測）。
  - 「HPC・システム」は、分野チップが「高性能計算」と出しているのに内部キー由来の `HPC` を
    出していた（§7 の「内部キー・実装語を画面に出さない」に反する）。「高性能計算・システム」に直した。
    検索側は今までどおり `HPC` を受け付ける（打てる語を狭めたのではない）。
  - 「国内研究会」は、値を入れている条件がチェック欄とまったく同じ `domestic-jp` なのに、
    ラベルだけ短く **プリセットの方が狭い条件だと読めた**。チェック欄と同じ
    「国内研究会・国内シンポジウム」に直した（第 94 回の収録状況と同じ型の誤り）。
  - てびきが並べていたボタンの語も実装と食い違っていた（「HPC・システム」「国内研究会」）ので、
    同じ語に揃えた。
  - 検査: ボタンを `data-preset` で洗い、①分野のボタンはビルド成果物の
    `CATEGORY_LABELS_JA` から作った語と一致すること（テスト側に語を書き写さない）
    ②ボタンの欄に `HPC` を出さないこと ③国内のボタンの語がチェック欄の語に包含されること
    ④てびきが 5 つのボタンを実装と同じ語（「…」で囲った形）で挙げていること。
  - 折り返しの確認: `.presets-bar` は規則全体を見たところ元から `flex-wrap: wrap` が
    あった（第 94 回で上からしか読まずに重複追記をした反省を守った）。
- **画面上部の四つの数が、何を数えているかを示していなかった**（2026-09-23 実測）。
  `追跡会議数 680` / `直近30日締切 176` / `穴場/特化誌 63` / `国内研究会 56` と並んでいて、
  - **単位が無く、会議の数と締切の件数が混在**していた。前三つは `DATA.conferences`（会議）、
    「直近30日締切」だけ `rows`（締切の行）。680 と 176 が同じ物だと読める。
  - **「穴場/特化誌」はラベルが 2 つの集まりを騙っていた**。実数を入れているのは `niche`
    タグの会議（63）だけで、`journal` タグは数えていない。
  - **「国内研究会」も絞り込みと同じ集まりでは無い**。値は `domestic-jp` タグの会議で、
    チェックボックスの語は「国内研究会・国内シンポジウム」だった（同じ物が二つの名前で出る）。
  - 四つとも**絞り込みで動かない**のに、そのことが書かれていない（一覧が 478 行のときに
    176 が何を指すのか分からない）。
  - 直し方: ラベルを「収録している会議」「これからの30日間の締切 __件」（単位を隣に置く）
    「穴場として収録した会議」「国内研究会・国内シンポジウム」に変え、先頭に
    「絞り込み前の収録全体:」のキャプションを置いた。語が長くなったので項目間の隙間を入れる
    （`gap` は元々無く、4 項目で語が短かったため目立っていなかった）。計算は変えていない
    （値はそのまま 680 / 176 / 63 / 56）。
  - てびきに「画面上部の四つの数」を追加し、単位・数え方（`niche` / `domestic-jp` タグ、
    30 日の方は概要締切と論文締切だけを推定抜きで数える）と、一覧の行数は件の欄を見ることを
    書いた。画面に出る語をてびきが説明していないと調べられない。
  - 計測の間違いを 1 件: 語が長くなって折り返しが無いと画面外に消えると読み、
    `flex-wrap: wrap` を足そうとした。**規則の末尾に元から在った**（上から 8 行しか読んで
    いなかった）。重複を追記したので戻した。確認は規則全体を見る。
- **「本日終了」が JST で昨日の締切にも出ていた**（2026-09-23 実測）。
  `remain()` の過ぎた側は `Math.floor(-diff / DAY)` の経過日数で判定していたため、
  経過 23 時間 59 分まで「本日終了」になる。JST 15:00 に見た JST 前日 19:00 締切
  （20 時間前）が「本日終了」で、**「今日の締切だと思って開いたら昨日だった」**が起きる。
  一覧は JST を単位にしている（月見出しも JST）ので、暦日の差で数えるようにした。
  - `jstDay(t) = floor((t + 9h) / DAY)` の差が 0 なら「本日終了」、1 以上なら「N 日前に終了」。
    境界の実測（now = JST 8/10 15:00）: 1 時間前・8 時間前・14 時間前（JST 同日 01:00）は
    「本日終了」、20 時間前（JST 前日 19:00）と 26 時間前（同 13:00）は「1 日前に終了」、
    50 時間前は「2 日前に終了」。修正前は 20 時間前が「本日終了」だった。
  - 先の側（「あと N 時間」「まもなく」「あと N 日」「14 日以内は強調」）は変えていない
    （てびきの記述と一致することを同じ検査で抑えた）。
  - JST オフセットはインラインに置いた。`remain` はビルド成果物から抜き出して検査する
    関数なので、依存を増やすと検査側が壊れる（第 91 回の教訓）。
  - 検査: ビルド成果物の `remain` を凍結時刻で動かし、上の境界を押さえる。加えて
    てびきが「日数は JST の暦日」と同じ約束で書かれていることを見る（案内と実装のズレ）。
  - 検査側の失敗: 抽出した関数本体をテンプレートリテラルへ素で埋め込むと、本体の中の
    バッククォートで外側が壊れた（`JSON.stringify` で渡す）。
- **「過去の締切も表示」を入れると、2019 年の行が画面の先頭を埋め尽くしていた**（2026-09-23 実測）。
  収録 3,235 行のうち締切時刻が過ぎた行が **2,318 行**あり、既定の並び（残りの昇順）では
  過ぎた行がそのまま先頭に来る。2019-05-25 の AFT が最初の行になり、直近に締切った行も
  これからの締切もすべて 2,318 行の下に沈む。過去を見たい意図（去年いつだったか）とは
  別に、現在のリストが使えなくなる。
  - 直し方: 過ぎた行を**後ろの塊**に寄せ、塊の切り替わりに「これからの締切（N 件）」
    「過ぎた締切（N 件）」の見出し行を置く。塊の内側は選んだ列の向きそのまま（残りの
    昇順なら過ぎた塊も古い順）。ここで塊の中で向きを反転させると列見出しの ↑・↓ と
    食い違うので、正直さに取る。直近から見たければ「残り」を押して降順にすればよい、
    という事をてびきに書いた。
  - 見出し行は月見出しと同じ `month-row` を併せ持つ（`section-row` で装飾だけ分ける）。
    `month-row` を共有しているから、①支援技術が列を跨ぐ見出しとして扱う（`scope="colgroup"`）
    ②既存のキーボード移動・選択の「数えない行」規則がそのまま効く、の 2 つが無料で従う。
  - 並びを裏で変えるので件数欄に「過ぎた締切 N 件は下にまとめました」を出す（読み上げ欄
    にも同じ語。第 89 回の短い生領域へ）。
  - 塊の目印 `_pastBlock` は `filter` の並び替え直前で置く。比較関数の**自由変数を増やさ
    ない**ため（第 91 回で、ヘルパーを生やした瞬間にビルド成果物から関数を抜き出す既存
    検査 6 件が `ReferenceError` で落ちた教訓）。抽出する検査側は `state.past` を持たない
    形なので、旧来検査の並びは変わらない（既定の画面では過ぎた行が来ないため実質無効）。
  - 検査: ビルド成果物の `filter` に 3+2 行を流し、塊の並びと目印を確認する。
    検査側の失敗: 過ぎた塊の内側を「直近順」と期待して落ちた（列の向きを正しく写す）。
    実測値（2,318 行）はコメントに書き、行その物は合成している（並びの契約を見る検査なので）。
- **締切の時刻を持たない行を交ぜると、日時順の比較が壊れていた**（2026-09-23 実測）。
  `compareDeadlineRows` は `if (a.t !== b.t) return a.t < b.t ? -1 : 1;` で、片側が NaN
  （常時受付の学術誌など、締切の時刻を持たない行）だと `NaN < x` が常に false になり、
  **どちらを先にしても 1 を返す**＝比較関数の契約（反対称性）を満たさなかった。
  同じ集合を入力順を変えて sort すると結果が変わり、昇順では時刻の無い行が先頭に
  出て「いちばん近い締切」と誤読させる。収録カタログには現在 時刻の無い行が **0 件**
  なので今日の見え方は変わらないが、学術誌を 1 行追加するだけで表全体の順序が化ける
  形だった（予防の修正であることを明記する）。
  - 直し方: ① 時刻の有無で最初に かたまり を分ける（向きの影響を受けない最後尾へ。未知の
    種別を末尾に置く `kindSortIndex` と同じ約束）② 数値比較は `deadlineTimeMs` で
    NaN を 0 に寄せてから行う ③ `mult`（昇降）を関数の内側に受け取り、締切のある行の
    中での向きだけ反転させる。外で `* mult` をすると、時刻の無い行が降順で先頭に
    反転して「いちばん遠い」に化ける。
  - 同じ型で `Recommender.comparePapers` の末尾 `a.t - b.t` も直した（ジャーナル同士は
    上で後方へ寄せているが、同士どうしが NaN になっていた）。
  - 検査: ビルド成果物の比較関数を取り出して、① 反対称性（全ペア）② 入力順を 4 通り
    変えても並びが 1 通りに収まること ③ 昇順・降順のどちらでも時刻の無い行が末尾に
    あること。修正前の成果物では ① が 1/1、② が 2 通りに割れていた。
  - 検査側の失敗: 同じ修正で `deadlineTimeMs` / `deadlineTimeTail` を新しい関数として
    生やしたら、**ビルド成果物から関数を抜き出す既存の検査 6 件が `ReferenceError` で
    落ちた**（抽出した関数の自由変数は、検査側が全部渡し直す前提になっている）。
    新しいヘルパーは生やさず、NaN の寄せを `compareDeadlineRows` の中にインライン化した。
    ビルド成果物の検査をしている限り、**実装側が依存を増やすのは検査側のコスト**になる。
  - 呼び出し形を変えたことで、**呼び出し箇所の文字列をピン留めしていた検査 4 件**
    （build_golden 3 + recommender 1）が同時に落ちた。うち 1 件は `indexOf` の戻り値が
    -1 になったまま `slice(start, -1)` になり、**ランク順の塊を実際には見ていない
    空振り**になりかけていた（見つからなかったら落ちる、という前置きを自分で追加した）。
    「実装の文字列を写す検査」は実装を動かすと必ず追従が必要で、空振りの可能性を常に持つ。
- **CSV 書き出しのランク列だけが、画面と違う書き方だった**（2026-09-23 実測）。
  上流の `N` は「ランクが付いていない」ことを表す**番兵**で等級ではない（§2）。画面と
  行の詳細は同じ所を「評価なし」と出しているが、CSV は `N` をそのまま書いていた。
  将来締切 917 行の書き出しで **271 マス**が `N` で、表計算側では「N という等級」で
  絞り込めてしまい、空欄（その体系を未追跡）との違いも読めない。
  - 直し方: 書き出し側でも番兵を「評価なし」へ直す。**体系その物が無い欄は空のまま**
    （「評価なし」と「未追跡」を混ぜない）。画面と同じ語なので、画面で打てる語が
    表計算でも引ける。
  - 検査: ① 単体で `N` / `None` → 「評価なし」、体系のキー無し → 空欄、実等級はそのまま、
    欄のどれにも `N` が残らないこと ② 収録カタログから組んだ実データの CSV で
    「`N` マス 0 件」かつ「『評価なし』マス数 == データ側の番兵数」（双方向。合成
    fixture では該当 0 件になって空振りする）。列数が全行で揃っているかも同時に検める。
  - 副産物: 案内文への中国語表記の混入を **ファイル横断の検査でピン留めした**。
    「dropdown に当たる語」の混入を 3 回数えている（2026-09-23 までに 3 か所を修正）。
    点検語は文字番号で書き、語列出典が自分自身を拾って落ちないようにした。
    実物の誤記をバッククォートで引用した記録（§7 の失敗記録など）は除外する。
  - 計測側の失敗: 最初に `split(",")` で列を見たとき、引用符で括った開催地
    （`"Thessaloniki, ギリシャ"`）で列がずれ、無いはずの「欄に R1 が入っている」と
    誤読した。引用符を見る簡易パーサで読み直すと**列崩れは 0 件**で、実缺陷は `N` だけ
    だった。検査では列の揃いもピン留めした。
- **第 88 回で入れた `aria-live` が読みすぎだった**（同じラウンドでの自分による修正）。
  `#count` は件数だけでなく「のぞく」の内訳（過去の締切・投稿締切以外の種別・推定・
  締切まで窓・評価・分野・国内・オンラインの **8 項目まで**積める）や注記を載せる長い欄で、
  そこごと `aria-live="polite"` にすると **1 打鍵ごとに数十語が流れ**、絞り込みの途中で
  読み上げが更新され続ける。画面の表示はそのままで、読み上げだけを短い専用の生領域に
  分けた：
  - `#countLive`（`class="sr-label" aria-live="polite"`）に件数・解決結果（「来月 =
    2026年9月」など）・取得状態（全履歴の読み込み中 / 意味検索の実行中・利用不可）・
    分野自動判定だけを書く。画面に積む 9 か所のうち「のぞく」の 1 か所を読まない。
  - `sr-label` は clip で消す（`display: none` にすると支援技術からも消える。第 87 回）。
  - 検査: `#count` そのものを aria-live に戻していないこと、ビルド成果物で
    画面側には「のぞく」の積込みがあるが読み上げ側には同じ積込みが無いこと、状態の通知は
    `cntLive` へ積まれていること。
  - 作り直しを 1 件記録する: 挿入時に既存コメントの行頭だけ呑んでしまい、コメント本文が
    コードとして残って型検査で落ちた（部分一致置換は行全体を見ること）。
- **支援技術に伝わっていない箇所が 3 か所あった**（2026-09-23 実測）。
  - **種別・ランク・締切までの見出しがただの `<span>`** で、`<label for>` では無かった。
    支援技術では 3 つの選択欄が「すべて」としか読めず、どれが種別でどれがランクか分からない。
    `<label for>` に直した（`.field > span` だったスタイルは `.field > label` を足して
    見た目をそのまま維持）。検索欄は見出し自体を置いていなかった（placeholder だけ。
    打つと消える）ので、画面に出さないラベル（`.sr-label`）を置く。
    `.sr-label` は `display: none` ではなく clip で消す（第 87 回と同じ教訓）。
  - **絞り込みのたびに書き換わる件数欄（`#count`）に `aria-live` が無かった**。件数・
    「こう探しました」の展開式・0 件のときの案内を出す欄なので、入力して一覧がどう
    変わったかが黙って入れ替わっていた。`#historyStatus`（過去の締切を出すときの
    取得状態）と同じく `aria-live="polite"` にした。
  - **列見出しの `<th>` に `scope` が無かった**。月見出し側は `scope="colgroup"` を
    使っていましたが、列の方が無く、478 行のセルがどの列か伝えられなかった。
    7 つすべてに `scope="col"` を入れた。
  - 検査: ① 列見出しすべてに `scope="col"` ② 件数欄と履歴状態に `aria-live="polite"`
    ③ 操作できる欄すべてに名前がある（選択欄と検索欄は `label[for]` 必須。
    placeholder だけ・`aria-label` だけは不可）④ `label[for]` が居ない id を指していない
    こと。ドロワーは開いたとき ✕ ボタンへ焦点を移し、閉じるとき開く直前の要素へ戻して
    いたのでそのまま（実装を確認した）。
  - 検査側の失敗を 2 件: ① 囲いラベルの判定をタグ文字列だけから作ろうとして空振りした
    （囲われていることは本文上の位置で見る）② 隠し保持用の `paperText` を点検対象に
    入れて落ちた（操作しない欄は除く）。
- **分野チップがキーボードで到達できなかった**（2026-09-23 実測）。`.chips input` を
  `display: none` で消していたが、`display: none` はタブ順序からも外れるので、
  **分野での絞り込みがマウス・タップ専用**だった。期間・種別・ランクの `<select>` も
  `outline: none` だけで焦点の目印を書いていなかった（入力欄は `border-color` が変わるが
  select は変わらない）。
  - 直し方: チップの checkbox は「見えなくするだけ」に直す（`opacity: 0` + 1px +
    `pointer-events: none`。見た目は今までと同じで、タブで届く）。焦点の目印は
    `.chips label:has(input:focus-visible)` でピルごと囲い、`+ span` 側も併記する
    （`:has()` 非対応でも語に枠が出る）。
  - `input` / `textarea` / `select` / `button` / `[tabindex]` に `:focus-visible` の枠を
    まとまって与えた（既存の `th[data-sort]:focus-visible` は指定が強いのでそのまま勝つ）。
  - 印刷 CSS は操作要素を意図的に消す（紙で操作しない）ので、検査は `@media print` の
    塊を除いて見る。CSS の注釈も落としてから規則を洗う（注釈に `outline: none` と
    同じ語を書いていたので、規則の選抜が注釈ごと拾って誤判した）。
  - 検査: ① 操作要素そのものに `display: none` を掛けない ② チップは「見えなくするだけ」
    （`opacity: 0`）で焦点の目印規則がある ③ `outline: none` を掛けた要素は、同じ要素に
    対する `:focus` 規則が在ること（要素名で突き合わせる）。**②③を実際に戻して落ちる
    ことを確認した**（検査が空振りになっていないことの確認）。
  - 見切れ点検も兼ねて配色のコントラスト比を出した（WCAG 相対輝度）。本文・淡色・
    強調・警告・注意のすべてで **4.5:1 以上**（最小は ライトの `--soon` on `--bg` の 4.55、
    `--muted` on `--chip` の 4.69）で、直す所は無かった。
- **スマートフォンの幅では並び替えができなかった**（2026-09-23 実測）。640px 以下では
  `thead { display: none }` で行をカード化するが、並び替えの入口は列見出しのクリック
  だけで、他に操作が無かった。てびきは「列の見出しを押すと並び替わります」と書いていた
  ので、**案内できる操作が端末に存在しなかった**ことになる。
  - 直し方: 表の上に並べ替えの列（`.sortbar`）を置き、**狭い画面だけに出す**。押す物は
    既存の `toggleSort` そのまま（新しい状態を作らない＝URL・件数欄・月まとめと同じ挙動）。
    桌面では見出しがあるので `.sortbar` は `display: none`。
  - 目印は `setSortAria` が `[data-sort]` をまとめて見るようにした（見出しは `aria-sort`、
    ボタンは `aria-pressed`。ボタンに `aria-sort` は意味が通らない）。目印の語尾だけ
    入れ替える既存の性質は変えない。
  - 印刷にも気をつける: 印刷 CSS は操作要素を並べて隠しているので `.sortbar` を足した
    （用紙に「並べ替え 残り ↕ …」が印刷されるのを防ぐ）。
  - 検査: ① 見出しを隠す規則と並べ替えバーを出す規則が**同じメディアクエリ内に対で**
    有ること（片方だけ変えると落ちる）② バーの列が `SORTABLE_KEYS` と見出しの
    `data-sort` と一致すること（双方向）③ 画面に出る語も見出しと同じこと
    （別名にすると検索で引けない語になる）④ `setSortAria` が両方に目印を付けること。
  - 第 85 回で追記したキーボードの項を、狭い画面で隠すのを忘れていた（`.count-kbd` を
    隠しているのと同じ理由。ショートカットの無い端末で誤導する）。`.only-keyboard` にして
    隠し、上の検査 ⑤ に入れた。
  - 検査側の失敗: 目印の規則を写すとき、`sortMarkJa` は目印を語に続けて返す（先頭に空白を
    含まない）という契約を写し忘れ、二重スペースを期待して落ちた。実装は正しかった。
- **一覧のキーボード既定操作が、説明も検査も無かった**（2026-09-23 確認）。`j`/`k`・`↑`/`↓`・
  `Enter`・`d`・`/`・`Esc` が実装されていたのに、てびきのどの項にも出てこず、検査も 0 件だった。
  - てびきに「キーボードで一覧を動かす」を追加し、**入力欄の中ではこれらのキーがただの
    文字として扱われる**こと（検索語に `j` を含んでも行が動かない）と、論文から探すモードでは
    表用の操作を使わないことを書いた。
  - 挙動の検査を入れた（`onKeydown` をビルド成果物から取り出して、作り物の画面に叩かせる）。
    入力中は選択が動かない／一覧では `j`・`k` が効く／上端で `k`・下端で `j` は周回しない／
    `/` は検索欄に焦点を当てる／`d` は選択行の詳細を開く／`Enter` は会期リンクが無ければ
    会議本体のリンクを開く／推薦モードでは表用操作を止める／入力欄の中では `Esc` だけ焦点を外す。
  - てびきと実装の対応検査も入れた（`Esc` のように画面の書き方が違うキーは対応表を持つ）。
  - **検査自体の失敗を 2 件記録する**: ① `new Function(...)` の戻り値は作られた関数なので、
    依存を渡した呼び出しとは別段で叩かないと発火しなかった。② 作り物の行は `classList` を
    持たせず、`onKeydown` の `d` 節が例外で落ちた。③ 上端検査は `selectedIndex` を毎回 1 で
    渡していたため、単に検査側の期待が間違っていた。
  - 副産物: テストコメントに中国語混入が 1 件あった（`日只显示` → 「日付だけを表示している」）。
    自分で追記したてびき本文にも `这些` が混入して即修正した。どちらも画面には出ないが、
    「日本語で書く」の約束に対して点検語を増やした。
- **推薦カードに実装側の語が残っていた**（2026-09-23 確認）。ビルド成果物の
  画面へ出る日本語文字列を洗ったところ、次の 3 つが利用者に読める位置に出ていた。
  - `取得状態: キャッシュ退避` / `スナップショット退避` → 「今回あたって確認」/
    「前回の取得データ（今回は上流にあたらず）」/「確定済みの収録データ（今回は上流にあたらず）」。
    「退避」は実装のフォールバックの語で、**その締切が今回見直した値なのか古い値なのか**が
    伝わらなかった。推薦の行は投稿先を決める判断材料なので、そこが読める書き方にする。
  - `観測年数 N年、プロフィール N件` → 「確認した年 N年、その会議の論文サンプル N件」。
    `profileCoverage` は `recommendation-core.ts` で `strings(conference.papers).length`、
    つまり数えているのは会議のプロフィールではなく論文サンプルの件数だった。
  - 開発用語の禁止語リストに `退避` `観測年数` `プロフィール` を追加（画面へ出る
    文字列だけを見る既存検査を通す）。**置き換えた語が成果物に出ていることも対で見る**
    （禁止語だけ増やしても、直ったことを検査できないため）。
  - てびきの「一致評価の出し方（論文から探す）」に、**推薦カードの4行の意味**を追記した。
    並びの目安の説明しかなかったため、`取得状態` が出してよい/だめな読み方を
    利用者が判断できなかった。「今回は上流にあたらず」の行は公式の締切を確かめるよう書く。
- **`health.md` だけ英語のままだった**（「health.json の人間向け要約」と案内しているのに、
  2026-09-23 まで本文が "# Build health" / "Tracked venues" / "| Metric | Value |" だった）。
  収録の健全性を見に来るのは人なので日本語に寄せ、**結論（まとめ）を先頭**に置いた
  （収録件数、確定/推定の締切の内訳、今回 snapshot で組んだかどうか）。
  - 機械可読の正は `health.json` のままなので、各行の見出しに JSON のキーを併記した
    （見出しは「収録している会議（tracked_venues）」の形）。ラベルだけ見てキーを辿れなくしないため。
  - 「Snapshot fallback: yes」のような書き方は、何が起きたかを読者に伝えなかった。
    「収録 snapshot で組んだか: はい」＋まとめに「上流をその場で取っていないので日付は
    snapshot 時点のまま」と書いた。`source_failures` の見出しも
    「上流をその場で取れなかったソース」に改める（オフラインビルドで「失敗」と出るのは
    実態と違う）。「yes/no」→「はい/いいえ」、「none」→「なし」、「present」→「収録済み」。
  - 分野の内訳は機械可読のキーのまま出す（日本語の名前を持つ表が `site/recommender.ts`
    の `CATEGORY_LABELS_JA` にしかなく、ビルド側に写すと 2 所管理になるため）。
    md 側にその旨を書いた。
  - 検査: md に出た数値が `health.json` と同じ行になっていること（6 項目）、
    英語の見出しに戻っていないこと（4 語）、まとめ章があることを見る。
- **`llms.txt` の「サイトの日本語での引き方」が実装に追いついていなかった**。
  `llms.txt` は機械（検索・要約の支援ツール）が読むので、ここに無い機能は利用者に
  伝えられない。第 76 回のラウンド検索・第 77・80 回の並べ語・第 81 回の月語の和暦展開・
  第 72 回の「略称と年を離して打つ」の 4 か所が書かれていなかった（2026-09-23 確認）。
  案内の 4 項目を足し、**本文の句と挙動を対で固定する検査**を入れた
  （「llms.txt に書いた検索の引き方が、ビルド成果物で実際に効く」）。
  本文だけ先に変更しても、実装だけ先に進んでも落ちる。
- **月・日の語で隣の月日が混ざっていた**（照合が部分一致なので `1月` が `11月` に当たる）。
  2026-09-23 実測: 「1月」の当たり 892 件のうち **526 件が 1 月と無関係**、「2月」も
  394 件、「1日」は 287 件。「12月締切だけ」と絞った画面に 11 月の締切が並んでいた。
  「月でも引ける」と案内していたので、案内と実態が食い違っていた。
  - 直し方: 月語は **hay に出る和暦付きの形**（`2026年12月`）に展開する（収録の和暦は
    2019〜2028 年なので 2018〜2032 を見る）。日の語は `8月10日` の形に展開する。
    素の語は残さない — 残すと混ざったままになる。
  - **失敗した直し方を 1 つ記録する**: 最初に「語の先頭へ空白を付けて照合する」手を
    試みたが、`searchNormalize` が語を trim するため素の語に戻り、実測で一切変わらなかった。
  - 検査: 実カタログで **当たり = 和暦の語を持つ行** を 12 か月 + 6 件の日で双方向に見る
    （1 件でも多く出しても、落としても落ちる）。「1月」は 892 件 → 365 件になった
    （落ちた分は 11 月など別月の行）。
  - 副作用の点検: `2026年12月`・`8月10日`・「明日」「今週」は展開しない（もともと隣の月を
    含まない語なので）。`13月`・`0日` のようなありえない語も展開しない。全走査は
    1 語 14 ms → 月語 19.5 ms（和暦 15 とおりの照合。入力し直すたびに走るが、体感の壁に
    ならない範囲）。「スパコン・12月」のような併用も従来どおり。
- **並べ語を中黒（・）に統一し、入力側でも並べ語で切るようにした**。行の詳細の
  分野・主題・ランクだけ全角コンマ（，）で並べていた（一覧・CSV・件数欄は中黒）。
  同じ情報を 2 通りの書き方で見せるうえ、**行の詳細から検索欄へ写した人が 1 語扱いで
  0 件に当たっていた**（2026-09-23 実測: `人工知能，データベース` 0 件、同じ意味の
  中黒形は 150 件）。
  - 行の詳細を `join("・")` に統一（ビルド後の `app.js` に全角コンマの並べ語が
    残っていないことを検査）。
  - 入力側は `・，、,/` で切る。`/` は `AI/ML` のような自前の区切りに必要
    （変更前は `ai/ml` が 1 語で 0 件）。`／` は正規化で `/` になるのでまとめて受ける。
    並べ語だけの入力は語を作らない — `，` だけだと「カンマを含む行」全件
    （3,014 件）に化けていた。
  - `・` を含む見出し（別表で `サン・マロ` の 1 件）を救う束ねはそのまま効く
    （`サン・マロ` は 6 件のまま）。
  - **`/` を並べ語に加えたときに自分で壊したものを直す過程**: 当初のままだと
    `2026-08-22`・`13/45` のような暦日入力が割れて、暦日検索（「日付を数字で打つ」検査）が
    落ちた。数字とかぎ括弧だけで構成される入力は `/` を区切りにしないガードを入れた
    （`ai/ml` は分割、`12/25` は 1 語のまま）。ドロワーの並べ語を変えた検査
    （「ドロワーは表の情報を落とさない」）も新表記に更新した。
  - 実装上の注意: `site/recommender.ts` は語の Shields に**生の NUL 文字**を使うため
    編集ツールが「binary file」で弾く。その箇所を触るときは機械的な文字列置換を使う。
- **案内文に書いた実測値が噓をついていた**（2026-09-23 に 7 か所ズレ）。案内文は
  「既定画面 477 行」「のぞく 462 件」「2 ラウンドの行は 387 件」「`プライバシー` 20 件」
  などと書いていたが、正しくは 478 行 / 463 件 / 378 件 / 16 件だった
  （ほかも 1〜2 ずつズレ）。**原因は測る基準の取り違え**。上流キャッシュ込みのビルド
  （`--cache .cache`）で測っており、再現可能な基準（収録 `data/snapshot.json` ＋固定時刻
  2026-08-09 のオフラインビルド）と行数が違った。
  - 案内文の数字を基準に合わせて書き直し、**20 の実測値を検査で固定**した
    （「案内文に書いた実測値が、ビルド成果物に対して今も合っている」）。収録や実装が
    動いて数字がズレるか、案内文のほうが変わると落ちる。
  - 検査の基準を組み直すときに判明した事実を 1 つ記録する: `tests/helpers.ts` の
    `tempCache()` は **合成 fixture を書いたキャッシュ**であり、snapshot への
    フォールバックではない（既定画面が 306 行になり、案内文と合わない）。
    収録についての検査は空キャッシュで組む必要がある。
- **1 つの日本語が複数の開催地に寄るときのおしらせを件数欄に出すようにした**。
  `バリ` はイタリアの `bari` とインドネシアの `bali` の両方に当たる（違う場所を足している）
  のに、おしらせが無く、行の開催地は公式の英文字表記のまま残るため、
  「なぜこの行が出たか」が画面のどこにも出なかった（2026-09-23 実測: 空）。
  1 とおりの寄せ（`クラクフ` → `krakow`）は精密に引けているので付けない —
  地域まとめの検査が「精密に引ける語には付けない」と見ているのと同じ規則に揃えた
  （当初は全ての開催地の寄せに出し、`東京` に付く形で既存の規則と衝突したので狭めた）。
  表示側で日本語に寄せる語（国名など）も書かない（画面に既に日本語で出る）。
- **主題の寄せおしらせの重複を書いた**: 長音の書き方が違う条目が同じ寄せ先に来ると
  「英語で書かれた会議名（user interface / user interface など）」と並んでいた
  （`ユーザインタフェース`・`ユーザインターフェース` → `user interface`）。束ねた。
- **中黒（・）を入力側でも区切りとして扱うようにした**。件数欄・CSV の分野列・行の詳細は
  分野を `人工知能・データベース` の形で書く（この表記を持つ行は収録 397 行）のに、
  写すと 1 語になって **0 件**だった（2026-09-23 実測）。切る方向は他の語と同じく AND
  （両方持つ行）。`・` だけの入力は語を作らない（全件に化けない）。
  実データで、・付きの分野表記を実際に持つ行がすべて出ることを見る。
  なお絞り込み欄のラベル `国内研究会・国内シンポジウム` は選択肢の列挙（二者択一）なので
  AND で 0 件になる。語は単独で引ける（`国内研究会` 24 行・`国内シンポジウム` 5 行）し、
  該当するのはチェックボックス自身なので、そこは検索の語にしない前提のままとする。
- **ラウンドの語を、画面の書き方のまま検索できるようにした**。表の種別セルと行の詳細は
  「第 N ラウンド」と書き、CSV は `R1` `R2` と書くのに、検索用の文字列に入れていなかった
  （2026-09-23 実測: 2 ラウンドの行は 387 件あるのに `R2` は 3 件、`第2` は 5 件）。
  `roundSearchTerms` を追加して hay に入れ、`第Nラウンド` / `第 N ラウンド` / `rN` の 3 形を
  寄せる先にした。
- **画面どおりにスペースを入れて写した入力が全件に化けていた**問題も同時に直す:
  「第 2 ラウンド」は 「第」 AND「2」 AND「ラウンド」 に割れ、どれもほぼ全行に含む。
  `queryTokenGroups` で `第` + 数字 + `ラウンド` を 1 まとめの語に寄せる
  （他の語との AND はそのまま。略称+年の扱い（`nsdi 27`）は巻き込まない）。
  実データで 第1/2/3/12 ラウンドとも、そのラウンドの行だけを出ること・
  取りこぼし 0 件・全件化していないことを見る。
- **日本開催の行の開催地を、漢字で引けるようにした**。国内の行はローマ字をそのまま打つ人が
  少ないのに、海外側しか検査していなかった（「5 行以上」の閾値に 1 都市 1〜2 行の日本開催は
  届かない）。2026-09-23 実測で `Aizuwakamatsu` の 2 行だけがどの言い方でも 0 件だったため
  `会津若松`・`会津` を、会場名で行を書いている回に `一橋講堂`・`日本科学未来館`・`未来館` を足した。
  `Miyakojima`（FC の回）は公式の "Miyakojima, Japan" に応じて `宮古島` が既に寄せてあり、
  行の無い地名（`宮島`）は置いていない。行の無い語を置かないのは他の表と同じ約束。
  検査は実行ビルドの収録から日本開催の行を数え上げ、開催地（最初の市区郡・会場）ごとに
  日本語の言い方の表に対応があること + 合成行を実際に引いて当たることを見る
  （収録側の行は上流の取得状況で増減するため、当たり方の判定は再現できる形でおく）。
- **分野の言い方を 12 語さらに足した**（`プライバシー`・`医療`・`医用`・`健康`・`認知`・
  `ドローン`・`知識グラフ`・`データマイニング`・`推論`・`プロトコル`・`センサネットワーク`・
  `自律`。2026-09-23 実測: 日本語は 0 件、英文字表記は 1〜183 行。既定画面では
  「プライバシー」20 件・「データマイニング」22 件になった）。
  `自動運転` は置いていない — 収録の英文字は `autonomous` で自律システムまで含むため、
  日本語の対応が広い `自律` のほうを置いた（当たらない語を約束しない）。
  実データ検査は第 1 群・第 2 群と同じ表に載せて継続（32 組）。
- **行の詳細の「今後の会期」と 0 件時の会期案内の開催地を、表と同じ書き方に直した**。
  表は開催市を公式表記のまま、国だけ日本語に寄せる（`Kyoto, 日本`）のに対し、この 2 か所は
  原文のままだった（`＠Kyoto, Japan`）。同じ画面の中で同じ種類の情報が 2 通りに書かれていると、
  別の場所だと誤解する。原表記は title に残す。
  検査はビルド後の `renderNextMeetingNote` を**疑似 DOM で実際に動かして**、
  出た文字列が表と同じ書き方になっていることと、原表記が title に残ることを見る
  （関数抽出 + `eval` なので、`new Function` と違いスクリプトスコープの変数が見える）。
- **略称と年をスペースで離して 2 桁打つ入力を通した**（`NSDI 27` `ICDE 27` `OSDI 26`）。
  貼り付けた形（`nsdi27`）と 4 桁の形（`NSDI 2027`）は通っていたのに、いちばん打つ
  真ん中の形が 0 件だった（2026-09-23 実測）。裸の 2 桁を年として扱うのは
  **同じ入力に略称らしき語があるときだけ**（裸の `27` は暦日の 27 日、`8月 27` は 8/27 の
  まま。当たり方を広い方へ動かさない）。実データで 3 会議分、4 桁を打ったときと
  同じ行の集合になることを見る。
- **開催市の日本語の言い方を 15 語足した**（`カンクン`・`マルメ`・`テュービンゲン`・
  `マラガ`・`サクラメント`・`ニージメヘン`・`ヴェローナ`・`ハリファックス`・
  `アレクサンドリア`・`ドゥブロブニク`・`ロングビーチ`・`シャーロット`・`クラクフ`・
  `ピサ`・`ノッティンガム`）。開催地は公式表記を変えないので、カタカナで引く人に届くのは
  検索語側だけ。`Cancún` は収録 23 行がありながら `カンクン` で 0 件だった。
- **「5 行以上の開催都市はカタカナで引けるか」検査の穴を閉じた**: 都市語を
  `^[A-Za-z][A-Za-z .'-]*$` で拾っていたため、**アクセント付きの都市名が検査から
  丸ごと落ちていた**（`Cancún` 23 行・`Malmö` 13 行・`Tübingen` 11 行・`Málaga` 7 行の 4 種）。
  検索がアクセントを捨てるので、数え上げもアクセント記号を除いて行う（除いた後なので
  ラテン文字表記はすべて拾える。ギリシャ文字・キリル文字表記は従来どおり数えない）。
  修正後の比較: 追加前は 4 種が未カバー、追加後は 0 種（実測で確認）。
- **分野の言い方（日本語 → 英文字表記）を 20 語足した**。`リアルタイム`・`実時間`・
  `プログラミング言語`・`コンパイラ`・`クラスタ`・`モバイル`・`仮想現実`・`拡張現実`・
  `データ分析`・`パターン認識`・`音響`・`ゲーム`・`ユーザインタフェース`（長音の別表記も）・
  `エッジコンピューティング`・`バイオインフォマティクス`・`スケジューリング`・
  `計算機アーキテクチャ`・`脆弱性`・`マルウェア`・`侵入検知`（2026-09-23 実測:
  いずれも日本語は 0 件、同じ意味の英文字表記は 2〜44 件当たっていた）。
  「収録に無い」と「打ち方が通じない」を区別できないと、そこで検索をやめる。
  追加の基準は既存と同じく**英文字側が収録カタログに現れること**。
  `画像認識` は `image recognition` の語順で収録に現れないので割愛した（当たった 3 行は
  `graphics, patterns and images` と別箇所の `recognition` で、同じ場所を指す語ではない）。
  `テスト`・`対話`・`モデリング` は当たり方が広すぎて寄せない。
  検査は実データで「日本語で引いた行 ⊇ 英文字の語順を含む行」かつ 1 件以上を見る。
  **ハーネスの `grab()` が表の末尾が説明コメントで終わると壊れる**のも直した
  （`]` をコメント行に繋いで構文エラーになっていた。2026-09-23 に実発生）。
- **分野チップでのぞいた件数を件数欄に出すようにした**（評価と同じ型の続き）。
  チップには分野ごとの件数が写るが、「選んだ分野で何行が出て他が何行だったか」は
  件数欄に無かった（2026-09-23 実測: 既定画面 477 行のうち「人工知能」は 182 行で、
  のこり 295 行の話し手が件数欄にいなかった）。件数欄は
  「分野「人工知能・高性能計算」を持たない行 N 件」（チップと同じ日本語名を書く）。
  のぞいた数は**他の条件を通った行**から数えるので、チップの件数と足して全件に
  ならない。その関係を案内にも書き、足して 100% になる内訳だと誤解させない。
  チップは複数選択で OR（押すほど増える）なので、2 つ選んで減る側を検査で固定する。
- **CSV に「分野」列を足した**（会議のうしろに 1 列）。分野は絞り込みの次元なのに、
  一覧は 7 列（残り・日時・会議・種別・ランク・会期・開催地）で分野列を持たず、
  CSV にも無かったので、表計算に持ち出すと分野ごとに並べ替えられなかった
  （研究室内の予定表に貼る使い方で困る）。書く語は**画面と同じ日本語**
  （`categoryLabelJa` を呼ぶ。分野チップ・行の詳細と同じ正本）で、
  `hpc` のような内部キーは表計算に渡さない。
  収録カタログ全体で、①全行の列数が見出しと揃うこと（RFC4180 の読み方で割る。
  開催地などにカンマが入るため素の分割では確かめられない）、②分野を持つ行の
  分野列が空でないこと、③ラベル表の無いキーがそのまま出ていないこと
  （日本語を含まないセルが 0 件）、④画面と同じ語になっていることを見る。
- **「評価でしぼる」でのぞいた件数を件数欄に出すようにした**。窓・過去・推定・種別・国内・
  オンラインはのぞいた件数を出していたのに、評価だけ出さなかった（2026-09-23 実測:
  既定画面 477 行のうち「A*」は 61 行で、のこり 416 行の話し手が件数欄にいなかった）。
  選択欄には評価の収録数が写らないため、「収録に A* が少ない」と誤解して
  絞り込みを外してしまう。件数欄は「評価「A*」を持たない行 N 件」の形（選択欄の
  表記をそのまま使う）。
  ビルド後の `filter` を動かす検査で、**表示件数 + のぞいた件数 = 対象行数**を
  全等級について確認する（数え漏らし・二重計上の検出）。等級の判定はハーネス側の
  簡易スタブではなく **recommender の正本（厳密比較）をビルド成果から注入**して使う
  （`includes` の部分一致だと「A」が「A*」に誤マッチして、合うはずの数字が合う）。
- **開催地の翻訳が複合地名を壊していた**ので、守るようにした（`PLACE_NAME_SHIELDS_JA`）。
  `New Mexico` はアメリカの州なのに、国名 `mexico` の置換で表示が **「New メキシコ」** に
  なり、**「メキシコ」で引いた人にアメリカの会議を渡していた**（2026-09-23 実測: 2 行）。
  「ニューメキシコ州」に寄せると `ニューメキシコ` の中に `メキシコ` が残って
  検索側でも同じ誤りが再発するので、**翻訳せず公式表記のまま**置く規則を入れた
  （州名から国を推測して検索語に足すこともしない）。カタカナで引けるよう
  `ニューメキシコ` → `new mexico` の別表記だけ別側に加える。
- **別表記の国名が英語のまま残る**状態を直した（`PLACE_TERMS_JA` / `PLACE_COUNTRY_CODES_JA`）。
  `Mérida, México`（アクセント付きは語として登録されていても当たらなかった）、
  `Willemstad, Curaçao`、`Antwerp, BE`（2 文字の国コード）が、それぞれ
  「メキシコ」「キュラソー」「ベルギー」で引いても 0 件で、表示も英語のままだった。
  国コードは**末尾の句に単独で出たときだけ**寄せる（会場名を食いちぎらない）。
  収録カタログで、①「メキシコ」「韓国」の当たり行の原文に本当にその国の語が
  書かれていること、② `BE` 表記の行が「ベルギー」で出ること、
  ③ 寄せ結果の日本語の語にラテン文字が食い付いた表記（`パナマ City` 型）が 0 件
  であることを検査にした。
- **ランク順を体系名ではなく等級で並べるようにした**（`rankSortKey`）。一覧の比較式は
  `rankPairs[0]`（`ccf:A` のような「体系:等級」の文字列）をそのまま比べていたので、
  **体系名が等級より先に効いて** `ccf:C` の行が `core:A*` の行より前に並び、
  降順では **ccf:N（一覧に載っているが評価が付いていない）の行が先頭**に来ていた
  （2026-09-23 実測。既定画面 477 行のうち 280 行は評価なし）。
  等級を点数に直して並び、並びの規則は `Recommender.rankSortKey` を正本にした
  （**昇順はいちばん低い行＝評価の無い行から、降順はいちばん高い行＝A* から**出る。
  数値列と同じ約束）。複数の評価を持つ行は最良の等級→次の等級の順。未知の等級は
  「評価あり」側として `N` の下・評価なしの上に置く（知らない等級を「評価なし」と混ぜない）。
  選択欄の等級順も同じ正本（`rankGradeOrderJa()`）から取るようにした
  （選択肢だけ違う順序になる状態を防ぐ）。
- **「南米」「中米」で引けるようにした**（`CONTINENT_READINGS`）。地域のかたまりは
  「中南米」しかなかく、**「南米」も「中米」も 0 件**だった（2026-09-23 実測: 「中南米」は
  95 行当たるのに「南米」0 行・「中米」0 行）。南米の会議を見ようとする人は「南米」と書く。
  南米 56 行・中米 39 行が引けるようになり、「中南米」は両方の包含として保った（検査で見る）。
  構成員は**収録の開催地に現れる国だけ**に置く（既存の検査 `地域まとめの構成員は、
  収録カタログの開催地に現れる` が同じ規則を見ていて、今日は ブラジル 42・メキシコ 29・
  チリ 8・コスタリカ 6・パナマ 4・コロンビア 4・アルゼンチン 2 行の 7 か国。
  ペルー・ウルグアイ・グアテマラなどは未収録なので足さず、収録された日に検査が
  「足す案内」になる）。
  同じ見直しで **メキシコを「北米」にも入れた**（北米 935 → 964 行。3 分けた北米の慣行で、
  「北米」で引いた人にメキシコ開催 29 行が黙って落ちるほうが困る。`アメリカ` と打った人には
  出さない）。地域の語は**一方向のまま**（国名を打っても地域語へ展開しない）で、
  ブラジルの行がヨーロッパに混ざらないことを収録カタログの検査で確認している。
- **かなで打った地名が、漢字で打ったときと同じ行に届くようにした**（展開の1ホップ合成）。
  漢字見出しは英文字表記の寄せ（`東京` ↔ `tokyo`）を持つが、かな見出し（`とうきょう`）は
  漢字見出しへ寄せるだけで、その寄せを受け継いでいなかった。開催地の公式表記は
  そのまま残す設計なので、**漢字で出てかなで出ない**行が黙って生まれた（2026-09-23 実測で
  漢字に及ばない読みが9あった: `とうきょう` 1 件（漢字 28 件）`きょうと` 2 件（同 18 件）
  `なら` 0 件（同 4 件）`おきなわ` 3 件（同 5 件）ほか `ぎふ` `ふくい` `おおさか` `ふくおか`
  `ながさき`）。かな見出しの展開に漢字見出しの寄せを1ホップだけ合成し、9件とも漢字と同数の
  行に届くようになった（`とうきょう` の展開は `[とうきょう, 東京, tokyo]`）。
  1 ホップに限定するのは連鎖展開で組が膨らみ続けるのを防ぐためで、全文スキャンは
  3,234 行で 13 ms のまま（変更前と同じ）。検査は読み表の条目ごとに「漢字で出る行を
  かなでも出す」ことを収録カタログで見る。寄せ先が他の語へ漏れていないこと
  （`なら` が奈良以外の行を拾わない）も同じ検査で見る。
- **早め絞り込みのボタンは、押した条件だけを出し入れする切り替えにした**。変更前は
  押すたびに検索語・締切種別・推定まで初期値へ戻し、点灯も「他の条件がすべて空で、
  その条件だけが掛かっているとき」だけだった（2026-09-23 実測: `スパコン` と打ってから
  「オンライン参加可」を押すと検索語が消えて 15 件（`スパコン` とは無関係な
  オンライン会議）が並び、押したはずのボタンは点かない。混乱してもう一度押すと、
  また全件に戻る）。ボタンが守るべきは (1) 入力したものを消さない (2) 押されていることが
  見える (3) もう一度押して取り消せる の3つ。出し入れの規則は recommender の
  `presetNextSelection` / `presetIsActive` に置き（一覧の点灯と押下後の状態が
  ズレないようにする）、一覧の点灯は他の条件を見ない。
  条件をまとめて外す操作は 0 件案内の「条件をまとめて外す」が担うので、
  ボタン側に初期値戻しの役は残さない。検査はビルド後の成果物で、検索語を消して
  いないこと・点灯が状態を見ていること・ボタン名と条件表がズレていないこと
  （押しても黙って効かないボタンと、二度押しで戻らないボタンを落とす）を見る。
- **海外の開催都市をカタカナで引けるようにした**（`PLACE_QUERY_ALIASES_JA` に 50 語）。
  海外の出張先はカタカナで覚えるのが普通なのに、収録カタログの開催地 426 種（英文字表記）を
  数えると、**収録 5 行以上なのに日本語表記の表に無い都市が 123 種**あった
  （`Lille` `Tucson` `Jeju` `Macau` `Bangalore` `Strasbourg` `Aachen` `Ghent` など。
  2026-09-23 実測。`マカオ` は表にあってもつづりが `macao` で、収録の `Macau` に
  届いていなかった）。追加した語で、重複を除いて **324 行**（既定画面では 56 行）が
  カタカナ入力でもたどれるようになった。1 行も増やさない条目は置いていない（同じ検査を通す）。
  検査は**収録カタログ側**から見る。収録 5 行以上の都市に、その都市のつづりを含む表の条目が
  あり、その語でその行に届くこと — 都市が増えて表が追いついていない日に落ちる。
  ただし当初の検査は弱かった（`Anaheim, California` が「カリフォルニア」でカバーされて
  緑になった）。語を打って当たった行を覚えるのではなく、**条目のつづりが都市語に現れるか**
  を見る形に直し、その検査で `アナハイム` `ハンティントンビーチ` の漏れが出ている
  （2026-09-23）。
  `ワシントン` は `Washington, DC` だけでなく `Bellevue, Washington`（州）や
  `Washington University ...` にも当たる。`バリ` はインドネシアの島とイタリアのバーリに
  寄せる（日本語で区別する書き方が無い）。いずれも開催地に国・州が併記されるので、
  当たった行で見分けられると判断した。
- **チェックボックスの語「国内研究会」を複合語のまま引ける**（`domesticFacetSearchTerms`）。
  行の名前には「研究会」としか書かれず、「国内」はタグ側の情報なので複合語では当たらず、
  **`国内研究会` は 0 件** だった（同じ行はチェックボックスでは出た。2026-09-23 実測）。
  domestic-jp の行のうち名前に応じて `国内研究会` `国内シンポジウム` `国内ワークショップ`
  を検索用文字列に入れる（24 行。既定画面では 16 行で、チェックボックスの 29 行のうち
  研究会と名前につく行だけを指す — 語はその行に本当に当てはまるときだけ入れる規則）。
  名前にない語を入れないことも検査する。
- **締切種別は「〜締切」を付けた言い方で引ける**。選択肢に出る語と「締切」の複合で打つ人が
  多く、`アブストラクト締切` `抄録締切` `要旨締切` `全文締切` はいずれも 0 件だった
  （`概要締切` 660 件 / `論文締切` 1,971 件はある）。同義語表に複合語をたし、単語で引いたときと
  同じ行集合になることを収録カタログで見た。広げることは件数欄に出す
  （「「アブストラクト締切」は種別「概要締切」で探しています」）。
- **常時受付の行で 2 つの名前が見えていた**。種別セル・CSV・詳細・てびきは `常時受付`
  （`KIND_LABEL_JA`）なのに、日時セルとドロワーの一部だけ `随時受付` と書いていた
  （行の中で別のものだと誤解させる）。表示を `常時受付` に統一し、ほかのサイトで
  `随時受付` と書く人に合わせて同義語だけ残した（`随時受付` → 種別「常時受付」）。
  一覧・CSV に古い語が残っていないことはビルド後の成果物で検査する。
- **チェックボックスの語は検索の語にもなる**（`ONLINE_PARTICIPATION_LABEL_JA`）。
  `国内` を hay に入れるのと同じ流儀で、オンライン参加可の行の検索用文字列に
  `オンライン参加可` を入れる。これで「オンライン参加可」「オンライン参加」「参加可」
  いずれの入力でも、チェックボックスと同じ 15 行が引ける（収録 117 行。判定は
  `placeOffersOnline` 1本なので、チェックと検索で出る行がズレることはない）。
  `ハイブリッド` は同義語表から参加形式の語へ寄せる（語の途中ではなく語として当たる）。
  広げることは件数欄に出す: 「「ハイブリッド」は参加形式「オンライン参加可」で探しています」。
  寄せ先の語が画面に出る語であることを、検査（分野の言い方の検査）で保証する
  —— 参加形式の語も表示語の対応表として検査側に読み込ませている。
- **地方名で引くと、開催市だけ書かれた国内行も出る**（`PREFECTURE_CITIES_JA`）。
  国内の国際会議の開催地は上流どおりの英字表記（`Tokyo, Japan`）で、**都道府県が書かれない**
  （2026-09-23 実測: 日本開催 72 行のうち都道府県を含む行は 0）。地方名を都道府県に展開する
  だけでは取りこぼしていて、`東京` は 28 件当たるのに `関東` は 1 件だった。各県の開催市
  （英文字つづり + `PLACE_QUERY_ALIASES_JA` から引く日本語表記）も同じ組に入れるようにした。
  実測（収録 / うち日本開催）: `関東` 1→**34**（33）、`関西` 4→28（24）、`中部` 8→17（9）、
  `九州` 0→9（9: 福岡・長崎・沖縄を含む）、`北陸` は `石川`・`福井` の行が入って 8 件。
  沖縄は総務省区分に合わせて `九州` の成員に入れた（`沖縄` 単独でも従来どおり引ける）。
  展開は一方向のまま（`東京` を打った人の当たり方を関東全体に広げない）。
  広げた先は件数欄に「「関東」は地方の都道府県と開催市（茨城・栃木 など 12 か所の表記）で
  探しています」と出す — 説明の語列表は検索語の展開と**同じ関数**から作るので、
  片方だけ直して説明が実態とズレることはない。
  あわせて、収録カタログの日本開催行に実際のつづりで現れる都市のうち、日本語で打つと
  0 件だったものを `PLACE_QUERY_ALIASES_JA` に追加した（`金沢` 0→2、`福井` 0→3、`長崎` 0→2、
  `筑波` 0→1、`宮古島` 0→1、`岐阜` 3→5）。
  実行検査: 収録カタログで都市→地方の対応を検査側に言い直しておき、その地方の語で
  その行が引けること（漏れ 0 件）と、表に 1 件も当たらない都市を置いていないことを見た。
  全文スキャンは 12→14 ms（3,234 行。地方名は語の数が 12〜13 に増えるため）。
- **画面に出る状態の語は、検索でも引ける**（`statusBadgeWords`）。締切セルの `推定` バッジと
  CSV の状態欄は同じ語を書いていたのに、検索用の文字列（hay）に入れていなかったため、
  **「推定」と打つと推定行 134 件が 1 件も引けなかった**（2026-09-23 実測。`再確認待ち`
  `要確認` も同じ経路。この 2 つは現時点の収録で 0 行だが、出た日に検索できる）。
  バッジ語を 1 つの関数にまとめ、CSV・検索・画面で同じ語を使うようにした。
  「推定」で当たる行は推定バッジの行と**完全一致**し、推定でない行の誤爆は 0 件
  （収録カタログで検査）。推定行は開催地がまだ空なので、開催地との複合検索では出ない
  （てびきに書く）。
  既定では推定行は一覧から落ちたままなので、件数欄の内訳を
  「推定 N 件（『推定締切を含める』で出ます）」に直し、出し方（どのチェックをオンにするか）を同じ行に書いた。
- **日付を数字だけの表記で打てる**（`calendarDateGroups`）。表の行には暦日の日本語形が
  年あり・年なしの両方で入っている（`2026年8月22日 8月22日`）ので、`2026-12-25`
  `2026/12/25` `12/25` `12-25` `12.25` `2026-12` を同じ組に入れる。変更前は**すべて 0 件**
  だった（2026-09-23 実測）。暦日そのものへの解決なので件数欄の説明は出さない
  （`明日`・`今週` のように現在時刻に依存する語だけがおしらせの対象）。
  **年を打った人はその年限定**と見る（年なしの暦日を足さない）。年なしで足すと
  `2026-8-22` が 14 件当たってうち 4 件が別年だった（実測）。暦日にありえない数字
  （`13/45` `2026-13` `0/12`）は展開せず、そのままの部分一致に残す — 会議名や号数の
  数字の取り合わせを別物に解釈して当たり方を狭めるほうが害が大きい。
  実行検査: 検査用カタログで実際に締切のある日を選び、`M/D`・`M-D`・`Y/M/D`・`Y-M` が
  それぞれ `M月D日`・`Y年M月D日`・`Y年M月` と**同じ行集合**になることを見た。
- **開催地は地域のかたまりで引ける**（`CONTINENT_READINGS`）。`ヨーロッパ` `欧州` `アジア`
  `北米` `中南米` `中東` `アフリカ` `オセアニア` `欧米` を打つと、画面の開催地に現れる
  日本語の国名（`placeJa` の結果）のかたまりに展開する。変更前は **すべて 0 件** だった
  （`アフリカ` だけ 6 件）。実測（収録 3,234 行 / 既定画面 477 行）:
  `ヨーロッパ` 0→**収録 993・画面 117**、`北米` 0→935・106、`アジア` 0→523・77、
  `オセアニア` 0→128・4、`中南米` 0→95・12、`中東` 0→43・5、`アフリカ` 6→38・13。
  展開は**一方向だけ**（`イタリア` と打った人の当たり方を欧州全体に広げない）。境界の判断は
  コメントに書いた: `アジア` に日本は入れない（国内は `国内`・`日本` で引く）、`トルコ` は
  `中東` のみ、キプロスは `ヨーロッパ`、`北米` は米加（メキシコは `中南米`）、`欧米` は
  欧州＋北米（豪州は入れない）、アルメニアはどちらも入れない。広げたことは件数欄に
  「「ヨーロッパ」は地域まとめ（イタリア・ドイツ など 29 か所の表記）で探しています」と出す。
  構成員は収録カタログの開催地に現れる語だけ（`data/snapshot.json` で検査する）。
  `米国` `アメリカ` には**州表記の行**も入れた（上流は `San Diego, CA` のように国名を
  書かないことがあり、実測で `米国` だけ 135 行少なかった → 778 行に揃った）。
- **英字の語は語境界で当てる**（`foldedLetterAtWordBoundary`）。語の途中の一致をそのまま
  使うと誤爆する。実測（2026-09-23）:
  - `N` は 3,234 行中 3,219 行、`sc` は 342 行（"science" の一部まで拾っていた）→ 1〜2 文字は前後の境界を見る（従来）。
  - `米国` が **収録 18 行を誤って**当てていた（`evomusart` に `usa`、`usage` に `usa`、
    `latin american` に `america`。パナマ 3 行・ドイツ 1 行・IEICE 特集号など）→
    **開催地として置く語（国名・都市名・地域まとめの構成員）は語全体**で当たったときだけ使う。
    修正後は誤り 0 件（`data/snapshot.json` で確認）。
  - それ以外の英字語（主題の寄せなど）は**語頭だけ**見る。`crypto`→cryptography、
    `robot`→robotics は今までどおり当たる。これにより `視覚`→vision を置けるようになった
    （語の途中当たりでは 258 行に誤爆していたが、語頭照合で 248 行になり、当たり例は
    すべて computer vision / machine vision 系だった。`視覚` は収録 3→248 件）。
  代价は全文スキャン 11→12 ms（3,234 行）で、1 打鍵の応答に影響する規模ではない。
- **主題のことばも、日本語の表記で英文字の会議名に届く**（`TOPIC_QUERY_ALIASES_JA`）。
  分野ラベル（`セキュリティ` など）とは別に、会議名そのものに主題が英文字で書かれている行が
  多い（`Applied Cryptography and Network Security`）。変更前の実測（収録カタログ 3,234 行 /
  既定画面 477 行）: `暗号` は収録 4 件・画面 0 件だったのが、いまは **収録 118 件・画面 11 件**。
  他に `信号` 0→43 件、`ロボット` 5→97 件（画面 3→32 件）、`画像` 0→24 件、`量子` 1→6 件。
  広げたことは件数欄に「「暗号」は英語で書かれた会議名（crypto など）も探しています」と出す
  （分野・主題の寄せ説明が既に出ている語では二重になるので出さない）。
  **新しい行を増やさない条目は置かない**（実測で追加 0 件だった `機械学習`→machine learning、
  `データベース`→database、`札幌`→sapporo、`シンガポール`→singapore は削った。分野ラベルや
  開催地の日本語表記が同じ行を拾えていたため）。実測で 4〜258 行に現れる語だけを上げ、
  `自動運転` `省電力` `仮想化` `安全` など収録に現れない語は置いていない。
- **`new Function` に渡すハーネスのソースは `vmSafeSource` を通す**。Node 26 は `-e` のソースを
  ESM かどうか機械的に判定し、配列のリテラルに `"crypto"` が 1 語で含まれていると
  **モジュール扱いになってトップレベルの `const`/`var` が `new Function` の本体から見えなく**
  なる（症状は `ReferenceError: Recommender is not defined`。`cryptography` `xcrypto` は無事で
  `crypto` だけ該当した。2026-09-23 に実発生）。実行時に同じ文字列になる
  `"cr\u0079pto"` へ書き換えて回避する（正本の `site/recommender.ts` はそのまま）。
- **英文字のアクセント記号は検索の正規化で落とす**（`searchNormalize`）。収録される開催地は
  現地つづりで、実測 118 行がアクセント付き英文字を含む（`Montréal` `Malmö` `Kraków`
  `Florianópolis` など）。NFKC だけでは分解されないため NFD にして合成記号を落とす。
  **NFD を掛けるのは英文字に限る**（`LATIN_DIACRITIC_CHARS`）。日本語へ掛けた実装では
  `パ` が `ハ` + 半濁点（U+309A）に分解され、件数欄の寄せ説明が「見た目は同じなのに違う
  文字列」になった（実発生。`スパコン` → `スハコン`）。`ł` `ø` `ß` などは置換表で寄せる
  （`kraków` を `krakw` に壊さない）。検索の全スキャンは 3,234 行で 9.6 ms → 11 ms。
  表示（開催地セル・一覧）は公式表記のまま。
- **「締切まで N 日以内」の窓で外れた件数を件数欄に出す**。窓は選択欄で一番効きが大きいのに、
  「のぞく」の内訳は過去の締切・種別・推定しか言わなかった。実測（2026-08-09、対象=投稿締切・
  未来・非推定の 477 行）: **7 日以内 39 件／301 件が 30 日超**という形で、
  7 日以内なら **438 行**が黙って消える（30 日以内 301 行、90 日以内 97 行、180 日以内 10 行）。
  「今週は収録が薄い」と誤解して検索が止まるので、上限側（`isAfter`）と下限側（`windowFloorMs`、
  「過去の締切も表示」と併用したときの対称窓）を同じ `hiddenCounts.window` に数え、
  件数欄に選択欄の表記そのままの「「締切まで 7 日以内」を超える N 件」を出す。
  てびきには戻し方（選択欄を「かまわない」にする）と実測の数字を書く。
  計数は他の内訳と同じく**検索語で絞る前**の母集団で行う（「N 件 / 全 M 件」の差の説明だから）。
- **「オンライン参加可のみ」で出ない理由は 2 通りに分けて数える**。この絞り込みは会場表記の
  記述だけで動く（対面を断定しない方針は §7 のとおり）。実測で既定画面 477 行のうち条件に
  書くのは **15 行だけ**で、のぞく 462 件のうち **110 行は開催地自体が未確認**だった。
  「オンライン参加を認めていない会議」と誤解されると検索が止まるので、`hiddenCounts.online` と
  `hiddenCounts.onlinePlaceUnknown` を別々に数え、件数欄に
  「オンライン参加の記載がない N 件（うち開催地が未確認 M 件）」を出す。
  チェックボックスの `title` にも「記述が無い行は対面だと判定していません」と確認先を書く。
  判定そのものは `Recommender.placeOffersOnline` に一本化していて、UI 側に表記規則を写さない。
- **「国内研究会・国内シンポジウムのみ」は主催の区分であって、日本の開催ではない**ことを画面で
  伝える。チェックしたままだと `Tokyo, 日本` と書かれた行が黙って消える（実測: 既定画面
  477 行のうち **448 行が落ち、そのうち 11 行は日本開催**）。`domestic-jp` タグの意味を変える
  のではなく（CCF-A の東京開催を「国内研究会」に混ぜるのは誤り）、次の 3 手で伝えた。
  1. 絞り込みでのぞいた件数を `hiddenCounts.domestic` として数え、件数欄に
     「のぞく: 国内研究会・国内シンポジウム以外 N 件」を出す（他の内訳と同じ欄に寄せる）。
  2. チェックボックスの `title` に「日本の開催かどうかは関係ありません。…検索に『東京』
     『日本』などと打ってください」を出す（てびきは畳めるのであてにしない）。
  3. てびきの「国内」でも **日本の開催かどうかとは別物** と戻し方を書く。
  日本開催の会議をまとめて引く経路は §7 の開催地別表記（`東京`→tokyo など）が担う。
- **てびきは画面に出ている操作を網羅する**。検索・種別・ランク・締切まで・国内・オンライン・
  推定・過去・データ更新に加えて、画面の操作なのに説明の無かった **過去の締切も表示** と
  **CSV** を補った。CSV は「表示中＝絞り込み後の全行」「残りは数値（過ぎた分は負）」「BOM 付き」
  を書かないと、中身を開けるまで分からない。検査は `<dt>` の実在と、実装と矛盾する説明を
  持たないことを見る。
- **同じ締切時刻の行は、表に出る会議名 → 種別の順で並べる**（`compareDeadlineRows`）。
  そのままではデータ源の順で並ぶため、同じ日の内側がバラバラになる。既定画面 477 行のうち
  **303 行が別の行と同じ締切時刻**を持ち（同値グループは最大 17 行）、影響は大きい。
  種別の並びは**種別セレクトに並べる順（`SELECTABLE_KINDS`）と共通**にする（`kindSortIndex`。
  書き写すとセレクトと表で順がズレる）。ランク順・会議名順のタイにも同じ補助比較を使う。
  - **並び順に使う文字列は、セルに実際に出る語と共通化する**（`conferenceNameCell`）。
    以前は SORT が素の `conf.title`、セルは `titleWithYear(title || key, year)` を使っており、
    タイトル欠落の行（表示は `ieice-nolta-2027` のような語）が空文字で先頭に集まる原因だった。
  - **`localeCompare` のロケールを `"ja"` に固定する**。ロケールを省略すると閲覧者の UI
    ロケールで順序が変わる（実測: 「航空宇宙研究会」「情報処理研究会」の前後が en/de と ja で
    入れ替わり、`zh-u-co-pinyin` では全く別の順になった）。`"ja"` は漢字を読みの五十音順に
    並べる（実測で 航空(か) → 情報(ざ) → 電子(た)）。ただし読み辞書を持たないので
    **カタカナ語は漢字語より前の段**に出る（異スクリプト間の段差は越えられない。検査で
    仕様として固定する）。
  - コストは既定画面のソートで 0.19 ms / 477 行（実測）。入力の debounce とは別に、
    行ごとの語分解を行側でやらない方針は変えない。
  - 日付のみ（時刻不明）の行は 175 件あり、JST 00:00 相当として同じ日内では先に並ぶ。
- **暦日でも引ける**（`dayTermsJa`）。「明日の締切」「8月10日」は月より細かく言う形で、
  変更前は hay に暦日が無く（ISO 暦日を含む行は既定画面 477 行中 12 行）、`8月10日` も
  「明日」「今週」も 1 件も当たらなかった。締切（JST の暦日）から `2026年8月10日 8月10日` を
  hay に足す。**会期は締切ではないので足さない**（表は締切で並び「締切まで」で絞る）。
  暦日の読み出しは月語と共有する（`calendarDateJa`。瞬間は JST の暦日、`YYYY-MM-DD` は
  タイムゾーンに依存せず暦日として読む、暦月繰り越しは語を作らない — いずれも月語と同じ検査）。
- **相対日・相対週でも引ける**（`RELATIVE_DAY_OFFSETS_JA` / `RELATIVE_WEEK_OFFSETS_JA`）。
  `今日 / 本日 / 明日 / 明後日 / 昨日` はその日の暦日語へ、`今週 / 来週 / 先週` は
  **月曜始まりの 7 暦日**へクエリ側で展開する。実測（既定画面 477 行、検証時計 2026-08-09 は
  JST 日曜）で `来週` 0 件 → **48 件**（= 8/10〜8/16 の和集合と一致。週の外の日を交えないこと、
  週 7 日の和集合と行集合が等しいことを実カタログで検査する）。`今週` は 0 件で、これは
  週明け月曜からの締切が無いだけ（嘘の説明は出さない）。
  - 週の語は 7 暦日の **OR** なので、文字列展開では作れない（語同士は AND なので、
    スペースで並べた時点で 0 件になる）。`queryTokenGroups` の 1 グループとして返す。
  - 解決結果は件数欄に書く（`明日 = 2026年8月10日(月)` /
    `来週 = 2026年8月10日(月)〜8月16日(日)`）。黙って条件が変わったように見せない
    （相対月 `来月 = 2026年10月` と同じ方針）。年をまたぐ週は両側に年を書く。
  - 週の照合は 1 語あたり 7〜8 候補の OR になるため、全走査は 9.6 ms → 約 43 ms / 3234 行
    （実測）。入力 debounce（180 ms）内に収まるので許容するが、語ごとの分解を行側で
    作らない方針は変えない。
- **月でも引ける**（`monthTermsJa`）。締切（JST の暦日）と会期の開始・終了から
  `2026年12月 12月` の形の語を検索用テキストへ足す。国際会議の `date_text` は
  `June 7-11, 2027` のような英語表記なので `6月` では当たらず、ISO 暦日から作る必要がある。
  瞬間から月を引くときは一覧の日時列と同じく JST の暦日で読み、`YYYY-MM-DD` は
  ビルド・閲覧者のタイムゾーンに依存せずそのまま暦日として読む。暦月繰り越し
  （`2026-02-30`）は月語を作らない（`weekdayJaFromDate` と同じ検査）。
- **かな表記と土地名でも引ける**。比較の直前に `kanaFold` でカタカナをひらがなへ畳み、
  長音符と小文字の差を落とす（`ネットワーク` = `ねっとわーく`）。`hay` 自体は表示にも使うので
  変えず、照合のときだけ畳む。土地名は `PLACE_READINGS`（47 都道府県）と `REGION_READINGS`
  （地方 9 区分）で検索語を展開する（`おきなわ` → 沖縄、`しこく` → 徳島/香川/愛媛/高知）。
  展開は語ごとに OR の候補を増やすだけなので、誤りが既存のヒットを消すことはない。
  読み辞書は都道府県と地方に限定する（一般語の読み辞書は誤爆が高く作らない）。
  「中国」は国名と衝突するため素では展開せず、`ちゅうごくちほう` だけが地方への展開になる。
- **0 件のときは「条件をまとめて外す」を同じ場所に出す**: 外せる条件を並べて書くだけでは、
  利用者にひとつずつチェックを外させることになる。`filtersClearable` が「いま外せる条件が
  残っているか」だけを判定してボタンを出し、検索語・分野・ランク・国内のみ・期間を初期値へ
  戻す。一覧の意味を変える「過去の締切も表示」（過去行の読み込みを伴う）はまとめて外す側に
  含めず、文章での案内に留める。説明文は専用の span へ書く（`#empty` の `textContent` を
  直接書き換えると中に置いたボタンが消える）。
- 一覧の絞り込みは `Recommender.searchMatcher(query)` で**照合関数を 1 描画に 1 回**作る。
  `hayMatches(hay, query)` は薄い入口（`searchMatcher(query)(hay)`）で、行ごとに検索語を
  分解し直すため、3234 行で 1 打鍵あたり約 83 ms（うち約 69 ms が分解）かかった。作り直すと
  約 8 ms。検索語の分解を行ごとにやらない、という形はビルド後の `app.js` を見るガードで固定する
  （`searchMatcher(searchQuery)` を使い `hayMatches(r.hay, searchQuery)` を呼ばないこと）。
- 検索の照合は `site/recommender.ts` の `searchNormalize` / `queryTokens` / `hayMatches` を単一正典と
  する。照合前に **NFKC 正規化・小文字化・空白圧縮**を施す（日本語入力では全角の会議名
  「ＮＳＤＩ」や全角スペース区切りが打たれるため）。検索語は空白で語に割し、**全語が
  行の `hay` に含まれるときだけ一致**（AND）とみなす。語順と間に挟まった文字は問わない。
  一覧側は `r.hay.indexOf(q)` を直呼びしない。`hay` を作る側も同じ正規化を通す。
- **長い和語は分割照合も試す**（`compoundSplitHit` / `COMPOUND_MIN_LENGTH_JA = 7`）。
  語そのものが無いときだけ、2 文字以上二つに割った両方が含まれるかを見る。中黒で割れた
  表記（`オペレーティング・システム`）や、主題語が別々に並ぶ行に当てるため。短い語で
  短い語でやると別々の語の取り合わせで何でも当たるので、7 文字以上かつ日本語文字だけに限る。
  行ごとに全分割案を試すと遅い（検索は 1 文字ごとに全行を見る）ので、語の先頭 2 文字と
  末尾 2 文字を含むことを必要条件に先に落とす。
- 検索語の**両端の句読点だけ**落としてから照合する（`QUERY_EDGE_PUNCTUATION`）。
  `upcoming.md` の種別列は「種別: ラベル」の形なので、表をそのまま貼られた語で引けるように
  するため。語の一部である記号（`C++`）は落とさない。記号は列挙し、文字クラスで広く削らない。
- **表示している語で検索できる**ことを保証する。種別の日本語表記は `site/recommender.ts` の
  `KIND_LABEL_JA` / `kindLabelJa()` が正典で、`src/build.ts` の `KIND_LABEL_JA` とサイトの
  `KIND_LABEL` はどちらもそこから表を受け取る（二重実装にしない）。`hay` には種別の日本語も
  入れる。実測で「論文締切」「概要締切」「登録締切」が 0 件だったことが根本原因。
  検査は `upcoming.md` の種別列に実際に載る語を全文字、検索で引けることで見る。
- 地方名（九州・関西・東北など）は**漢字見出しでも都道府県へ展開**する（`REGION_READINGS`）。
  漢字そのものは会場文字列に書かれないため、「九州」で別府（大分県）の会場に当たらないと
  使えない。市名は会場文字列にそのまま出るのでkana読みだけの従来どおりにする。
- 主題タグ（`tags`）も検索語に入れる。対応表 `TAG_LABELS_JA` は**実データに現れるタグだけ**を
  載せ（`machine-learning` → 機械学習、`niche` → 穴場、`storage` → ストレージ）、存在しない語を
  翻訳して作らない。区切り（半角スペース / ハイフン / アンダースコア）は吸収して引く。
  `domestic-jp` などの構造タグは詳細ドロワーの「主題」には出さない。
- 表の下に「見方のてびき」を `<details>`（既定は折り畳み）で置き、JST/AoE・時刻未確認・推定・
  再確認待ち・国内・ランク・データ更新の意味をその場で説明する。推薦モードでは非表示にする。
- 表は**日時順（昇順）で見ているときだけ月で区切る**。月見出し行（`.month-row`）は
  JST の年月で `2026年10月（N 件）` の形を出す（表示が JST なので区切りも JST で決める）。
  一致度順・ランク順・会議名順・逆順・推薦モードでは区切らない（月が往復して読めなくなるため）。
  常時受付ジャーナルと日時未確定の行は月を持たない。月見出し行は選択対象にしない
  （選択・詳細・キーボード移動は `.detail-row` と `.month-row` を数えない）。
- 絞り込み: 分野 / 締切種別 / ランク / フリーテキスト / 推定の表示切替 / 締切までの窓。
  絞り込み状態は URL のクエリに反映する（`replaceState` で履歴を汚さない）。
- **「締切まで」の窓**（`site/app.ts` の `WIN_OPTIONS` が正本で、値は `all`・`7d`・`30d`・
  `90d`・`180d`）。選択肢の文言は「かまわない / 7 日以内 / …」で、**「直近 7 日」とは書かない** —
  過去 7 日とも読める（この表は締切日からの日数で絞る）。見出しも「期間」より「締切まで」が
  正しい。選択肢に無い値を URL で通すと、その URL を開いた人のセレクトが空欄になる
  （選択肢に無い値を `select.value` に代入すると表示が消える）ので、`readUrl` の受け付け値は
  `WIN_OPTIONS` を使う。かつて `future` を通していたが、過去行を落とさない
  **何もしない値**だったので受け付けをやめた（選択肢に増やしたくなるが、中身が無い）。
  窓の上限時刻は `windowLimitMs` の 1 箇所で持つ — 絞り込みと 0 件時の会期案内が別の式を
  書くと、表と案内が違う窓で動く。プリセットボタンは**その状態そのもの**のときだけ点灯させる
  （国内に `online` の条件を忘れる、国内＋オンラインの画面で片方だけ押された表示になる）。
- **サイト表は投稿締切のみ表示する。** サイトの表は投稿締切（`abstract`・`paper`。
  論文モードのみ常時受付ジャーナル `journal`）だけを描き、
  開催・採否通知・カメラレディ等の行は出さない（種別の絞り込みにも含めない）。
  開催日だけを持つ会議（ISC High Performance・HOTI・情報処理学会 HPC 研究会・
  P4 Workshop・Netdev・LPC など）がサイト表から消えるのは仕様であり、利用者は
  `upcoming.md`（§4）で開催日を追う。
  開催行の過去判定（終了日 + 1 日）と残り日数の表示規則は §4 に定める。
  推定版には開催日を持たせないので、開催行が推定になることはない。
- 一覧には確認済みでない締切の警告だけを表示し、確認済みの根拠本文や変更履歴は詳細画面に限定する。
  詳細画面では確認元、確認範囲、状態、次回確認予定、根拠本文の抜粋を表示し、未確認の値を確認済みと表示しない。
- 過去の締切は既定で非表示、トグルで表示。トグルを締切モードで有効にしたときだけ
  `catalog.json.history_ref` の全履歴を遅延取得し、既定の並びは締切が近い順。
- ライト/ダーク両対応（`prefers-color-scheme`）。表は `overflow-x: auto` の中でだけ
  横スクロールし、body は横スクロールさせない。狭い画面（640px 以下）ではカード表示に落とす。
  カード化したら **デスクトップ用の `table { min-width: 880px }` を解除する**（`min-width: 0` と
  `.tablewrap` の枠・スクロールの解除）。解除を忘れるとカード自体が 880px に広がり、
  1 行読むのに横スワイプが要る。解除規則はデスクトップ規則より**後ろ**に置く
  （セレクタの特異性が同じで、前に書くと後書きが勝つ）。カード化の列名は `td()` が付ける
  `data-label` を使う。ブラウザで描画確認ができないため、検査は CSS をルール単位に割って
  幅 400px / 1200px での解決結果（`min-width` と `overflow-x`）を見る形にする。
- 日本語 UI。ラテン文字の英単語を不必要に混ぜない
  （「フィルタ」ではなく「絞り込み」、「デッドライン」ではなく「締切」）。
  狭い画面ではキーボード ショートカットの案内を消し、タップで詳細が見られることだけを残す。
- JS から組み立てる inline style は CSS 変数を `var(--name)` で参照する。
  `let(--name)` のように不正な関数にすると宣言ごと破棄され、
  「公式サイトを開く」のように `color: #fff` と組み合わせた要素が白抜きの invisible になる
  （実障害として発生。`tests/build_golden.test.ts` が `let(--` の混入を阻止する）。
- 1000 件規模でも操作が引っかからないこと。コア UI に依存ライブラリは置かない
  （推薦の任意 CDN は上の例外）。

---

## 8. テスト（`tests/`）

実装を読まずに本仕様だけから書く。

- `timezone.test.ts`: `resolveTz` の実在値 19 + 12 種すべて。`AoE` = UTC-12。
  `UTC-08` と `UTC-8` が同じ。IANA 名。**`PT` が夏と冬で異なるオフセットになること**。
  不明値では UTC を代替値として使うこと。
- `parse.test.ts`: `parseInstant` の AoE→UTC 変換
  （`2026-04-08 23:59:00 AoE` → `2026-04-09T11:59:00Z`）。`TBD` が null。
  `parseDateRange` の月跨ぎ・年跨ぎ・略記月・`Sept.`・en dash・単日。
  上流 rankings の自由文字列変換（`rankOf`）。
- `kind.test.ts`: §3.3 の表の全 20 行。特に **`deadline` → `paper`**、
  `supplementary` が `paper` に潰れないこと、`rebuttal_start` と `rebuttal_end` が別物であること。
- `keys.test.ts`: sub 分割後も同じ key を共有する会議が 0 件であること
  （上流に新しい衝突が入ったら落ちる）。`aliases` が cross-source 名寄せを行うこと。
- `merge.test.ts`: 同一版に同じ kind の締切が複数あっても消えないこと
  （notification 3 本、submission 4 本のケース）。round の保持。overrides 適用。
  rollforward が未来版のある会議に推定を足さないこと。
  §3.6「締切の重複統合」の 3 事象（源間の丸め違い・上流内の同日ラウンド重複・
  源間の round 表現差）がそれぞれ 1 件に畳まれること。
  NSDI 型の数か月離れたラウンドと、許容幅の外側（3601 秒差）が畳まれないこと。
  締切も開催日も持たない会議が `select` で落ちること。
- `snapshot.test.ts`: build の最後に `data.json` → `snapshot.json` のコピーで
  情報が落ちないこと。全データ源が失敗したとき snapshot から復旧すること。
- `build_golden.test.ts`: 小さな固定入力から `--now` 固定でビルドし、
  ファイル一式が生成されること・JSON スキーマが §4.1 どおりであること。
  推定値が `estimated` フラグで確定値と区別されること。
  サイト表は投稿締切のみ（`index.html has no meeting rows`）。締切を持たない会議
  （ISC High Performance・HOTI・情報処理学会 HPC 研究会）の開催日は
  `upcoming.md` に出し、index.html の表には開催行を出さない。
  サイト UI の回帰もここで押さえる: 日時列の JST 主表記（`TZ` を変えても同一出力・曜日付き）、
  JS 組み立て inline style への `let(--` 混入阻止、検索語に含まれる分野の日本語名と「国内」、
  「見方のてびき」と「日時（JST）」ヘッダーの存在。

`tests/fixtures/` に上流 YAML の**縮小版**を置く（ネットワーク不要）。
実物から次のエッジケースを含む代表を抜く:
nsdi（複数ラウンド）、sc（AoE）、sigcomm（abstract あり）、
ica3pp（**edition_id が全版で同一**）、fse（**別会議で id 重複**）、
neurips（hf 新形式）、cvpr（**新旧形式併存 + supplementary**）、
aaai（**rebuttal_start と rebuttal_end が別日**）、hf 旧形式 1 本、
`abstract deadline`（空白キー）1 本、date 自由文の月跨ぎ、`TBD` を含む 1 本。

---

- **recommender に共有部品を 1 本足すと、関数を名前で抜き出す検査ハーネスはそれを知らない**
  （第 256 回 `shorterHitTipsJa`・第 257 回 `searchGroups`・第 258 回の畳み込み保持で 3 度実発生）。
  `tests/built_golden_shared.ts` の `FILTER_RUNTIME_STUBS` は関数名の列をビルド成果物から抜いて
  並べ、`new Function` の本体にするので、抜いた関数が知らない語を呼んでいると、動かした時に落ちて音が出る。
  選び方は 2 つ – **(a) 自己完結の 1 関数に収める**（畳み込みの保持は関数自身の側に置いた）、
  **(b) 注入リストに同じ変更で足す**（`searchGroups` はこれで直した）。
  壊れ方は `ReferenceError: X is not defined` と音が出る（黙って古い形を組むよりマシ）。
  気をつけたいのは改ざん検査の読み方で、**ビルドが壊れた実行は検査が 1 本も落ちない** –
  「落ちていない」と読まずにビルドの成否を別に見る（第 258 回で実際に間違えた）。

- **ビルド済み画面のスタイルを読み取って数える検査は、`@media print` を落とす**（実発生は §7 のコントラストの項に書いた回）。
  紙用に薄い色（`background: #eee !important` 等）へ差し替える規則が並んでいて、そのまま
  総当たりすると画面では起こらない不合格が出る。括弧の対応で塊ごと落としてから数える。
- **ファイルを直す道具は「読む → 組み立てる → 最後に書く」**（同じ回で実発生）。
  `io.open(path, "w").write(s.replace(anchor, clean(new)))` は、`io.open(..., "w")` が
  引数の評価より先に走るため、`clean()`（外国語の混入検査）が失敗してもファイルは空になる。
  一時ファイルに書いて `os.replace` で戻す形にしておく（この正本自体を一度失いかけた）。

- **ゲートの表示を `head` で端折ると、検査のエラーが視界から消える**（第 263 回で実発生）。
  `npm run check` の総称を 3 行で切っていたら「Found 1 error」が 4 行目に出ていて、
  「0 エラー」と読み間違えていた。総称（Checked / errors / warnings / infos）は端折らずに出す。
- **`biome.json` は厳密な JSON として読む**（第 263 回で実発生）。`files.includes` の配列の中に
  説明のコメントを書いた途端に設定が効かなくなり、見に行く対象が `.venv/` まで広がって
  127 件の赤になった。コメントは消して設定は最小にし、理由はこの文書側に書く。
- **改ざんが効いていないように見えるときは、改ざんの側を先に疑う**（第 263 回の実発生）。
  `A ? x : value && real` と差し替えた差し込みは、`&&` が後者を返すので何も変えていなかった。
  差し込み後に差分が目で見える形（文字列が実際に変わるか）を確認してから結果を信用する。
- **速さを壁時計で比べる検査は、同じ機械の並列実行で落ちる**（第 258 回の検査が第 263 回の
  連続実行で落ちた：初回 4.6 ms / 2 回目 6.2 ms）。速さの主張は働き方の構造で検める形に作り直す（§7 の畳み込みの項で作り直した）。

- **外国語の漏れ検査は「追加分だけ」に掛ける**（第 264 回の実発生）。組み立てた文書全体に
  語一覧を突き合わせると、はるか前に書いた項（上流の綴りの話をした箇所）が引っかかって、
  直していない箇所を直そうとしてしまう。検査するのは自分の書いた断片だけにする。

- **抜き出した関数は、ハーネスの中で宣言するだけでは走らない**（第 265 回の実発生）。
  `new Function` の本体に関数の中身を貼って終わりだと、呼んでいないのでどんな実装でも通る。
  抜き出し検査は必ず末尾で呼び出す（`syncTableScroll();`）。
- **後始末の見張りは、前状態を持った要素で始める**（第 265 回の実発生）。からっぽの要素で
  「越えていないとき」を真似ると消す物が無く、`removeAttribute` を消しても検査が通った。
  狭い窓から広い窓へ戻した場面（`attrs` に `tabindex` 等が残っている）を真似る。
- **同じ id が 2 個有る差し込みを通していた**（第 265 回の実発生）。「外に有る」ことだけを見ると、
  外に残したまま中にも置く形で素通りする。表示の場は `id` の個数も同時に数える。

- **ICS の項目名を属性ごと読むと、検査が黙って空振りする**（第 266 回の実発生）。
  `DTSTART;VALUE=DATE:20261005` を最初の `:` の手前までを名前にすると `DTSTART;VALUE=DATE` に
  なり、`ev.DTSTART` は常に `undefined`。「項目が無い」検査は `undefined` を弾くはずが、
  組み立て側の実装が正しくても通る形になっていた。名前は `;` で切る。
- **表のヘッダと本文で列の分け方を変えると、隣の欄の値が正解になった**（第 266 回の実発生）。
  `upcoming.md` の種別欄を見張る検査で、ヘッダだけ `split("|")`（先頭に空要素が残る）で分け、
  本文は先頭のパイプを落としてから分けた。列の番号が 1 ずれ、`ラウンド` の `R1` `R2` が
  「種別」として一致していた。同じ関数で分ける。
- **にせのレコードは本物の形に揃えないと、はじかれた原因が見えなくなる**（第 266 回の実発生）。
  収録の締切は `precision: "date-only"` を持つ（`isDateOnlyDeadline` はそれを見る）。にせ物に
  `local_date` だけ渡すと瞬間の締切の枝に入り、黙って 0 件になった。
- **整形を挟んだ後に文字列一致で探すと当たらない**（第 266 回、3 度の実発生）。
  `npx biome check --write` のあとは改行位置が変わる。断片まるごと一致ではなく、
  行の一意な語で位置を決めて直す（外れたら書き込まない順守で、誤適用は起きなかった）。

- **前の回に自分が書いた「数の一致」の見張りが、次の回の直しを止めた**（第 267 回の実発生）。
  第 266 回は `llms.txt` について「`deadlines.ics` という語が 1 回だけ出る」で縛っていた。
  今回、`index.html` の説明に同じファイル名を載せただけでその見張りが落ち、直しまで止まった。
  要求は「別名のカレンダーのファイルが索引なしに増えない」ことで、**名前の種類**で比べるべきだった。
  同じ語が説明文に何度出るのは自由なので、文字出現数で要求を書かない。
- **1 ベース / 0 ベースの足し算で位置を外すと、何も書き込まれない**（第 267 回の実発生）。
  断片まるごと一致が整形で外れたのに続き、行番号の計算でも外れた。外れたら書き込まない順守は
  効いているので誤適用は起きないが、往復が無駄になる。位置は一意な語で決め、置き換えは
  下の行から順に適用する。

- **ビルド成果物から関数を抜き出すとき、`async` が落ちて構文エラーになった**（第 268 回の実発生）。
  `tests/runtime_extract.ts` の `jsFunction` は `function 名前(` から探していたので、
  `async function` の修飾語を落として本体だけ連れ出し、`await` を持つ同期関数になって
  `new Function` が「await は async 関数の中でだけ」と言った。修飾語も一緒に連れてくるよう
  直し、見つからないときに例外を投げるようにした（黙って空の本体を返すと検査が空振りする）。
  同じ理由で、**関数が参照している語（`ICS_FILE_NAME` など）も正本から注入する**（第 265 回の
  教訓の続き – にせ物に書き写すとズレ、抜くと `ReferenceError`）。
- **`#icsCopy` を文字列で探すと `#icsCopyNote` にも当たった**（第 268 回の実発生）。
  印刷用の規則から片方を消した改ざんが黙って通った。語の区切りまで見る（`\b` を付ける）。
- **自分の編集手順で、値の差し込みの括弧と正規表現のバックスラッシュが落ちた**（第 268 回の実発生）。
  経由の多重エスケープで、テンプレートリテラルの中身と正規表現のバックスラッシュが落ちた。
  型検査（`npm run typecheck`）で検出した – 編集の直後に型検査を回す手順が効いた。
  今後の手順: 検査の本体は整形を挟まず直接書き、エスケープを多重にしない。

- **自分の変更で落ちた見張りは、意図と実装を分けて直す**（第 269 回の実発生）。
  `tests/build_golden.test.ts` は「広い画面（1200 px）で `.tablewrap` が `overflow-x: auto`」を
  見ていた。意図は「表が潰れないこと」で、`auto` その物は「横に越える幅で続きに辿れる」ことの
  手段にすぎない。見出しの粘着とは両立しないので、**はみ出す幅（900 px）で `auto` を見る**形に
  変え、幅その物は新検査が「越えない幅だけ粘らせる」として、必要な幅の数の合わせ込みで見るようにした。
  期待値を無条件に書き換えず、理由を §7 に残す。
- **属性を付けた瞬間に `<p>` ぴったりの正規表現が別な文を拾って空振りした**（第 269 回の実発生）。
  第 267 回に自分が書いた見張りが `/<p>([\s\S]*?)<\/p>/` で先頭の案内の文を探していて、
  `id="top"` を付けた瞬間に**リンクの無い注記**を拾って「案内のリンクが 0 本」で落ちた。
  位置（`<main>` の直後の文）で決める形に直した。
- **行数は生成時刻で動く前提を、固定時計の数字で縛らない**（第 269 回の実発生）。同じ表が共有ハーネスの
  時計で 592 行、固定時計（2026-08-09）で 1,127 行。前提としては「画面 1 画面ぶん（40 行）を
  大きく越える」で見る。
- **ある語が本文に有るか無いかの判定は、スタイルシートにも出る**（第 269 回の実発生）。
  `data-sort` は静的な一覧のマークアップには無いが、同じページに埋め込まれた共有スタイルの中に
  出てくるので、ページ全体の文字列検索では「有る」になってしまう。見出しの形その物を見る。
- **CRLF のファイルは `newline=""` なしで読むと行数ぶん減る**（第 269 回の実測:
  `deadlines.ics` が 463,452 B → 451,702 B）。改行コードその物を比べる測定では必ず無変換で読む。

- **「欄の名前が索引に有るか」だけでは、説明が空欄の欄を通す**（第 270 回の改ざんで実発生）。
  `llms.txt` の列辞書は `- 名前：説明` の並びなので、`- kind_ja：` の後ろが空でも
  名前の検索は通ってしまった。説明側をリネームする改ざんが落ちなかったので、
  「名前の後ろに 1 文字以上有る」まで見る形に直した。同じ節を最後まで読んでいたため、
  次の節の語を拾って通す可能性もあったので、節の区切りで切ることも同時にやった。
- **`|` で始まる行を無条件に拾うと、同じ文書の中の別な表を拾う**（第 270 回の実発生）。
  `upcoming.md` から種別欄を読む検査で、縮約カタログのビルドだと別表の「R1」「R2」「-」が
  混ざった。見出しに目的の欄を持つ表だけを選び、その行が連なる分だけ読む形に直した
  （共有ハーネスの `upcomingRows` も同じ読み方をしていて、そちらは表が 1 枚の前提だった）。
- **ビルド後は関数名が付け替わることがある**（第 270 回の実測: `kindLabelTable` という名が
  `recommender.js` に 1 度も無く、検査が空振りした）。成果物から語彙を引きに来たときは、
  関数を抜き出すのではなく、成果物に実際に含まれる日本語の文字列その物を正しく使う
  （`japaneseStringLiterals`）。
- **公開成果物の値を変えたら、その成果物の契約文も同じ変更に入れる**（第 270 回の実発生）。
  `llms.txt` は `data.csv` について「日本語の値は書かない」と宣言したままだった。
  実装だけ直して契約文を放置すると、索引が噓をつき続ける。例外は理由込みで書けば、
  次の人が「日本語の欄をもう 1 本足す」ときに気づける。

- **案内の語を確かめるとき、ガイド全体で探すと空振りする**（第 271 回の改ざんで実発生）。
  「締切まで 7 日以内」を早め絞り込みの項目から消しても、別の項目の例文
  （件数欄に出る文の例「「締切まで 7 日以内」を超える N 件」）が語を含んでいて、検査が通ってしまった。
  項目（`<dt>` と、それに続いている `<dd>`）単位で見る helper を置いて、そこにあることを見る形にした。
- **改ざん検査のバックアップは「変更を適用した後」の状態で撮る**（第 271 回の実発生）。
  適用前で撮っておくと、差し替え対象が見つからず「手当てできない」とスキップされる上に、
  検査後の復元で**その変更その物が消える**（実際にてびきの 2 か所が飛び、復活させるはめになった）。
- **案内に語を足す前は、他の項目が既に言っていないか確かめる**（第 271 回の実発生）。
  クイック抽出のボタン名を追記しかけたが、「早め絞り込みのボタン」の項目が 5 つとも名乗っていた。
  同じ語を 2 か所に持たない方針は、実装だけでなく案内にも当たる。
- **成果物どうしの言い回しの一致は、組み立て方を明示して見る**（第 271 回の実測）。
  HTML 側は同じ正本に矢印を足すので、完全一致では通らない。マークダウンのリンク文言で HTML 側を
  探して「その語で終わっている」ことを見る形にした（片方だけ言い換えると落ちる）。

- **画面に 2 つある物に対して、検査が 1 つの代用を作っていた**（第 272 回の実発生）。
  `built_golden_2.test.ts` の `$ = () => more` は id を見なかったので、「すべて表示」を書いた
  文言が「さらに表示」の検査に写った。画面に同種の口を増やすとき、代用の作り方も直す必要がある。
- **ビルド後は `if (条件)` と `break;` が別の行に組み直される**（第 272 回の実測）。
  ビルド成果物に対して 1 行で書いた形の正規表現を当てると、直前の改ざんが通ってしまう。
  成果物を見る検査は組み直しを許した形（`\s*` など）で書く。
- **ループの止め方を `break;` の有無で確かめると空振りする**（第 272 回の改ざんで実発生）。
  同じ関数内の別の理由の `break;` が残って通った。進捗を測って抜ける形その物を見る。
- **抜き出した関数を動かす検査は、呼び先も自分で入れる**（第 272 回の実発生）。`updateMoreButton` が
  `showAllButtonLabel` を呼ぶようにしたら、依存を入れていなかった検査が `ReferenceError` で落ちた。
  関数を単独で抜く方針では、呼び先は常に並べて入れる（第 212 回と同じ教訓の再発）。

- **抜き出した関数の呼び先は、渡し方まで直さないと直ったことにならない**（第 273 回の実発生）。
  行の選び方を `dataRows` にまとめたら既存の検査 4 本が `ReferenceError` で落ちた。
  ①共有 helper（`keydownWithBlockers`）に入れる ②`return (関数)` の**式**として評価している
  検査は、宣言を並べるだけでは構文エラー（`new Function('return (' + SRC + ')')()` で式にする）
  ③仮引数に足した位置と**実引数の並び**がズレると、無関係な stub が渡って別の変な落ち方をする
  （`safeExternalUrl` の位置に `dataRows` が入った）。実行時に呼び先を足したら、渡している
  場所を全部数えて直す（同じ helper の趣旨は第 135 回から有った）。
- **検査の代用が、画面と同じ規則を持っているとは限らない**（第 273 回の改ざんで実発生）。
  カードの代用に `tabIndex: -1` を与えておくと、実装が `last.tabIndex = -1` を消しても
  検査は通る（空振り）。ブラウザでは `tabIndex` を読まないでも -1 が見えるが、フォーカスを
  受け取れるかどうかは `tabindex` **属性の有無**で決まる。代用は属性への代入として作り直した。
- **てびきの表記と実装のキーの対応を見る検査も、抜き出した関数を実行していた**（第 273 回の実発生）。
  文字列検査だと思っていた検査が 3 か所目だった。実行しているハーネスは名前から分からないので、
  `jsFunction` を呼んでいる箇所を `grep` で数えて当てる。

- **HTML の注釈のなかに実物のタグを書くと、重複検査が化ける**（第 274 回の実発生）。
  本文欄の見出しを足したとき、注釈に本文欄のタグ名を書いたら、既存の
  「本文欄が重複している」検査が 2 件数えて落ちた。ブラウザには無害でも、このサイトの
  見張りは HTML 文字列を数えている。注釈には実物のタグを書かない。
- **「画面に出さない規則が有るか」だけを見ると、クラスを外す改ざんが通る**（第 274 回の改ざんで実発生）。
  CSS に `only-sr` の規則が残っていても、見出しからクラスを外せば画面に出てしまう。
  規則の有無と、それを使っている側の両方を見る。
- **見出しの語が画面にあるか調べるとき、そのままの文字列で数えると空振りする**（第 274 回の実測）。
  見出しは組み立てなので、HTML には別々の場所に分散して書かれている。語に分けてから数が無いか見た。

- **説明文に語が一度出ていれば通る検査は、挙げだけの変更をすかした**（第 275 回の改ざんで実発生）。
  「AoE の説明の行を消す」改ざんが落ちなかった。先頭の案内文が `AoE` を語として挙げていて、
  「未確認」も「時刻未確認」の一部として現れるため、語の有無だけでは説明の有無を測れない。
  定義の形（「◯◯」は、）で見る。
- **正本に関数を足したら、ビルド成果物から組み立てているスタブを全部追う**（第 275 回の実発生）。
  `Recommender.unconfirmedMeaningJa()` を呼び側で読み始めたとき、既存の印刷凡例の検査が
  `… is not a function` で落ちた。ビルドした `recommender.js` から本物の語を借りる形の
  スタブなので、同じ流儀で 2 行を足して戻した（検査に語を書き写さない約束は守る）。
- **「書き写しが無い」はビルド成果物側の文字列本数で測る**（第 275 回の実測）。意味の一文を正本に寄せても、
  呼び側が同じ文を持っていれば成果物に 2 個並ぶ。ビルドした `app.js` の中にその文が 0 本であることを
  見て、組み立てだけになっていることを確かめた。

- **打ち消しの正規表現を 1 本にまとめると、本文まで消して「見出しが 0 個」と誤測した**（第 276 回の実測）。
  ビルド成果物の表や見出しを数えるとき、`<style>…</style>` と `<script>…</script>` を
  `<(script|style)\b[\s\S]*?</\1>` 一本で消したら、index.html の `<h1>` と `<main>` まで
  消えて 0 件と出た。規則を分けて個別に消したら 1 件 / 1 件に戻った。網羅で数える検査ほど、
  数える前の除去規則の空振りが測定結果その物を壊す。
- **表の説明文は、既にある見出しと列見出しから組み立てる**（第 276 回の実測）。同じ語を説明の側に
  書き写すと、列を足したとき・見出しの語を変えたときに、支援技術へ読む説明が事実と
  違う物になる。出所を 1 個に寄せておけば、ズレはビルドで自動で直る。

- **「語が一度出ていれば良い」検査は、同じ教訓を 2 回目で再び破っていた**（第 277 回の改ざんで実発生）。
  第 275 回に「AoE の説明を消す改ざんが、挙げだけの文があるため落ちなかった」のに通った。
  「該当なし」の項目から「 kamiyobi が公式で裏を取れていないだけの印」という向こう側の意味を
  消す改ざんも、同じ項目の中に「未確認」という語が残るので通った。説明の項目は、
  **その語が何を意味し、隣の語とどう違うか**まで見る（第 275 回の「定義の形」と同じ型）。
- **ハーネスの `site` は `beforeAll` が入れる**ので、検査ファイルの先頭で読むと `undefined`
  （2026-09-24 に実発生: `The "path" argument must be of type string`）。ビルド成果物を読む
  検査は、読む関数を検査の中から呼ぶ。

- **改ざんが通った理由が、検査ではなく改ざんの置き場所だった**（第 278 回の実測）。
  「狭い画面でだけ字を縮める規則を足す」改ざんが最初は落ちたつもりで通った。規則を元の規則の
  **前**に置くと同じ強さでは後勝ちになるので、画面では縮まない（CSS として正しい）。同じ規則を
  **後ろ**に置き直して初めて検査が落ちた（390px で 9.92px）。検査が弱いと断定する前に、
  改ざんが実際に勝つ位置に有るか確かめる。
- **文字サイズの検査は `effectiveCss` で幅を渡す**（`tests/built_golden_shared.ts` の
  `cssBlocks` は `@media` の中に降り、`cssMediaApplies` が幅で当たる／外れるを判定する）。
  `font-size` を直接正規表現で拾うと、後から効く `@media (max-width: …)` の縮小を黙って見逃す
  （第 278 回）。

- **「変更を当てる前に取った複製」で戻すと、当てた変更が消える**（第 279 回の実発生）。
  改ざん検査用の複製を、静的 HTML へ `</th>` を足す**前**に取った。検査の末尾は「複製と一致すれば
  戻せた」と判定するので、直した筈のファイルが黙って HEAD の状態へ戻り、`git diff` は空に
  なった。気づいたのは `grep -c "</th>"` が 3 のままだったから。複製は**変更を当てた後に**取り、
  戻した後は直した内容がそこに有ることを別の手で確かめる（`git diff --stat` が空になった事も
  気づきの材料になる – 「何も変えていない」は検査が通ることと違う）。
- **自分の検査の見立てが 2 本間違っていた**（第 279 回の実測）: `aria-sort` は押せる 5 列だけに出る
  （7 個ではない）/ 行の列数を数える検査は、`<th>` だけの見出しの行を別の扱いにしないと
  見出しの行を「0 列」として掴む。実測で直した（両方とも落ち方を見て本当の形へ合わせた）。

- **「語が一度出ていれば良い」検査を、3 回目にまた書いた**（第 280 回の実測）。
  内訳の名前をてびきと突き合わせる検査で、語の存在だけを見ると、語を残して**意味の括弧だけを
  消す**改ざんが通った（第 275 回・第 277 回と同じ型）。`名前</strong>（意味）` という
  **組み立ての形その物**を見てから落ちた。語の有無で合格を止めず、語の周りを見る。
- **否定すべき所を肯定で置き換える改ざんには、否定形を見る**（第 280 回の実測）。「一致スコア（点）を
  足して作った物ではありません」を「一致スコアとは別に決めています」へ変える改ざんが通った。
  後ろに残る「昔は足した数字を並べていて…」の文が距離 24 字以内に入ってしまい、
  「足」の語の有無では止められなかった。`足を?して … ではありません` のように**否定の形**を見る。

- **検査に渡すスクリプトの正規表現は、文字数ではなく実効で確かめる**（第 281 回の実測）。
  ビルド後の JS を動かす検査で、文字列リテラルの中に書いた正規表現を 4 重にエスケープして
  しまい、実行時には「円記号 + 文字」という別の意味になっていた（数字を数える規則が黙って
  空振り）。検査は通り続けるので、**改ざんを当てて落ちて初めて**気づけた。文字列へ嵌め込む
  正規表現は、改ざんで必ず検出できる形にしておく（この回の見張りはそれが出来た）。
- **関数が目印を通っていないと、見張りが空振りする**（第 281 回の実測）: 盾の関数 `placeTermJa` を
  調べたくて `placeJa("new mexico, USA")` を探りに使ったが、`placeJa` は末尾の句だけを書くので
  盾は一度も通らなかった（改ざんが通った）。`placeJa` は「/」で割った各句の末尾カンマより後ろ
  だけを書き換える（「Panama City, Panama」を壊さないため）– 探りは `都市名, 盾の語` の形に
  直して落ちて、はじめて検査が実データをなぞるようになった。

- **テキストモードで読むと、改行の形が化けて測れない**（第 282 回の実測）。
  配信物の改行が CRLF か確かめようとして、スクリプト側を既定のテキストモードで読んだ。
  読んだ側が CRLF を LF に直してしまい、「LF しかない（RFC 違反）」という**実際には違う**結果に
  なった。実測はバイトで読む（`errors` の指定よりも前に、改行の変換が効く）– 直すと
  CRLF 11,750 箇所・LF だけ 0 で、そこは正しかった。誤った結論で変更を作らずに済んだのは、
  書く側のコードを読んでから確かめたから。
- **検査に埋め込む正規表現は、書き直しの時に崩れやすい**（第 282 回の実測）: 文字列の中で 1 段
  エスケープが増える所を誤ると、読み込み自体が失敗して「Tests no tests」になる（今回の
  失敗は大きい音を下げてくれた）。一方で、たまたま別の語に当たって**弱く通る**検査もあった
  （URL が切れていない検査が `\n` を掴んで落ちた）。検査は実データで落とし方を見てから決める。

- **ハーネスに渡す JavaScript の書き方を、別の言語の癖で間違えると失敗の音が小さい**（第 283 回の実測）。
  正規表現の合致から本体を取り出す所を `m.group(0)` と書いた（別の言語ではそれが正しい）。
  型検査が 3 件で捕えたので迷わなかったが、**「検査が全部落ちる」形になったのは幸い**だった
  （1 本だけ落ちる形だと、直したのかと誤解する）。`Tests no tests` の時と同じで、
  失敗の音が検査の失效より大きいとは限らない。
- **空振りを防ぐ件数は、ページごとに一律に置けない**（第 283 回の実測）: 「JST を含む括弧が
  1 件以上」という条件は `health.md` が 0 件で正当に落ちた。欠陥ではなく、そのファイルが
  単位を書かないだけ。総量で見る検査と、ファイルごとに見る検査を分ける。

- **CSS の注記は成果物にそのまま載り、検査が数える物を汚した**（第 284 回の実測）:
  行ヘッダーの注記にタグの字面を書いたままにすると、`upcoming.html` のマスを数える検査が
  +2 で落ちた（注記は `<style>` ごとビルド後のページに入る）。注記にタグの字面を書かない、
  というのが安い直し方だった。
- **改ざん検査の「失敗本数」を、`Tests` の直後の数字で読んでいた**（第 284 回の実測）:
  対照群（注記の語だけ変える）の行は `Tests 73 passed (73)` で、直後の 73 を失敗と読んで、
  注記 1 語で 73 本が落ちるという無かった欠陥が立った。`failed` の語がある時だけ数える
  ようにした。音を読む側が壊れていると、直した物まで疑う（第 283 回の「音が小さい」とは
  逆方向の壊れ方）。

- **入れ物を割ると、その入れ物を「最初の閉じタグまで」で読んでいた検査が静かに細くなる**
  （第 285 回の実測）: てびきの `dl` を 9 つに割った瞬間、`id="helpPanel"` から最初の
  `</dl>` までで取り出していた 9 本の検査が、先頭の 4 語しか見えなくなって落ちた
  （「てびきに『会期のみ・締切未定』が無い」という筋違いの音で）。容器を割る作業には
  「読む側を閉じ element まで伸ばす」がセットで要る。
- **見出しの語を検査する規則が、空白で割っていて日本語を見られなかった**（第 285 回の実測）:
  「締切の日時と残り」を 1 語と数えるので、画面に無い造語でも通らないし、既存の語を
  並べただけの物も通らない（`expected 1 to be greater than 1`）。区切りを「・」にも広げ、
  見出しは既存の語の列挙にすると決めた。言語に合わない区切りでの検査は、強いのか弱いのか
  分からない状態になる。

- **ビルドのソースの字面を見た検査は、折り返しだけで化ける**（第 286 回の実測）:
  「ビルドが `upcoming.html` を出さなくなったらリンクが死ぬ」検査は `write("upcoming.html"` を
  そのまま探していたので、引数を 1 つ増やして折り返しただけで「ビルドが出さなくなった」事に
  なった。空白を跨ぐ正規表現（`write\(\s*"upcoming\.html"`）に直した。ソースの字面検査は
  折り返し・整形に弱いと心得る。
- **`Content-Security-Policy` を `name` と `property` から探して「規則が無い」と読んだ**
  （第 286 回の実測）: CSP は `http-equiv` に載る。指定子の違いで「有るのに無い」と読むと、
  直したあとも落ち続けて原因を別と誤解する。属性の載り方を変えて良い物は、読み方も一緒に
  広げる（この検査を作ったときに、有る前提で音を出させておかなかった）。

- **但し書きが「換算はよそが早い」と書いている行は、よそへ行けない読み方で読まれる**
  （第 287 回の実測）: 同じ表でも画面は JST 主表記、静的な一覧は公式表記のみ、という分担を
  ずっと置いていた。印刷・貼り込み・JavaScript なしで開く面では、画面の利点が一切効かない。
  「よそに同じ情報がある」は、その面に居る人には無いのと同じ。
- **正本文（SPEC）の例が実出力から取り残されていた**（第 287 回に気づいた）: 生成時刻の
  「（JST では 2026-08-09(日) 09:00 JST）」という例は、第 283 回で単位を言い直したとき
  実出力からは落ちたのに SPEC に残っていた。実出力を写している例は、直した回で一緒に
  流し直す（古い例を読むと、実装が古い形に戻ったと誤解する）。
- **検査の閾値は「検査用ビルドの実測」で決める**（第 287 回で実測）: 同じ検査を `repo/.cache` 付きの
  生成で走らせると行数が約 2 倍（1,126 行 / 検査用 591 行、AoE・UTC 表記 524 行 / 224 行）。
  手元のビルドの数字を閾値にすると検査用で落ち、緩い固定値にすると空振りする。
  両方の実測をコメントに書く。

- **突合の鍵は表示名ではなく「意味の同一性」で選ぶ**（第 288 回で実測）: `deadlines.ics` の
  `LOCATION` を `upcoming.md` の開催地欄と付き合わせる時、会議名を鍵にすると 16 件の噓の
  不一致が出た（別々の会議が同じ表示名に見える – 「会議名：種別」から種別を落とした形での
  衝突）。`URL` を鍵にすると不一致は 0 件になった。表示名は人間が見る値で、照合の鍵ではない。
- **「その欄は必ずこの形」という前提は、国内の行で崩れる**（第 288 回で実測）: 開催地に
  「カンマが入るはず」と書いた検査が `倉敷市芸文館 岡山県`・`北海道大学／オンライン` で落ちた。
  形の依存ではなく（転義を戻したら語が壊れない・カンマの後ろに空白が来る・国名が日本語に
  揃っている）という構造的な不変条件に直す。
- **変更の波及は「成果物ごとの差分の個数」で示す**（第 288 回で実測）: 前回のビルドと比較して
  変化したファイルを数えると、`deadlines.ics` とハッシュを持つ 4 個だけで、画面・静的一覧・
  CSV・JSON が 1 バイトも同じことが 1 行で示せる。費用の申告より強い証拠になる。

- **同じ数を 2 か所で数えない**（第 289 回で実測）: 「カレンダーに 928 件入ります」という申告と、
  実際に 928 個入っているかは、別々に数えた瞬間にズレる。値は配信物の行から一度だけ導き、
  説明欄・品書・画面の注記がそれを読む形にした。品書だけ 7 件多く言う改ざんは
  「`{ event_count: 437 }` to deeply equal `{ event_count: 430 }`」で落ちた。
- **受け口を増やすとき、位置のずれる引数に `unknown` は置けない**（第 289 回で実測）:
  使い道の無い仮の引き数を 1 つ挟んだら、次の位置に渡す値が 1 つ前へ入り、品書の申告は `null` に
  なっていた。型が広いので型検査は通り、ビルドも通る – 追加した口は **実データで値を見る**
  まで検査を増やしたことにはならない。
- **成果物に差し込む関数は、呼び出し口を全部見る**（第 289 回で実測）: `toCatalog` は
  `catalog.json` と `index.html` 埋め込みの 2 か所で呼ばれていた。後に足した申告を片方にだけ
  渡すと、配信物の説明には出ていて画面には出ない、という一段のズレが起きる。

- **「既定」が約束していることを、既定の場所で言う**（第 290 回で実測）: 「かまわない」は既定の
  選択で、てびきも「期限なく先」と書いていた。データが 180 日で切れているなら、その事は
  選択欄の語ではなく、**一覧のうしろに件数と一緒に**出す – 利用者が損をするのは一覧を見た時で、
  選択欄を見た時ではない。
- **品書の外を読む入口を 1 箇所に決めたつもりでも、条件は 5 か所に写っていた**（第 290 回で実測）:
  初期化・条件適用・モード切替・状態同期・状態欄の語。判断を関数に寄せてから全か所をそこに
  繋がないと、「ボタンで読んだのに件数欄は黙っている」型のズレが出る。
- **画面に置く語は、実測の値から作る**（第 290 回で実測）: 「一番遠い締切は 2027-02-04」を
  定数で書くと、翌月のビルドで噓になる。行から JST の暦日で数える関数にして、
  改ざん（協定世界時で数える）が落ちるようにした。

- **機械向けの索引ほど、範囲の数字を言う**（第 291 回で実測）: 人は「この先いつまでの締切が
  出せるか」を機械に訊き、機械は索引だけを見て答える。「現在・近日期間」という語は、
  180 日先で切れている事実を 1 つも運ばない。件数と両端の暦日を、そのビルドの成果物から数えて
  書く – 定数を書いた瞬間に、次のビルドの噓になる（改ざんで実測: 「510 件」のところに
  「約 3,000 件」を置くと検査が落ちた）。
- **画面・カレンダー・索引の三つが同じ日を指すには、暦日の目盛りを 1 箇所に寄せる**
  （第 291 回で実測）: `utc` をそのまま数えると JST の 09:00 より前の締切が前日に見え、
  索引だけが カレンダーより 1 日早い範囲を言い出す。
- **索引は「次に読む物」まで書く**（第 291 回で実測）: 品書の行に `data.json` への道と画面の入口の語を
  書いたことで、索引だけで「無い」ではなく「こっちに在る」まで答えられるようになった。

- **「収録に無い」と言い切ってよいのは、画面が持つ名簿を全部見たあと**（第 294 回で実測）。
  0 件の案内は行の一覧だけを見て「収録データにも見当たりません」と書いていたが、品書には
  会議の名簿（687 件）が行とは別に載っていて、そのうち 248 件は締切行を 1 本も持たない –
  名前で引いた人に「無い」と言い続けていた。「数えられる名单がもう一枚在らないか」を、0 件の
  文言を見るたびに確認する。
- **押し先を勧めるとき、そこに何が出てよいかを画面が知らないことがある**（第 294 回で実測）。
  名簿に在る会議の案内で「収録の全体を読み込む」へ送るとき、248 件のうち 74 件は収録の側にも
  締切が 1 本も無い – 6 MB 強を読ませても 1 件も増えない人が混じる。品書にその情報が無い今は
  「同じ語を引き直します」とだけ言い、出る約束をしていない。ボタンを送る文は、必ず「押したあと
  に何が起きるか」の形で書く。
- **「締切一覧」と名乗る成果物の中でも、載る日は締切とは限らない**（第 299 回で実測）。
  カレンダーの 928 件のうち 167 件は採否通知・査読結果公開・反論期間開始で、日付の欄が「締切」の
  ままだった。一覧の側では出さない種別でも、別の出口（ICS）では出て行く – 出口ごとに
  「何を載せるか」を決め事として持つより、「その日を何と呼ぶか」を種別の正本から引くようにした
  方が、出口が増えても噓が増えない。
- **改ざん検査は、走らせるテストの範囲が狭いと空振りする**（第 299 回で実測）。改ざん 38 種の
   検査バッテリーは 1 テストファイルだけ走らせていて、今回は新しい検査が別ファイルに在るため 5 種の
  うち 4 種が「捕まらない」ことになった（検査の欠陥ではなく、検査の置き場所の欠陥）。改ざんの
  対象を変えるときは、バッテリーが両方のテストファイルを走らせているかを確認する。
- **てびきの本文に、開発側の名前をそのまま書かない**（第 299 回で実測）。「品書」のような語が
  購読手順に 4 箇所も混んでいた。画面に出ない文書でも読むのは利用者なので、語の置き場所
  （画面 / てびき / コードのコメント / 内部文書）を決め事で分ける – 決め事が検査に無いと必ず混む。
- **文書に項を足す手順は、改行を足し忘れやすい**（第 299 回で実測）。錨が「行の末尾」なのに追記の
  後ろの改行を 4 回落としていて、項が繋がって読めていた（Markdown は同じ行の「- 」を項と数えない）。
  同じ手順を使い回すなら、文書の形その物を見る検査を側に置く。
- **「〜かどうか」は、決めた所で一行一値に持つ**（第 300 回で実測）。カレンダーの内訳を数えるとき、
  書き出した本文の文字列照合で数えようとして 0 件になった（`IcsRow.body` はエスケープ済みの
  `DESCRIPTION:` 行で、項目の区切りまで文字になっていた）。欄名を決めた所で行に印を置くようにしたら、
  申告・画面・索引が同じ数を言うようになった – 数え方を後から真似る箇所は、必ずズレる。
- **検査が「個数」を張っていると、正直な追記で壊れる**（第 300 回で実測）。「索引に `N 件` は 2 個まで」
  という検査は、総数と内訳という別の事実を同じ行に載せると落ちる。重複（同じ数の二度書き）を見る
  検査に置き換えた – 形式の個数より、噓になる形を縛る。
- **教訓は手順にしないと再発する**（第 300 回で実測）。第 298 回に「構文エラーの有る file へ
  biome の整形を掛けると、触っていない行の `${…}` が `$…` に化ける」と書いておきながら、同じ手順を
  踏んで 8 箇所を壊し、`git checkout` で戻した。整形の前に typecheck が 0 件であることを
  手順の先頭に置く。
- **「締切が在る」を語るとき、締切は一本ではない**（第 298 回で実測）。収録にこれからの締切が
  在る会議 42 件のうち 19 件で、画面が言っていた日（一番遠い日）より前の締切が取り残されていた。
  「何本あって、一番近いのはいつ」という形にすると、日付を一本選ぶより誤解が減る。一本の日を
  選んで出す設計は、選ぶ規則（一番近い/一番遠い/投稿締切だけ）を画面の言葉に必ず出そう。
- **ビルドで一度決めた日を、画面の現在形で言うとおかしい**（第 298 回で実測）。収録の「近い日」は
  生成時点の相対値なので、画面の時計で見れば過ぎていることがある – 過ぎたら近い日の話を消して、
  第 295 回の文に戻る形にした（推測で新しい日を足さない）。品書に日を載せるときは「生成時点の
  何からの相対か」を決め事として残す。
- **整形ツールは構文のエラー中のファイルを書き換える**（第 298 回で実測）。構文エラーの残る
  `site/app.ts` に `biome check --write` を掛けたら、触っていない箇所の変換文字列が `${record}` から
  `$record` に化けていた（第 296 回の `let` → `const` と同じ系列）。削除行を見る検査は有効だが、
  整形は typecheck が通ってから掛ける順に置き換える。
- **「締切が過ぎた」と「会議が終わった」は別の事実で、画面が前者だけ言うと人は後者を読む**
  （第 297 回で実測）。過ぎた締切しか持たない会議 174 件のうち 118 件は、これから開かる会だった。
  締切の日付を語る文のそばに、開催の日付を一行足すだけで「今年は間に合わないが来年は狙える」が
  伝わる。収録済みの別々の日付を、画面が一方しか出さずに結論づけていないかを見る。
- **行き先を塞ぐ案内を作ったら、同じデータ中に行き先が在るか探す**（第 297 回で実測）。「押しても
  1 件も増えません」で終わらせていたが、締切の無い会議が開かれる日は品書に在り、`upcoming.html` に
  出ていた（74 件のうち 31 件）。新しい項目を足さなくても直ることが多い。
- **前回の「次の候補」は、着手前に実測で潰す**（第 297 回で実測）。`2027` だけの検索が案内されないと
  書き写していたが、実ビルドの品の窓では 872 行中 374 行が 2027 を含み 0 件にならない – 案内が
  出る場面自体が無かった。持ち越しの候補は事実の断片であって、欠陥の確定ではない。
- **人が打つ語は、画面が想定した粒度と違う**（第 296 回で実測）。名前と日付をいっしょに打つのは
  自然な振る舞いなのに、案内は「打った語すべてが名前に当たる」ことを前提にしていた – 前提を
  満たさない入力を「該当なし」に落としていたことになる。語を型（名前の語 / 日付の語）に分けて
  から突き合わせると、壊れていた入力の多くが最も良い答えに変わった（`NETYS 2027` → NETYS 1 件）。
- **件数を出すとき、その数が何の総和かを書く**（第 296 回で実測）。「似た名前の会議が 35 件」は
  語それぞれに当たる物の和集合で、人が期待した数（両方に当たる物）では全くなかった。和集合を
  表示することに意味は無い – 掛け算で絞った数を出す。
- **案内を条件分岐で黙らせるとき、黙った先にある文が噓にならないかを見る**（第 296 回で実測）。
  件数 0 の打ち方で名簿の案内を黙らせると、下位の「いずれかの語を外すと増えます」が残る –
  その語を外しても 1 件も増えないのに、である。上位の案内が黙る場所では、下位の文の真偽も
  一緒に確かめる。
- **書式整形を壊れたソースに掛けない**（第 296 回で実測）。構文エラーの残る `site/app.ts` に
  `biome check --write` を掛けると、無関係な `let` 宣言 8 個を `const` に書き換えた（ parse が
  崩れているため再束縛を見失う）。`git diff` で削除行を見ると捕捉できた – 整形後は追加剧合では
  なく削除行を確認する。
- **押し先を勧める文は、そこに何が待っているかを調べてから書く**（第 295 回で実測）。
  第 294 回で「収録の側にも締切が 1 本も無い会が 248 件中 74 件在るので、出る約束をしない」で
  止めたが、正しくはそこで終わらせないことだった – 品書にその事実を載せれば、74 件には
  「押しても増えない（押す必要がない）」と、42 には「その会には 2028-03-30 の締切が在ります」と
  言える。画面が知らないから曖昧に言う、と決めた場所にこそ、ビルド側で事実を載せる余地が
  残っている。
- **画面が日付の向きを言うとき、その判定の基準はどこかを決める**（第 295 回で実測）。「過ぎた
  締切だけです」と言う文は、行の過去判定と同じ暦日の目（JST 正午）で見ないと、一覧の印と
  案内が食い違う。当日の締切を「過ぎた」と呼ばないことも検査にした。
- **案内に渡す値が欠けたときの defaults は、最も教えない形に寄せる**（第 295 回で実測）。
  向きを示す値を渡さない組み立て方をしたとき、画面は 2028-03-30 を「過ぎた締切だけで …
  過去の締切も表示をオン」と言いかけた（実測）。これから/過ぎたの二択に分ける文は、
  旗が無いときに第三の分岐（何も教えない）を持っていなければならない。
- **「外せる条件」は、効く条件だけを並べる**（第 295 回で実測）。原因を言い切った 0 件案内の
  下に「過去の締切も表示（120 件）」を並べると、人はそれを試して 0 件を見る。原因が締切行の
  無い会議その物にあるときは、条件の一覧ごと消す。
- **曖昧な例を挙げるくらいなら、件数だけを出す**（第 294 回で実測）。`CoNLL 2027` を引いた人に
  名簿の先頭 `ACM SAC 2027 - DBDM Track` を「似た名前」として挙げても、人はそれを信用しない。
  打った語すべてに当たる会議が 1 件に絞れたときだけ名前を出す。
- **名前の部分一致は、名前の途中で割る**（第 294 回で実測）。`sc` は `science` を含むので、
  そのまま部分一致させると 0 件の案内が別物の会議を「似た名前」として指名する。英数字の語は
  前後が区切りであることを要求する。
- **言語リークの検査は本文だけでなく注釈も読む**（第 294 回で実測）。注釈に「関数」の簡体字のつづりを書いて `site/app.ts` の検査が落ちた – 画面に出ない注釈でも、検査は同じ目を掛ける。
- **画面の範囲の話を、0 件の案内に繋げる**（第 293 回で実測）: 「品書の果て」を一覧の上に
  注記したつもりで、0 件になった人には「別の語で試す」を出していた。データの範囲が原因の 0 件は、
  打ち直しを勧げるほど人を遠回りにさせる – 画面のどこかで言った事実は、行く先ごとに言い直す。
- **日付の解釈は検索の実装に合わせる**（第 293 回で実測）: 一覧の検索が入力に持つ形
  （`2027年3月`・`2027-03-10`）だけを案内でも解釈した。年を言わない形に年を付けるのは締切の
  推測なので `null` にし、月末日は暦から数えた（2月31日を「その月の末尾」にしない）。
- **画面が言う数は品書の申告から読む**（第 293 回で実測）: 「180 日」を書き写していた注記は、
  `upcoming_days` を変えたビルドで画面が嘘を言い続ける形だった。知らないときは数を作らない
  （「一定の日数先」で止める）のが、でっち上げよりマシな語の粒度。

- **「絞り込みは効かない」と書いただけでは、画面の外では何も解決しない**（第 292 回で実測）:
  カレンダーの側にも分野を載せた。分布の実測は 928 件のうち 9 割以上の行が分野を持つ –
  1 件も載っていないファイルを 291 回も点検しながら、誰も数えていなかった。
- **受信側の挙動が検証できないなら、検証できる経路を必ず添える**（第 292 回で実測）:
  `CATEGORIES` を表示するカレンダーは検証できないので、同じ語を本文にも書く – 本文の語は
  どの受信側でもカレンダー内の検索に掛かる。索引にも「表示対応は検証していない」と書いた。
- **語を 2 か所で持つときは、同じ入口を呼ぶ**（第 292 回で実測）: 検査はビルドした
  `recommender.js` から分野の語一覧を取り出して照合したので、画面の訳語を変えると
  カレンダーの側がすぐに落ちる（改ざんで実測: 英表記に替えると 9 語すべてが拾えた）。

## 9. 非目標

- WikiCFP など HTML スクレイピング（壊れやすく、利得が小さい）。
- 会議の採択率・査読統計。
- ユーザ登録・購読管理。
- 上流に無い会議の締切を推測で確定値として書くこと（推定は `estimated` フラグで区別する）。
- ANCS の収録（2021 年以降開催されていない）。
- README の締切テーブル自動更新（ビルドが手書きのファイルを書き換える設計を避ける。
  README からは `public/upcoming.md` へリンクする）。

---

## 10. 論文推薦システム（`site/recommender.ts`・`src/embeddings.ts`）

論文タイトル/キーワード → 会議推薦のスコアリング。実行パスはブラウザ
（`site/template.html`）と恒久ベンチ（`npm run bench`）が同一コードを共有する。

### 10.1 スコア構成

- 語彙スコア（`breakdown`）: 会議名・分野シグナル・VENUE_PAPERS 語彙との一致。
  **画面に出す文言は実装名を使わない**（利用者は実装語を読まない）。対応は
  分野シグナル→「分野の一致」、領域タグ→「主題の一致」、カテゴリ→「分野」、
  トピック→「主題」、同分野ブースト→「同じ分野（掲載先から推定）」、
  語彙スコア→「言葉の一致スコア」、RRF→「2つの検索の順位を合わせて」、
  埋め込み検索→「意味検索」、閾値→「表示の下限」。検査はビルド後の文字列列挙に
  旧語が残っていないことを見る（コメントはビルドで消えるので、画面に出る文言だけ映る）。
- 語彙スコアは会議名、略称、スコープ、タグ、カテゴリ、代表論文のタイトル、概要、キーワードをフィールド別に計算し、
  フィールド重みと一致根拠を保持する。
  適応ブレンド `vocabWeight`（EN: 内容語数 ≤4→0.25 / ≥5→0.4、JP: 0.6）。
- 意味類似度スコア（`semanticScore`）: 埋め込み cosine。
  `public/embeddings.json`（`src/embeddings.ts` で生成、会議セット変化で自動再生成）。
- PRF（擬似関連性フィードバック）: 掲載先タグ付き論文はタグ会議の埋め込みを
  0.3 ブレンド。
  タグ付き評価の基準値は PRF なし top1 79%、PRF あり top1 97%。
- 日本語: 多言語モデルを遅延ロード。語彙重み 0.6。normKey の FILLER 除去と
  語境界一致（単複形 s? 許容）を適用。

### 10.2 恒久ベンチ（`npm run bench`）

- 本番と同じコードパスで 446 会議の合成クエリ精度を計測（EN: top1 85.2% /
  top5 96.0% / top10 98.4%、2026-08-12 時点）。`--samples` / `--failures` /
  `--topk` / `--lang jp` / `--golden-en` オプション。
- `--golden-en`: 実採択論文タイトル（`GOLDEN_EN`、DBLP 由来・n=92）で真の精度を
  測る（top1 26.1% / top5 70.7% / top10 82.6%）。スコア改変の回帰検出に使用。
- `--data-delta` はラベル付き63ケースで変更前後を比較する。Recall@1/5、MRR、
  nDCG@10 のいずれかが低下するか、期待会議が Top-5 から脱落した場合は非ゼロ終了する。
- `real-paper-dev.json` と `real-paper-heldout.json` は、プロフィールの cutoff より新しい実論文を各80件収録する。
- 両 split は9カテゴリ、英語と日本語、国際会議と国内会議、conference・workshop・journal・special issue、title-only・title+abstract・PDF抽出を含む。
- heldout の単一 venue 比率は25%以下とし、複数の妥当な投稿先を許すケースを含める。
- 実論文評価は lexical・semantic・fused の MRR、Recall@1/5/10、nDCG@10、95% bootstrap区間、層別値、abstentionを分けて報告する。
- ベンチの semantic はカタログ・クエリとも Node/fp32 で埋め込むが、本番ブラウザの
  クエリは q8 量子化（transformers.js 既定）で計算される。実測（6クエリ×664会議、
  2026-09-06）でクエリベクトル cosine(q8, fp32) = 0.9896〜0.9952、top5 集合一致
  93.3%・top10 88.3%・top1 完全一致 3/6。融合が rank-based RRF のため実害は小さいが、
  ベンチ数値は本番精度の点推定ではなく回帰検出の基準として扱う（#711）。
- candidate retrieval は lexical・semantic・union の Recall@50 と oracle reranker Recall@5 を分けて報告する。
  required 実測では候補深度 50 / 100 / 200 / 全件を比較し、Union Recall@K が
  Union Recall@all - 0.01 以上となる最小 K を実運用の既定深度とする。
  現行の実測では dev・heldout ともに K=200 がこの条件を満たす。
- 軽量線形 reranker は本番と同一の固定 feature schema から full dev (`real-paper-dev`) のみで
  L2 pairwise logistic を学習し、受理 venue の連結成分を保った greedy 5-fold 分割で係数・blend を選択して
  Platt 校正と confidence threshold を学習する。required-dev（短縮検査用 subset）を学習に使ってはならない。
  `data/recommender-reranker.json` は training/input hash、CV、校正、閾値根拠を持ち、heldout は評価にだけ使う。
  `confidence_policy.sufficient_enabled` は dev OOF 上で precision ≥ 0.80・Wilson 95% LCB ≥ 0.65・
  coverage ≥ 0.10・positive ≥ 20 を満たすまで false であり、false の間 UI は
  「候補 / 重なりうすい」の2段階のみを表示する。
- 必須検査は dev・heldout・negative の本番 semantic score と本番 reranker feature vector を固定した
  `real-paper-features.jsonl` と split 別 manifest を使う。frozen required 経路は manifest と各行の hash を決定的に検証し、
  pipeline、モデル cache、ネットワーク、埋め込み生成を一切使わず、lexical retrieval から Top-K まで本番経路を通す。
  候補Recall・oracle reranker・校正・MRR LCB・negative semantic false-positive abstentionを検査する。
  semantic bundle の seal には required gate と full real-paper benchmark の両方の合格が要る。
  推薦内容が不変の更新では封印済み bundle を再利用し、埋め込みモデルを読み込まない。
  bundle manifest は公開 commit (`source_commit`) と生成元 commit (`bundle_origin_commit`) を分けて記録し、
  `semantic_content_id`・`required_gate`・`full_benchmark`・`embeddings_sha256` を持つ。
  `gate_provenance.mode` は、渡された両レポートを封緘時に再検証した `verified-reports` と、
  同じ fail-fast pipeline 内での直前合格を呼出元の責任で保証する `trusted-pipeline` を区別する。
  `verified-reports` は required / full レポートそれぞれの SHA-256 と benchmark content ID も記録する。
  復元側は現在の data から `semantic_content_id` を再計算して一致を要求し (公開 commit の一致は問わない)、
  両 gate の `passed` も強制する。
- required と full はそれぞれ記録済みの回帰下限を持ち、heldout fused Recall@5 または negative abstention が下限を割れば失敗する。JSON レポートは検査結果としてファイルに保存する。
- `data/benchmarks/retrieval-audit.json` は候補深度、カテゴリ、言語、会議種別、失敗分類を保存し、
  `data/benchmarks/annotation-audit.json` は受理 venue の出典、理由、注釈 revision を監査する。
- クエリ信頼度は top-1 と top-2 の差、上位エントロピー、語彙と意味の一致、候補被覆率、入力概要の有無で記録する。
  校正済み確率を算出できない場合、画面は確率として表示せず「候補」または「重なりうすい」と表示する
  （「情報不足」という古い語は、論文を最後まで入力してもほぼ全行に出たため、入力不足を
  指摘する文と読まれていた – 2026-09-23 の実測を §7 に残す）。

### 10.3 会議プロファイル拡充手順（`data/venue-profiles.json`）

失敗会議（golden で top5 外）の語彙を補う代表論文リストは、schema 2 の
出典情報付きデータから生成する。各論文は `title` / `year` / `source` /
`source_url` / `collected_at` を持ち、`selection` の `method` /
`max_prototypes` / `source_year_max` は全会議で共通でなければならない。
現在の共通方針は、固定した埋め込みモデルによる決定的 k-medoids、代表数 3〜8、source year
上限 2025 である。`VENUE_PAPERS` はこのデータから派生する互換ビューであり、
直接編集しない。

**拡充手順**:

1. 失敗会議の採択リストを一次出典または dblp から取得し、入力 JSON に出典 URL と
   収集時刻を付ける。
2. `node scripts/generate-venue-profiles.ts <input.json> data/venue-profiles.json`
   で正規化・検証・hash 付与する。空の出典情報、重複タイトル、混在 cutoff、
   cutoff 超過、収集時点より未来の年は失敗させる。
3. `GOLDEN_EN`（テストセット）と重複しない論文だけを採用する
   （**同一タイトルを両方に入れるとリークになり、A/B が偽陽性になる**）。
4. `npx vitest run tests/recommender.test.ts -t "リークなし"` と
   `npm run bench -- --golden-en` で副作用を確認する。失敗例を見て個別に継ぎ足さず、
   同じ選定方針で出典情報付きデータを再生成する。

適用対象は usenix-security / rtss / rtas / icdcs / ndss / osdi / sosp / icml /
eurosys / ppopp。
rtss・usenix-security は論文個別ベクトル（paperVecs）も使用する。
paperVecs 適用条件は「1 分野に収まる + 語彙非衝突」の 2 条件であり、対象は usenix-security・rtss のみである。

### 10.4 推薦結果の一覧（`site/app.ts` の卡片）

- **件数欄は候補の総数、卡片は `RECOMMENDATION_PAGE`（20）件から段階的に出す**。
  変更前は卡片を 5 件で打ち切り、`#more` を推薦モードで常に隠していた。件数欄は総数を
  出すので「あなたの論文に合う投稿先 200 件」と言いながら 5 件しか見えず、残りに到達する
  手段が無い画面になっていた（実測: 入力の語彙数で候補 49〜200 件）。
- 打ち切るときは件数欄に **`（まず上位 20 件を表示）`** を添える。総数と画面の件数が
  食い違った状態を残さない。
- 「さらに表示」は締切一覧と同じボタンを推薦カードでも使う。ラベルと表示可否は
  `moreButtonLabel` / `updateMoreButton` に一本化し（`さらに表示 (残り N 件)` の組み立ては
  1 か所。検査は出現数が 1 であることを見る）、`drawMore()` がモードで分岐して
  `drawMoreCards()` を呼ぶ。
- **共有URLに論文の本文を載せない**（`writeUrl` / `readUrl` は `mode` と絞り込みだけ扱う）。
  タイトル・概要・キーワードをクエリに載せると、未発表の原稿がURL・リンクプレビュー・
  閲覧履歴・サーバログに残る。一方で `?mode=recommend` のリンクを受けた人は、論文欄が空の
  ままなので、放置すると「リンクが壊れた」と受け取られる。そこで
  - 入力欄のすぐ下に理由を書く（「共有用URLには論文のタイトル・概要を含めません。未発表の
    原稿がリンクや閲覧履歴に残るためです。…」）。**てびきは推薦モードで畳まれる**ので、
    てびきではなく推薦パネル側に置く。
  - 論文情報が入っていないときの案内にも同じことを添える
    （「リンクで開いた場合はここが空になります（論文の本文はURLに載せません）」）。
  - 検査は不変条件として `writeUrl` / `readUrl` の本文に `paper` / `abstract` / `keyword` が
    現れないことを見る（「共有が復元されない」報告で後から足させないため）。
- **論文の入力は同じタブの間だけ憶えておく**（2026-09-23 実測・第 222 回）。
  タイトル・概要・キーワード・参考論文は DOM の中にしか無く（`sessionStorage` /
  `localStorage` への書き込みはソースコードに 0 件だった）、画面を刷新すると貼り直しだった。
  「投稿先を探す」は概要を数百文字貼る画面なので、失う量がサイトで最も大きい。
  - 保存は `savePaperDraft` / `loadPaperDraft` / `restorePaperDraft` の 3 本。**呼び出し口は
    `syncPaperText` に寄せる**（欄の読み直しは必ずここを通る。打ち込み・サンプル・PDF/TXT・
    取り消しの 4 箇所にばら撒くと、増やした日にどこかで記憶が漏れる）。
  - 「論文の入力を消す」は記憶も消す（消した物が次の刷新で戻ってくる形を作らない）。
    欄が空の下書きは戻さない。打ち込み中の物が有れば上書きしない。
  - **URL には載せない**（上の方針のまま）。リンクを開いた人に戻る欄の中身は自分の下書き
    なので、その旨を欄の下に書く – 相手の原稿が来たと誤読される形を残さない。
  - 記憶できない環境（シークレットモード等）では例外を握ってそのまま進む。打ち込みは消えない。
  - 検査: 上の 3 本を built から抜いて直接動かし、保存・消去・復元・上書きしない・壊れた JSON・
    `sessionStorage` が throw する環境の 6 条件を見る。配線（`syncPaperText` /
    `clearPaperInput` / 起動時）が抜けていると落ちる検査も同じ 1 本に入れる
    （関数だけ見ると配線切れを通すため。第 222 回に実際に通してしまった）。
- **0 件の案内は、その画面に無い条件へ利用者を送らない**。推薦モードでは締切画面の
  絞り込み（検索・分野チップ・国内・オンライン・ランク・期間）を見せていないので、
  「条件を変えてみてください」は画面に存在しないものを探す案内になる。実際に打てる手
  （タイトル・概要・キーワードを足す、上のサンプルボタンで入力形を確かめる）だけを書く。
