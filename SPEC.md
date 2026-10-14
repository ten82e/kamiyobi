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

**確認済みの罠（実測の数つき。推測ではない）**

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
6. `date` は自由文。構造化された開始終了日は **ない**。実在形状の上位:
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

**確認済みの罠（実測の数つき）**

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
10. `date`/`start`/`end` が全てない版が 1 件（`eurographics27`）。

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
│   ├── history.ts              # 公開済み過年度履歴の保持
│   ├── semantic-content.ts     # sealed bundle の semantic_content_id 算出
│   ├── embeddings.ts            # 埋め込み生成
│   ├── embedding-profiles.ts    # 会議プロファイルの組み立て
│   ├── embedding-runtime.ts     # 実モデルの推論とベクトル生成
│   ├── bench-recommender.ts     # 推薦ベンチ
│   ├── build.ts                 # JSON/CSV/MD/llms.txt/HTML 出力
│   ├── semantic-profile-cache.ts # MCPの推論入力別キャッシュ
│   ├── mcp-semantic.ts          # MCPの英日実モデル推論
│   ├── semantic-model-error.ts  # 実モデルの失敗情報
│   ├── prepare-models.ts        # 英日実モデルの準備・確認
│   ├── mcp.ts                   # AI から引く読み取り専用の MCP サーバ（stdio）
│   └── cli.ts                   # エントリポイント
├── site/
│   ├── tsconfig.json            # strict なブラウザ TypeScript の型検査
│   ├── tsconfig.build.json      # public/ 用 JavaScript emit
│   ├── template.html            # コア UI（表・絞り込み。外部 CDN なし）
│   ├── app.ts                   # ブラウザ UI 実行時処理
│   ├── submission-identity.ts   # 公式照合済みの同一募集を元記録を保持して統合表示
│   ├── place-aliases.ts         # 國名・都市名の打ち方を収録の表記へ寄せる表
│   ├── topic-aliases.ts         # 主題の日本語の打ち方を會議名の英字檢索語へ寄せる表
│   ├── latin-retype.ts          # 欧文の語を一文字違いの検索語に、収録済みの綴りを提案する表
│   ├── recommender.ts           # 論文推薦（§10。任意 CDN）
│   ├── recommendation-core.ts   # browser / benchmark / test 共通の推薦軸
│   ├── recommendation.ts        # browser / benchmark 共通の語彙fallbackと掲載先指定
│   ├── publish.ts               # publish manifest のブラウザ側検証
│   ├── ics.ts                   # カレンダー（RFC 5545）の組み立て（配付物と画面の書き出しで共通）
│   └── runtime.d.ts             # ブラウザ・生成データの型境界
├── scripts/
│   ├── compare-head.ts          # snapshot / primary_overrides の実質差分
│   ├── update-data-pr-body.ts    # 完全診断を保持しつつGitHubのPR本文上限内に要約
│   ├── clean_tmp.ts              # 検査の使い捨て目録を掃く（一時間より古い物だけ）
│   ├── health-gate.ts           # 直近の健全な公開結果との配信前健全性ゲート
│   ├── ja-text-audit.ts        # 利用者に出る文の旧字体・中国語の候補出し
│   ├── generate-curated.ts      # promotion 正典から local 正典を再生成
│   ├── generate-venue-profiles.ts # 出典情報付きプロフィール成果物の再生成
│   ├── observe-cfp.ts           # CFP 本文・応答・抽出候補の保存
│   ├── refresh-ieice.ts         # 研究会発表申込システムから国内研究会の会期・締切を更新
│   ├── restore-recommendation-bundle.ts # 互換推薦 artifact の検証・復元
│   ├── seal-recommendation-bundle.ts # semantic_content_id 付き bundle 封印
│   ├── capture-published-history.ts # 実公開 manifest/data の照合保存
│   ├── semantic-content.ts     # semantic content id の算出 CLI
│   ├── train-reranker.ts       # dev-only reranker 学習・CV・校正 artifact 生成
│   ├── validate-data.ts         # 公開データの意味検査
│   ├── verify-cfp.ts            # CFP 観測の項目別検証
│   ├── verify-mcp-semantic.ts     # MCP実モデルの隔離破壊検証
│   ├── verify-mcp-recovery.ts     # 同じ接続でのモデル準備・再試行の破壊検証
│   ├── verify-live-consumers.ts     # 全収録会議の画面・MCP共通処理を隔離環境で破壊検証
│   ├── verify-full-pool-retrieval.ts # 全収録会議・実モデルの隔離改変検査
│   ├── verify-recommendation-retrieval.ts # 隔離環境で推薦の改変検査
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
// Optional event metadata: event_review pins this edition's exact source wording,
// date bounds, HTTPS evidence URL, review date and note. held_year distinguishes
// a reviewed postponed event from its nominal edition year; changed source dates
// must fail validation, never be overwritten to match the review.
// event_segments: {start: string; end: string; label: string}[] represents separate
// actual sessions. Every part remains <=31 days, ordered and non-overlapping;
// the exact source dates or reviewed envelope must match, and a long envelope
// must contain a real gap. event_date_precision is "split-dates" for these rows.
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
// 'AoE'/'aoe' / 'Anywhere on Earth'（the / inhabited を含む表記も）-> UTC-12
// '日本時間' / 'Japan Standard Time' は JST（Asia/Tokyo）として受ける
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
offline build は失敗した源に対応する source snapshot を優先し、ない場合だけ統合済み snapshot の源情報へ退避する。
source snapshot の parser 形式は `conferencesFromJson` が読み戻せる契約とする。
一次ソースの手動訂正は `data/source-snapshots/primary.json` に同じ形式で保存し、
`primary_overrides.yaml` がないオフライン build からも復元する。

