# kamiyobi

高性能計算・ネットワーク・システム・人工知能・セキュリティ・データベース・グラフィックス・HCI・理論の国際会議および穴場ワークショップ・ジャーナルについて、論文投稿の締切と開催日を収集・正規化する。
上流データの取得、候補探索、ビルド、公開は必要なときに手動で行い、JSON / CSV / Markdown と静的サイトを生成する。
生成した静的サイトは GitHub Pages で公開できる。

公開先は https://ten82e.github.io/kamiyobi/ である。

## 直近の締切と開催

直近 180 日の締切と開催の表は [upcoming.md](https://ten82e.github.io/kamiyobi/upcoming.md) にある。
締切を持たず開催日だけがわかっている会議も、開催の行としてここに出る。
この README は手書きで、ビルドが書き換えることはない。

## 生成物

投稿判断に使う正規化データ全体は `data.json`、一覧画面用の現在・近日期間カタログは
`catalog.json`、推薦モード用の会議プロフィールは `recommendation-index.json`、締切だけを扱う表は
`data.csv`、品質監視用の健全性レポートは `health.json`、直近の締切と開催日は `upcoming.md` にある。静的サイトでは会議名・締切・公式サイトを
検索でき、推薦機能は必要時に推薦インデックスを取得して論文の PDF/TXT をブラウザ内で処理する。
推薦インデックスは締切データと同じ公開物として維持され、埋め込みを取得・検証できない場合も
サイト全体は公開され、語彙スコアのみの推薦に切り替わる。

## 機械可読の出力

エージェントや自作の道具から使う場合は、次の 2 つを見るのが早い。

| ファイル | 用途 |
|---|---|
| `https://ten82e.github.io/kamiyobi/llms.txt` | 出力ファイルとデータの形を 1 枚にまとめた索引。まずここを読む |
| `https://ten82e.github.io/kamiyobi/data.json` | 正規化済みの全データ。時刻確認済みの締切は UTC と AoE、日付のみ確認済みの締切は `local_date` と不確実性区間で表す |
| `https://ten82e.github.io/kamiyobi/health.json` | 確定/推定締切、ソース失敗、警告数、カテゴリ件数、必須会議の健全性レポート |
| `https://ten82e.github.io/kamiyobi/publish.json` | 公開成果物のハッシュ、`content_id` / `build_id`、元 commit、入力 hash、実行元、build 時刻・Node 版・offline/cache 方針、`semantic_status`。公開物の再現元を示す |

他に、1 行 1 締切の平坦な表 [`data.csv`](https://ten82e.github.io/kamiyobi/data.csv) と、直近 180 日の締切と開催の表 `upcoming.md` がある。

## サイトの使い方（投稿先レコメンド）

公開サイト https://ten82e.github.io/kamiyobi/ の上部で、**読んだ論文（似た論文）または投稿予定の論文の PDF / TXT を選ぶだけ**で、合いそうな会議・ジャーナルを適合度順にランク付けする（複数ファイル可）。

- PDF は固定版 pdf.js で先頭 3 ページのタイトル・概要・キーワードを読み取って照合する（未接続環境では TXT のみ対応）。ページには許可済み CDN とモデル接続だけを記した CSP を設定している。
- 内部では 1 ファイルを `タイトル | 本文` の 1 行として処理する。掲載先タグ（`| RTSS` 等）による「掲載先一致」優先は手動の行入力時のみの機能だが、サイト上はアップロードが主経路のため通常は不要。
- 分野チップが空のときは論文内容から分野を自動判定して表示する（手動でチップを選ぶとその分野に絞る）。
- 英語・日本語どちらのタイトル/キーワードにも対応。日本語の場合は会議名の日本語表記と部分一致し、国内研究会（情報処理学会・電子情報通信学会等）も拾う。
- **AI による意味検索の補助**: 会議スコープはビルド時に all-MiniLM-L6-v2 で埋め込み済み（`embeddings.json`）。ブラウザで transformers.js が使える環境では、論文入力との意味類似度を計算し、入力言語と内容語数に応じた重みで語彙スコアと合成する。CDN が使えない環境では語彙検索のみで動作する。
- 埋め込みが未提供・不正・古い場合は、画面に意味検索が利用できず、語彙検索のみ有効であることを表示する。締切一覧はこの状態でも利用できる。
- AI 補助の実行時処理とモデル取得は固定 URL の外部接続を使う。接続できない場合も語彙検索と TXT 入力は継続する。
- 適合度は、分野シグナル・会議名・領域タグとの語彙一致と掲載先タグの合算。スコアリングの正本は `site/recommender.ts` で、ビルド時に `recommender.js` を生成する。`tests/recommender.test.ts` が実データで回帰検証する。

## データ源とライセンス

| 名前 | リポジトリ | ライセンス |
|---|---|---|
| `ccfddl` | [ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) | MIT |
| `aideadlines` | [huggingface/ai-deadlines](https://github.com/huggingface/ai-deadlines) | MIT |
| `local` | 本リポジトリの `data/extra.yaml` | MIT（本リポジトリ） |

発見ソース（候補生成）は `DBLP`、`OpenReview`、`wikiCFP`（70 カテゴリ）、`DBWorld` メーリス公開アーカイブ、`EasyChair` Smart CFP、IEEE ComSoc 誌特集号、IEICE 論文誌特集号、IPSJ 論文誌特集号である。
DBWorld は[公開アーカイブ](https://dbworld.sigmod.org/)から、wikiCFP に載らない併設ワークショップ、ジャーナル特集号、締切延長通知を拾う。
EasyChair は[公開 CFP 一覧](https://easychair.org/cfp)から、運営者が登録した締切、場所、トピックを分野フィルタ付きで取得する。
IEICE と IPSJ は、それぞれ[特集号 CFP 一覧](https://www.ieice.org/eng_r/information/schedule/journals.php)と[特集論文募集一覧](https://www.ipsj.or.jp/journal/index.html)を使う。
候補は締切を公式サイトで裏取りした後、`data/extra.yaml` に昇格する。

上流が扱わない会議は `data/extra.yaml` に自前で収録している。
帰属表示は [NOTICE.md](NOTICE.md) にある。
本リポジトリ自体のライセンスは MIT で、全文は [LICENSE](LICENSE) にある。

## 穴場の会議・ジャーナルの探索

上流に登録されていない特化ワークショップ、地域シンポジウム、ジャーナルの Call for Papers などの「穴場」を自律探索するには以下を実行する。

```sh
node src/cli.ts discover --dry-run
```

候補レジストリを永続化する場合:

```sh
node src/cli.ts discover --candidate-out data/discovered_candidates.yaml
```

`--out` は明示的に `extra.yaml` 互換の一時出力を作る場合だけ使う。
旧互換出力を追記する `--append` は、候補レジストリの更新には使わない。
候補レジストリはこのコマンドで更新する。`data/discovered_candidates.yaml` に既存レコードを
マージし、レビュー済みの状態・メモ・初回発見時刻は維持する。再発見時は最終発見時刻と
証拠だけが更新される。
候補は公式サイトで裏取りするまで `extra.yaml` には昇格しない。
探索対象を分野や年で絞るには `--categories`（例: `hpc,systems`）と
`--min-year`（省略時は実行時の UTC 年）を使う。

溜まった候補を締切昇順・重複・ハゲタカ会議の疑い付きで一覧するには `review` を使う。

```sh
node src/cli.ts review
```

`--limit` で表示件数を絞り、`--candidates` で候補 YAML の場所を変えられる。
候補の昇格（下記）の前に、ここで重複や怪しい候補を確認する。

**候補の昇格手順**（収録の裏取り原則: 締切は公式サイトで HTTP 確認できたもののみ）:

1. `data/discovered_candidates.yaml` から気になる候補を選ぶ
2. `scripts/observe-cfp.ts --url <公式URL> --body <保存先>` で公式ページの応答と本文を保存する。`--body` は必須
3. 観測 JSON に会議・カテゴリのレビュー結果を付け、`scripts/verify-cfp.ts` で本文 hash、公式ドメイン、抽出値、取得版を検証する
4. `scripts/promote-candidates.ts` で本文を同梱した manifest 付き batch を生成し、昇格された `extra.yaml` を確認する
5. ビルドして収録されることを確認する

## 更新の仕組み

更新は手動で行う。

```sh
# 1. 上流を取得して正規化し、一次ソース観測を適用する
node src/fetch-primary.ts --apply
# 2. 候補探索（新規会議の発見）
node src/cli.ts discover
# 3. フルビルド（public/ を生成）
node src/cli.ts build --out public
# 4. 意味検査
npm run validate:data -- public/data.json
# 5. health gate（前回成功時の health.json と比較）
node scripts/health-gate.ts public/health.json --require-baseline data/next-last-known-good-health.json data/next-last-known-good-health.json
```

全上流が fresh の場合だけ `data/snapshot.json` を更新する。このスナップショットは上流が
落ちたときの退避先を兼ねており、取得に失敗した日は前回の内容から生成を続ける。
スナップショットでも補えないほど収集が縮退した場合は、ビルドが非ゼロで終了して公開物を作らない。

変更は `git branch` → ローカルで `npm run typecheck && npm run check && npm test` → `git merge` の順で main に反映する。

## 手元で動かす

```sh
npm ci
node src/cli.ts build --out public
```

`public/index.html` をブラウザで開けばサイトを確認できる。

テストを走らせる。

```sh
npm test
```

その他の指定。

| 指定 | 意味 |
|---|---|
| `--config config.yaml` | 設定ファイルの位置 |
| `--out public` | 出力先 |
| `--now 2026-08-09T00:00:00Z` | 基準時刻を固定する。同じ入力で出力が一致することを確かめたいときに使う |
| `--cache .cache` | 上流の取得結果を置く場所 |
| `--offline` | 上流を取りに行かず、キャッシュ、それも無ければ `data/snapshot.json` を使う |
| `--no-embeddings` | 埋め込み（`embeddings.json`）を生成しない。モデル取得を避けてビルドを速くする（テスト・オフライン確認用） |

## 収録範囲を変える

`config.yaml` を編集する。

分野の割り当ては `taxonomy` にある。
上流の分野を丸ごと取り込む `ccfddl_subs` と、会議名を並べる `venues` の組み合わせで決めている。
個別許可リストにすると上流に新しく追加された会議が永久に出てこないため、この方式を採っている。
`venues` に書いた会議はランク判定を迂回して必ず残る（名指しは収録の意思表示でもある）。
特定の会議を外したいときは、その分野の `exclude` に会議のキーを足す。

```yaml
taxonomy:
  networking: {ccfddl_subs: [NW]}
  hpc:        {venues: [sc, ipdps, hpdc, icpp, cluster]}
```

ランクによる絞り込みは `rank_filter` にある。
空にすれば無条件で通る。
`keep_if_no_rank` を真にしておくと、ランク情報を持たない会議（`data/extra.yaml` 由来のものなど）が落ちない。

```yaml
rank_filter:
  ccf: [A, B]
  core: ['A*', A, B]
  keep_if_no_rank: true
```

上流に無い会議を足したいときは `data/extra.yaml` に書く。
上流の記述が誤っているときは `data/overrides.yaml` で訂正するか、除外する。
どちらも編集後は手元でビルドし直して結果を確かめる。

## 既知の限界

締切情報は上流データに依存しており、正確性を保証しない。
投稿の前に必ず各会議の公式サイトで確認すること。

推定締切は前年の同種の締切から機械的に作ったものである。`data.json` と `data.csv` に含めるが、
`estimated` フラグで確定値と区別している。サイト上でも推定であることを明示している。
根拠のない締切を確定値として扱わない方針を採っている。

締切を持たず開催日だけがわかっている会議（ISC High Performance・HOTI・P4 Workshop・Linux Plumbers Conference・情報処理学会 HPC 研究会など）は、種別「開催」の項目としてサイトと `upcoming.md` に出る。
開催の行は会期の最終日を過ぎるまで既定の表示に残る。
締切も開催日も裏が取れていない会議は、どこにも出さない（`data/extra.yaml` には未確認である旨のコメントだけを残してある）。
国内の研究会・シンポジウム（`tags: [domestic-jp]`）は通しやすい発表枠として local 源で維持している。サイトの「国内研究会・国内シンポジウムのみ」で絞れる（`?domestic=1`）。

会期は上流では自由文で書かれており、解釈できない書き方のものは開催イベントを作れない。
日付だけが確認でき、時刻とタイムゾーンが不明な締切は `date-only` として収録する。
この値は UTC、JST、AoE の公式時刻へ変換しない。
サイトは UTC+14 の日付開始から UTC-12 の日付終了までを不確実性区間とし、区間内では終了済みの可能性を表示する。
上流の誤りはそのまま反映されるので、気づいたときは `data/overrides.yaml` で訂正する。

上流のスキーマが変わればビルドが壊れうる。
その場合も前回のスナップショットから生成が続くため、サイトが即座に空になることはないが、データは古いままになる。
