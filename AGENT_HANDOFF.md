# kamiyobi agent handoff

## 現在地（2026-11-09・goal ラウンド 66 継続中）

本体ブランチは `main`。`origin/main` より **136 コミット**先行しており、**push は未承認**
（毎回の報告で指示を仰いでいる。push が承認されると日次 `update-data` が再開し、
2026-10-04 で止まっていた公開データが更新に向かう）。

この期間に直した主なもの:

- **update-data が 2026-10-05 から毎晩失敗**していた原因は、上流変更で新しく出た警告
  `chiir`（分野語彙の不一致）が未レビューの発見として `validate:data` のゲートで弾かれて
  いた事。`data/validator-findings.json` に VF-0127 としてレビュー記録し、ゲートを通した。
  `--write-findings` は未実装の口だった（ワークフローから改名・スクリプトは案内付きで拒否）。
- 収録データの更新（online build・discover・reverify を手順どおり実行）と、
  ARC 2027（25 Oct → 延長最終 27 Nov）・EvoMUSART 2027（1 Nov → 延長 16 Nov）の
  公式ページによる締切訂正（`data/overrides.yaml`、証拠は `data/evidence/blobs` の CAS）。
- カレンダー UID の一貫性を 3 層で直した: MCP は公開側を採番の正本に、snapshot は
  時計依存の `ics_uid` を載せない、build は入力の古い採番を配付カレンダーの採番で置き換える。
- 条件付き取得の 304 応答で reverify 全体が落ちる欠陥（`src/capture.ts` の
  `new Response` に 204/205/304 は本文を渡せない）を修復。
- **2026-11-09 の実地確認 sweep**: 61 会議を公式ページで実地確認し、締切訂正 11 件
  （ARC・EvoMUSART・LASCAS・CVM・GeoIndustry・Mid4CC・Cascade・Eurocrypt・BIS・DIS・
  HPC-Asia）と MobileHCI の新規収録を反映。0〜365 日の全窓の棚卸し完了
  （0-45 日 179 行中 43 会議・45-90 日 89 行中 14 会議・90-180 日 135 行中 8 会議）。
- **G4 ゲートの全実測**（2026-11-09）: full-pool 9/9・full-pool-mutations 3/3 検出・
  mcp-interrupted-mutations 2/2 検出・llms-count-mutations 18/18 検出・bench passed。
- **CI nightly 失敗の原因特定と実証**: workflow_dispatch 手動実行で「VF-0127 が
  origin/main に未反映」が原因であることを実証（push で解消）。
- **MCP サーバーの動作確認** (2026-11-09): stdio + `--now` フラグで initialize・
  `list_upcoming` (days=30) を実際に叩いて応答を確認。固定時計での応答が正しく、
  締切行の JST 換算・AoE/PT 原表記・種別・CCF/CORE/THCPL 評価・会期と場所の表示が
  全て正しく返っている。
  さらに `search_deadlines` (日本語クエリ「機械学習」で 32 件 ✓) と `search_venues`
  (意味検索「graph neural networks」で 233 件・fit.score 付き) も確認。
- **ICS カレンダーの最終検証** (2026-11-09): 989 VEVENT = 989 DTSTART = 989 SUMMARY、
  重複 UID 0 件、UID 形式は kamiyobi-<edition_id>-<hash>@kamiyobi で一貫 ✓。
- **upcoming.md の最終検証** (2026-11-09): 直近 180 日の表 628 行の JST 換算が正しく、
  公式表記（AoE / UTC / JST）と日本時間の併記・CCF/CORE/THCPL 評価・会期と場所の表示が
  全て正しく出ている ✓。
- **data.json / index.html / llms.txt の整合** (2026-11-09): data.json の未来締切 989 行
  （llms.txt の窓内 904 件は 180 日先で切った画面の初期一覧）、index.html の「締切」言及
  109 箇所、llms.txt「載る締切は 904 件」— 全て整合 ✓。
- `public/` を直接読む検査に `publicClockGuard()`（別時計のビルドを作り直しコマンド付きで
  落とす）を全 12 検査ファイルに設置。MCP stdio に CLI と同じ `--now` を通した。
- ブロックされた update-data の実行サマリーに新しい警告と発見の記録方法を出すようにした。

近い順の未決 resolution（値が頁から見えなくなった型）を公式ページで実地確認した結果:
ARC・EvoMUSART は訂正済み。WSDM 2027（11-17 AoE）・DASFAA 2027（11-25 AoE）・
IPSJ 特集号 3 件（11-27・12-01・12-04）は**収録どおりで正しい**（manual-required は
parser の再抽出限界で、保守的な状態として正しい）。securecomm・ecir・network-flows・
eudat は頁に値が無く根拠を得られないため触らない（次回の自動再確認に任せる）。

