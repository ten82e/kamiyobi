# kamiyobi

HPC・ネットワーク・システム・AI・セキュリティなどの国際会議、国内研究会、ワークショップ、ジャーナル特集号の投稿締切と開催日を集めています。

[締切を検索する](https://ten82e.github.io/kamiyobi/) · [直近の締切と開催](https://ten82e.github.io/kamiyobi/upcoming.html) · [カレンダーを購読する](https://ten82e.github.io/kamiyobi/deadlines.ics)

## 締切を探す

会議名・分野・開催地を検索し、「締切まで」で期間を絞ります。日時は日本時間（JST）です。時刻未確認の締切は公式の日付のまま表示し、時刻を補いません。投稿の前に公式の募集要項を確認してください。

- 「詳細・投稿日程」で、同じ開催回の概要登録・論文提出などを確認できます。一覧の期間外の日程や別ラウンドも表示します。日付の前後関係だけでは同じ投稿トラックとは判定しません。
- 適用中の条件は結果の上に表示します。各条件の × でその条件だけ外し、「条件クリア」で絞り込みを戻します。
- 検索欄の Enter で結果へ移動します。日本語の変換中は検索を適用しません。戻る・進むで検索条件や詳細を復元できます。
- 「過去の締切も表示」で履歴を読み込みます。推定締切は確定した締切と区別し、表示するか選べます。
- 国内の研究会は「国内研究会・国内シンポジウムのみ」で絞れます。日本で開かれる国際会議とは別の区分です。

画面の「データ生成」と各データ源の取得日時は別です。キャッシュや保存済みデータを使った場合は、その状態も表示します。

## カレンダーと表計算で使う

`deadlines.ics` の URL をカレンダーアプリの購読先に指定すると、更新された締切を継続して読めます。画面の「購読 URL をコピー」から取得できます。

購読用 ICS は収録済みの今後の締切全体です。画面の絞り込みは引き継ぎません。絞った結果を持ち出すには、一覧・推薦候補の CSV または ICS ダウンロードを使います。会期はイベントの説明に入り、締切とは別の開催イベントにはしません。

[upcoming.md](https://ten82e.github.io/kamiyobi/upcoming.md) は直近の締切と開催をまとめた表です。JavaScript が使えない場合は [upcoming.html](https://ten82e.github.io/kamiyobi/upcoming.html) を利用できます。

## 投稿先を探す

「投稿先を探す」で論文の PDF / TXT を読み込むか、タイトル・概要・キーワードを入力します。複数ファイルにも対応しています。候補は一致評価の高い順に並び、「さらに表示」「すべて表示」で続きを確認できます。

論文はブラウザ内で処理します。論文の本文は共有 URL に含めません。入力は同じタブの `sessionStorage` に保存し、欄を空にすると保存した下書きも消します。保存できない環境でも入力できます。

意味検索用のモデルや PDF 処理ライブラリには外部接続が必要です。埋め込みを利用できない場合は語彙検索で動き、状態を画面に表示します。分類が同じという理由だけでは推薦せず、会議名・主題などの一致根拠がある候補を評価します。一致評価は採択率や投稿成功の確率を表すものではありません。

## 機械可読の出力

まず次の 5 つを使えます。表示用カタログと全履歴は用途が異なるため、全件を調べるときは `data.json` を参照してください。

| ファイル | 内容 |
|---|---|
| [llms.txt](https://ten82e.github.io/kamiyobi/llms.txt) | 出力ファイルとデータ形式の索引 |
| [data.json](https://ten82e.github.io/kamiyobi/data.json) | 正規化した収録データ全体。締切の精度、推定、根拠、履歴を含む |
| [data.csv](https://ten82e.github.io/kamiyobi/data.csv) | 1 行 1 締切の表 |
| [health.json](https://ten82e.github.io/kamiyobi/health.json) | データ源の状態、警告、確認・推定の件数など |
| [publish.json](https://ten82e.github.io/kamiyobi/publish.json) | 公開成果物のハッシュ、生成元、意味検索の利用状態 |

画面の初期一覧は `catalog.json`、推薦用プロフィールは `recommendation-index.json` です。日付のみの締切は `local_date` と不確実性区間を持ち、`utc` は `null` です。区間の端を公式締切時刻として扱わないでください。

クローラと AI の入口は三段です。[robots.txt](https://ten82e.github.io/kamiyobi/robots.txt) が [sitemap.xml](https://ten82e.github.io/kamiyobi/sitemap.xml) と `llms.txt` の絶対 URL を名指し、`sitemap.xml` は人が開ける口（画面・直近の表・索引）だけを並べます。データのファイルは索引が名指します。

### MCP サーバとして使う

リポジトリ内で `npm ci` を実行した後に起動します。

```sh
node src/mcp.ts
```

stdio の読み取り専用サーバです。外部への送信は行わない設計で、保存済みの収録データと、存在すればビルド済みカタログ・推薦インデックスを読みます。

接続した AI には、`initialize` の `instructions` で使い方の手引きを一度に渡します。日時の精度（`date-only` に時刻を作らない）、推定を確定として案内しないこと、既定で返す範囲と `scope` の二つ、会期と締切の別、投稿の前に公式ページを確かめること、どの道具をいつ使うかを書いています。道具を足したらこの手引きの「道具:」の行も直します（`tests/mcp_server.test.ts` が `tools/list` と突き合わせます）。

| ツール | 用途 |
|---|---|
| `search_deadlines` | 日本語の検索と締切の絞り込み。構造化結果とページ送りに対応 |
| `list_upcoming` | 今日から指定日数以内の締切と開催日程 |
| `venue_info` | 会議の開催回、締切、ランク、会期 |
| `explain_word` | 検索語に当たる行と、検索できない語への案内 |
| `collection_stats` | 収録数、生成時刻、確認状態、配布ファイル |
| `search_venues` | 全収録会議から研究テーマ・題名・概要で投稿先を検索 |
| `recommend_venues` | 論文情報に合う投稿先の候補 |

`search_venues` と `recommend_venues` は `retrieval: "semantic"` で英日実モデルを使えます。`node src/prepare-models.ts` でモデルだけを `.cache/embedding-models` に準備できます。`--offline` を付けると外部接続せずに読込・推論を確認します。未準備ならエラーを返します。指定しない場合は従来の語彙検索です。

`search_deadlines` は画面と同じ検索処理を使います。`scope: "screen"` は初期一覧（`catalog.json`）、`scope: "all"` は**収録の元データ**（`data/snapshot.json`）です。初期一覧のファイルがない場合は全体へ切り替え、その旨を返します。**件数を画面と比べるときは注意してください**: 公開している `data.json` は重複をまとめた後なので、`all` の行数はそれより多くなります（画面の「収録の全体を読み込む」が読むのは `data.json` の方です）。

結果の `structuredContent` は `total`・`rows`・`next_offset` を持ちます。続きは同じ検索条件で `next_offset` の値を `offset` に指定します。日付のみの締切の `utc`・`jst` は `null` で、推定期間と確認状態も別に返します。検索の注意点はテキスト結果に含まれます。

手元で結果を見る場合は、次のように一回だけ実行できます。

```sh
node src/mcp.ts search "セキュリティ" 5
node src/mcp.ts venue_info sc
```

## データ源とライセンス

| 名前 | リポジトリ | ライセンス |
|---|---|---|
| `ccfddl` | [ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) | MIT |
| `aideadlines` | [huggingface/ai-deadlines](https://github.com/huggingface/ai-deadlines) | MIT |
| `local` | 本リポジトリの `data/manual.yaml` と `data/curated.generated.yaml` | MIT（本リポジトリ） |

発見ソース（候補生成）は `DBLP`、`OpenReview`、`wikiCFP`（70 カテゴリ）、`DBWorld` メーリス公開アーカイブ、`EasyChair` Smart CFP、IEEE ComSoc 誌特集号、IEICE 論文誌特集号、IPSJ 論文誌特集号である。
DBWorld は[公開アーカイブ](https://dbworld.sigmod.org/)から、wikiCFP に載らない併設ワークショップ、ジャーナル特集号、締切延長通知を拾う。
EasyChair は[公開 CFP 一覧](https://easychair.org/cfp)から、運営者が登録した締切、場所、トピックを分野フィルタ付きで取得する。
IEICE と IPSJ は、それぞれ[特集号 CFP 一覧](https://www.ieice.org/eng_r/information/schedule/journals.php)と[特集論文募集一覧](https://www.ipsj.or.jp/journal/index.html)を使う。
候補は締切を公式サイトで裏取りした後、promotion batch を経て `data/curated.generated.yaml` に昇格する。

手入力の会議は `data/manual.yaml` に記録する。
`data/extra.yaml` は既存データからの移行入力として残し、正典にはしない。
promotion から生成した正典を更新するには `npm run generate:curated` を実行する。
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
運用上の確認対象は `data/discovery/active.yaml` であり、期限切れ・重複・対象外などの候補は
`data/discovery/archive.json` に理由付きで移す。
候補は公式サイトで裏取りするまで `manual.yaml` または `curated.generated.yaml` には昇格しない。
探索対象を分野や年で絞るには `--categories`（例: `hpc,systems`）と
`--min-year`（省略時は実行時の UTC 年）を使う。

溜まった候補を締切昇順・重複・ハゲタカ会議の疑い付きで一覧するには `review` を使う。

```sh
node src/cli.ts review
```

`--limit` で表示件数を絞り、`--candidates` で候補 YAML の場所を変えられる。
候補の昇格（下記）の前に、ここで重複や怪しい候補を確認する。

**候補の昇格手順**（収録の裏取り原則: 締切は公式サイトで HTTP 確認できたもののみ）:

1. `data/discovery/active.yaml` から気になる候補を選ぶ
2. `scripts/observe-cfp.ts --url <公式URL> --body <保存先>` で公式ページの応答と本文を保存する。`--body` は必須
3. 観測 JSON に会議・カテゴリのレビュー結果を付け、`scripts/verify-cfp.ts` で本文 hash、公式ドメイン、抽出値、取得版を検証する
4. `scripts/promote-candidates.ts` で本文を同梱した manifest 付き batch を生成し、`npm run generate:curated` で生成された正典を確認する
5. ビルドして収録されることを確認する

公式ページの再確認は、公開済み `data.json` の次回確認時刻を過ぎた締切だけを対象にする。
本文は SHA-256 付きで `data/evidence/blobs/` に保存し、日付の変更は台帳へ記録する。
公開データを自動上書きしないため、変更後の値は台帳の resolution を確認してから反映する。

```sh
node src/cli.ts reverify --due --now 2026-08-31T00:00:00Z
```

証拠本文の参照整合を検査し、未参照本文を回収する。

```sh
node src/cli.ts evidence verify
node src/cli.ts evidence gc --dry-run
```

上流の取得結果は `data/source-snapshots/` に源ごとに保存する。
一次ソースの退避は `data/source-snapshots/primary.json` を使い、オフラインビルドでも検証済み観測を復元できる。

## 更新の仕組み

手元では次の順で更新する。push 後は `.github/workflows/ci.yml` が同じ検査を実行し、
main では `deploy.yml` が Pages を配信する。

```sh
# 1. 上流を取得して正規化し、一次ソース観測を適用する
node src/fetch-primary.ts --apply
# 1b. 国内研究会の会期・締切を研究会別スケジュール表から更新する（既定は dry-run）
node scripts/refresh-ieice.ts --cache-dir .cache/ieice
#     新しい研究会を足すときは data/manual.yaml へ editions: [] のブロックを置いてから
#     実行する（研究会名は公式ページのタイトルから取る。dry-run で追加予定が出るはず）
#     情報処理学会の研究会も同じスケジュール表に乗っているので、ipsj.or.jp が 403 でも
#     IPSJ の研究会（HPC・CSEC・ARC・EMB・SE・DPS・UBI・DBS・AL・IFAT・CGVI・IOT）は
#     ここで更新できる
node scripts/refresh-ieice.ts --cache-dir .cache/ieice --apply
# 2. 候補探索（新規会議の発見）
node src/cli.ts discover
# 3. promotion batch から local 正典を生成
npm run generate:curated
# 4. フルビルド（public/ を生成）
node src/cli.ts build --out public
# 5. 意味検査と health gate
npm run update
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

次のコマンドでローカルサーバを起動し、`http://localhost:8000/` を開きます。モジュールや JSON を取得するため、ファイルを直接開く方法は使いません。

```sh
python3 -m http.server 8000 --directory public
```

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
| `--offline` | 上流や埋め込みモデルを取りに行かず、上流はキャッシュ、それも無ければ `data/snapshot.json` を使う |
| `--history-baseline PATH` | 公開済み履歴の比較元JSONを指定する。未指定なら開始時のsnapshotを使い、過年度の会期・締切を根拠なく短縮・削除しない。自動更新は公開manifestのハッシュと照合したdata.jsonを使う。 |
| `--history-report PATH` | 履歴保持の判断と比較元hashを診断JSONに保存する。公開ファイルとは別の場所を指定する。 |
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
`keep_if_no_rank` を真にしておくと、ランク情報を持たない会議（local 正典由来のものなど）が落ちない。

```yaml
rank_filter:
  ccf: [A, B]
  core: ['A*', A, B]
  keep_if_no_rank: true
```

上流にない会議を手入力で足したいときは `data/manual.yaml` に書く。
上流の記述が誤っているときは `data/overrides.yaml` で訂正するか、除外する。
どちらも編集後は手元でビルドし直して結果を確かめる。

## 既知の限界

締切情報は上流データに依存しており、正確性を保証しない。
投稿の前に必ず各会議の公式サイトで確認すること。

推定締切は前年の同種の締切から機械的に作ったものである。`data.json` と `data.csv` に含めるが、
`estimated` フラグで確定値と区別している。サイト上でも推定であることを明示している。
根拠のない締切を確定値として扱わない方針を採っている。

締切を持たず開催日だけがわかっている会議（ISC High Performance・HOTI・P4 Workshop・Linux Plumbers Conference・情報処理学会 HPC 研究会など）は、種別「開催」の項目として `upcoming.md` と `upcoming.html` に出る。締切一覧には開催行を出さない。
開催の行は会期の最終日を過ぎるまで既定の表示に残る。
締切も開催日も裏が取れていない会議は、どこにも出さない（手入力ファイルには未確認である旨のコメントだけを残せる）。
国内の研究会・シンポジウム（`tags: [domestic-jp]`）は通しやすい発表枠として local 源で維持している。サイトの「国内研究会・国内シンポジウムのみ」で絞れる（`?domestic=1`）。
電子情報通信学会の研究会は[研究会発表申込システムの開催スケジュール表](https://ken.ieice.org/ken/program/)を裏取り元にする。この表は「発表申込締切日」を**日付だけで**示すため、締切は `date-only`（サイトでは「時刻未確認」）で収録する。時刻を補完しない。次の回の締切が未公開の会は会期だけ収録し、締切欄は空のままにする。

会期は上流では自由文で書かれており、解釈できない書き方のものは開催イベントを作れない。
日付だけが確認でき、時刻とタイムゾーンが不明な締切は `date-only` として収録する。
この値は UTC、JST、AoE の公式時刻へ変換しない。
サイトは UTC+14 の日付開始から UTC-12 の日付終了までを不確実性区間とし、区間内では終了済みの可能性を表示する。
上流の誤りはそのまま反映されるので、気づいたときは `data/overrides.yaml` で訂正する。

上流のスキーマが変わればビルドが壊れうる。
その場合も前回のスナップショットから生成が続くため、サイトが即座に空になることはないが、データは古いままになる。

延期した開催回は「2021年版・開催は2022年」のように区別し、詳細に会期の根拠を示します。オンライン日と現地の日が離れている場合や週次セミナーは、各開催日を分けて表示します。機械処理では `data.json` / `data.csv` の `event_segments` を参照してください。原文の期間の開始・終了だけでは連続開催を意味しません。

「元の日時」は収録元の時刻・タイムゾーンです。公式サイトで再確認できたかどうかは、別の確認状態で表示します。集約サイトの日時を公式で確認済みとは扱いません。