### 3.5.1 公開済みの過年度履歴

上流取得が成功しても、公開済みの非推定・過年度 edition を無根拠に短縮・削除しない。
`update-data` は実公開の `publish.json` と `data.json` を取得し、SHA-256 と commit identity を
照合する。取得失敗・空データ・不一致は中断する。この同じ保存ファイルを両 build の
`--history-baseline` に渡す。生成済み候補や再生成した main を公開履歴の代わりにしない。

`src/history.ts` は、年が build 年より小さい上流 edition の会期・精度・分割会期と既存締切
スロットを保持する。新しい edition・新しい締切スロットは取り込む。venue の確定 identity・
公開 key を優先し、edition の明示 ID または同じ venue・年度内で一意の公式 URL で照合する。
明示 ID で対応済みの候補は先に確保し、別の公開版への URL 照合で再利用しない。
ID が変わった場合は `legacy_ids` に旧 ID を記録し、次回更新でも引き継ぐ。
対応する ID・公式 URL がない過去版は別 edition として復元し、年度だけで統合しない。
複数候補に対応する曖昧な照合や多対一は失敗させる。
local 正典の削除や推定値は復活させない。
CoRL 2025 の汎用 URL と年度別 URL は公式アーカイブに基づく `edition_identities` で結び、
同一開催の二重収録と取得失敗時の復元衝突を防ぐ。

候補と公開基準の両方に手動 overrides と検証済み一次ソースを適用してから照合するので、
根拠のある訂正・延期・削除は引き続き可能である。履歴復元は rollforward の後に行い、
復元した過去版から新しい推定版を作らない。TCC 2023・SYSTOR 2024・CSCW 2022 は公式に基づく個別訂正を持つ。
保持の判断は baseline hash とともに `--history-report PATH` の診断 JSON に出力し、
更新 artifact に残す。公開ディレクトリには追加しない。
これは公式確認済みへの格上げを意味しない。ISS 2025 の保存済み2締切は集約元由来のまま残す。