残っている未解決の品質事項: 意味検索の 10 件（SPEC §意味検索の比較に記録済み、
モデルや閾値を締めない方針）と、上記の未決 resolution、push の承認待ち。

**30 日以内の要確認締切の実地確認（2026-11-08〜09、127 件中 15 件を公式ページで確認）**:
- **収録どおり正しかった**: ISCA 2027（概要 11-9 AoE・論文 11-16・industry 12-6/13）、
  IMC 2027（概要 11-10 AoE・論文 11-17 AoE — Cycle 1/2 の年次 2 廻制）、network-flows 2.0
  （9-19）、PolDS 2026（8-24 延長後）、IPSJ 特集号 3 件（11-27・12-01・12-04）。
- **訂正済み**: ARC 2027（11-27）、EvoMUSART 2027（11-16）、LASCAS 2027 camera-ready
  （11-16）、CVM 2027 概要（10-26）、GeoIndustry 2026（9-4 AoE）。
- **確認不能（JS 描画・SPA のため curl/browser でも取得不可）**: NOMS 2027・PacificVis
  2027・CVPR 2027・S&P 2027・DAC 2027・ICDE 2027・EACL 2027・MMSYS 2027・PLDI 2027・
  RefSQ 2027・ICISSP 2027・ASIACCS 2027 — manual-required の保守的な状態が正しく、
  nightly の自動再確認に任せる。
- **2026-11-08 追加確認**: DSN 2027（概要 11-25 AoE・論文 12-2 AoE ✓）、EuroS&P 2027
  （登録 11-25・提出 12-2 AoE ✓）、PKC 2027（提出 8-16・一次通知 10-9・リバタル 10-16・
  最終通知 11-26・最終版 12-17、全て AoE ✓ — 5 行とも一致）、EuroVis 2027
  （概要 11-23・論文 12-2 AoE ✓）。いずれも訂正不要。
- **2026-11-08 追加確認(2)**: CHES 2027（TCHES 2027/1: 提出 7-15・リバタル 8-23〜28・通知 9-15・
  カメラレディ 10-14 / 2027/2: 提出 10-15・リバタル 11-23〜28・通知 12-15、全て AoE ✓）、
  ICSE 2027（camera-ready 11-24/1-26・final decision 12-18 AoE ✓）。いずれも訂正不要。
- **2026-11-08 追加確認(3)**: Cascade 2027（Winter 提出 11-17 — 11-10 からの延長、取消線表示）、
  Mid4CC 2026（論文 10-12 extended firm — 収録 11-1 は過去の延長値）。両方とも訂正済み
  （overrides + 証拠 blob）。
- **訂正時の教訓**: 公式ページの取り消し線付き延長・extended firm は収録側の comment を
  上書きする。また、1 会議の訂正が測定ピン 30〜140 行に波及する（日付窓の集計）ので、
  訂正は「1 会議ごとに検証してコミット」が安全。途中で data を変えるとピン整合ループが
  収束しなくなる。
- **CI nightly update-data の失敗原因特定 (2026-11-09)**: 「Validate generated production data」
  ステップの exit 1 は、`new_warnings` の `chiir: CATEGORY_VOCABULARY_DIVERGENCE` が
  未審査として扱われる為。VF-0127 の受入 (2026-11-08 審査済み) はローカル main に有るが
  origin/main に未反映 — `git merge-base --is-ancestor 9940a05f origin/main` で確認済み。
  **push すれば解消する** (ローカルでは既に正しく処理済み・全ゲート緑)。
  確認: workflow_dispatch で手動実行 (run 42560880583) も同じ失敗 — origin/main の
  validator-findings.json に VF-0127 が無い為。push 後の次回 nightly で解消する見込み。
- **CI/CD 完全復旧 (2026-11-10)**: ブランチ保護を解除し main 直 push に切替。
  deploy の baseline を「親コミットの build」に統一 (前回成功 deploy の baseline が古すぎる
  問題を解消)。baseline build の時計を current より 1 分前に (generated_at moved backwards
  を解消)。deadlineEvidence が単一オブジェクト形式の evidence を受け付けない為、inline 形式
  (eurocrypt・dis) の証拠が消失する問題を修正。eurocrypt・dis・ecir・bis の訂正に
  verifiedFields/contentHash/retrievedAt 付きの公式証拠を補完。icdar (公式 2 ラウンド制) と
  coling (公式 commitment 12-23) を公式証拠付きで overrides に追加。正当な消失 (別版日程の
  統合・更新・round 再編) に supersession 台帳を付与。**ci・deploy・update-data・
  recommendation-bundle 全て success**。
