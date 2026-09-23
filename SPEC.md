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
| `catalog.json` | 締切画面向けの現在・近日期間カタログ。履歴と論文プロフィールを含めず、全履歴の `history_ref` を持つ |
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
推薦モードは URL に `past=1` があっても履歴を取得しない。推定の表示切替はサイト側の絞り込みで行う。
`upcoming.md` には締切と開催日の両方を載せる。締切を持たない会議も開催行で確認できる。

**`upcoming.md` の日付は曜日を添える**: `2026-08-17(月) 23:59 JST`・`2026-02-06(金) 23:59:00 AoE`・
`2026-09-30(水)（時刻未確認）・会期行は 2026-08-07(金) 〜 2026-08-09(日)` の形にする。
曜日は `YYYY-MM-DD` をその暦日として読む（`calendarDayJa`）。ビルドのタイムゾーンに依存せず、
`Date.UTC` の暦月繰り越し（`2026-13-45`）には曜日を付けない。
`data.json` / `data.csv` の `aoe` 値は機械可読なので曜日を付けない（上の実測例）。

**`upcoming.md` は対象期間と JST での読み方を最初に書く**: md を単体で読む人（grep する人、
他のツールに食わせる人）にとって、表が「いつの時点の、いつまで」を網羅しているか分からないと
使えない。先頭には生成時刻を UTC の ISO と JST の両方で（`生成時刻: 2026-08-09T00:00:00Z
（JST では 2026-08-09(日) 09:00 JST）`）、続けて `対象期間: 2026-08-09 〜 2027-02-05(金)` を
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
  - 検査: ビルド後の `index.html` の `<style>` から、規則がどの `@media` 块に入るを読む
    （コメントは実装と同じく先に落としてから読む – コメントに URL を書いたとき自分の検査が
    誤読したため。CSS 側のコメントには URL を置かない）。`.count-kbd` と `.only-keyboard` を
    隠す条件が `(pointer|hover)` を含むこと、`max-width` の块に混ざっていないこと、
    `onKeydown` に幅の判定が無いことを見る。
  - 第 103 回の検査が旧方針（幅で隠す）をピンしていたので、**意図（見出しと説明を対で閉じる）を
    保ったまま**、照合する条件を操作手段の块へ移した。幅の块に混ざっていないことの検査に
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
- **0 件の案内は、その画面に無い条件へ利用者を送らない**。推薦モードでは締切画面の
  絞り込み（検索・分野チップ・国内・オンライン・ランク・期間）を見せていないので、
  「条件を変えてみてください」は画面に存在しないものを探す案内になる。実際に打てる手
  （タイトル・概要・キーワードを足す、上のサンプルボタンで入力形を確かめる）だけを書く。