引数がなければ online / offline とも開始時の `data/snapshot.json` を比較に使う。
公開用 deploy/bundle もコミット済み snapshot を明示する。
固定入力テストの build は更新対象データを混ぜない。
検索の旧来の実測件数は `query-reference-data.json.gz.base64` の固定入力と固定 hash で検査し、
現行 snapshot の都市網羅性・日本語検索の同値性は別の実データ検査で維持する。

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
`exact` と `date-only` は exact が date-only の不確実性区間内にある場合に同一の締切として精度差に畳み、
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
                              [--no-embeddings] [--history-baseline PATH] [--history-report PATH]
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
| `upcoming.html` | 直近の締切と開催の静的な表 |
| `404.html` | 存在しない URL から一覧へ戻る案内 |
| `deadlines.ics` | 今後の締切の購読用カレンダー（§4.2） |
| `index.html` | 静的サイト（テンプレートに正規化データを埋め込む） |
| `data.json` | 正規化データ全体（機械可読の正）。推定版も含む |
| `health.json` | 確定・推定締切、ソース状態、警告、カテゴリ、出力ファイルの健全性レポート |
| `health.md` | `health.json` の人間向け要約 |
| `publish.json` | 埋め込み復元・生成後の最終成果物ハッシュと `semantic_status` |
| `catalog.json` | 締切画面向けの現在・近日期間カタログ（画面の最初の一覧に出る物）。履歴と論文プロフィールを含めず、全履歴の `history_ref` を持つ。**載る締切の件数と範囲は索引に実測で書く** |
| `recommendation-index.json` | 投稿先推薦用の会議プロフィール、代表締切、埋め込みマニフェスト参照 |
| `data.csv` | 1 行 1 締切の平坦な表。推定版も含む |
| `upcoming.md` | 直近 N 日の締切と開催日の表（N は `site.upcoming_days`、既定 180） |
| `llms.txt` | エージェント向け出力索引 |
| `embeddings.json` | 会議スコープの埋め込み（§10）。`--no-embeddings` で省略可 |
| `recommender.js` | `site/recommender.ts` から生成するサイトの推薦ロジック |
| `recommendation.js` | `site/recommendation.ts` から生成する共有の語彙fallback・掲載先指定処理 |
| `place-aliases.js` | `site/place-aliases.ts` から生成する、開催地の寄せ先の表（`recommender.js` が import） |
| `topic-aliases.js` | `site/topic-aliases.ts` から生成する、主題の寄せ先の表（`recommender.js` が import） |
| `latin-retype.js` | `site/latin-retype.ts` から生成する、欧文の打ち間違いへ収録の綴りを見当として出す表（`recommender.js` が import する。検索しは広げん – 打ち手の提案だけ）
| `recommendation-core.js` | `site/recommendation-core.ts` から生成する共有推薦軸 |
| `publish.js` | `site/publish.ts` から生成する publish manifest 検証 |
| `app.js` | `site/app.ts` から生成するブラウザ UI 実行時処理 |
| `submission-identity.js` | 公式照合済みの同一募集の表示・ICS方針 |
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
Pages 用アーカイブも `.nojekyll` を含む同じ一覧にするため、upload action の `include-hidden-files` を `true` にする。
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
推薦モードは URL に `past=1` があっても履歴を取得しない。推定の表示切替はサイト側の絞り込みで行う。`catalog.json` は設定した期間の一覧であり、全履歴や期間外の確定締切は `data.json` を参照する。画面は一覧・カレンダーの収録範囲を表示する。

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
                     "utc":"2026-02-07T11:59:59Z",
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
締切の行が見えなくなる。

- `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` は **JST の暦日**の終日イベント（締切に継続時間は
  ない。`DTEND` は翌日）。`TRANSP:TRANSPARENT`（締切は予定を埋めない）。
- `SUMMARY` は「会議名：種別」。推定の行は「（推定）」を種別のかたに添える。
- `DESCRIPTION` は `会議:` `種別:` `締切:` `開催地:`（+ 推定の注記・`詳細:` URL・`収録:`）を
  `\n` で繋ぐ。`締切:` の値は JST（`2026-08-11 08:59（JST）`）で、時刻を確認できていない行は
  「（時刻未確認）」を添える。開催地が出ていない行は `開催地: 未確認`（画面と同じ語）。
- **本文に `会期:` を 1 本書く**。値は「2027-04-06(火) 〜 2027-04-09(金)」の
  形で、1 日なら範囲を書かず、上流が推定とした会期には「（推定）」を添え、分かっていない日は
  `会期: 未確認`（画面と同じ語）。語と形は `upcoming.md` の会期欄と同じ正本（`fmtDate` +
  `calendarDayJa`）を呼ぶ。会期その物の `VEVENT` は立てないので（上）、出張の段取りはこの行で読む。
- 出口の言い方（`X-WR-CALDESC`・`llms.txt`・導線の説明・画面の注記）は、**会期を並べない事と本文に
  書く事**を同じ事実で言う。
- **`LOCATION` は開催地が判っている行だけ**に載せる。カレンダーは場所欄を
  そのまま旅行の段取りに使うので、「未確認」を場所として渡さない – ない場所を渡すより
  空しい方がマシで、本当のことは `DESCRIPTION` の `開催地:` に書く。
  語は `upcoming.md` の開催地欄と同じ正本（`Recommender.placeJa` + 県名の補い）を呼ぶ。