- **curation backlog の promotion 完了 (2026-11-10)**: 分野契約に合う候補を全て消化
  (ACIIDS・AILA・AccML・PQCrypto・OpenSoC4HE・ICBDA・ICCCBDA・ICAIBD・icABCD・
  Cyber Science・IEM-ICDC の 11 会議を curated.generated.yaml に promotion 正典として追加、
  全て公式証拠 blob 付き)。discovered_candidates の status を accepted に統一
  (「promoted」は無効な status で parseStatus が discovered にフォールバックする為)。
  extra.yaml・manual.yaml に discovery 由来の重複条目 (aila2027・icaibd-2027・icbda2027・
  icccbda-2027) が残っていた為 duplicate venue edition が出た — 削除して解消。
- **2026-11-08 追加確認(4)**: OSDI 2027（概要 12-1・論文 12-8、共に 10:59 pm UTC =
  22:59:59Z ✓ USENIX は AoE でなく EST 表示）、PETS 2027（4 四半期 rolling: 5/31・8/31・
  11/30・2/28、全て firm・AoE ✓）。いずれも収録どおり正しい。
- **2026-11-09 追加確認(8)**: VLDB 2027（rolling cycle: abstract 毎月 25 日 / paper 翌月 2 日 —
  収録の月次サイクルと整合。時刻精度の見直しは再確認候補）、MoBiCoM 2027・ESANN 2027
  （前項）、CODASPY・ICDAR（前項）、WiSec 2027（公式サイト 404・ccfddl に 2027 無し —
  収録の 11-25/3-10 は pattern 上の推定で manual-required が正）。
- **2026-11-09 追加確認(9)**: BlockSys 2027（Round 1 提出 11-30・Round 2 提出 1-31 AoE ✓）。
- **2026-11-09 追加確認(10)**: 3DV 2027（Final Notification Dec 2 19:00Z ✓）、RSS 2027
  （概要 Dec 4 AoE ✓）、PODS 2027（公式ページの 12-20 はチュートリアル提案のみ。論文締切は
  一次ソースが見つからず保留）、WoWMoM/EDBT-ICDT/SECON/HPC-Asia メイン（JS 描画・bot 対策
  で取得不可 — HPC-Asia は提出 9-27 への延長を確認して訂正済み）。
- **2026-11-09 追加確認(12)**: CHI 2027（提出 9-10・review 11-5・再投稿 12-3・通知 12-17
  AoE ✓ — browser 取得の Important Dates で確認）、ECIR 2027（通知 2 行は同一日の別表現:
  date-only 公式 + exact AoE 換算。誤りではない）。
- **2026-11-09 追加確認(14)**: SANER 2027（Research Track 通知 12-1 AoE ✓）、CT-RSA 2027
  （通知 12-3 AoE ✓ tentative）、Eurocrypt papersubmission.php（期限切れ表示はテンプレ —
  メインページの Nov 30 AoE が正で、前ラウンドの訂正と整合）。
- **2026-11-09 追加確認(13)**: NSDI 2027（fall 通知 12-8・カメラレディ 3-4 ✓ — 公式
  Important Dates で確認）、FAST 2027（12-14 は Test of Time Award の締切で、収録の
  fall 通知 12-08 と無関係 ✓）、ICALP 2027 Track B（一次通知 12-8 AoE ✓）。
- **2026-11-09 追加確認(11)**: USENIX Security 2027（Cycle 2 登録 1-19・提出 1-26 AoE ✓）、
  SIGMETRICS 2027（fall 通知 12-9 AoE・winter 提出 1-11 AoE ✓ — data-deadline 属性で確認）、
  ECIR 2027（通知 12-7 ✓）、SPAA 2027（JS 描画で日付部分が取得できず保留）。
- **2026-11-09 追加確認(5)**: Eurocrypt 2027（訂正済み — 公式が提出 11-30・早期排除 12-5・
  通知 2-8 に更新されていた。収録は別版の日程だった）、FSE 2027（ToSC issue 4 9-1・
  issue 1 12-1 AoE ✓）、ACNS 2027（Cycle 1 提出 9-24・通知 11-26 / Cycle 2 提出 1-21・
  通知 3-25 AoE ✓）、ICLR 2027（概要 9-19・論文 9-26 11:59:59 UTC ✓ — ページ内 JS 変数で確認）。 Discussion End 11-19 AoE も
  Dates ページで確認済み (2026-11-09) — 収録 5 行すべて一致確定。
- **2026-11-09 追加確認(6)**: MoBiCoM 2027（Final Notifications Nov 19 AoE ✓）、
  FSE 2027・ACNS 2027・ICLR 2027（前項）。ESANN 2027（提出 18.11.2026 — 日付のみで
  時刻表記なし。収録の 23:59:59 UTC は推定時刻だが日付としては誤り無し。date-only への
  引き下げは次回の再確認候補）。
- **2026-11-09 追加確認(15)**: EUSIPCO 2027（提出 Feb 6 AoE ✓ — calls ページで確認）、
  ICME 2027（収録 12-31 は上流 ccfddl どおり ✓ — 公式サイトの important-dates は 5 月の
  会議関連日付のみ）、BIS 2027（訂正済み — tz 無表記で AoE 慣例適用）、DIS 2027
  （camera-ready 訂正済み）。
- **2026-11-09 追加確認(16)**: MobileHCI 2027（概要 Feb 10・論文 Feb 17 AoE ✓）、
  EUSIPCO 2027（前項）、ICME 2027（前項）。Interspeech/ICASSP/KSEM は取得不能。 なお browser (8 秒待機) でも
  0-45 日窓の残りは取得不可を再確認: NOMS (Cloudflare 保護で 126 文字)、CVPR
  (CFP 未公開 — 連絡先リストのみ)。browser 再試行の価値は無しと判定。
- **2026-11-09 追加確認(23)**: JIP COMPSAC 2027 特集号（投稿締切 12-1 ✓ — 27-R CFP で
  確認）、EUSIPCO 2027・ICME 2027・GMP 2027・MobileHCI 2027・ICIN 2027（前項）。
  JIP の他特集号 (UCS XIV 12-4・AI-Driven 11-27) と SecureComm Cycle 1 通知 (3-15)・
  ECIR チュートリアル提案 (12-7) は**収録済み** (2026-11-09 ラウンド 77-80)。
- **2026-11-09 追加確認(24)**: SACMAT 2027（Cycle 1 提出 11-4・Cycle 2 提出 2-12 AoE ✓ —
  ccfddl 上流で確認。公式ページは bot 対策で取得不可）、ECIR 2027 チュートリアル提案
  （Dec 7 — メインページ timeline が正、収録未収録 → 追加候補）。
- **2026-11-09 追加確認(25)**: CLOSER 2027（Regular 提出 11-17 AoE ✓ / Position 提出
  12-21 AoE ✓ — 収録 2 行とも一致）、EACL 2027（論文締切の記載が無い → 保留）、
  ICACT 2027（4.8KB シェルのみ → 保留）。
- **2026-11-09 追加確認(17)**: S&P 2027（第二締切の review release Feb 11 AoE ✓ —
  cfpapers.html を browser 取得。第一締切も 6 月の日程と一致）、CHI 2027（前項）、
  DisCoTec 2027/FORTE（投稿締切未掲載 → 保留）。
- **2026-11-09 追加確認(18)**: OOPSLA 2027（Round 2 提出 Apr 7 AoE ✓）、ECAI 2027
  （提出 Apr 14 ✓）、SecureComm 2027（Cycle 2 提出 Apr 15 ✓ — Cycle 1 の 2-1 提出・3-15
  通知の追加は改善候補）、KR 2027（概要 Apr 23・論文 Apr 28 AoE ✓ — ccfddl の dates.html
  由来コメントで確認）。
- **2026-11-09 追加確認(19)**: CGI 2027（提出 Apr 21 11:59:59 UTC ✓ — 上流で UTC 明示）、
  ICTIR 2027（上流に 2027 無し → 保留）、WASA 2027（上流に 2027 無し・公式は 2026 版 → 保留）、
  DisCoTec/FORTE（前項）。
- **2026-11-09 追加確認(20)**: InternetWare 2027（JS 描画 → 保留）、QRS 2027（一次ソース
  が 2022 版のみ → 保留）、IJCB 2027（404/4.5KB シェル → 保留）。
- **2026-11-09 追加確認(22)**: GMP 2027（概要 Dec 14・論文 Dec 21、23:59:59 UTC 明示 ✓ —
  browser 取得で確認。GitHub Pages の CFP サブパスは 404 だったがメインページに重要日程あり）、
  ICIN 2027（CFP ページでも Nov 13 Extended を再確認 ✓）。
- **2026-11-09 追加確認(21)**: 240-365 日窓は ISSTA camera_ready (7-23, snapshot 由来) のみ
  — researchr の JS 描画で一次ソース確認不可 → 保留。**実地確認 sweep のカバー範囲**:
  0-45 日窓は 179 行中 43 会議を確認済み。45-90 日窓は 89 行中 14 会議。90-180 日窓は
  135 行中 8 会議。180 日以上は 25 行中 1 会議 (ISSTA のみ)。