- `UID` は締切日を含まない `kamiyobi-<edition_id>-<種別>`。
- TEXT 値は転義（`\,` `\;` `\\` `\n`）し、1 行 75 オクテット以内へ畳む。折り返しで 2 文字の
  転義の途中を割らない。
- **`X-WR-CALDESC` は、値を空白で始めない**。RFC 5545 §3.1 は名前とコロンとの間に
  空白を置かないと定めており、相手は残した空白を値の一部として情報欄に出す。
- 説明欄には **入る件数と、収録している最初・最後の締切日**を実測の値で書く。
  カレンダー側に「画面上の全件」のような位置の語は通じない上、収録の期間は画面に並べる
  期間より長い（2026-08-09 生成のビルドで 928 件・2026-08-09 〜 2028-03-30、画面の既定窓は
  生成から 180 日）。同じ期間を想像して購読すると、予定の方が 2 年分になる。
  同じ申告は `catalog.json` の `calendar`（`event_count`・`first_day`・`last_day`）にも載り、
  画面の「カレンダーに追加（.ics）」の下の注記がそれを読む – **数はビルドが行から導く一度きりで、
  画面は数え直さない**（別々に数えた物は必ずズレる）。
- **分野を `CATEGORIES` と説明行の `分野:` の両方に載せる**。実測
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
  （`IEICE-` を二重に付けると空ページになる）。対応表にない tgid は IEICE の略称とみなす。
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
- 公式 CFP または出版社の capture がない観測、本文と一致しない観測、会議レビューまたはカテゴリレビューが未完了の観測は昇格しない。
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

### 投稿締切の探索と詳細

- 初期一覧は投稿締切を表示し、過去の締切と推定を既定で除く。種別・分野・ランク・開催地・期間・国内研究会・オンライン参加の条件は URL と同期する。
- 検索は `site/recommender.ts` の共通処理を使う。日本語の分野名や日付表現を解釈し、期間に解けた語は判定範囲を表示する。未収録の情報や意味の定まらない期間を推測して絞らない。検索が別ラウンドや会期の日付にも当たることと、「締切まで」による絞り込みの違いを案内する。
- 日時は `YYYY-MM-DD(曜) HH:MM JST` を主表示とし、元の時刻とタイムゾーンを併記する。閲覧者のタイムゾーンで表示を変えない。AoE は UTC-12 として換算する。
- `date-only` は公式の暦日を表示し、JST・UTC・AoE の時刻を作らない。不確実性区間に基づき、未到来・終了の可能性あり・締切日経過を区別する。推定は推定期間と点推定を区別する。
- 同じ種別でも投稿トラック・ラウンド・募集が異なる締切は別に保持し、表示名と共有リンクで区別する。旧 URL が複数行に当たる場合は候補を選べるようにする。
- 詳細では同じ開催回の全日程を確認できる。一覧の期間外の日程も表示し、前後関係だけで同じ投稿枠とは判定しない。締切の変更、確認状態、公式ページ、会期の見直し理由を示す。
- 適用中の条件を個別に外せる。「条件クリア」は論文入力を消さない。戻る・進むで一覧条件と詳細を復元する。
- 日本語 IME の変換開始時には予約済みの検索を止め、確定後に適用する。検索欄の Enter は変換中には結果へ移動しない。
- 表・入力欄・ボタンに読み上げ用の名前を付ける。追加表示の最後にフォーカスを失わせず、件数の変化を通知する。狭い画面では追加条件を開閉できる。

### 一覧の書き出し

CSV と画面からダウンロードする ICS は、絞り込み後の全行を対象とする。画面に描画済みの行数で切らない。推薦候補の出力では順位と投稿トラックを保持する。購読用 `deadlines.ics` は収録全体の今後の締切であり、絞り込みを引き継がない。

### 読み込みと外部接続

サイトは `recommender.js` と `app.js` を同一 origin から読み、初期データは `catalog.json` と一致する。推薦インデックスと履歴は必要時に取得する。取得失敗は利用者に知らせ、既に読めたデータで継続または再試行できるようにする。

意味検索には `cdn.jsdelivr.net` の固定版 `@xenova/transformers`、PDF 処理には `cdnjs.cloudflare.com` の固定版 `pdf.js` を使う。モデル取得先は `huggingface.co` と許可した CDN に限定し、CSP は必要な接続先だけ許可する。接続できないときの代替動作は語彙検索と TXT 入力である。論文本文はブラウザ内で処理し、共有 URL に含めない。