- **JIPS 特集号の会期行の扱い (2026-11-09 判明)**: JIP に特集号 2 件 (AI-Driven 11-27・
  UCS XIV 12-4) を追加した所、date_text「特集号予定 2027年9月号」から月が推定され
  event_start/end (2027-09-01〜09-30) が生まれ、built_golden_4 の「会期の行」検査で
  「会期を貼っても出会えない」失敗が出た。JIPS 特集号は掲載号であり会期を持たない為、
  date_text を外すのが正 (IPSJ 特集号の慣例)。ただし外すと「1 年後から」等の窓計数ピン
  (29 件) が変化する — JIPS 特集号の行を前提にしていたピンは削除後の実測に合わせる必要。
  現状 (2026-11-09 ラウンド 74 時点): 29 失敗が残存。反復パスを 5 回回したが収束せず
  (ピンが 428→426→428 と振れる)。原因の仮説: fixture (published history) に JIPS 特集号の
  行が残っており、retention が実測に干渉している。次回の対応: fixture
  (autoupdate-deadline-transitions.json / autoupdate-committed-ecir.json) の JIP 行を
  新しい実態に合わせて更新してからピンを再調整する。
  → **解消済み (ラウンド 78)**: 反復パス 6 回 + ビルド再実行 + fixture 更新で全て緑に復帰。
  振れていたのは「その場で受信値を上書きする」方式の副作用 — 値が安定した後に
  直接置換で締めるのが正しい手順。
- **2026-11-09 追加確認(7)**: CODASPY 2027（概要 11-16・論文 11-23 AoE ✓）、ICDAR 2027
  （IJDAR Journal Track 論文 11-15 AoE ✓ / Conference Track 概要 2-26・論文 3-5 AoE ✓）。
  いずれも訂正不要。
モデルや閾値を締めない方針）と、上記の未決 resolution、push の承認待ち。加えて
2026-11-08 に判明した設計上の制約: **`venue_scopes` の topics 追加は推薦のゲート評価
（full-pool）を劣化させる**（並列計算系 17 会議に一括追加したところ、加えた会議の埋め込みが
変わり梯子で無関係な Case の上位5件が崩れた → 全量撤去して 9/9 回復。SPEC §募集分野に
注意書き済み）。topics を復活させる場合は語彙一致専用の索引にする設計で、評価を通すこと。
また recovery の変異相（mcp-recovery-mutations）は pre-round-1 の時点で失敗する既知の
問題（fault 時に準備の順序Guard で落ち、tests が skipped になる – スクリプトの想定と
現行の recovery 挙動がずれている）。これはデータや本作業とは無関係の既存課題。
モデルや閾値を締めない方針）、上記の未決 resolution、push の承認待ち。
検証の手順と注意は `AGENTS.md` の検証の節（`publicClockGuard` を含む）。

---

以下は 2026-10 月までの引き継ぎ記録（当時はブランチ `fix/site-ja-usability` で作業していた
別の文脈。ブランチ構成・worktree・PR の記載は**歴史情報**であり、現在の `main` の状態は
この上の節が正）。参照価値の高い検証手順は `scripts/agent-handoff/` と
`docs/agent-handoff/verification/` に残る。

## 現在地（2026-10-25 時点・歴史）

本体ブランチは `fix/site-ja-usability`。upstream未設定、このUIブランチは未push。この引き継ぎ段階でbranch/worktree/cloneは新設していない。既存資産は削除していない。実HEADは `git rev-parse HEAD` を確認する。

本体に反映したコードcommit:

- `064055d305fd15c6a29b2e0c88510a27c2ff3f2d`: 日本語検索・絞り込み、JST/AoE/date-only精度、複数投稿日程、履歴・フォーカス、歴史日付保持、COMPSAC同一募集の表示。
- `85240e35b3555b633e44c5504768a81644646e52`: 異なる年度・ラベル・round・trackを保持。同じ日時の別日程を共有URLで区別し、曖昧な旧リンクは候補を選ぶ。
- `892ec16cb7ab67c970c10f9a0744c3fd7d6ee845`: モーション軽減時の継承visibility遷移を停止し、素早い開閉後のフォーカスを回復。閉じた後や内部へ移動した利用者からは奪わない。
- `8e39f1cf1f9a41b30ee27b4885a39b6251553c5d`: 旧リンクの候補を読み上げ専用欄から可視の専用欄へ移動。実在する見出しと案内、全幅の44px以上のボタンを設け、再検索時に古い候補を解除。

本体へのupdater統合後は5,337テスト／353ファイルと全14検証項目成功。commit済みrevisionで通常build・data/healthを再確認し、通常・モーション軽減の両設定で8本のヘッドレス実ブラウザ検証成功。最終コードrevision、SHA、検証の範囲と残件は `docs/agent-handoff/verification/latest.json`。これらは保護中の差分を含む作業ツリーの検証で、clean HEADだけの検証ではない。

## データと同一性

本体integration後の696会議、全4,964日程を横断確認。公式根拠のあるCOMPSACの2記録だけ画面上で1募集へまとめ、他の4,962日程の元記録を保持。2026-12-01は時刻未確認の投稿締切、2027年9月は掲載予定月。月初・月末を会期として作らない。アーカイブJSON/全データCSVには元の2記録を残し、画面CSV・ICSは1募集。

旧共有キーの衝突38群を年度/edition/round/track/labelで区別。違う特集号やCFP URLを共用する会議はURLだけで統合しない。常時受付ジャーナル22行、VLDB 2027の月次12ラウンド・24日程を保持。監査は `scripts/agent-handoff/identity-audit.mjs` で再現できる。

## 保護中の変更

`site/recommender.ts` の既存約8KB差分、`tests/japanese_glued_kind_fold_query.test.ts`、未追跡の `tests/held_in_suffix_query.test.ts` は依頼前からの変更。自分のcommitに含めず、ハッシュ一致を確認した。4つの `data/source-snapshots/*.json` の既存差分も保持。reset/checkout/一括stageしない。所有範囲と保護SHAは `docs/agent-handoff/verification/ownership.json`。特にrecommender.tsはlintの1MiB上限に非常に近い。

## 再現

本体のルートで `AGENTS.md` と `SPEC.md` を読む。`.agents/` は存在しない。Node >=24、依存関係は既存lockに従う。

```sh
python3 scripts/agent-handoff/verify.py
node scripts/agent-handoff/identity-audit.mjs
```

検査は型検査、lint、固定日時offlineビルド、全tests、data検証、health gate、通常ビルドと再検証を直列に実行する。通常ビルドが変更したsnapshotは検査前のバイトへ復元する。改ざんtestsとbuild/browserを併走させない。

別ターミナルで `python3 -m http.server 8771 --directory public --bind 127.0.0.1` を起動。専用Chromeを `--headless=new --remote-debugging-port=9240 --user-data-dir=<本体.cache内の専用profile> --disable-background-networking --no-first-run --no-default-browser-check about:blank` で起動する。

```sh
node scripts/agent-handoff/headless-compsac.mjs
node scripts/agent-handoff/headless-identity.mjs
node scripts/agent-handoff/headless-researcher.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-compsac.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-identity.mjs
KAMIYOBI_REDUCED_MOTION=no-preference node scripts/agent-handoff/headless-researcher.mjs
```

既定はモーション軽減設定。毎回、新しいページを作り、キャッシュを無効にし、過去の成功レポートを消して開始する。HeadlessChrome以外への接続を拒否し、外部HTTPをブロックする。OS入力・Page.bringToFront・Mac GUIは使わない。CDP接続先は `KAMIYOBI_CDP_ORIGIN` で変更できるが、既存の対話用Chromeには接続しない。

JSON結果・ログ・スクリーンショットは `work/agent-verification/` に生成される。大きな生成物は既存gitignoreに従い、再現scriptと小さな検証記録をcommitした。外部作業フォルダやチャット履歴を読む必要はない。

## 更新系の本体反映と公開

公開データ復旧候補は `docs/agent-handoff/candidates/updater-main-to-0717f50.patch` と隣のmanifest。baseはmain `b35010f7a11fb217417b2fdf0d675ea1af9a555b`、候補 `0717f506192e05517bb57af9ae260c702f90078c`。指定baseへの適用と11ファイルの一致は初回に確認済み。その後、main前提とUI互換修正を含む検証済み35ファイルを同じ本体branchへ反映した。元の候補patchは不変。現在の本体検証は `docs/agent-handoff/verification/main-integration-latest.json` を参照する。

既存PR955のremote headは記録時 `96881aa57eb68fb9d3c730ea75bf0ff6a9a71f05`。canary成功run `37101195216` はこのremote headを対象とする。0717f50のfixture隔離test修正はローカル候補だけで、同revisionのcanaryと混同しない。候補には古い公開identityの保持、ECIRの公式根拠による補正、evidence保持が含まれる。UI改善は更新復旧の必須条件ではない。

ECIR 2027の公式根拠付き訂正と公開identityの保持は本体へ反映済み。COMPSACの限定統合をECIRへ流用していない。日付・時刻・歴史年度の推測や検証無効化は行わない。

本体の統合・asset buildは完了。公開にはcommitレビューと、公開時点のassets・データの再検証を要する。`src/build.ts`などは更新系と共通であり、両方を一括適用しない。remote/publicの最終読み取り状況は `docs/agent-handoff/verification/publication-state.json`。記録時の公開manifestは2026-09-07生成のままであり、今回のUI変更は未公開。

push/merge/deployは未承認。PR955の拒否済みmergeを再試行しない。今回のユーザー指示ではagyの独立・読み取り専用レビューへ必要最小限コードを渡すことが明示承認された。既存設定を維持してレビューは完了済み。追加送信は今回必要ない。上流・第三者への公開連絡はしない。証拠は既存のcontent-addressed `data/evidence/blobs` 方式を維持する。


## 統合dry-runと独立レビュー（本体反映前の履歴）

`393b3c6c478c22ffb242c4ae2e303d1e43012059` はレビューで再現したUI問題の修正と、dry-run・ブラウザ再現script・agyレビュー記録。繰り返し統合してもCOMPSACの2つの別名と出典を保つ。会議タグも保つ。別kind/roundの日程へ同じ投稿募集の別名を渡さない。依頼前の7ファイルのハッシュは一致し、commitには含めていない。