生成日時と上流取得日時を分けて表示する。キャッシュ・snapshot への切り替えと取得失敗を隠さず、未確認を「情報が存在しない」と言い換えない。

### MCP の検索契約

MCP は同じ検索・推薦処理を使う読み取り専用の stdio サーバである。`search_deadlines` は `scope: screen/all`、絞り込み、`limit`（既定20、最大100）、`offset`（0以上の安全な整数）を受ける。構造化結果には件数・取得位置・次の取得位置・生成時刻・判定時刻・検索行を含め、従来のテキスト結果も返す。日付のみの行の `utc`・`jst` は null とし、推定・確認状態・投稿トラックを独立した項目にする。画面と同じ募集の統合処理を使い、確認済みの特集号には掲載予定・投稿言語・元の出典を `submission` に保持する。次ページは同じ条件で `next_offset` を `offset` に渡す。 `search_venues` は締切の有無によらず全収録会議を候補に、研究テーマ・題名・概要で投稿先を検索する。`recommend_venues` と共通の処理を使い、`retrieval: semantic` はローカルの実モデルで英日推論し、未指定は語彙検索とする。意味検索は現行プロフィールから推論し、生成済みベクトルを要求しない。モデル未準備時はエラーを返す。実モデルの失敗は `isError: true` と日本語の案内、`structuredContent.error` のコード（`MODEL_NOT_READY`・`MODEL_LOAD_FAILED`・`SEMANTIC_INFERENCE_FAILED`）、モデルID・revision、相対保存先、不足ファイルを返す。プロフィールの再推論はモデルや推論対象の文章が変わった場合に行い、締切だけの更新では再利用する。保持する結果は最大2組とし、失敗した推論は再試行できる。`candidate_venues` に検索した会議数を返す。`recommend_venues` も `offset` によるページ送りと構造化結果を返す。順位・一致評価・受付状態・締切の確認情報を保持し、常時受付の論文誌には締切日時を作らない。語彙のみの推薦では画面と同じ処理を使う。 推薦の `venue_evidence` は収録開催年数、論文サンプル数、DBLP情報・出版社情報・ランクの記載の有無を返す。創設年、会議の年齢、査読品質は推測しない。

`node src/prepare-models.ts` は固定revisionの英日モデルだけを取得し、MCPと同じローカル推論経路で384次元の正規化ベクトルを確認する。会議データを読まず、生成済みベクトルを要求・出力しない。`--offline` は取得せず、保存済みモデルだけを検証する。

手元のCLIでは、投稿先検索・推薦に `--retrieval semantic` を指定して実モデルを使える。投稿先検索・推薦の `--input ファイル名` はUTF-8のテキスト・JSONを読み、`--input -` は標準入力を読む。直接入力との混在は拒否する。`--limit N` を使った場合は題名末尾の数字を件数として切り取らない。検索・推薦の `--json` は構造化結果だけを標準出力へ返し、失敗は終了コードと標準エラー出力で通知する。

同じ MCP 接続でも、カタログ・snapshot・推薦索引の更新を次の要求で反映する。ファイルがない場合や読めない場合も、修復後の要求で再読込する。判定時刻は要求ごとの現在時刻とし、推薦の生成日時は推薦索引の日時を返す。

## 8. テスト（`tests/`）

実装を読まずに本仕様だけから書く。

- `timezone.test.ts`: `resolveTz` の実在値 19 + 12 種すべて。`AoE` = UTC-12。
  `UTC-08` と `UTC-8` が同じ。IANA 名。**`PT` が夏と冬で異なるオフセットになること**。
  不明なタイムゾーンの観測を確定締切に適用しないこと。
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

検証は `npm run typecheck`、`npm run check`、`npm test` と固定時刻の offline build を使う。必須テストではネットワークを使わず、異常入力は隔離したコピーかメモリ内で検証する。改ざん中のソースをビルドと別のテストで同時に読まない。データを含むリポジトリ全体への一括整形は行わない。

文書のテストは現行の API・利用手順・表示との整合を検査する。作業回数や変更日記の存在を必須にしない。ソースのサイズ制限と、正常例・異常例の両方に反応する文字化け検査を維持する。

## 9. 非目標

- WikiCFP など HTML スクレイピング（壊れやすく、利得が小さい）。
- 会議の採択率・査読統計。
- ユーザ登録・購読管理。
- 上流にない会議の締切を推測で確定値として書くこと（推定は `estimated` フラグで区別する）。
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
  `semantic_content_id`・`gate_policy_id`・`required_gate`・`full_benchmark`・`embeddings_sha256` を持つ。
  `gate_policy_id` は baseline・全 split fixture/manifest・固定 feature・品質下限/評価器・
  推薦/埋め込み実装・seal/restore・workflow・依存 lock のファイル名と SHA-256 を束縛する。
  再利用と復元には現行 policy の一致を要求し、policy 無しの旧 bundle も拒否する。
  締切 snapshot 自体は policy に含めず、semantic 内容も不変なら締切だけの更新は再利用できる。
  `gate_provenance.mode` は、渡された両レポートを封緘時に再検証した `verified-reports` と、
  同じ fail-fast pipeline 内での直前合格を呼出元の責任で保証する `trusted-pipeline` を区別する。
  `verified-reports` は required / full レポートそれぞれの SHA-256 と benchmark content ID も記録する。
  復元側は現在の data から `semantic_content_id` を再計算して一致を要求し (公開 commit の一致は問わない)、
  両 gate の `passed` も強制する。production restore CLI の不適合は非0終了で公開を止め、
  配信後の照合には `semantic_status` を含める。main SHA の取得失敗・空値・不正形式を
  stale の成功 skip と扱わず失敗させ、取得に成功した正しい旧 SHA だけを skip する。
  これは gate の来歴と公開失敗の修正であり、frozen full 経路による生成 embedding 評価の欠落、
  trusted-pipeline の report 束縛不足、pending queue と HEAD^ baseline の問題は未解決である。
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

### 10.4 推薦の根拠と候補集合

分類一致の +10 ブーストは `fused > 0`、つまり会議名・主題などに実質的な一致がある候補だけに適用する。分類だけの一致で候補を推薦せず、一致根拠がない候補のスコアは0とする。

画面と MCP は同じ推薦インデックスと共通処理を使う。初期カタログには論文プロフィールがないため、それだけを推薦の根拠にしない。推薦の評価は固定された特徴量と分割で再現し、入力の更新とスコア処理の変更を区別する。

### 10.5 推薦結果と論文入力

候補の総数と表示済み件数を区別する。最初は `RECOMMENDATION_PAGE`（20）件を出し、「さらに表示」「すべて表示」で続きを読めるようにする。候補の書き出しも同じ順位表を使う。

共有 URL にはモードと絞り込みだけを含め、論文のタイトル・概要・キーワード・参考論文は含めない。論文入力は同じタブの `sessionStorage` に保存し、入力が空なら保存済み下書きも消す。保存できない環境でも入力を続けられるようにする。URL から開いて論文欄が空の場合は、共有対象の範囲をその場で案内する。

### 公式根拠と複数会期（日本語の投稿日程確認）

- `Edition.year` は開催回の名称の年。延期後の開催年とは別。原文 `date_text` と元の `event_start/end` を保持する。
- `event_review` は exact edition ID、原文、開始/終了、HTTPS公式根拠、確認日と説明を固定する。`held_year` は公式確認した実開催年（版の年または翌年）。一致しない証拠や変化した上流は検証エラーになる。収録元が実際に持つ空白違いの原文だけを `source_date_text_alternatives` に列挙でき、全候補のパース結果も固定した開始/終了と一致を要する。レビュー付きの override の `date_text` は固定値の検査用で、上流をその値に書き換えない。
- `event_segments` は `{start, end, label}` の順序付き配列。明確な非連続日程は `split-dates` 精度で各区間を保持し、区間外を連続開催として補わない。元の期間から週次開催などに分解する場合には原文・期間に固定した公式レビューを要する。各区間の不正日付・逆順・重複・31日超は従来通り棄却する。長い連続開催を分割マーカーで許可しない。
- 一覧・詳細・画面CSVは共有の `eventCellJa` で各区間と参加方式を表示する。`data.csv` の末尾 `event_segments` に構造化日程を出し、元の期間欄は保持する。`upcoming.md` の開催行は各区間を別行にし、締切ICSの本文も区間を列挙する。締切ICSに開催だけの予定を混ぜない契約は維持する。
- EvoMUSART 2027の概要登録は主催者CFP確認済みの2026-11-01、時刻未確認。時刻・タイムゾーンを推測せず、同日の論文締切とは別の種別として収録する。