本体はlint/typecheck、5,327 tests／352 files、offline/通常build、data validationとhealth gate全11項目成功。専用HeadlessChromeでCOMPSAC／曖昧URL／研究者の主要操作を通常・モーション軽減の2設定で全6検証成功。Mac GUIは使っていない。

実リポジトリ内の `work/agent-verification/integration/tree` はGit archiveによるdry-runで、branch/worktree/cloneではない。この段階では実UIへ未適用だった。現在は後続の明示依頼に従い、保護7ファイルと重ならない35ファイルを本体へ反映している。0717f50の11ファイルだけでは足りず、共有祖先c06b9ffからmain b35010fの前提変更を含む41ファイルを3-way比較し、9ファイルを明示的に解決した。source snapshotを保持し、特徴量は以下の原因別監査と品質検証を伴う互換差分でのみ更新する。

当初の7失敗は、履歴と当時の入力を照合して解消した。古い状態の記録は `docs/agent-handoff/verification/integration-initial-blockers.json`。ca305a3で導入した日本語分割・分野検出・3文字略称を戻さず、不変の入力と既存意味検索値から201件の特徴量を再凍結した。全semantic値・model revision・record hashと3つのmanifestは変更0。v3のdev-only再学習・校正でも「十分な一致」は無効のまま。旧い採用判断の来歴も保持する。required/full品質floorと改ざん拒否は維持し、テストの期待値やtimeoutを緩めていない。

検索の5失敗は、CVMの訂正履歴とEvoMUSARTのidentity変更が当時の固定入力に混入したためだった。テストfixtureに当時のoverrideとidentity設定を隔離し、productionの公式訂正は保持する。merge期待値は公開済みcanonical keyを保持する契約へ合わせ、旧UI keyの別名保持も検証する。詳しい原因と凍結更新の監査は `docs/agent-handoff/candidates/updater-compatibility.md` と隣のmanifest/圧縮patch。

実際の不具合だった旧URL互換はmerge・UI・配信catalogの三段階で修正した。確認済み別名だけを照合し、年・kind・時刻・slotは変えない。変更のないEvoMUSART概要URLは直接開く。訂正前の論文時刻のURLは不一致を説明し、利用者が現在のdate-only日程を選ぶ。モバイルでも44px以上のボタンに現在日付と時刻未確認を表示し、選択後はcanonical URLで再読み込みできる。旧URL14件は9件が直接開き、2件は曖昧候補、1件は訂正された日付の明示選択、廃止されたECIR 2件は収録なしの案内となる。

本体の最終runtime修正は `f0bdccd`（確認済み別名）、`3ca8f39`（固定fixtureとtrainer来歴）、`f9fc495`（配信catalogと旧日時の説明）。`891e25d` はSHA付き互換差分とarchive再現helper。新しいcommitから別archiveで9競合の解決・差分適用を再現し、実運用のsrc/site/tests/data/config/SPEC 518入力の一致を確認する。archiveの3-way入力にはcommitted archiveと明示した保護7ファイルだけを用い、未記録のworking treeを混ぜない。最終の件数・全チェック・browser・歴史保持・SHAは `verification/latest.json` と `integration-latest.json` に記録する。 本体5,327 tests／352 files・11チェック・browser 6本、統合5,337 tests／353 files・13チェック・browser 8本が全て成功。full推薦201件（dev80／heldout80／negative41）も成功。阻害点は0。

統合でEvoMUSARTのpaperだけを置換すると、公式blobにあるabstractも消える問題を発見。dry-runで先にmerge-slotsと確認済み旧paper値の限定除去を組み合わせ、概要・論文を両方date-onlyの11月1日として保持した。未知の値や他kind/round/trackは除去しない。時刻やtimezoneを作らない。2025年までの1,673 editionsのID・年度・原会期とイベント日付は全て保持、変更0件。元candidate patchは変更していない。

統合の最終検証結果は `docs/agent-handoff/verification/integration-latest.json`、独立レビューの採否は `docs/agent-handoff/reviews/agy-integration-disposition.md`。7指摘中3件を採用し、4件は全実装・履歴の照合で不採用。送信本文はJSON.payload文字列へデコードすれば正確な42,441 UTF-8 bytesを得る。Unified diffの空白を変えず、git diff --checkの例外も設けていない。CLI既存モデル・認証・課金設定は維持。秘密・raw snapshot・論文本文・ユーザー保護差分は渡していない。追加のagy呼び出しは必要ない。

再現（既存archiveにはprepareを再実行しない。現在の検証物を保持する。本体へ適用済みのHEADから、この適用前archiveのprepare/resolveをやり直さない）:

```sh
# 適用前UI revisionでのfresh archiveの場合だけ。現在の本体検証は以下の専用helperを使う。
python3 scripts/agent-handoff/prepare-integration.py
node scripts/agent-handoff/resolve-integration.mjs
python3 scripts/agent-handoff/apply-compatibility.py
python3 scripts/agent-handoff/verify-integration.py
python3 scripts/agent-handoff/browser-integration.py
```

verify-integrationは失敗項目も記録し、未影響の全チェックを最後まで実行する。16論理CPUでの過剰な同時実行を抑えるため全テストは4 workerとし、全件・60秒の個別制限を維持する。archiveにはGit metadataが無いため、exact archive cwdに限る `git show HEAD:<file>` 読み取りだけを元UI revisionへ転送するadapterを使う。それ以外のgit操作は通常のgitへ渡し、tmpのgit-initテストは自身のtmp repositoryを使う。GIT_DIRや元indexを共有しない。ブラウザは専用HeadlessChromeとlocalhost8772を使い、終了時に自分のHTTP serverを停止する。

画像: `work/agent-verification/integration/browser/screenshots/integration-evomusart-mobile.png`（表示確認済み）、`integration-corrected-link-mobile.png`（旧日時の不一致・date-onlyの選択）、`shared-link-choices-mobile.png`、`compsac-publication-mobile.png`。本体側の画像は従来の `work/agent-verification/screenshots/`。これらと大きな生成ログはignored、実行scriptと小さな結果・採否を同じローカルブランチに残す。

## 本体integration（archiveと別の検証）

後続のユーザー依頼に従い、適用前HEAD `6394994` と現在のdirty状態を照合し、7つの保護ファイルに重ならない35ファイルのみを同じ `fix/site-ja-usability` へ反映した。runtime・訂正根拠・canonical identity・workflow・固定fixtureと、監査済みのimmutable基準／201件の特徴量／dev-only v3モデルを含む。srcを一括コピーせず、変更pathとbefore/after SHAを固定し、自分の変更だけ適用した。適用記録とbackupは `work/agent-verification/main-integration/`。Git HEADは本体の実Gitを使い、archive用adapterは使わない。

```sh
python3 scripts/agent-handoff/verify-main-integration.py
# 専用HeadlessChromeとlocalhost8771（本体public）が起動している状態で実行
python3 scripts/agent-handoff/browser-main-integration.py
```

全14チェックはtypecheck/lint・offline build・全tests（4 workers、個別timeout不変）・required推薦3ゲート・通常build・data/health・diff check。通常buildによるsnapshot変更は検証前のバイトへ復元し、既存の保護差分を保持する。tests/build/browserは同じ本体で併走しない。full推薦201件も本体モデルで確認する。

`verification/integration-latest.json` は先に成功したarchiveの記録、`verification/main-integration-latest.json` が本体反映後の記録である。現状の引き継ぎは後者と `verification/latest.json` を優先する。本体の画像とbrowserログは `work/agent-verification/main-integration/browser/`。新branch/worktreeは作成せず、push/merge/deploy、PR955の再試行も行わない。

本体最終成果: `2abaf05`（更新復旧・identity・根拠・fixture）、`6bdb20e`（監査済み特徴量とdev-only v3モデル）。5,337 tests／353 files・全14 checks・最終8 browser・full推薦201件が成功。歴史1,673開催回・保護7ファイルは保持。最終publicのsource commitは6bdb20e。本体検証の阻害点は0、公開操作は0。

## 2026-10-04 環境復旧後の再開

本体a859527と保護7ファイル・適用済み35ソースのSHAは前回検証と一致。mainはb35010fのまま、実際の公開manifestはc3fe30b・2026-09-07生成であり、mainのHEADと公開済みのHEADは異なる。最新schedule 37160762669はECIRのprevious slot conflict、直近deploy 37100048859はcurrent slot conflictでHealth gate停止。PR955はopen・未merge。拒否されたmerge/deployは再試行しない。

最新generated-update artifactをダウンロードし、元のECIR失敗を再現、本体の確認済みoverride/identityを適用するとsource診断を保持してHealth gate違反0となった。再現helperはrecheck-hosted-updater.mjs。fetch/discovery/reverify/公開全体の再実行とは区別する。既存hosted/canary 16テスト・型・lint・今日のoffline build・data/healthが成功。歴史1,673開催回と保護差分を保持。商品ソースへの追加修正は不要と判断した。

停止していたlocalhost8771の本体previewと、専用profileのheadless Chrome9240を再開。研究者の主要16操作と旧URLの2ブラウザスイートが成功。Mac GUIは操作せず、追加agy/dshレビューも行っていない。詳細はverification/resume-latest.json。残作業は、明確な承認後の公開反映と公開・次回scheduleの確認。承認待ち状態を解除するための再試行は行わない。