日時の併記は「元の日時」と呼ぶ。UTC/JST変換が正しいことと公式ページの再確認が済んだことを分け、集約サイトのexact値も公式確認済みと表示しない。

### 同一の特集号募集と掲載年

- 公式CFP `https://www.ipsj.or.jp/journal/cfp/27-R.html` のCOMPSAC連携特集号は、JIP（英語論文のみ）、投稿締切2026-12-01（時刻未確認）、掲載予定2027年9月号。開催日を掲載月から補わない。
- `jip/jip-compsac2027-si` と `ipsj-27-r-compsac/ipsj-27-r26` の元の記録・年度・IDは保持する。上記CFP・ID・論文・トラック無し・date-only 2026-12-01が一致する場合だけ、画面一覧・画面CSV・締切ICSを1件にまとめる。別の日時・種別・回・トラック・CFPを黙って統合しない。
- 表示はJIPを優先し、2027年を掲載年として明記する。旧共有リンクの行キーを別名として受け入れる。ICSは既存JIP UIDを保持する。アーカイブ用JSON/CSVの2記録は削除しない。公式根拠は `data/evidence/blobs/9972268f811c33df5e345fc94570018d6ea5ec55be146ca81b95744b7fd4f3bd.body` に保存する。

### 共有リンクの同一性

- 同じ会議・年度・種別・日時でも、edition ID・round・track・ラベルの違いを同一の日程としない。旧4要素キーが衝突する行だけに、これらの識別情報を含む suffix を付ける。衝突しない共有URLは維持する。
- 複数候補がある旧URLは先頭行を黙って開かず、ラウンド・トラック付きの候補ボタンを出す。候補を選ぶと識別可能な新URLになる。元の一覧条件と日付精度は変更しない。
- COMPSACの例外統合は各出典の元年度（JIP 2027、IPSJ 2026）・確認済みラベル（投稿締切、Submission）・明示round 1も固定する。未確認の別年度やラベルのみの別トラックは統合しない。


### 自動更新の入力と推薦検証

自動更新では `data/source-snapshots/` を生成物とデータ更新 PR に含める。offline ビルドは統合済み snapshot より先にデータ源別 snapshot を復元し、古い集約データで上書きしない。

実論文の品質検査では `--real-v2-feature-baseline` を指定し、固定された入力メタデータ（main の `c06b9ff`）から候補の特徴量と基礎スコアを再現する。その後、現在の投稿先候補について同じ意味検索の観測・検索範囲・負例・品質下限を評価する。特徴量の不一致は失敗とし、入力データの変化とスコア処理の不具合を区別する。

`deadline_identity_migrations` は確認済みの識別子変更を設定から公開 JSON と健全性レポートへ引き継ぐ。移行先が存在する間だけ出力し、不正な指定は拒否する。WSDM 2027 の short-paper の移行では元の確定時刻と公式 CFP を指定し、締切を作らずに上流の round-2 ラベルを訂正する。

### 公開時の初回snapshotと語彙推薦の互換性

- SIGMOD 2026の合同会期「May 31-June 5, 2026」と個別日程「May 31 and June 2-4, 2026」は出典の原文をそのまま保持する。個別日程のreviewを別の原文へ付けず、分割日程はparseEventSegmentsで解析する。過去の開催年・原文・会期や検証基準を書き換えてCIを通さない。
- site/recommendation.tsはブラウザとベンチマークが共有する語彙fallback方針。入力のタイトル/keywordsに会議のkeyが単独で指定された場合、元のスコア・confidenceを変えず該当候補を優先する。部分一致・分野名は指定と見なさず、カテゴリ以外のfield根拠も主題根拠もない短い名称の誤一致は棄権する。
- semantic推薦と固定feature artifactは従来通り。語彙fallbackのfield重み・スコアは変更せず、ブラウザが使うfieldedの語彙経路にも同じ掲載先指定方針を適用する。回帰評価の正解・閾値・heldoutによるモデル選択は変更しない。

- update-data writerは既存生成branchの親履歴を保持して通常pushする。既存branchに生成データ以外の編集がある場合は停止し、同時にremoteが進んだ場合もnon-fast-forwardとして拒否する。force pushで履歴を置き換えない。
- update-dataのPR本文はGitHubの文字数上限内に収め、長い診断は要約する。完全なcategory/deadline差分はgenerated-update artifactに保存し、その実行へのリンクを本文に含める。本文生成の確認はremote push前に行い、データ検証・health gateを省略しない。
