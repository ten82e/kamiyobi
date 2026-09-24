import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import {
  data,
  FILTER_RUNTIME_STUBS,
  keydownWithBlockers,
  site,
  siteHtmlRuntime,
} from "./built_golden_shared.ts";
import { REPO_ROOT, runCli } from "./helpers.ts";
import { jsFunction, liveNoteSource, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

it("相対週が実カタログで其の週 7 日と同じ行を出し、暦日でも引ける（SPEC §7）", () => {
  // 「来週」が 0 件、`8月11日` が 0 件だった（hay に暦日が無く、週の語も展開しなかった）。
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const hit = (q) => { const m = Recommender.searchMatcher(q, now); return view.filter((r) => m(r.hay)); };",
    // 来週 = 8/10〜8/16（月曜始まり）。7 日の和集合と同じ行になること。
    "const week = hit('来週');",
    "const days = Recommender.weekDayTermsJa('来週', now);",
    "const union = view.filter((r) => days.some((d) => String(r.hay).indexOf(d) >= 0));",
    // 週の外の日を交えないことも、実際の行で見る（週末日曜の翌日を含む行があるとは限らないので、
    // 週の日付そのものを持つ行が和集合に入っていることを確認する）。",
    "const outside = view.filter((r) => {",
    "  const j = new Date(r.t + 9 * 3600000);",
    "  const key = j.getUTCFullYear() + '年' + (j.getUTCMonth() + 1) + '月' + j.getUTCDate() + '日';",
    "  return !r.dateOnly && days.indexOf(key) < 0 && week.indexOf(r) >= 0;",
    "});",
    "const byDay = hit('8月22日').length;",
    "console.log(JSON.stringify({ week: week.length, union: union.length, outside: outside.length, byDay, days: days.length }));",
    "})();",
  ]
    .filter((line) => !line.trim().endsWith('",') || !line.includes("// "))
    .join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    week: number;
    union: number;
    outside: number;
    byDay: number;
    days: number;
  };
  expect(out.days).toBe(7);
  expect(out.week, "「来週」が 0 件のまま").toBeGreaterThan(0);
  expect(out.week, "週 7 日の和集合と違う行を出している").toBe(out.union);
  expect(out.outside, "週の外の日を持つ行を交えている").toBe(0);
  expect(out.byDay, "暦日（8月22日）で引けない").toBeGreaterThan(0);
});

it("論文から探すの候補も「さらに表示」で全件に到達する（SPEC §7）", () => {
  const runtime = siteRuntime("app.js");
  // 変更前は推薦カードを 5 件で打ち切り、`#more` を常に隠していた。件数欄は候補総数
  // （実測で 49〜200 件）を出すので、「200 件」と言いながら 5 件しか見えず、
  // 残りに到達する手段が無い画面になっていた。
  const page = runtime.match(/const RECOMMENDATION_PAGE = (\d+);/);
  expect(page, "推薦カードの初期表示件数が決まっていない").not.toBeNull();
  expect(Number(page?.[1])).toBeGreaterThan(5);
  expect(runtime).toContain("cardsDrawn = Math.min(list.length, RECOMMENDATION_PAGE);");
  expect(runtime).toContain("list.slice(0, cardsDrawn)");
  // 推薦モードでも「さらに表示」を生かし、残り件数を同じ形で見せる。
  expect(runtime).toContain("updateMoreButton(cardsDrawn, recommendationList.length);");
  expect(runtime).toContain('if (!$("recommendationCards").hidden) {');
  expect(runtime).toContain("drawMoreCards();");
  // 「さらに表示 (残り N 件)」の組み立ては一か所（表とカードで文言がズレないようにする）。
  expect((runtime.match(/さらに表示 \(残り/g) || []).length).toBe(1);
  // 件数欄の言い切りと画面を食い違わせない。
  expect(runtime).toContain("まず上位 ${countJa(RECOMMENDATION_PAGE)} 件を表示");

  // ラベルと表示可否は本物を実行して見る（書き写すと「残り」の対応がズレる）。
  const script = [
    `const countJa = (${jsFunction(runtime, "countJa")});`,
    "const more = { hidden: null, textContent: '' };",
    "const showAll = { hidden: null, textContent: '' };",
    /* 画面には「さらに表示」と「すべて表示」の 2 つのボタンが並ぶので、返す物は id で
     * 分ける。1 つの物を返すと、のちに足した側の文言が `more` に写ってしまい、この検査が
     * 画面に無い文言を待つ形になる（第 272 回の実発生）。 */
    "const $ = (id) => (id === 'showAll' ? showAll : more);",
    `const moreButtonLabel = ${jsFunction(runtime, "moreButtonLabel")};`,
    `const showAllButtonLabel = ${jsFunction(runtime, "showAllButtonLabel")};`,
    `const updateMoreButton = ${jsFunction(runtime, "updateMoreButton")};`,
    "const seen = [];",
    "for (const [drawn, total] of [[0, 200], [20, 200], [180, 200], [200, 200]]) {",
    "  updateMoreButton(drawn, total);",
    "  seen.push([more.hidden, more.textContent].join('/'));",
    "}",
    "console.log(JSON.stringify(seen));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual([
    "false/さらに表示 (残り 200 件)",
    "false/さらに表示 (残り 180 件)",
    "false/さらに表示 (残り 20 件)",
    "true/さらに表示 (残り 20 件)",
  ]);

  // 0 件の案内は、この画面に無い条件へ利用者を送らない（推薦モードでは
  // 検索・分野・国内などの絞り込みを見せていない）。
  expect(runtime).not.toContain("該当する投稿先がありません。論文本文を長めに入れるか");
  expect(runtime).toContain("タイトル・概要・キーワードを足すと当たりやすくなります");
});

it("同じ締切時刻の行は表に出る会議名と種別で並ぶ（SPEC §7）", () => {
  const runtime = siteRuntime("app.js");
  // 既定画面 477 行のうち 303 行が別の行と同じ締切時刻を持つ（同値グループは最大 17 行）。
  // 変更前のタイはデータ源の順のままだった。
  // 第 91 回で昇降の掛け算は比較関数の内側へ移した（外で掛けると、締切の時刻を
  // 持たない行が降順で先頭に反転して「いちばん遠い」に化けるため）。
  expect(runtime).toContain("return compareDeadlineRows(a, b, mult);");
  // ランク順も同じ評価の塊の中を読めるようにする。
  expect(runtime).toContain("return cmp ? cmp * mult : compareDeadlineRows(a, b, mult);");
  expect(runtime).not.toContain("compareDeadlineRows(a, b) * mult");
  // 並び順は表のセルに出る語を共通の helper で使う（セルとSORTが別文字列を持つのが原因）。
  expect(runtime).toContain("const name = conferenceNameCell(r);");
  expect(runtime).not.toContain('localeCompare(b.conf.title || "")');
  // ロケールを明示しない比較は閲覧者の UI ロケールで順序が変わる（実測で en/de と ja が違った）。
  expect(
    (runtime.match(/\.localeCompare\(conferenceNameCell\(b\), "ja"\)/g) || []).length,
  ).toBeGreaterThanOrEqual(2);

  const consts = /const SELECTABLE_KINDS = [^\n]*;/.exec(runtime)?.[0];
  expect(consts, "種別の並び順の元になる配列がない").toBeTruthy();
  const script = [
    consts,
    `const kindSortIndex = ${jsFunction(runtime, "kindSortIndex")};`,
    `const titleWithYear = ${jsFunction(runtime, "titleWithYear")};`,
    `const conferenceNameCell = ${jsFunction(runtime, "conferenceNameCell")};`,
    `const compareDeadlineRows = ${jsFunction(runtime, "compareDeadlineRows")};`,
    "const row = (title, key, t, kind, year) => ({ conf: { title, key }, ed: { year }, t, kind });",
    // 同じ時刻の3行。漢字名は読み基準の五十音順（航空=か → 情報=ざ）に並ぶ。
    "const tied = [",
    "  row('情報処理研究会', 'ipsj-hi', 1, 'paper', 2027),",
    "  row('航空宇宙研究会', 'ipsj-ast', 1, 'paper', 2027),",
    "  row('ネットワーク研究会', 'ipsj-nw', 1, 'paper', 2027),",
    "];",
    "const byName = tied.slice().sort(compareDeadlineRows).map((r) => conferenceNameCell(r));",
    // 名前の末尾に年が付く（セルと同じ文字列で並んでいることを見る）。
    "expect_year = byName.every((n) => n.endsWith('2027'));",
    // 会議名も時刻も同じなら、種別セレクトに並べる順（概要 → 論文）で割る。
    "const sameKind = [",
    "  row('SC', 'sc', 5, 'paper', 2027),",
    "  row('SC', 'sc', 5, 'abstract', 2027),",
    "  row('SC', 'sc', 5, 'journal', 2027),",
    "];",
    "const kinds = sameKind.slice().sort(compareDeadlineRows).map((r) => r.kind);",
    // 時刻が違う行は種別より先に関係なく時刻で並ぶ。
    "const times = [row('B', 'b', 9, 'abstract', null), row('A', 'a', 3, 'paper', null)];",
    "const byTime = times.slice().sort(compareDeadlineRows).map((r) => r.conf.key);",
    // 入力順を変えても結果が同じ（表の並びをビルド・描画順に依存させない）。
    "const many = [];",
    "for (let i = 0; i < 40; i += 1) {",
    "  many.push(row('会議' + (i % 5), 'k' + (i % 5), (i % 3) * 7, i % 2 ? 'paper' : 'abstract', 2027));",
    "}",
    "const forward = many.slice().sort(compareDeadlineRows).map((r) => [r.conf.key, r.kind, r.t].join(':'));",
    "const backward = many.slice().reverse().sort(compareDeadlineRows).map((r) => [r.conf.key, r.kind, r.t].join(':'));",
    // 降順は昇順の完全な逆順になる（矢印を押しただけで並びの意味が崩れない）。",
    "const asc = many.slice().sort(compareDeadlineRows);",
    "const desc = many.slice().sort((x, y) => compareDeadlineRows(y, x));",
    "console.log(JSON.stringify({",
    "  byName,",
    "  expect_year,",
    "  kinds,",
    "  byTime,",
    "  deterministic: JSON.stringify(forward) === JSON.stringify(backward),",
    "  reversed:",
    "    JSON.stringify(desc.map((r) => [r.conf.key, r.kind, r.t].join(':'))) ===",
    "    JSON.stringify(asc.map((r) => [r.conf.key, r.kind, r.t].join(':')).reverse()),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    byName: string[];
    expect_year: boolean;
    kinds: string[];
    byTime: string[];
    deterministic: boolean;
    reversed: boolean;
  };
  expect(out.byName).toEqual([
    "ネットワーク研究会 2027",
    "航空宇宙研究会 2027",
    "情報処理研究会 2027",
  ]);
  // カタカナ語は漢字語より前の段に出る（読み辞書を持たないため。仕様として固定する）。
  expect(out.expect_year).toBe(true);
  expect(out.kinds).toEqual(["abstract", "paper", "journal"]);
  expect(out.byTime).toEqual(["a", "b"]);
  expect(out.deterministic, "入力順で表の並びが変わる").toBe(true);
  expect(out.reversed, "降順が昇順の逆順になっていない").toBe(true);
});

it("共有URLに論文の本文を載せず、そのことを画面で伝える（SPEC §10）", () => {
  const app = siteRuntime("app.js");
  const html = siteHtmlRuntime();
  /* URL に書き出すのはモードと絞り込みだけ。論文のタイトル・概要・キーワードを
   * クエリに載せると、未発表の原稿がリンク・チャットプレビュー・閲覧履歴・サーバログに
   * 残る。将来「共有が復元されない」という報告で足されないよう、不変条件として固定する。 */
  const writeUrl = jsFunction(app, "writeUrl");
  const readUrl = jsFunction(app, "readUrl");
  expect(writeUrl).toContain('p.set("mode", state.mode)');
  expect(writeUrl.toLowerCase()).not.toMatch(/paper|abstract|keyword/);
  expect(readUrl.toLowerCase()).not.toMatch(/paper|abstract|keyword/);
  /* 論文の本文が入らないことは、気づかなければ「リンクが壊れた」に見える。
   * 入力する場所と、空のときに出る案内の両方に書く。 */
  expect(html).toContain("共有用URLには論文のタイトル・概要を含めません");
  expect(app).toContain("リンクで開いた場合はここが空になります");
  // 案内は推薦モードのpanelに出す（てびきは推薦画面では畳まれるため、あてにできない）。
  const panel = html.slice(
    html.indexOf('class="recommend-only"'),
    html.indexOf('id="recommendationCards"'),
  );
  expect(panel).toContain("共有用URLには論文のタイトル・概要を含めません");
});

it("論文の入力は同じタブなら刷新を耐え、リンクには乗らない（SPEC §7・§10）", () => {
  /* 2026-09-23 実測: 論文の入力（タイトル・概要・キーワード・参考論文）は DOM の中にしか無く、
   * `sessionStorage` / `localStorage` への書き込みはソースコードに 0 件だった。概要を数百文字貼って
   * 画面を刷新すると貼り直しになる – 「投稿先を探す」で失う量が最も大きい画面なので、
   * 同じタブのセッション中だけ憶える形にした（上の検査の通り、URL には載せない）。 */
  const app = siteRuntime("app.js");
  const src = [
    app.match(/const PAPER_DRAFT_KEY = "[^"]*";/)?.[0] ?? "",
    jsFunction(app, "paperInputHasText"),
    jsFunction(app, "readPaperInput"),
    jsFunction(app, "writePaperInput"),
    jsFunction(app, "savePaperDraft"),
    jsFunction(app, "loadPaperDraft"),
    jsFunction(app, "restorePaperDraft"),
  ];
  expect(src[0], "下書きの key 定義が見つからない").toBeTruthy();
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const els = {};",
    "for (const id of ['paperPrimaryTitle', 'paperPrimaryAbstract', 'paperPrimaryKeywords', 'paperReferences']) els[id] = { value: '' };",
    "function $(id) { return els[id] || null; }",
    "function valueElement(id) { return els[id]; }",
    "function inputElement(id) { return els[id]; }",
    "let paperPrimaryVenue = '';",
    "const store = new Map();",
    "const throwing = Boolean(Number(process.env.DRAFT_THROW));",
    "const window = {",
    "  sessionStorage: {",
    "    getItem: (k) => { if (throwing) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },",
    "    setItem: (k, v) => { if (throwing) throw new Error('denied'); store.set(k, String(v)); },",
    "    removeItem: (k) => { if (throwing) throw new Error('denied'); store.delete(k); },",
    "  },",
    "};",
    src.join("\n"),
    "const setAll = (v) => {",
    "  els.paperPrimaryTitle.value = v.title || '';",
    "  els.paperPrimaryAbstract.value = v.abstract || '';",
    "  els.paperPrimaryKeywords.value = v.keywords || '';",
    "  els.paperReferences.value = v.references || '';",
    "  paperPrimaryVenue = v.venue || '';",
    "};",
    "const out = {};",
    // 1) 打ち込んだ内容は key を分けて憶える
    "setAll({ title: '低遅延ミドルウェア', abstract: '概要です'.repeat(40), keywords: '分散, ミドルウェア', references: 'Ref A | x | ICDCS', venue: 'ICDCS' });",
    "savePaperDraft(readPaperInput());",
    "const saved = JSON.parse(store.get(PAPER_DRAFT_KEY) || 'null');",
    "out.saved = saved && { title: saved.title, abstract: saved.abstract.slice(0, 2), keywords: saved.keywords, references: saved.references, venue: saved.venue };",
    // 2) 全部消したら記憶も消える（「論文の入力を消す」で消えた物が戻ってくる形を作らない）
    "setAll({});",
    "savePaperDraft(readPaperInput());",
    "out.消したあと = store.has(PAPER_DRAFT_KEY);",
    // 3) 欄が空なら戻す（掲載先の指定も戻る）
    "setAll({ title: '低遅延ミドルウェア', abstract: 'あ'.repeat(80), venue: 'ICDCS' });",
    "savePaperDraft(readPaperInput());",
    "setAll({});",
    "out.戻った = restorePaperDraft();",
    "out.戻った内容 = { title: els.paperPrimaryTitle.value, abstract: els.paperPrimaryAbstract.value.length, venue: paperPrimaryVenue };",
    // 4) 打ち込み中の物があれば上書きしない
    "setAll({ title: '打ち込み中' });",
    "out.上書きした = restorePaperDraft();",
    "out.打ち込み中が残った = els.paperPrimaryTitle.value;",
    // 5) 空の下書きは戻さない
    "store.set(PAPER_DRAFT_KEY, JSON.stringify({ title: '   ', abstract: '' }));",
    "setAll({});",
    "out.空を戻した = restorePaperDraft();",
    // 6) 壊れた JSON・記憶できない環境でも落ちない
    "store.set(PAPER_DRAFT_KEY, '{');",
    "setAll({});",
    "out.壊れたとき = restorePaperDraft();",
    "console.log(JSON.stringify(out));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const run = (env: Record<string, string>) =>
    spawnSync("node", ["-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ...env },
    });
  const proc = run({ DRAFT_THROW: "0" });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, unknown>;
  expect(out.saved).toEqual({
    title: "低遅延ミドルウェア",
    abstract: "概要",
    keywords: "分散, ミドルウェア",
    references: "Ref A | x | ICDCS",
    venue: "ICDCS",
  });
  expect(out.消したあと, "欄を空にしたのに記憶が残っている").toBe(false);
  expect(out.戻った).toBe(true);
  expect(out.戻った内容).toEqual({ title: "低遅延ミドルウェア", abstract: 80, venue: "ICDCS" });
  expect(out.上書きした, "打ち込み中の欄を下書きで上書きした").toBe(false);
  expect(out.打ち込み中が残った).toBe("打ち込み中");
  expect(out.空を戻した, "空の下書きを戻した").toBe(false);
  expect(out.壊れたとき).toBe(false);
  // 記憶できない環境（シークレットモード等）では、例外で見えなくならない
  const denied = run({ DRAFT_THROW: "1" });
  expect(denied.status, denied.stderr).toBe(0);
  expect(JSON.parse(denied.stdout).戻った).toBe(false);

  /* 実際に効いている場所（欄の読み直し・消す操作・起動時）で呼ばれていることを、ソースコードで押さえる。
   * 上の検査は関数を直接動かすので、配線を外しても通ってしまう – ここが実動作の検査になる。 */
  expect(jsFunction(app, "syncPaperText")).toContain("savePaperDraft(readPaperInput())");
  expect(jsFunction(app, "clearPaperInput")).toContain("savePaperDraft(readPaperInput())");
  const boot = app.slice(app.lastIndexOf("toForm();"));
  expect(boot).toContain("restorePaperDraft()");
  /* 覚えておくことは、気づかないと「相手の原稿が来た」と誤読される。欄の下に書く。 */
  const html = siteHtmlRuntime();
  expect(html).toContain("このタブの間は覚えておきます");
  expect(html).toContain("相手の原稿ではなく自分の下書き");
  // 上の不変条件（URL に本文を載せない）を、記憶の導入でも崩していないこと。
  expect(jsFunction(app, "writeUrl").toLowerCase()).not.toMatch(/paper|abstract|keyword|draft/);
});

it("開催地を日本語で引け、アクセント付きのつづりは ASCII で当たる（SPEC §7）", () => {
  /* 開催地は公式表記（`Seattle, USA` / `Montréal`）のまま変えない。日本人は「シアトル」
   * 「米国」「montreal」と打つので、検索語側だけで届かせる。実データで測る:
   * 変更前は `東京` 0 件（`tokyo` は 28 件）、`krakow` 0 件（表記は `Kraków`）だった。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year); };",
    "const jp = keys('東京');",
    "const latin = keys('tokyo');",
    "const krakow = keys('krakow').length;",
    "const beikoku = keys('米国');",
    // 誤爆検査: 「米国」が出した行は、どれも hay に usa / america を持つ。
    "const m = Recommender.searchMatcher('米国');",
    // 別表記の寄せで当たり方が広がった結果、**語の途中**で当たっている行が混ざる
    // （`evomusart` の中に `usa`、`latin american` に `america`。2026-09-23 実測で
    // `米国` に収録 18 行の誤りが残る。語境界で照らす修法に変えるまで、ここでは
    // 寄せた語そのものが誤って入っていないことだけを見る）。
    // 誤爆の判定は画面に出る開催地表記で見る。`米国` は開催地の日本語化（`United States` →
    // `アメリカ`）と州表記（`San Diego, CA` → `カリフォルニア州`。上流は国名を書かない）で
    // 当たる行が増えていて、hay の英文字だけを見るとそれを誤爆として拾ってしまう。
    // ただし語の途中当たり（`evomusart` の中の `usa`、`latin american`）は別の話で、
    // 語境界で照らす修法に変えるまで語として現れる行は許す（§7 の既知の誤り）。
    "const US_STATES = ['カリフォルニア州', 'コロラド州', 'ハワイ州', 'ペンシルベニア州', 'ルイジアナ州', 'テネシー州', 'インディアナ州', 'オレゴン州'];",
    "const wordHit = (hay) => /(^|[^a-z0-9])(usa|america)($|[^a-z0-9])/.test(hay);",
    "const phantoms = rows.filter((r) => {",
    "  if (!m(r.hay)) return false;",
    "  const place = String(Recommender.placeJa(r.ed.place)).trim();",
    "  if (!place) return !wordHit(String(r.hay));",
    "  if (/(usa|america|united state|アメリカ)/i.test(place)) return false;",
    "  if (US_STATES.some((x) => place.includes(x))) return false;",
    "  return !wordHit(String(r.hay));",
    "}).length;",
    // 別表記の表に、収録カタログで 1 件も当たらない英文字表記を置いていないこと。
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const i = src.indexOf('const PLACE_QUERY_ALIASES_JA = [');",
    "const table = eval(src.slice(i + 'const PLACE_QUERY_ALIASES_JA = '.length, src.indexOf('];', i) + 1));",
    "const alive = table.filter(([, latin]) => keys(latin).length > 0).length;",
    "console.log(JSON.stringify({",
    "  jp: jp.length, same: jp.join(',') === latin.join(','), krakow,",
    "  beikoku: beikoku.length, phantoms, total: table.length, alive,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    jp: number;
    same: boolean;
    krakow: number;
    beikoku: number;
    phantoms: number;
    total: number;
    alive: number;
  };
  // 検査用のビルドは小型のカタログなので、「何件当たるか」ではなく
  // 日本語表記と英文字表記で**同じ行に届く**ことだけを見る（件数の実測は SPEC §7 に載せる。
  // アクセントを落とす動作は `tests/recommender.test.ts` の固定データで見る）。
  expect(out.jp, "「東京」が 0 件").toBeGreaterThan(0);
  expect(out.same, "日本語表記と英文字表記で出会う行が違う").toBe(true);
  expect(out.beikoku, "「米国」が 0 件").toBeGreaterThan(0);
  expect(out.phantoms, "別表記の寄せが誤爆している行がある").toBe(0);
});

it("別表記の表は、実際に新しい行を増やしている（SPEC §7）", () => {
  /* 開催地・主題の別表記は「打たれた語」と「画面に出る語」をつなぐためだけのもの。
   * 分野ラベルや日本語の開催地表記が既に同じ行を拾えているのに表へ足すと、
   * 説明だけが増えて当たり方が変わらない（例: `データベース`→database は追加 0 件だった）。
   * 収録カタログで、別表記側の語が**日本語表記だけのときより多く**の行を出すことを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const rows = Recommender.candidateRows(DATA);",
    "const norm = (s) => String(s).normalize('NFKC').toLowerCase();",
    "const keys = (pred) => new Set(rows.filter(pred).map((r) => r.conf.key + '@' + r.ed.year));",
    "const grab = (name) => {",
    "  const head = 'const ' + name + ' = ';",
    "  const i = rec.indexOf(head);",
    "  const j = rec.indexOf('\\n    ];', i);",
    // Node の ESM 検出回避は検索の正典の注入と同じものを使う（`vmSafeSource`）。
    // 表の末尾が説明コメントで終わることがある（`//` の行に `]` を繋ぐとコメントに
    // 飲み込まれて構文エラーになる）。改行 after 閉じる。
    '  return eval(vmSafeSource(rec.slice(i + head.length, j)) + "\\n];");',
    "};",
    "const stats = (name) => {",
    "  let alive = 0;",
    "  let total = 0;",
    "  const dead = [];",
    "  for (const [ja, latin] of grab(name)) {",
    "    const m = Recommender.searchMatcher(latin);",
    "    const latinKeys = keys((r) => m(r.hay));",
    "    const jaKeys = keys((r) => norm(r.hay).includes(norm(ja)));",
    // 検査用のビルドは小型カタログなので、英文字側が 1 行も出ない条目は判定しない
    // （収録欠落ではなく、単にその会議が無いだけ）。当たった条目だけを見る。
    "    if (latinKeys.size === 0) continue;",
    "    total += 1;",
    "    const added = [...latinKeys].filter((k) => !jaKeys.has(k)).length;",
    "    if (added > 0) alive += 1;",
    "    else dead.push(ja + '→' + latin);",
    "  }",
    "  return { alive, total, dead };",
    "};",
    "console.log(JSON.stringify({",
    "  place: stats('PLACE_QUERY_ALIASES_JA'),",
    "  topic: stats('TOPIC_QUERY_ALIASES_JA'),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    place: { alive: number; total: number; dead: string[] };
    topic: { alive: number; total: number; dead: string[] };
  };
  /* 別表記は「打てば行が増える」ためだけに置く。当たった条目で追加 0 件が続くなら、
   * その条目は説明だけを太らせる死んだ寄せなので、割愛する判断の材料にする
   * （`データベース`→database は実カタログで追加 0 件だったので実際に削った）。
   * ただし開催地の日本語化（`Kyoto, Japan` → `京都, 日本`）で日本語側が既に拾える場合が
   * あるため、0 件は少数派であることまでしか要求しない。 */
  for (const [name, stat] of Object.entries(out)) {
    expect(stat.total, `${name} の表で判定できる条目が無さすぎる`).toBeGreaterThan(3);
    expect(stat.dead.length).toBeLessThanOrEqual(Math.max(1, Math.ceil(stat.total * 0.2)));
  }
});

it("「国内研究会・国内シンポジウムのみ」で消えた行を件数欄が説明する（SPEC §7）", () => {
  /* このチェックは主催の区分で、日本の開催かどうかではない。付けたままだと
   * `Tokyo, 日本` と書かれた行が黙って消える（実測: 既定画面 477 行のうち 448 行が落ち、
   * そのうち 11 行は日本開催）。のぞいた件数を出さないと「国内に無かった」と誤解される。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, tags, place) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: key,",
    "    tags: tags, t: now + DAY, tLast: now + DAY, ed: { place: place, deadlines: [] },",
    "    conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('ieice-nolta', ['domestic-jp'], '京都大学 楽友会館（京都府）／オンライン'),",
    "  row('icde', [], 'Tokyo, 日本'),",
    "  row('sc', [], 'St. Louis, USA'),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (domestic) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, domestic: domestic }, true, 'rem');",
    // `new Function` は絞り込み関数を返すので、ここから一度呼ぶ。
    "const shown = run(false)().map((r) => r.conf.key);",
    "run(true)();",
    "console.log(JSON.stringify({ shown, domestic: hiddenCounts.domestic }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { shown: string[]; domestic: number };
  // 同じ締切時刻なので、並び順は表に出る会議名の昇順（SPEC §7 のタイ処理）。
  expect(out.shown).toEqual(["icde", "ieice-nolta", "sc"]);
  // チェックを付けると国内研究会の 1 行だけになり、のぞいた 2 行が件数へ出る。
  expect(out.domestic, "のぞいた件数が出ていない").toBe(2);

  const app = siteRuntime();
  // 件数欄の実装がその件数を出していること。
  expect(app).toContain("国内研究会・国内シンポジウム以外 ${countJa(hidden.domestic)} 件");
  // 説明は「日本の開催とは別物」と、戻し方（検索で引く）を同じ箇所に書く。
  const html = siteHtmlRuntime();
  const dd = html.slice(html.indexOf("<dt>国内</dt>"), html.indexOf("<dt>種別</dt>"));
  expect(dd).toContain("日本の開催かどうかとは別物");
  expect(dd).toContain("Tokyo, 日本");
  expect(dd).toContain("のぞいた件数");
  // チェックボックス自体にも同じ注意を出す（てびきは畳まれているので）。
  const box = html.slice(html.indexOf('id="domestic"'), html.indexOf('id="online"'));
  expect(box).toContain("日本の開催かどうかは関係ありません");
  expect(box).toContain("検索に「東京」");
});

it("「オンライン参加可のみ」で出ない理由を 2 通りに分けて数える（SPEC §7）", () => {
  /* この絞り込みは会場表記の記述だけで動く。チェックした人から見て「出ない」理由は
   * (a) 対面の記述しかない、(b) **開催地自体が未確認**で読みようがない、の 2 つある。
   * (b) を混ぜると「オンライン参加を認めていない会議」と誤解される。
   * 実測: 既定画面 477 行のうち条件に書くのは 15 行だけで、のぞく 462 件のうち 110 行は
   * 開催地が空だった。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    `const countJa = (${jsFunction(siteRuntime(), "countJa")});`,
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, place) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], tags: [], hay: key,",
    "    t: now + DAY, tLast: now + DAY, ed: { place: place, deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('hybrid', 'Alicante, Spain / Online'),",
    "  row('onsite', 'Kyoto, 日本'),",
    "  row('unknown', ''),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (online) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, online: online }, true, 'rem');",
    "const all = run(false)().length;",
    "const shown = run(true)().map((r) => r.conf.key);",
    "console.log(JSON.stringify({",
    "  all, shown, online: hiddenCounts.online, unknown: hiddenCounts.onlinePlaceUnknown,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    shown: string[];
    online: number;
    unknown: number;
  };
  expect(out.all).toBe(3);
  expect(out.shown).toEqual(["hybrid"]);
  expect(out.online, "のぞいた行数が出ていない").toBe(2);
  expect(out.unknown, "開催地が未確認の行数を分けていない").toBe(1);

  const app = siteRuntime();
  expect(app).toContain("オンライン参加の記載がない ${countJa(hidden.online)} 件");
  expect(app).toContain("うち開催地が未確認 ${countJa(hidden.onlinePlaceUnknown)} 件");
  // チェックボックスの tool tip にも、対面を断定していないことと確認先を書く。
  const html = siteHtmlRuntime();
  const box = html.slice(html.indexOf('id="online"'), html.indexOf('id="est"'));
  expect(box).toContain("記述が無い行は対面だと判定していません");
  expect(box).toContain("開催地が未確認");
  const dd = html.slice(
    html.indexOf("<dt>オンライン参加可</dt>"),
    html.indexOf("<dt>会期のみ・締切未定</dt>"),
  );
  expect(dd).toContain("オンライン参加が無いのだと誤解しないでください");
});

it("「締切まで N 日以内」の窓で外れた件数を件数欄に出す（SPEC §7）", () => {
  /* 窓は選択欄の下側にも効くのに、件数欄は過去の締切・種別・推定しか言わなかった。
   * 「7 日以内」を選ぶと実測で対象 477 行のうち 39 行しか出ず、のこり 438 行が黙って
   * 消えるので「今週は収録が薄い」と誤解される。外れた件数と戻し方を出す。 */
  const filterSrc = jsFunction(siteRuntime(), "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, offset) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], tags: [], hay: key,",
    "    t: now + offset * DAY, tLast: now + offset * DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [row('soon', 2), row('far', 40), row('old', -40)];",
    FILTER_RUNTIME_STUBS,
    "const run = (win, past) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: win, est: false, past: past }, true, 'rem');",
    "const all = run('all', false)().length;",
    "const narrow = run('7d', false)().map((r) => r.conf.key);",
    "const narrowWindow = hiddenCounts.window;",
    // 「過去の締切も表示」と併用すると窓は前後対称になる（下限側も同じ計数にまとめる）。
    "const both = run('7d', true)().map((r) => r.conf.key);",
    "const bothWindow = hiddenCounts.window;",
    "console.log(JSON.stringify({ all, narrow, narrowWindow, both, bothWindow }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    narrow: string[];
    narrowWindow: number;
    both: string[];
    bothWindow: number;
  };
  // 窓を「かまわない」にしても、40 日前の行は既定では「過去の締切」の内訳で落ちる。
  expect(out.all).toBe(2);
  // 7 日以内: 40 日後の行が上限側で外れる（40 日前の行は「過去の締切」側の内訳なので窓に数えない）。
  expect(out.narrow).toEqual(["soon"]);
  expect(out.narrowWindow, "窓で外れた件数が出ていない").toBe(1);
  // 過去表示と併用: 下限側（40 日前）も同じ窓として数える。
  expect(out.both).toEqual(["soon"]);
  expect(out.bothWindow, "対称窓の下限側を窓に数えていない").toBe(2);
  const app = siteRuntime();
  expect(app).toContain("`「締切まで ${Number.parseInt(state.win, 10)} 日以内」を超える");
  // 選択欄の表記（「7 日以内」）とその戻し方を選んで書く。
  const html = siteHtmlRuntime();
  const dd = html.slice(
    html.indexOf("<dt>締切まで</dt>"),
    html.indexOf("<dt>過去の締切も表示</dt>"),
  );
  expect(dd).toContain("「締切まで 7 日以内」を超える N 件");
  expect(dd).toContain("収録が薄いわけではありません");
  expect(dd).toContain("「かまわない」");
});

it("月の見出しは、会期の月ではなく締切の月だと書く（SPEC §7）", () => {
  /* 第 231 回。表には締切の日時列と会期列の両方がある。2026-08-09 生成ビルドの実測で、
   * 会期が分かる投稿締切の行 94 件のうち 89 件（94.7%）は見出しの月と会期の月が違い、
   * 30 件は年まで違った（`aila2027`: 締切 2026-11-15 / 会期 2027-04）。月だけの見出しは
   * そこへ読み違える余地を残す。 */
  const app = siteRuntime();
  const script = [
    `const countJa = (${jsFunction(app, "countJa")});`,
    // `monthKey` は月の零埋めに `pad` を使うので、一緒に置いてやる。
    "function pad(n) { return (n < 10 ? '0' : '') + n; }",
    jsFunction(app, "monthKey"),
    jsFunction(app, "monthHeading"),
    "const 行 = { kind: 'paper', t: Date.parse('2026-11-15T02:00:00Z') };",
    "console.log(JSON.stringify({ 見出し: monthHeading(monthKey(行), 12) }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const 結果 = JSON.parse(proc.stdout) as { 見出し: string };
  expect(結果.見出し).toBe("締切 2026年11月（12 件）");
  expect(結果.見出し, "会期の月だと読む余地を残している").toContain("締切");
  // 区切る月自体は表示している暦日から決める（残り・並びと同じ基準。第 202 回）。
  expect(jsFunction(app, "monthKey"), "月の基準が表示暦日でない").toContain("r.tShown");
  // 見出しの行が、見出しの組み立てを見ていること（別の場所で月を組み直さない）。
  // 呼び出しの形で見る（関数名だけだと `function monthHeading(key, count)` の宣言にも当たる）。
  expect(app, "月見出しが見出しの正本を見ていない").toContain(
    "textContent = monthHeading(key, count)",
  );
  // てびきも同じ読み方をしているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきに月の基準を書いていない").toContain("締切 2026年11月（N 件）");
});

it("分野チップは、チップに出る日本語名の五十音順に並ぶ（SPEC §7）", async () => {
  /* 第 230 回。上は上流の分野表の項目順のままで、2026-08-09 生成ビルドの実測は
   * 高性能計算 / ネットワーク / システム / 人工知能 / セキュリティ / データベース /
   * グラフィックス / 人間情報処理 / 計算理論 – 9 個から探している語を探し出す形だった。
   * 同じ画面の「会議」列は `localeCompare(..., "ja")` で五十音順に並ぶので、日本語の
   * 並びの約束が画面の中に二つあった。並びは `categoryChipKeys` の 1 本にまとめる。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const fn = new Function("Recommender", `return (${jsFunction(app, "categoryChipKeys")});`)(R) as (
    categories: Record<string, string>,
  ) => string[];
  const ラベル = (categories: Record<string, string>) =>
    fn(categories).map((key) => R.categoryChipLabelJa(key, categories[key] || ""));
  const 並んでいる = (labels: string[]) =>
    labels.every((label, i) => i === 0 || labels[i - 1].localeCompare(label, "ja") <= 0);
  // 入力の並びを逆にしても同じ順に出る（並び替えていること自体の証明。データ順が
  // たまたま五十音順でも空振りしない）。
  const 逆順 = (categories: Record<string, string>) => {
    const keys = Object.keys(categories).reverse();
    return Object.fromEntries(keys.map((key) => [key, categories[key]]));
  };
  expect(
    fn(逆順({ hpc: "High Performance Computing", ai: "AI", sec: "Security" })),
    "入力の並び順で出ていて、並び替えていない",
  ).toEqual(fn({ hpc: "High Performance Computing", ai: "AI", sec: "Security" }));
  // 収録している分野でも五十音順で、1 つも落とさない。
  const categories = JSON.parse(readFileSync(join(site, "data.json"), "utf8")).categories as Record<
    string,
    string
  >;
  const 収録の順 = Object.keys(categories);
  expect(収録の順.length, "分野が無く、この検査が空振りしている").toBeGreaterThan(1);
  const 出てくる順 = fn(categories);
  expect([...出てくる順].sort().join(), "チップから落ちる分野がある").toBe(
    [...収録の順].sort().join(),
  );
  expect(並んでいる(ラベル(categories)), "チップが五十音順に並んでいない").toBe(true);
  // チップの組み立てがその並びを見ていること（並びを決める関数を素で置かない）。
  expect(app, "チップの組み立てが並びの正本を見ていない").toContain(
    "categoryChipKeys(DATA.categories)",
  );
  // てびきも同じ約束を書いているか（画面の並びを文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきにチップの並びを書いていない").toContain(
    "チップの並びは日本語名の五十音順",
  );
});

it("画面上部の「これからの30日間の締切」は「30 日以内」の一覧と同じ行を数える（SPEC §7）", () => {
  /* 第 228 回。上の四つの数は経過 24 時間で区切り、一覧の窓は JST の暦日で区切る（第 202 回）
   * という二重実装になっていた。2026-08-09 生成ビルドで実測: JST 8/10 朝の見立て
   * （2026-08-09T21:00Z）で上部 176 件・「30 日以内」の一覧 177 件。一覧が「あと 30 日」と
   * 出す `pacificvis`（締切 JST 9/9 20:59）が上の数だけに入っていなかった。
   * 画面の上と下が同じ語について違う数を言うのは、どちらを信じてよいか分からない。 */
  const app = siteRuntime();
  const fn = (name: string) => jsFunction(app, name);
  const script = [
    "const DAY = 86400000;",
    "let NOW = 0;",
    "const RealDate = Date;",
    // 時計を止めた Date を、絞り込みにも渡す（素の Date を渡すと現実の時刻で走って
    // すべての行が「過ぎた」になる）。
    "const StoppedDate = class extends RealDate { static now() { return NOW; } };",
    "globalThis.Date = StoppedDate;",
    // 絞り込みの本体が使う語彙（検索照合の正本など）をビルド成果物から注入する。
    FILTER_RUNTIME_STUBS,
    // 過ぎたかの判定は一覧と同じ正本を見る（規則をテスト側に書き写さない）。
    "Recommender.deadlineRowIsPast = " +
      jsFunction(siteRuntime("recommender.js"), "deadlineRowIsPast") +
      ";",
    // 窓の上下限・表示暦日の比較は FILTER_RUNTIME_STUBS が正本から注入している。
    fn("rowIsPast"),
    fn("rowIsFuture"),
    `const ROWS_SRC = ${JSON.stringify([
      // 30 日後の JST 暦日の中、その日の遅い時刻（経過 24 時間だと窓の外になる）。
      { key: "later-in-the-day", t: "2026-09-09T11:59:00Z", kind: "paper" },
      // 31 日後の暦日（どちらの目盛りでも窓の外）。
      { key: "next-day", t: "2026-09-10T02:00:00Z", kind: "paper" },
      // 締切の瞬間は窓の中、でも画面に出る暦日は 31 日後（AoE 詰めなどでずれる行）。
      // 窓は「表示している暦日」で切る（第 202 回）ので、この行は出ない。
      {
        key: "shown-later",
        t: "2026-09-09T10:00:00Z",
        tShown: "2026-09-10T03:00:00Z",
        kind: "paper",
      },
      // 推定（既定では数えない・一覧にも出ない）。
      { key: "estimated", t: "2026-09-01T03:00:00Z", kind: "paper", est: true },
      // 投稿締切以外の種別（同じく数えない）。
      { key: "notification-only", t: "2026-09-01T03:00:00Z", kind: "notification" },
    ])};`,
    "const rows = ROWS_SRC.map((d) => ({",
    "  kind: d.kind, est: Boolean(d.est), cats: ['hpc'], rankPairs: [], hay: d.key, tags: [],",
    "  t: RealDate.parse(d.t), tLast: RealDate.parse(d.t),",
    "  tShown: d.tShown ? RealDate.parse(d.tShown) : NaN, dateOnly: false,",
    "  ed: { place: 'Paris, 日本', deadlines: [] }, conf: { key: d.key },",
    "}));",
    "const DATA = { conferences: [{ key: 'a', editions: [] }, { key: 'b', editions: [] }] };",
    "const els = {};",
    "const $ = (id) => (els[id] = els[id] || { textContent: '' });",
    fn("renderSummaryStats"),
    `const FILTER = ${JSON.stringify(fn("filter"))};`,
    // 同じ行・同じ時計で、上の数と「30 日以内」の一覧をそれぞれ本物の実装で数える。
    "NOW = RealDate.parse('2026-08-09T21:00:00Z');",
    "renderSummaryStats();",
    "const 上の数 = Number(els.statUpcoming.textContent);",
    "const runFilter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(StoppedDate, DAY, rows,",
    "  { mode: 'deadlines', q: '', cats: [], kind: '', rank: '', win: '30', est: false,",
    "    domestic: false, online: false, past: false }, true, 'rem');",
    "const 一覧 = runFilter().map((r) => r.conf.key);",
    // 経過 24 時間での数え方（直前の実装）はここより 1 件少ない。時計と行の組み合わせが
    // 検査を決めていることを、この数字で示す。
    "const 経過24時間 = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && !r.est &&",
    "  rowIsFuture(r, NOW) && !(r.t > NOW + 30 * DAY)).length;",
    "console.log(JSON.stringify({ 上の数, 一覧, 経過24時間 }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const 結果 = JSON.parse(proc.stdout) as { 上の数: number; 一覧: string[]; 経過24時間: number };
  expect(結果.一覧, "窓の想定と違う行が出た").toEqual(["later-in-the-day"]);
  expect(結果.経過24時間, "経過 24 時間でも同じ結果ならこの時計は検査になっていない").toBe(0);
  expect(
    結果.上の数,
    `上部 ${結果.上の数} 件・一覧 ${結果.一覧.length} 件で画面が自己矛盾している`,
  ).toBe(結果.一覧.length);
  // 日をまたいで開いたタブでもズレないよう、四つの数は描画ごとに数え直す。
  expect(jsFunction(app, "render"), "四つの数を描画ごとに数え直していない").toContain(
    "renderSummaryStats()",
  );
});

it("CSV ボタンのラベルは、画面に並んでいない行を「表示中」と数えない（SPEC §7）", () => {
  /* 第 229 回。ラベルは「表示中の 478 件を CSV でダウンロード」だったが、一覧は一度に
   * 先頭 40 件（`PAGE = 40`）しか並べず、残りはずっと下の「さらに表示」で足す。
   * つまり 438 件について噓を言っていた。書き出しの中身（絞り込み後の全行）は正しく、
   * 語だけが誤っていたので、語を直す側の検査にする。 */
  const app = siteRuntime();
  const page = Number(/const PAGE = (\d+);/.exec(app)?.[1]);
  expect(page, "一覧のページングサイズが読めない").toBeGreaterThan(0);
  const 総数 = page + 438; // 既定の一覧を再現（40 件だけ画面に並び、438 件は下にある）
  const script = [
    // `exportCsvLabelJa` は `countJa`（桁区切りの正本）を呼ぶので、両方抜き出す。
    [jsFunction(app, "countJa"), jsFunction(app, "exportCsvLabelJa")].join("\n"),
    `console.log(JSON.stringify({ ラベル: exportCsvLabelJa(${総数}), 総数: ${総数}, ページ: ${page} }));`,
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const 結果 = JSON.parse(proc.stdout) as { ラベル: string; 総数: number; ページ: number };
  expect(結果.総数, "ページ数より少ない件数ではこの検査は意味がない").toBeGreaterThan(結果.ページ);
  expect(結果.ラベル, "件数欄と同じ数字が出ない").toBe(
    `この一覧の ${結果.総数} 件を CSV でダウンロード`,
  );
  expect(結果.ラベル, "画面に並んでいない行まで「表示中」と数えている").not.toContain("表示中");
  // 数字は件数欄と同じ `shown.length` を見る（ラベルだけ別の数を言わないように）。
  const render = jsFunction(app, "render");
  expect(render, "ボタンがラベルの組み立てを見ていない").toContain(
    "exportCsvLabelJa(shown.length)",
  );
  expect(render, "件数欄が `shown.length` を言っていない").toMatch(
    /countJa\(shown\.length\)\} 件 \/ 全/,
  );
  // てびきがボタンと同じ語を引用しているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきの CSV の項がボタンの語とズレている").toContain(
    "この一覧の N 件を CSV でダウンロード",
  );
});

it("地域まとめの構成員は、収録カタログの開催地に現れる（SPEC §7）", () => {
  /* `ヨーロッパ` → 国名、という寄せは「画面の開催地に出る語」だけで作る。
   * 収録に無い国名を混ぜると、件数欄の説明だけが長くなって当たり方が変わらない
   * （§7 の別表記と同じ基準）。構成員が実際の開催地に現れることと、
   * 各地域の語で実際に一行以上当たることを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    // 検査用ビルドのカタログは小さい（小型 fixtures）ので、開催地の語は収録カタログ
    // （`data/snapshot.json`）で見る。件数の検査だけ実行ビルドのコードを使う。
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(
      new URL("../data/snapshot.json", import.meta.url).pathname,
    )}, 'utf8'));`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const head = 'const CONTINENT_READINGS = ';",
    "const i = rec.indexOf(head);",
    "const j = rec.indexOf('\\n    ];', i);",
    // 表は `EUROPE_JA` などの変数で国名リストを共有しているので、その定義も eval に入れる。
    'const decls = (rec.match(/const [A-Z_]+_JA =\\s*\\n?\\s*(?:`[^`]*`|"[^"]*");/g) || [])',
    "  .map((d) => vmSafeSource(d))",
    "  .join('\\n');",
    "const table = eval(`${decls}\\n${vmSafeSource(rec.slice(i + head.length, j))}\\n];`);",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const norm = (s) => String(s).normalize('NFKC').toLowerCase();",
    "const places = rows.map((r) => norm(Recommender.placeJa(r.ed.place) + ' ' + String(r.ed.place || '')));",
    "const missing = [];",
    "const emptyRegions = [];",
    "const seen = new Set();",
    "for (const entry of table) {",
    "  const heading = entry[0];",
    "  if (seen.has(heading)) continue;",
    "  seen.add(heading);",
    "  for (const member of String(entry[2]).split(',')) {",
    "    if (!places.some((p) => p.includes(norm(member)))) missing.push(heading + '→' + member);",
    "  }",
    "  const m = Recommender.searchMatcher(heading, now);",
    "  if (!rows.some((r) => m(r.hay))) emptyRegions.push(heading);",
    "}",
    "console.log(JSON.stringify({ regions: [...seen], missing, emptyRegions }));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    regions: string[];
    missing: string[];
    emptyRegions: string[];
  };
  expect(out.regions.length).toBeGreaterThanOrEqual(8);
  expect(out.missing, `収録の開催地に現れない構成員: ${out.missing.join(" ")}`).toEqual([]);
  expect(out.emptyRegions, `1 行も当たらない地域の語: ${out.emptyRegions.join(" ")}`).toEqual([]);
});

it("ビルド後の照合式は英字語を語の途中では当てない（SPEC §7）", () => {
  /* 語境界の照合は `matchFoldedGroups` の規則で、一覧の絞り込みはビルド後の
   * `recommender.js` を通る。ここで見ておくのは「実装が効いて shipped の挙動が直っているか」。
   * `米国` が語の途中当たりでパナマ・ドイツの会議を出していた実発生をそのまま固定する。 */
  const script = [
    "(async () => {",
    "const { default: Recommender } = await import(",
    `  ${JSON.stringify(`file://${join(site, "recommender.js")}`)},`,
    ");",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const hays = [",
    "  'evomusart 2027 16th international conference mainz, ドイツ',",
    "  'ieice trans. inf. & syst. special section on log data usage techniques',",
    "  'lascas ieee latin american symposium on circuits and systems panama city, パナマ',",
    "  'sigcomm 2027 alexandria, va, usa アメリカ',",
    "  'asplos vienna, オーストリア computer-vision computer vision',",
    "];",
    "const match = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return hays.map((hay) => (m(hay) ? 1 : 0));",
    "};",
    "console.log(JSON.stringify({",
    "  us: match('米国'),",
    "  eu: match('ヨーロッパ'),",
    "  vision: match('視覚'),",
    "  sc: match('sc'),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    us: number[];
    eu: number[];
    vision: number[];
    sc: number[];
  };
  // 語の途中当たり（evomusart / usage / latin american）は落ち、語として出る行だけ残る。
  expect(out.us, "`米国` の語の途中当たりが残っている").toEqual([0, 0, 0, 1, 0]);
  // 地域まとめは画面に出る日本語の国名で当たる（Mainz は `ドイツ`、Wien は `オーストリア`）。
  expect(out.eu).toEqual([1, 0, 0, 0, 1]);
  // 語頭の一致（computer-vision のハイフン越え）は生かす。
  expect(out.vision).toEqual([0, 0, 0, 0, 1]);
  // 1〜2 文字は従来どおり前後の境界を見る。
  expect(out.sc).toEqual([0, 0, 0, 0, 0]);
});

it("数字で打った日付が、暦日の日本語表記と同じ行に当たる（SPEC §7）", () => {
  /* 一覧の絞り込みはビルド後の `recommender.js` を通る。検査用のカタログの日付をそのまま
   * 数字表記（`8/22`・`2026/8/22`）に直して、日本語表記（`8月22日`）と同じ行集合になることを
   * 見る。固定の日付を書くと、このビルドにその日が無いときに空振りで通ってしまうため、
   * 実際に締切のある日を選ぶ。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // JST の暦日で最多数の行を持つ日を使う。
    "const jst = (t) => new Date(t + 9 * 60 * 60 * 1000);",
    "const counts = new Map();",
    "rows.forEach((r) => {",
    "  if (Number.isFinite(r.t)) {",
    "    const d = jst(r.t);",
    "    const k = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;",
    "    counts.set(k, (counts.get(k) || 0) + 1);",
    "  }",
    "});",
    "const [year, month, day] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split('-');",
    "const keys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind).sort();",
    "};",
    "const ja = keys(`${month}月${day}日`);",
    "const jaYear = keys(`${year}年${month}月${day}日`);",
    "console.log(JSON.stringify({",
    "  date: `${year}/${month}/${day}`,",
    "  sameMonthDay: JSON.stringify(keys(`${month}/${day}`)) === JSON.stringify(ja),",
    "  sameMonthDayDash: JSON.stringify(keys(`${month}-${day}`)) === JSON.stringify(ja),",
    "  sameWithYear: JSON.stringify(keys(`${year}/${month}/${day}`)) === JSON.stringify(jaYear),",
    "  sameYearMonth: JSON.stringify(keys(`${year}-${month}`)) === JSON.stringify(keys(`${year}年${month}月`)),",
    "  hits: ja.length,",
    "  invalidUntouched: JSON.stringify(Recommender.queryTokenGroups('13/45', now)),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    date: string;
    sameMonthDay: boolean;
    sameMonthDayDash: boolean;
    sameWithYear: boolean;
    sameYearMonth: boolean;
    hits: number;
    invalidUntouched: string;
  };
  expect(out.hits, `検査用カタログに ${out.date} の締切が無い`).toBeGreaterThan(0);
  expect(out.sameMonthDay, `${out.date} を「M/D」で引くと行集合が違う`).toBe(true);
  expect(out.sameMonthDayDash, `${out.date} を「M-D」で引くと行集合が違う`).toBe(true);
  expect(out.sameWithYear, `${out.date} を「Y/M/D」で引くと行集合が違う`).toBe(true);
  expect(out.sameYearMonth, `${out.date} を「Y-M」で引くと行集合が違う`).toBe(true);
  // ありえない日付は展開しない（会議名の数字の取り合わせを壊さない）。
  expect(out.invalidUntouched).toBe('[["13/45"]]');
});

it("画面に出る状態の語（推定）が一覧の検索でも引ける（SPEC §7）", () => {
  /* 締切セルに `推定` のバッジを出し、CSV にも同じ語を書いていたのに、検索用の文字列に
   * 入れていなかったため「推定」で 1 件も引けなかった（2026-09-23 実測: 収録 134 件が 0 件）。
   * 画面に出る語は検索でも引ける、をビルド後の成果物で確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const m = Recommender.searchMatcher('推定', now);",
    "const hit = rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind).sort();",
    "const flagged = rows",
    "  .filter((r) => r.ed.estimated === true)",
    "  .map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind)",
    "  .sort();",
    // バッジ語を共有していること: 推定行の hay と CSV の状態欄が同じ語を書く。
    "const est = rows.find((r) => r.ed.estimated === true);",
    "const csv = est ? Recommender.deadlinesToCsv([est], now) : '';",
    "console.log(JSON.stringify({",
    "  flagged: flagged.length,",
    "  sameSet: JSON.stringify(hit) === JSON.stringify(flagged),",
    "  hayHasWord: est ? String(est.hay).includes('推定') : false,",
    "  csvHasWord: csv.includes('推定'),",
    "  noFalsePositive: rows.filter((r) => !r.ed.estimated && String(r.hay).includes('推定')).length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    flagged: number;
    sameSet: boolean;
    hayHasWord: boolean;
    csvHasWord: boolean;
    noFalsePositive: number;
  };
  expect(out.flagged, "検査用カタログに推定の行が無い").toBeGreaterThan(0);
  expect(out.sameSet, "「推定」で引ける行と推定バッジの行が違う").toBe(true);
  expect(out.hayHasWord, "推定行の検索用文字列に「推定」が無い").toBe(true);
  expect(out.csvHasWord, "CSV の状態欄と検索の語がズレている").toBe(true);
  expect(out.noFalsePositive, "推定でない行が「推定」で当たる").toBe(0);
  // 件数欄は、落ちた行の出し方まで同じ行に書く（回復経路を検索語から探させない）。
  const app = siteRuntime("app.js");
  expect(app).toContain("件（「推定締切を含める」で出ます）");
});

it("地方名で引くと、開催市だけ書かれた国内行も漏れない（SPEC §7）", () => {
  /* 国内の国際会議の開催地は上流どおりの英字表記（`Tokyo, Japan`）で都道府県が書かれない。
   * 地方名を都道府県に展開するだけでは取りこぼしていた（実測で `東京` 28 件に対し `関東` 1 件）。
   * **収録カタログ（`data/snapshot.json`）**で、都市→地方の対応をここでおいて、その地方の語で
   * その行が引けることを見る（検査用のビルドはカタログが小さく空振りするため）。
   * 新しい都市が増えたときはこれが失敗するので、表を足す案内になる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    // 開催地の語はビルド後の成果物から、行は収録カタログから読む。
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const i = src.indexOf('const PREFECTURE_CITIES_JA = [');",
    "const table = eval(src.slice(i + 'const PREFECTURE_CITIES_JA = '.length, src.indexOf('];', i) + 1));",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // 都市 → 地方（表の書き写しではなく、検査側で独立に言い直した対応）。
    "const REGION_OF_CITY = {",
    "  tokyo: '関東', yokohama: '関東', tsukuba: '関東',",
    "  kyoto: '関西', osaka: '関西', kobe: '関西', nara: '関西',",
    "  nagoya: '中部', gifu: '中部', fukui: '中部', kanazawa: '中部',",
    "  fukuoka: '九州', nagasaki: '九州', okinawa: '九州', miyakojima: '九州',",
    "};",
    "const hitKeys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const regionHits = {};",
    "Object.values(REGION_OF_CITY).forEach((region) => {",
    "  if (!regionHits[region]) regionHits[region] = hitKeys(region);",
    "});",
    "const missing = [];",
    "const citiesSeen = new Set();",
    "rows.forEach((r) => {",
    "  const place = String(r.ed.place || '').toLowerCase();",
    "  if (!/japan|日本/.test(String(r.ed.place) + String(Recommender.placeJa(r.ed.place)))) return;",
    "  const city = Object.keys(REGION_OF_CITY).find((c) => place.includes(c));",
    "  if (!city) return;",
    "  citiesSeen.add(city);",
    "  const key = r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "  if (!regionHits[REGION_OF_CITY[city]].has(key))",
    "    missing.push(`${city} (${String(r.ed.place)}) が ${REGION_OF_CITY[city]} で引けない`);",
    "});",
    // 表に、収録カタログで 1 件も当たらない都市を置いていないこと。
    "const dead = [];",
    "table.forEach(([, cities]) => {",
    "  String(cities).split(',').forEach((city) => {",
    "    if (hitKeys(city).size === 0) dead.push(city);",
    "  });",
    "});",
    "console.log(JSON.stringify({",
    "  cities: citiesSeen.size, tableRows: table.length, missing, dead,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    cities: number;
    tableRows: number;
    missing: string[];
    dead: string[];
  };
  // 検査が空振りで通らないように、実際に都市の行を拾えている件数を見る。
  expect(out.cities, "収録カタログで都市の行を 1 つも拾えていない").toBeGreaterThanOrEqual(14);
  expect(out.missing, `地方名で引けない国内行がある:\n${out.missing.join("\n")}`).toEqual([]);
  expect(out.dead, "都市の表に、収録カタログで当たらない語がある").toEqual([]);
});

it("参加形式の語で引いた行が、チェックボックスで出る行と一致する（SPEC §7）", () => {
  /* `オンライン参加可` はチェックボックスの語。その語で検索した人が同じ行にたどり着けること、
   * 判定が `placeOffersOnline` 1本で決まっていること（別の書き方をするとズレる）を、
   * 収録カタログの行で見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const key = (r) => r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "const byPredicate = rows.filter((r) => Recommender.placeOffersOnline(r.ed.place)).map(key).sort();",
    "const byQuery = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map(key).sort();",
    "};",
    "const phrase = byQuery('オンライン参加可');",
    "const hybrid = byQuery('ハイブリッド');",
    "const outside = hybrid.filter((k) => !byPredicate.includes(k));",
    "console.log(JSON.stringify({",
    "  predicate: byPredicate.length,",
    "  sameAsPhrase: JSON.stringify(phrase) === JSON.stringify(byPredicate),",
    "  hybrid: hybrid.length,",
    "  hybridOutside: outside.slice(0, 3),",
    "  noFalseFacet: rows.filter((r) => !Recommender.placeOffersOnline(r.ed.place) && String(r.hay).includes('オンライン参加可')).length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    predicate: number;
    sameAsPhrase: boolean;
    hybrid: number;
    hybridOutside: string[];
    noFalseFacet: number;
  };
  expect(out.predicate, "収録カタログにオンライン参加可の行が無い").toBeGreaterThan(0);
  expect(out.sameAsPhrase, "「オンライン参加可」で引ける行とチェックボックスの行が違う").toBe(true);
  expect(out.hybrid, "「ハイブリッド」が 0 件").toBeGreaterThan(0);
  expect(out.hybridOutside, "「ハイブリッド」がオンライン参加の記載のない行を出した").toEqual([]);
  expect(out.noFalseFacet, "オンライン参加可の語が該当外の行に入っている").toBe(0);
});

it("チェックボックスの語と種別の言い方を実データで引ける（SPEC §7）", () => {
  /* 「国内研究会」はチェックボックスの語、「アブストラクト締切」は種別セレクトの語に
   * 「締切」を付けた言い方。どちらも 0 件で止まっていた（2026-09-23 実測:
   * `国内研究会` 0 件 / `アブストラクト締切` 0 件）。収録カタログの行で見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const key = (r) => r.conf.key + '@' + r.ed.year + '@' + r.kind;",
    "const keys = (q) => {",
    "  const m = Recommender.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).map(key).sort();",
    "};",
    // 国内研究会の語は、domestic-jp の行で名前に研究会を含む行と一致すること。
    "const expectedDomestic = rows",
    "  .filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0)",
    "  .filter((r) => String(r.conf.title || '').includes('研究会'))",
    "  .map(key)",
    "  .sort();",
    "const domestic = keys('国内研究会');",
    // 語を、該当しない行に入れていないこと（シンポジウムとワークショップは別々の語）。
    "const wrongWords = rows.filter((r) => {",
    "  const hay = String(r.hay);",
    "  const title = String(r.conf.title || '');",
    "  const words = [];",
    "  if (hay.includes('国内シンポジウム')) words.push('シンポジウム');",
    "  if (hay.includes('国内ワークショップ')) words.push('ワークショップ');",
    "  return words.some((w) => !title.includes(w));",
    "}).length;",
    // 種別の複合語は、単語で引いたときと同じ行集合になること。",
    "const kindPairs = [",
    "  ['アブストラクト締切', 'アブストラクト'],",
    "  ['抄録締切', '抄録'],",
    "  ['要旨締切', '要旨'],",
    "  ['全文締切', '全文'],",
    "];",
    "const kindMismatch = kindPairs",
    "  .filter(([phrase, word]) => JSON.stringify(keys(phrase)) !== JSON.stringify(keys(word)))",
    "  .map(([phrase]) => phrase);",
    "console.log(JSON.stringify({",
    "  domestic: domestic.length,",
    "  sameDomestic: JSON.stringify(domestic) === JSON.stringify(expectedDomestic),",
    "  wrongWords,",
    "  abstractRows: keys('アブストラクト締切').length,",
    "  kindMismatch,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    domestic: number;
    sameDomestic: boolean;
    wrongWords: number;
    abstractRows: number;
    kindMismatch: string[];
  };
  expect(out.domestic, "「国内研究会」が 0 件").toBeGreaterThan(0);
  expect(out.sameDomestic, "「国内研究会」で引ける行が国内の研究会行と違う").toBe(true);
  expect(out.wrongWords, "名前にない参加形式の語が行に入っている").toBe(0);
  expect(out.abstractRows, "「アブストラクト締切」が 0 件").toBeGreaterThan(0);
  expect(
    out.kindMismatch,
    `複合語で引くと単語と違う行集合になる: ${out.kindMismatch.join(",")}`,
  ).toEqual([]);
  // 常時受付: 行の中で 2 つの名前が見えていた（日時セルだけ「随時受付」）。画面に出す語を統一する。
  const app = siteRuntime("app.js");
  const rec = siteRuntime("recommender.js");
  expect(app, "一覧に「随時受付」が残っている").not.toContain("随時受付");
  expect(rec, "CSV の常時受付表記が「随時受付」に戻っている").not.toContain('"随時受付";');
});

it("収録 5 行以上の開催都市は、カタカナの入力でたどれないものがない（SPEC §7）", () => {
  /* 海外の出張先はカタカナで覚えるのが普通なのに、収録カタログに現れる都市の多くが
   * 日本語表記の表に無く、カタカナで打つと 0 件だった（2026-09-23 実測: 収録 5 行以上の
   * 都市のうち 123 種が表に無かった）。**収録カタログ側**から検査するので、都市が増えて
   * 表が追いついていないときに落ちる（＝足す案内になる）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    "const i = src.indexOf('const PLACE_QUERY_ALIASES_JA = [');",
    "const aliases = eval(src.slice(i + 'const PLACE_QUERY_ALIASES_JA = '.length, src.indexOf('];', i) + 1));",
    /* 都市語はアクセント付きで収録されている（`Cancún` `Malmö` `Kraków` など）。
     * 検索側はアクセントを捨てるので、数え上げもアクセント記号を除いて行わないと、
     * **アクセント付きの都市が検査から丸ごと抜ける**（2026-09-23 に実測で発覚:
     * `Cancún` は収録 23 行あったのに ASCII の正規表現で弾かれて検査されていなかった）。 */
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const cityOf = (r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return '';",
    "  const segment = raw.split('/')[0];",
    "  const at = segment.indexOf(',');",
    "  return FOLD(at < 0 ? segment : segment.slice(0, at));",
    "};",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // 都市語を数える。開催形式の語と会場名（大学・会議センターなど）は都市ではないので除く。
    "const NOT_CITY = /university|center|centre|centre|universitat|resort|foundation|institute|campus|hall|online|virtual|tbd|sar$|california/i;",
    "const counts = new Map();",
    "rows.forEach((r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return;",
    "  const segment = raw.split('/')[0];",
    "  const at = segment.indexOf(',');",
    "  const city = FOLD(at < 0 ? segment : segment.slice(0, at));",
    // アクセント記号を除いた後なので、ラテン文字の都市名はここで拾える（ギリシャ文字・キリル文字の
    // 表記は引き続き数えない。検索のアクセント除去と同じ範囲に揃えている）。
    "  if (!city || !/^[a-z][a-z .'-]*$/.test(city)) return;",
    "  if (NOT_CITY.test(city) || city.length < 4) return;",
    "  const key = city;",
    "  counts.set(key, (counts.get(key) || 0) + 1);",
    "});",
    /* 「その都市の行が 1 行以上当たる日本語の語があるか」を、表の条目ごとに確かめる。
     * ただ語を打って当たった行の都市を覚えるやり方だと、`Anaheim, California` が
     * 「カリフォルニア」でカバーされてしまい、都市の名前では引けないまま緑になる
     * （2026-09-23 に実測で通ってしまい、検査として弱かった）。表の条目が示す
     * 英文字のつづりが都市語に現れていて、かつその語でその行に届くことを見る。 */
    "const covered = new Set();",
    "aliases.forEach(([ja, latin]) => {",
    "  const word = String(ja);",
    "  const want = String(latin).toLowerCase();",
    "  const m = Recommender.searchMatcher(word, now);",
    "  rows.forEach((r) => {",
    "    const city = cityOf(r);",
    "    if (!city || city.indexOf(want) < 0) return;",
    "    if (m(r.hay)) covered.add(city);",
    "  });",
    "});",
    "const uncovered = [...counts.entries()]",
    "  .filter(([, n]) => n >= 5)",
    "  .filter(([city]) => !covered.has(city))",
    "  .map(([city, n]) => `${city} (${n} 行)`)",
    "  .sort();",
    // 表の語が、カタログで本当に当たる語だけか（死んだ条目を置かない）。
    // ただし **寄せ先の英文字がこのカタログに 1 行も無い条目は判定しない** — それは死んだ
    // 条目ではなく、単にその会議がこのビルドに無いだけ（「別表記の表は、実際に新しい行を
    // 増やしている」検査と同じ約束。例: `会津若松` の行は上流の取得状況で増える）。
    // 実際に当たるかの判定は、収録に依存しない形の検査（日本開催の行の検査）で見る。
    "const dead = [];",
    "let unjudged = 0;",
    "aliases.forEach(([ja, latin]) => {",
    "  const ml = Recommender.searchMatcher(String(latin), now);",
    "  if (rows.filter((r) => ml(r.hay)).length === 0) {",
    "    unjudged += 1;",
    "    return;",
    "  }",
    "  const m = Recommender.searchMatcher(ja, now);",
    "  if (rows.filter((r) => m(r.hay)).length === 0) dead.push(String(ja));",
    "});",
    "console.log(JSON.stringify({",
    "  cities: counts.size, uncovered, dead: dead.slice(0, 6), unjudged,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    cities: number;
    uncovered: string[];
    dead: string[];
    unjudged: number;
  };
  expect(out.cities, "カタログから都市を 1 つも数え上げられない").toBeGreaterThan(100);
  expect(out.uncovered, `カタカナで引けない開催都市がある:\n${out.uncovered.join("\n")}`).toEqual(
    [],
  );
  expect(out.dead, "日本語表記の表に、1 件も当たらない語がある").toEqual([]);
  // 判定を飛ばした条目が多すぎるなら（表が実データから浮いている）、この目検が効かなくなる。
  expect(
    out.unjudged,
    "このビルドに無い都市への寄せが多すぎる（表が実データから浮いている）",
  ).toBeLessThan(30);
});

it("早め絞り込みのボタンは、押した条件だけを出し入れし、押されたまま見える（SPEC §7）", () => {
  /* 変更前: ボタンを押すたびに検索語・締切種別・推定まで初期値へ戻り、点灯は他の条件が
   * すべて空のときだけだった。`スパコン` と打ってから「オンライン参加可」を押すと
   * 検索語が消えて 15 件（無関係なオンライン会議）が並び、押したボタンは点かない。
   * ここはビルド後の成果物で、(1) 検索語を消さないこと (2) 点灯が状態を見ること
   * (3) ボタンの名前と条件表がズレていないこと を見る。
   * 出し入れの規則そのものは `tests/recommender.test.ts` で実行して確かめる。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  const presetBody = app.slice(
    app.indexOf("window.applyPreset = "),
    app.indexOf("// Column Sorting"),
  );
  expect(presetBody, "ボタンが状態をまるごと戻している（正本は recommender）").toContain(
    "presetNextSelection",
  );
  expect(presetBody, "ボタンが検索語を消している").not.toContain('q: ""');
  expect(presetBody, "ボタンが締切種別を消している").not.toContain('kind: ""');

  const activeBody = jsFunction(app, "updatePresetActive");
  expect(activeBody, "点灯が recommender の判定を見ていない").toContain("presetIsActive");
  expect(activeBody, "他の条件が空のときだけ点く判定が残っている").not.toContain("!state.q");

  // 一覧のボタンと条件表の名前がズレると、押しても効かないボタンが黙って増える。
  const buttons = [...html.matchAll(/data-preset="([^"]+)"/g)].map((m) => m[1]).sort();
  expect(buttons.length).toBeGreaterThan(3);
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const buttons = ${JSON.stringify(buttons)};`,
    "const empty = { win: 'all', rank: '', cats: [], domestic: false, online: false };",
    // 名前のないボタンは状態を変えられない（黙って効かないボタンにしない）。
    "const inert = buttons.filter((b) => {",
    "  const next = Recommender.presetNextSelection(b, empty);",
    "  return JSON.stringify(next) === JSON.stringify(empty);",
    "});",
    // 二度押しで戻る（押した意味を取り消せる）。
    "const noUndo = buttons.filter((b) => {",
    "  const once = Recommender.presetNextSelection(b, empty);",
    "  return JSON.stringify(Recommender.presetNextSelection(b, once)) !== JSON.stringify(empty);",
    "});",
    // 押している間は点く（他の条件を足した画面でも）。
    "const neverLit = buttons.filter((b) => {",
    "  const once = Recommender.presetNextSelection(b, empty);",
    "  // 他の条件を足した画面（検索語はここで渡さないが、分野・ランク・窓を埋めた状態）でも点くか。",
    "  return !Recommender.presetIsActive(b, once) || !Recommender.presetIsActive(b, {",
    "    ...once,",
    "    cats: b === 'hpc_sys' ? once.cats : ['security'],",
    "    rank: b === 'a_star' ? once.rank : 'A',",
    "    win: b === '7d' ? once.win : '90d',",
    "  });",
    "});",
    "console.log(JSON.stringify({ inert, noUndo, neverLit }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { inert: string[]; noUndo: string[]; neverLit: string[] };
  expect(out.inert, `押しても効かない早め絞り込みのボタンがある: ${out.inert.join(", ")}`).toEqual(
    [],
  );
  expect(out.noUndo, `もう一度押しても外せないボタンがある: ${out.noUndo.join(", ")}`).toEqual([]);
  expect(
    out.neverLit,
    `他の条件を足した画面で点かないボタンがある: ${out.neverLit.join(", ")}`,
  ).toEqual([]);
});

it("かな入力の地名が、漢字で引ける行を取りこぼさない（SPEC §7）", () => {
  /* 漢字見出しは英文字表記の寄せ（`東京` ↔ `tokyo`）を持つが、かな見出しはその漢字へ
   * 寄せるだけだった。開催地の公式表記はそのまま残す設計なので、**漢字で出てかなで
   * 出ない**行が黙って生まれた（2026-09-23 実測: 東京 28 件 / `とうきょう` 1 件、
   * 京都 18 件 / `きょうと` 2 件、`なら` 0 件）。
   * 読み表の条目ごとに、**漢字で出る行をかなでも出す**ことを収録カタログで見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const src = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const i = src.indexOf('const PLACE_READINGS = [');",
    "const readings = eval(src.slice(i + 'const PLACE_READINGS = '.length, src.indexOf('];', i) + 1));",
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const keys = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const worse = [];",
    "readings.forEach((entry) => {",
    "  const kanji = String(entry[0]);",
    "  const kana = String(entry[1]);",
    "  const byKanji = keys(kanji);",
    "  if (!byKanji.size) return; // 収録に無い場所は比較しようがない",
    "  const byKana = keys(kana);",
    "  const missing = [...byKanji].filter((k) => !byKana.has(k)).length;",
    "  if (missing) worse.push(`${kana} / ${kanji}: 漢字 ${byKanji.size} 件 → かな ${byKana.size} 件（${missing} 件足りない）`);",
    "});",
    // 受け取った寄せが違う語へ漏れていないこと（`なら` が奈良以外の行を拾わない等）。
    "const leak = [];",
    "[['なら', '奈良'], ['とうきょう', '東京'], ['きょうと', '京都']].forEach(([kana, kanji]) => {",
    "  const a = keys(kana);",
    "  const b = keys(kanji);",
    "  if (a.size !== b.size || [...a].some((k) => !b.has(k))) leak.push(`${kana} と ${kanji} の行集合が違う`);",
    "});",
    "console.log(JSON.stringify({ worse, leak }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { worse: string[]; leak: string[] };
  expect(out.worse, `かなで打くと漢字より足りない行がある:\n${out.worse.join("\n")}`).toEqual([]);
  expect(out.leak, `かな入力の行集合が漢字とズレている: ${out.leak.join(" / ")}`).toEqual([]);
});

it("「南米」「中米」で引けると、地域の切れ目が実データで崩れない（SPEC §7）", () => {
  /* 「中南米」は当たっても「南米」単体では 0 件で止まっていた（2026-09-23 実測:
   * 中南米 95 行 / 南米 0 行 / 中米 0 行）。南米の会議を開こうとする人は「南米」と書く。
   * 収録カタログで、国名で引ける行が地域の語でも引けること、地域の切れ目が
   * 混ざらないことを見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const keys = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "};",
    "const missing = (broad, narrowList) =>",
    "  narrowList.flatMap((narrow) => [...keys(narrow)].filter((k) => !keys(broad).has(k)).map((k) => `${narrow}: ${k}`));",
    "const intersect = (a, b) => [...keys(a)].filter((k) => keys(b).has(k)).length;",
    "console.log(JSON.stringify({",
    "  south: keys('南米').size,",
    "  central: keys('中米').size,",
    "  latin: keys('中南米').size,",
    "  southFromCountries: missing('南米', ['ブラジル', 'チリ', 'コロンビア', 'アルゼンチン']),",
    "  centralFromCountries: missing('中米', ['メキシコ', 'コスタリカ', 'パナマ']),",
    "  latinMissing: missing('中南米', ['南米', '中米']),",
    "  southInEurope: intersect('南米', 'ヨーロッパ'),",
    "  centralInAsia: intersect('中米', 'アジア'),",
    "  mexicoInNorthAmerica: keys('メキシコ').size && missing('北米', ['メキシコ']).length === 0,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    south: number;
    central: number;
    latin: number;
    southFromCountries: string[];
    centralFromCountries: string[];
    latinMissing: string[];
    southInEurope: number;
    centralInAsia: number;
    mexicoInNorthAmerica: boolean;
  };
  expect(out.south, "「南米」が 0 件").toBeGreaterThan(0);
  expect(out.central, "「中米」が 0 件").toBeGreaterThan(0);
  expect(
    out.latinMissing,
    `「中南米」が南米・中米の行を取りこぼしている:\n${out.latinMissing.join("\n")}`,
  ).toEqual([]);
  expect(
    out.southFromCountries,
    `国名で引ける南米の行が「南米」で出ていない:\n${out.southFromCountries.join("\n")}`,
  ).toEqual([]);
  expect(
    out.centralFromCountries,
    `国名で引ける中米の行が「中米」で出ていない:\n${out.centralFromCountries.join("\n")}`,
  ).toEqual([]);
  // 地域の切れ目（ブラジルの行がヨーロッパに入らない等）。
  expect(out.southInEurope, "南米の行がヨーロッパで当たっている").toBe(0);
  expect(out.centralInAsia, "中米の行がアジアで当たっている").toBe(0);
  expect(out.mexicoInNorthAmerica, "メキシコ開催の行が「北米」で出ていない").toBe(true);
});

it("「中国」で国と地方の両方が出ても、大陸の語に国内の行は混ざらない（SPEC §7）", () => {
  /* 「中国」は国名としても地方名としても打たれる。国名の行しか当たらない状態は
   * 調べ方を狭めるが（2026-09-23 実測: `中国` 233 行、中国地方の 3 行は `中国地方`
   * と打たないと出なかった）、広げすぎると `アジア` に国内の行が混ざる
   * （実際 `中国` を地方見出しへ足した日にアジアが 523 → 526 行へ広がった）。
   * 収録カタログで両方を同時に確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rowsOf = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return rows.filter((r) => m(r.hay));",
    "};",
    "const keys = (word) => new Set(rowsOf(word).map((r) => r.conf.key + '@' + r.ed.year + '@' + r.kind));",
    "const chugoku = keys('中国地方');",
    "console.log(JSON.stringify({",
    "  chugoku: chugoku.size,",
    "  china: keys('中国').size,",
    "  chinaMissing: [...chugoku].filter((k) => !keys('中国').has(k)),",
    "  // 「アジアに国内研究会は入らない」はてびきで書いている約束。",
    "  asiaDomestic: rowsOf('アジア').filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0).length,",
    "  europeDomestic: rowsOf('ヨーロッパ').filter((r) => (r.conf.tags || []).indexOf('domestic-jp') >= 0).length,",
    "  shutoken: keys('首都圏').size,",
    "  tokai: keys('東海').size,",
    // 開催地に都道府県が書かれない行（`Nagoya, Japan`）もあるので、「東海」の当たり行が
    // 都道府県名を含むことでは確かめられない。構成県の語で引ける行を含むことを見る。
    "  tokaiMissing: [",
    "    ...new Set([...keys('愛知'), ...keys('岐阜')].map((k) => k)),",
    "  ].filter((k) => !keys('東海').has(k)),",
    "  shutokenMissing: [...keys('東京')].filter((k) => !keys('首都圏').has(k)),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    chugoku: number;
    china: number;
    chinaMissing: string[];
    asiaDomestic: number;
    europeDomestic: number;
    shutoken: number;
    tokai: number;
    tokaiMissing: string[];
    shutokenMissing: string[];
  };
  expect(out.chugoku, "中国地方の行が 0 件").toBeGreaterThan(0);
  expect(
    out.chinaMissing,
    `「中国」で引くと中国地方の行が足りない:\n${out.chinaMissing.join("\n")}`,
  ).toEqual([]);
  expect(out.asiaDomestic, "「アジア」に国内の行が混ざっている").toBe(0);
  expect(out.europeDomestic, "「ヨーロッパ」に国内の行が混ざっている").toBe(0);
  expect(out.shutoken, "「首都圏」が 0 件").toBeGreaterThan(0);
  expect(out.tokai, "「東海」が 0 件").toBeGreaterThan(0);
  expect(
    out.tokaiMissing,
    `「東海」が愛知・岐阜の行を取りこぼしている:\n${out.tokaiMissing.join("\n")}`,
  ).toEqual([]);
  expect(
    out.shutokenMissing,
    `「首都圏」が東京の行を取りこぼしている:\n${out.shutokenMissing.join("\n")}`,
  ).toEqual([]);
});

it("ランク順は等級で並び、評価の無い行は末尾に回る（SPEC §7）", () => {
  /* 変更前は `rankPairs[0]`（`ccf:A` のような文字列）で並べていたので、
   * 体系名が等級より先に効き、降順で ccf:N（評価が付いていない）の行が先頭に
   * 来ていた（2026-09-23 実測）。並びの規則は recommender の `rankSortKey` が正本で、
   * 一覧の比較式がそれを使っていること、選択欄の等級順と同じ正本であることを見る。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const rankAt = app.indexOf('sortKey === "rank"');
  const rankEnd = app.indexOf("compareDeadlineRows(a, b, mult)", rankAt);
  // 目印が見つからず -1 になると slice の終端が化けて、中身を見ているのに見ていない
  // 検査になる（第 91 回で呼び出し形を変えたときに実際へ起きた）。
  expect(rankAt, "ランク順の並び替え箇所が見つからない").toBeGreaterThan(0);
  expect(rankEnd, "ランク順が比較関数を呼んでいない").toBeGreaterThan(rankAt);
  const rankBlock = app.slice(rankAt, rankEnd);
  expect(rankBlock, "ランク順が recommender の等級キーを見ていない").toContain("rankSortKey");
  expect(rankBlock, "rankPairs を直接比較している").not.toContain("rankPairs[0]");
  // 選択欄の等級は app 側で組み立てるので、静的な HTML には無い。
  // ここは選択欄が recommender の正本から等級をもらっていることを見る
  // （並び順と同じ順序で選択肢を出すための前提）。
  expect(html, "HTML にランク選択欄がない").toContain('id="rank"');
  expect(app, "ランクの選択欄が等級順の正本を使っていない").toContain(
    "RANK_GRADE_OPTIONS = Recommender.rankGradeOrderJa()",
  );

  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const key = (r) => Recommender.rankSortKey(r.rankPairs);",
    "const desc = view.slice().sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));",
    "const rated = (r, grades) => r.rankPairs.some((p) => grades.indexOf(p.slice(p.indexOf(':') + 1)) >= 0);",
    "const topBad = desc.slice(0, 20).filter((r) => !rated(r, ['A*', 'A'])).map((r) => r.rankPairs.join('+') || '(なし)');",
    "const tailBad = desc.slice(-20).filter((r) => rated(r, ['A*', 'A'])).map((r) => r.conf.key);",
    /* 体系名が等級より先に効いていないこと: `A*` を1つでも持つ行が、最良の等級が
     * C 以下の行（`ccf:C` を最良とする行など）より前に並びきるかを見る。
     * 変更前は `core:A*` の行が `ccf:C` の後ろに置かれていた。 */
    "const isAStar = (r) => rated(r, ['A*']);",
    "const bestIsLow = (r) => !rated(r, ['A*', 'A', 'B']) && r.rankPairs.length > 0;",
    "const aStarIndexes = desc.map((r, i) => (isAStar(r) ? i : -1)).filter((i) => i >= 0);",
    "const lowIndexes = desc.map((r, i) => (bestIsLow(r) ? i : -1)).filter((i) => i >= 0);",
    "const crossSystemOk = aStarIndexes.length > 0 && lowIndexes.length > 0",
    "  ? Math.max(...aStarIndexes) < Math.min(...lowIndexes)",
    "  : null;",
    "console.log(JSON.stringify({",
    "  viewRows: view.length,",
    "  topBad,",
    "  tailBad,",
    "  crossSystemOk,",
    "  hasAStar: desc.some((r) => rated(r, ['A*'])),",
    "  gradeOrder: Recommender.rankGradeOrderJa(),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    viewRows: number;
    topBad: string[];
    tailBad: string[];
    crossSystemOk: boolean | null;
    hasAStar: boolean;
    gradeOrder: string[];
  };
  expect(out.viewRows).toBeGreaterThan(0);
  expect(out.hasAStar, "収録に A* の行がない（検査が空振りする）").toBe(true);
  expect(
    out.topBad,
    `ランク順の降順で先頭に評価の無い・等級の低い行が来ている: ${out.topBad.join(" / ")}`,
  ).toEqual([]);
  expect(
    out.tailBad,
    `A* / A の行がランク順の末尾に置かれている: ${out.tailBad.join(", ")}`,
  ).toEqual([]);
  expect(
    out.crossSystemOk,
    "A* を持つ行が、最良の等級が C 以下の行より後ろに置かれている（体系名が優先している）",
  ).toBe(true);
  expect(out.gradeOrder).toEqual(["A*", "A", "B", "C", "N"]);
  // URL にも同じ値を書く（`rank=A*` が選択肢に無い値で共有されない）。
  expect(app, "ランクの URL 読み書きが選択肢と同じ表を見ていない").toContain("RANK_GRADE_OPTIONS");
});

it("開催地の翻訳が収録データで化けていない（New Mexico・別表記の国名・語の食い付き）（SPEC §7）", () => {
  /* 開催地の国名を日本語に寄せる処理は、複合地名を壊すと画面が嘘をつく
   * （`New Mexico` → 「New メキシコ」で、アメリカの会議が「メキシコ」で出ていた）。
   * 収録カタログ全体で、寄せ結果と原文が食い違っていないことをみる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');",
    "const rowsOf = (word) => {",
    "  const m = Recommender.searchMatcher(word, now);",
    "  return rows.filter((r) => m(r.hay));",
    "};",
    "const strip = (s) => fold(s).replace(/[^a-z ]/g, ' ');",
    // ① 国名で引いた行の原文に、その国の語が本当に書かれているか（州名の混入など）。
    "const mexicoBad = rowsOf('メキシコ')",
    "  .filter((r) => !/(^| )mexico( |$)/.test(strip(r.ed.place)))",
    "  .map((r) => String(r.ed.place));",
    "const koreaBad = rowsOf('韓国')",
    "  .filter((r) => !/(korea|korea|seoul)/.test(strip(r.ed.place)))",
    "  .map((r) => String(r.ed.place));",
    // ② 別表記で書かれた国が、日本語の語でたどれないままになっていないか。
    "const count = (word, re) => rowsOf(word).filter((r) => re.test(String(r.ed.place))).length;",
    "const codeRows = rows.filter((r) => /,\\s*BE$/.test(String(r.ed.place))).length;",
    // ③ 寄せ結果で日本語の語にラテン文字が食い付いていないか（`パナマ City` 型）。
    "const glued = [];",
    "rows.forEach((r) => {",
    "  const out = Recommender.placeJa(r.ed.place);",
    "  const hit = out.match(/[ぁ-んァ-ン一-龥][A-Za-z]/);",
    "  if (hit && glued.indexOf(out) < 0) glued.push(out);",
    "});",
    "console.log(JSON.stringify({",
    "  mexicoBad,",
    "  koreaBad,",
    "  newMexicoRows: rowsOf('ニューメキシコ').length,",
    "  newMexicoAllNewMexico: rowsOf('ニューメキシコ').every((r) => /new mexico/i.test(String(r.ed.place))),",
    "  belgiumFromCode: count('ベルギー', /,\\s*BE$/),",
    "  codeRows,",
    "  curacao: count('キュラソー', /cura[çc]ao/i),",
    "  mexicoAccented: count('メキシコ', /m[ée]xico/i),",
    "  glued: glued.slice(0, 5),",
    "  gluedCount: glued.length,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    mexicoBad: string[];
    koreaBad: string[];
    newMexicoRows: number;
    newMexicoAllNewMexico: boolean;
    belgiumFromCode: number;
    codeRows: number;
    curacao: number;
    mexicoAccented: number;
    glued: string[];
    gluedCount: number;
  };
  expect(
    out.mexicoBad,
    `「メキシコ」で引くとメキシコ国内ではない行が出る:\n${out.mexicoBad.join("\n")}`,
  ).toEqual([]);
  expect(out.koreaBad, `「韓国」で引くと韓国の行ではない:\n${out.koreaBad.join("\n")}`).toEqual([]);
  expect(out.newMexicoRows, "「ニューメキシコ」が 0 件").toBeGreaterThan(0);
  expect(out.newMexicoAllNewMexico, "「ニューメキシコ」に別の場所が混ざっている").toBe(true);
  expect(
    out.codeRows,
    "国コードで書かれた開催地が収録に見当たらない（検査が空振りする）",
  ).toBeGreaterThan(0);
  expect(out.belgiumFromCode, "国コード `BE` の行が「ベルギー」で引けない").toBe(out.codeRows);
  expect(out.curacao, "Curaçao が「キュラソー」で引けない").toBeGreaterThan(0);
  expect(out.mexicoAccented, "México が「メキシコ」で引けない").toBeGreaterThan(0);
  expect(
    out.gluedCount,
    `日本語の語にラテン文字が食い付いた開催地表記: ${out.glued.join(" / ")}`,
  ).toBe(0);
});

it("「評価でしぼる」でのぞいた件数を件数欄に出す（SPEC §7）", () => {
  /* 評価の選択欄は「A*」などの一語で、収録にその評価がどれくらいあるかが見えない。
   * のぞいた行数を出さないと「収録に A* が少ない」と誤解する（2026-09-23 実測:
   * 既定画面 477 行のうち「A*」は 61 行だけで、のこり 416 行の話が件数欄になかった）。
   * ビルド後の `filter` を動かし、表示件数とのぞいた数の合計が対象行数と一致ることをみる。
   * 等級の判定は recommender の正本（厳密比較）を使う — 選択欄と同じ比較式でないと
   * 「A」が「A*」に誤マッチして数字が合うはずのものが合わなくなる。 */
  const runtime = siteRuntime();
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  const filterSrc = jsFunction(runtime, "filter");
  const rankMatchesSrc = jsFunction(rec, "rankMatches");
  expect(rankMatchesSrc, "recommender の等級判定が見つからない").toBeTruthy();
  // 関数ソースをそのまま入れる（JSON.stringify すると文字列になって代入にならない）。
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, rankPairs) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: rankPairs, tags: [],",
    "    hay: key, t: now + DAY, tLast: now + DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('a', []), row('b', []), row('c', []),",
    "  row('astar', ['ccf:A*']), row('aA', ['core:A']), row('bB', ['ccf:B']),",
    "  row('n1', ['ccf:N']), row('n2', ['ccf:N', 'core:A*']),",
    "];",
    FILTER_RUNTIME_STUBS,
    // 等級の判定だけ正本に差し替える（スタブの `includes` は部分一致で誤マッチする）。
    `Recommender.rankMatches = ${rankMatchesSrc};`,
    "const run = (rank) => {",
    // `hiddenCounts` はスタブ側の `let` 束縛そのものを戻す（globalThis に書いても
    // `filter` は語彙束縛を見るので数え直されない）。
    "  hiddenCounts = {",
    "    past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0, rank: 0, cats: 0,",
    "  };",
    "  const out = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "    { q: '', cats: [], kind: '', rank: rank, win: 'all', est: false }, true, 'rem')();",
    "  return { shown: out.map((r) => r.conf.key), hidden: hiddenCounts.rank };",
    "};",
    "const out = { noRank: run(''), grades: {} };",
    "['A*', 'A', 'B', 'C', 'N'].forEach((g) => { out.grades[g] = run(g); });",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    noRank: { shown: string[]; hidden: number };
    grades: Record<string, { shown: string[]; hidden: number }>;
  };
  // 評価を掛けない行はすべて出る（のぞいた数も 0）。
  expect(out.noRank.shown).toHaveLength(8);
  expect(out.noRank.hidden).toBe(0);
  Object.entries(out.grades).forEach(([grade, v]) => {
    // 表示 + のぞく = 対象行数（数え漏らし・二重計上の検出）。
    expect(v.shown.length + v.hidden, `評価「${grade}」`).toBe(8);
  });
  expect(out.grades["A*"].shown).toEqual(["astar", "n2"]);
  // 厳密比較なので「A」は「A*」を含まない（選択欄と同じ判定を使っていることの確認）。
  expect(out.grades.A.shown).toEqual(["aA"]);
  expect(out.grades.N.shown).toEqual(["n1", "n2"]);
  expect(out.grades.C.shown).toEqual([]);
  expect(out.grades.C.hidden, "0 件の評価でのぞいた数が出ていない").toBe(8);

  const app = runtime;
  // 件数欄が評価で絞った件数を書く（語の形は下の検査で見る – ここは配線だけ）。
  expect(app, "件数欄が評価で絞った件数を書いていない").toContain("rankDropWordsJa(state.rank)");
});

it("CSV の分野列は画面と同じ日本語の語で、英字のキーを書かない（SPEC §7）", () => {
  /* 分野は絞り込みで使う次元なのに、一覧は 7 列で分野列を持たないため、
   * 表計算に持ち出すと分野ごとに並べ替えられなかった。CSV だけに見出すとき、
   * 書く語は画面（分野チップ・行の詳細）と同じ日本語で、`hpc` のような
   * 内部キーを表計算に渡さない。収録カタログ全体で列の組み立ても確かめる。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    // RFC4180 の読み方で 1 行ずつ分ける（開催地などにカンマが入る）。
    "function splitLine(line) {",
    "  const out = [];",
    "  let cur = '', quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === '\"' && line[i + 1] === '\"') { cur += '\"'; i++; }",
    "      else if (ch === '\"') quoted = false;",
    "      else cur += ch;",
    "    } else if (ch === '\"') quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "}",
    "const csv = Recommender.deadlinesToCsv(rows, now);",
    "const lines = csv.split('\\r\\n').filter((l) => l.length);",
    "const header = splitLine(lines[0]);",
    "const at = header.indexOf('分野');",
    "const cells = lines.slice(1).map((l) => splitLine(l)[at]);",
    "const widths = new Set(lines.map((l) => splitLine(l).length));",
    // キーがそのまま出ている例（ラベル表に無い語）を集める。
    "const asciiCells = [...new Set(cells.filter((c) => c && !/[ぁ-んァ-ン一-龥]/.test(c)))];",
    "const emptyWhereCats = lines.slice(1)",
    "  .map((l, i) => ({ cats: (rows[i].cats || []).length, cell: cells[i] }))",
    "  .filter((x) => x.cats > 0 && !x.cell).length;",
    "const mismatch = lines.slice(1)",
    "  .map((l, i) => (rows[i].cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・'))",
    "  .filter((want, i) => want !== cells[i]).length;",
    "console.log(JSON.stringify({",
    "  header, at, dataRows: lines.length - 1, widths: [...widths],",
    "  sample: cells.filter((c) => c).slice(0, 3),",
    "  asciiCells: asciiCells.slice(0, 5),",
    "  emptyWhereCats, mismatch,",
    "  labeled: rows.reduce((n, r) => n + (r.cats || []).length, 0),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    header: string[];
    at: number;
    dataRows: number;
    widths: number[];
    sample: string[];
    asciiCells: string[];
    emptyWhereCats: number;
    mismatch: number;
    labeled: number;
  };
  expect(out.header, "CSV の見出しに分野がない").toContain("分野");
  expect(out.at).toBeGreaterThan(0);
  expect(out.dataRows).toBeGreaterThan(1000);
  // 列の組み立てが全行で揃っている（1 列だけ欠ける行を作らない）。
  expect(out.widths, "行によって列数が違う").toEqual([out.header.length]);
  expect(out.labeled).toBeGreaterThan(0);
  expect(out.sample.length, "分野が書かれた行がない（検査が空振りする）").toBeGreaterThan(0);
  expect(
    out.asciiCells,
    `分野列に日本語でない語が混ざっている: ${out.asciiCells.join(", ")}`,
  ).toEqual([]);
  expect(out.emptyWhereCats, "分野を持つ行の分野列が空").toBe(0);
  expect(out.mismatch, "分野列が画面と同じ語になっていない行がある").toBe(0);
});

it("分野チップでのぞいた件数を件数欄に出す（SPEC §7）", () => {
  /* チップには分野ごとの件数が写るが、「選んだ分野で何行が出て他が何行だったか」は
   * 件数欄に書かないと分からない（2026-09-23 実測: 既定画面 477 行のうち
   * 「人工知能」は 182 行で、のこり 295 行の話し手が件数欄にいなかった）。
   * のぞいた数は「他の条件を通った行」からの数えなので、表示と足して全件にはならない
   * — その関係も検査で固定する（何と何を足した数か分からない表示を避ける）。 */
  const runtime = siteRuntime();
  const filterSrc = jsFunction(runtime, "filter");
  const script = [
    `const countJa = (${jsFunction(runtime, "countJa")});`,
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(key, cats) {",
    "  return { kind: 'paper', est: false, cats: cats, rankPairs: [], tags: [],",
    "    hay: key, t: now + DAY, tLast: now + DAY,",
    "    ed: { place: 'Kyoto, 日本', deadlines: [] }, conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('hpc', ['hpc']), row('ai', ['ai']), row('both', ['hpc', 'ai']),",
    "  row('sec', ['sec']), row('net', ['net', 'sec']),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (cats) => {",
    // `hiddenCounts` はスタブ側の `let` 束縛そのものを戻す（語彙束縛を見ないので
    // globalThis に書いても数え直されない）。
    "  hiddenCounts = {",
    "    past: 0, est: 0, kind: 0, domestic: 0, online: 0, onlinePlaceUnknown: 0, window: 0,",
    "    rank: 0, cats: 0,",
    "  };",
    "  const out = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "    'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "    { q: '', cats: cats, kind: '', rank: '', win: 'all', est: false }, true, 'rem')();",
    "  return { shown: out.map((r) => r.conf.key), hidden: hiddenCounts.cats, facets: catFacetCounts };",
    "};",
    "console.log(JSON.stringify({",
    "  none: run([]), one: run(['hpc']), two: run(['hpc', 'ai']), other: run(['quantum']),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    none: { shown: string[]; hidden: number };
    one: { shown: string[]; hidden: number };
    two: { shown: string[]; hidden: number };
    other: { shown: string[]; hidden: number };
  };
  /* 並び順はこの検査の話ではないので、比較は常に順を揃えて行う。 */
  // チップを押していないときは内訳に立たない（件数欄に出さない）。
  expect(out.none.shown).toHaveLength(5);
  expect(out.none.hidden).toBe(0);
  // 1 つのチップ: 表示 + のぞく = 他の条件を通った行（ここでは全 5 行）。
  expect(out.one.shown.slice().sort()).toEqual(["both", "hpc"]);
  expect(out.one.hidden).toBe(3);
  // 2 つのチップは OR なので、のぞく数は減る（`net` は hpc・ai のどちらでもない）。
  expect(out.two.shown.slice().sort()).toEqual(["ai", "both", "hpc"]);
  expect(out.two.hidden).toBe(2);
  // 収録に無い分野を選ぶと 0 件＋のぞいた全件（0 件の案内と合わせて理由が分かる）。
  expect(out.other.shown).toEqual([]);
  expect(out.other.hidden).toBe(5);

  const app = runtime;
  expect(app, "件数欄が分野で絞った件数を書いていない").toContain(
    '分野「${state.cats.map((key) => catLabel(key)).join("・")}」を持たない行 ${countJa(hidden.cats)} 件',
  );
});

it("新しい分野の言い方が、収録カタログの英文字表記に届いている（SPEC §7）", () => {
  /* 「打ち方が通じない」で 0 件にしないための表なので、**実データで当たること**を見る。
   * 日本語で打った行が英文字表記の行をすべて含み、かつ 1 件以上出ること。
   *英文字側の語順が収録に無い条目を置いていないことも、ここで同時に確かめる。 */
  const pairs: Array<[string, string]> = [
    ["リアルタイム", "real-time"],
    ["実時間", "real-time"],
    ["スケジューリング", "scheduling"],
    ["プログラミング言語", "programming language"],
    ["コンパイラ", "compiler"],
    ["クラスタ", "cluster"],
    ["バイオインフォマティクス", "bioinformatics"],
    ["音響", "acoustic"],
    ["脆弱性", "vulnerability"],
    ["マルウェア", "malware"],
    ["侵入検知", "intrusion detection"],
    ["モバイル", "mobile"],
    ["ユーザインタフェース", "user interface"],
    ["ゲーム", "game"],
    ["エッジコンピューティング", "edge computing"],
    ["仮想現実", "virtual reality"],
    ["拡張現実", "augmented reality"],
    ["計算機アーキテクチャ", "computer architecture"],
    ["データ分析", "data analytics"],
    ["パターン認識", "pattern recognition"],
    // 第 3 群（英文字側が 1〜183 行当たり、日本語は 0 件だった語）。
    ["プライバシー", "privacy"],
    ["医療", "medical"],
    ["医用", "medical"],
    ["健康", "health"],
    ["認知", "cognitive"],
    ["ドローン", "drone"],
    ["知識グラフ", "knowledge graph"],
    ["データマイニング", "data mining"],
    ["推論", "reasoning"],
    ["プロトコル", "protocol"],
    ["センサネットワーク", "sensor network"],
    ["自律", "autonomous"],
  ];
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    `const PAIRS = ${JSON.stringify(pairs)};`,
    "const out = [];",
    "for (const [ja, latin] of PAIRS) {",
    "  const folded = Recommender.searchNormalize(latin);",
    "  const phrase = new Set(rows.filter((r) => Recommender.kanaFold(r.hay).indexOf(folded) >= 0).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const m = Recommender.searchMatcher(ja);",
    "  const viaJa = new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const missing = [...phrase].filter((k) => !viaJa.has(k)).length;",
    "  out.push({ ja, latin, phrase: phrase.size, viaJa: viaJa.size, missing });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    ja: string;
    latin: string;
    phrase: number;
    viaJa: number;
    missing: number;
  }>;
  expect(out.length).toBe(pairs.length);
  for (const row of out) {
    expect(
      row.phrase,
      `「${row.ja}」の寄せ先 ${row.latin} が収録に現れない（死んだ寄せ）`,
    ).toBeGreaterThan(0);
    expect(row.missing, `「${row.ja}」で引くと ${row.latin} の行が ${row.missing} 件届かない`).toBe(
      0,
    );
    expect(row.viaJa, `「${row.ja}」で 1 件も出ない`).toBeGreaterThan(0);
  }
});

it("新しい開催市の言い方が、収録の開催地に届いている（SPEC §7）", () => {
  /* 「5 行以上の都市は検査で見ている」検査は、**アクセント付きの都市名を ASCII 正規表現で
   * 弾いていた**ため、`Cancún`（収録 23 行）など 4 種を見ていなかった（2026-09-23 実測）。
   * アクセント記号を除いて数え上げるように直したので、足した語が本当に届くことを実データで見る。 */
  const pairs: Array<[string, string]> = [
    ["カンクン", "cancun"],
    ["マルメ", "malmo"],
    ["テュービンゲン", "tubingen"],
    ["マラガ", "malaga"],
    ["サクラメント", "sacramento"],
    ["ニージメヘン", "nijmegen"],
    ["ヴェローナ", "verona"],
    ["ハリファックス", "halifax"],
    ["アレクサンドリア", "alexandria"],
    ["ドゥブロブニク", "dubrovnik"],
    ["ロングビーチ", "long beach"],
    ["シャーロット", "charlotte"],
    ["クラクフ", "krakow"],
    ["ピサ", "pisa"],
    ["ノッティンガム", "nottingham"],
    ["マインツ", "mainz"],
  ];
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const cityOf = (r) => {",
    "  const raw = String(r.ed.place || '').trim();",
    "  if (!raw) return '';",
    "  const seg = raw.split('/')[0];",
    "  const at = seg.indexOf(',');",
    "  return FOLD(at < 0 ? seg : seg.slice(0, at));",
    "};",
    `const PAIRS = ${JSON.stringify(pairs)};`,
    "const out = [];",
    "for (const [ja, latin] of PAIRS) {",
    "  const want = String(latin).toLowerCase();",
    "  const cities = new Set(rows.filter((r) => cityOf(r).indexOf(want) >= 0).map((r) => r.conf.key + '@' + r.ed.year));",
    "  const m = Recommender.searchMatcher(ja);",
    "  const viaJa = new Set(rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year));",
    "  out.push({ ja, latin, cities: cities.size, missing: [...cities].filter((k) => !viaJa.has(k)).length });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    ja: string;
    latin: string;
    cities: number;
    missing: number;
  }>;
  expect(out.length).toBe(pairs.length);
  for (const row of out) {
    expect(
      row.cities,
      `「${row.ja}」の寄せ先 ${row.latin} が開催地として収録に現れない`,
    ).toBeGreaterThan(0);
    expect(row.missing, `「${row.ja}」で引くとその都市の行が ${row.missing} 件届かない`).toBe(0);
  }
});

it("略称と年をスペースで離して 2 桁打つ入力も、実カタログで 4 桁と同じ行を出す（SPEC §7）", () => {
  /* `nsdi27`（貼り付け）と `NSDI 2027`（4 桁）は通っていたのに、いちばん打ちやすい
   * `NSDI 27` が 0 件だった（2026-09-23 実測）。**裸の 2 桁を年として扱うのは、
   * 同じ入力に略称があるときだけ**なので、月日や裸の数字の当たり方が広まっていないことも
   * 同じ実データで確認する。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year).sort(); };",
    "const pairs = [['NSDI 27', 'NSDI 2027'], ['ICDE 27', 'ICDE 2027'], ['OSDI 26', 'OSDI 2026']]",
    "  .map((pair) => ({ short: keys(pair[0]), long: keys(pair[1]) }));",
    "const bare = keys('27').length;",
    "const monthDay = keys('8月 27').length;",
    // 暦日で引ける入力は従来どおり（年の展開で減っていないこと）。
    "const isoMonth = keys('2026-12').length;",
    "console.log(JSON.stringify({ pairs, bare, monthDay, isoMonth }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    pairs: Array<{ short: string[]; long: string[] }>;
    bare: number;
    monthDay: number;
    isoMonth: number;
  };
  out.pairs.forEach((pair, i) => {
    expect(pair.long.length, `${i} 件目の 4 桁入力が 0 件`).toBeGreaterThan(0);
    expect(pair.short, `${i} 件目: 離して 2 桁打つ入力が 4 桁と同じ行を出さない`).toEqual(
      pair.long,
    );
  });
  // 裸の 2 桁・月日の入力は広げていない（暦日の当たり方のまま）。
  expect(out.bare).toBeGreaterThan(0);
  expect(out.monthDay).toBeGreaterThan(0);
  expect(out.isoMonth).toBeGreaterThan(0);
});

it("会期だけの会の案内と行の詳細の開催地は、表と同じ書き方で出す（SPEC §7）", () => {
  /* 行の詳細は「開催地: Kyoto, 日本」と出すのに、「今後の会期」と 0 件時の会期案内は
   * 原文のままだった（＠Kyoto, Japan）。開催都市は公式表記のまま、国だけ日本語に寄せる
   * のが表の書き方なので、そちらに揃える。同じ画面の中で同じ種類の情報が 2 通りの
   * 書き方をしていると、別の場所だと誤解する（開催地は日本語に寄せる、が既定の約束）。
   * ビルド後の `renderNextMeetingNote` を疑似 DOM で実際に動かして確かめる。 */
  const runtime = siteRuntime();
  const _recSrc = readFileSync(join(site, "recommender.js"), "utf8");
  expect(runtime).toContain("＠${shownPlace}");
  // 行の詳細の「今後の会期」の書き方は recommender.js の正本へ移した（索引と同じ 1 本）。
  expect(siteRuntime("recommender.js")).toContain("\uff20${placeJa(place)}");
  expect(siteRuntime("recommender.js")).not.toContain("\uff20${next.place}");
  // 原文を出しっぱなしにする形に戻っていないこと（表題の語で探す人が探せる形）。
  expect(runtime).not.toContain("＠${m.place}");
  expect(runtime).not.toContain("＠${next.place}");
  const noteSrc = jsFunction(runtime, "renderNextMeetingNote");
  const matchSrc = jsFunction(runtime, "scheduleOnlyMatches");
  const limitSrc = jsFunction(runtime, "windowLimitMs");
  // 会期の書き方は recommender.js の正本へ移したので、この検査は import した本物を使う（第 220 回）。
  const rangeSrc = "const meetingRangeJa = Recommender.meetingRangeJa;";
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const DAY = 86400000;",
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    // 会期だけ確定している回（締切の無い edition）を 1 件置く。
    "const DATA = { conferences: [{ key: 'demo', title: 'Demo Conf', link: 'https://example.org/',",
    "  categories: ['hpc'], tags: [], editions: [{ event_start: '2026-09-30', event_end: '2026-10-02',",
    "  place: 'Kyoto, Japan', deadlines: [], link: 'https://example.org/cfp' }] }] }",
    "const boxes = [];",
    "function node(text) { return { textContent: text || '', title: '', tag: 'span', children: [],",
    "  appendChild(c) { this.children.push(c); return c; } }; }",
    "const box = node();",
    "box.hidden = true;",
    "boxes.push(box);",
    "const document = { createElement: (tag) => { const n = node(); n.tag = tag; return n; },",
    "  createTextNode: (t) => node(t) };",
    "const $ = () => box;",
    "let searchQuery = '';",
    `${limitSrc}`,
    `${rangeSrc}`,
    `${matchSrc}`,
    `${noteSrc}`,
    "renderNextMeetingNote(scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false }));",
    "const flat = (n) => (n.textContent || '') + n.children.map(flat).join('');",
    "const titles = [];",
    "(function walk(n) { if (n.title) titles.push(n.title); n.children.forEach(walk); })(box);",
    "console.log(JSON.stringify({ hidden: box.hidden, text: flat(box), titles }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { hidden: boolean; text: string; titles: string[] };
  expect(out.hidden, "会期案内が出ていない（検査が空振りする）").toBe(false);
  // 表と同じ書き方（国は日本語、開催市は公式表記）。
  expect(out.text, `開催地が表と同じ書き方になっていない: ${out.text}`).toContain("Kyoto, 日本");
  expect(out.text).not.toContain("Japan");
  expect(out.titles, "原表記をどこにも残していない").toContain("Kyoto, Japan");
  // 会期の書き方も表と同じ（暦日 + 曜日）。
  expect(out.text).toContain("2026-09-30(水)");
});

it("日本開催の行は、開催地の市区郡・会場を日本語で打つとその行に出会える（SPEC §7）", () => {
  /* 国内の行はローマ字をそのまま打つ人が少ない（漢字で打つ）。海外側は「5 行以上の都市」で
   * 見ていたが、日本開催は 1 都市 1〜2 行なので閾値に届かず、検査の外にあった。
   * 2026-09-23 実測: 日本開催の行のうち `Aizuwakamatsu` の 2 行だけが、どの日本語の
   * 言い方でも 0 件だった（`会津若松` を足して解消）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const rec = readFileSync(${JSON.stringify(join(site, "recommender.js"))}, 'utf8');`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const FOLD = (v) => String(v).normalize('NFKC').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();",
    "const grab = (name) => {",
    "  const head = 'const ' + name + ' = ';",
    "  const i = rec.indexOf(head);",
    "  const j = rec.indexOf('\\n    ];', i);",
    '  return eval(vmSafeSource(rec.slice(i + head.length, j)) + "\\n];");',
    "};",
    "const cityOf = (place) => {",
    "  const seg = String(place || '').trim().split('/')[0];",
    "  const at = seg.indexOf(',');",
    "  return (at < 0 ? seg : seg.slice(0, at)).trim();",
    "};",
    // ① 実行ビルドの収録に対して: 日本開催の行の開催地（最初の市区郡・会場）ごとに、
    //    日本語の言い方の表に対応があるか。
    "const rows = Recommender.candidateRows(DATA);",
    "const japan = rows.filter((r) => /日本|japan/i.test(String(r.ed.place || '')));",
    "const pairs = grab('PLACE_QUERY_ALIASES_JA').map((p) => [p[0], FOLD(p[1])]);",
    // 除外は置かない。`Miyakojima`（FC の回）は公式の "Miyakojima, Japan" に応じて
    // `宮古島` が既に寄せてあるので、そのまま通る。
    "const segs = new Map();",
    "japan.forEach((r) => { const c = cityOf(r.ed.place); segs.set(c, (segs.get(c) || 0) + 1); });",
    "const uncovered = [];",
    "for (const [city, n] of segs) {",
    "  const folded = FOLD(city);",
    "  if (!/^[a-z]/.test(folded)) continue;",
    "  if (!pairs.some((p) => folded.indexOf(p[1]) >= 0)) uncovered.push(city + ' (' + n + ' 行)');",
    "}",
    // ② 表にあっても当たり方が違えば意味がないので、合成した行に対して実際に引いて見る
    //    （収録側の行は上流の取得状況で増減するため、ここでは再現できる形でおく）。
    // 収録の形（`tests/helpers.ts` の makeConference/makeEdition と同じ字段）。
    "const mk = (key, place) => ({ key, title: key.toUpperCase(), full_name: key.toUpperCase(),",
    "  link: 'https://example.org/', rank: {}, dblp: null, upstream_sub: null, tags: [],",
    "  categories: ['hpc'], sources: ['ccfddl'], editions: [{",
    "  edition_id: key + '26', link: 'https://example.org/cfp', place, date_text: '2026-09-30',",
    "  event_start: '2026-09-30', event_end: '2026-10-02', estimated: false, source: 'ccfddl',",
    "  deadlines: [{ kind: 'paper', label: '2026-09-01', at_utc: '2026-09-01T15:00:00.000Z',",
    "  tz_raw: 'AoE', round: 1, comment: null }] }] });",
    "const fixture = { conferences: [",
    "  mk('aizu', 'Aizuwakamatsu, Japan'), mk('hitotsubashi', 'Hitotsubashi Hall, Tokyo, Japan'),",
    "  mk('miraikan', 'Tokyo Odaiba Miraikan, Japan'), mk('tokyo', 'Tokyo, Japan'),",
    "  mk('kyoto', 'Kyoto, Japan'), mk('nagoya', 'Nagoya, Japan'),",
    "] };",
    "const frows = Recommender.candidateRows(fixture);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const checks = [['会津若松', 'aizu'], ['会津', 'aizu'], ['一橋講堂', 'hitotsubashi'],",
    "  ['日本科学未来館', 'miraikan'], ['未来館', 'miraikan'], ['東京', 'tokyo'], ['東京', 'hitotsubashi'],",
    "  ['京都', 'kyoto'], ['名古屋', 'nagoya']];",
    "const misses = [];",
    "for (const [ja, key] of checks) {",
    "  const m = Recommender.searchMatcher(ja, now);",
    "  const row = frows.find((r) => r.conf.key === key);",
    "  if (!row) misses.push(ja + ': 行が無い');",
    "  else if (!m(row.hay)) misses.push('「' + ja + '」が " + "' + key + ' の行を返さない');",
    "}",
    "console.log(JSON.stringify({",
    "  total: segs.size, japan: japan.length,",
    "  uncovered, misses, fixtureRows: frows.length,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync(
    "node",
    ["-e", `const vmSafeSource = ${vmSafeSource.toString()};\n${script}`],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    total: number;
    japan: number;
    uncovered: string[];
    misses: string[];
    fixtureRows: number;
  };
  // 検査が実際に日本開催の行を見ていること（空振りを防ぐ）。
  expect(out.japan, "日本開催の行が検査に乗っていない").toBeGreaterThan(8);
  expect(out.total).toBeGreaterThan(5);
  expect(out.fixtureRows, "合成行が作れていない").toBe(6);
  expect(
    out.uncovered,
    `日本語で打ってもたどれない日本開催の開催地:\n${out.uncovered.join("\n")}`,
  ).toEqual([]);
  expect(out.misses, `日本語で引いても行が出ない:\n${out.misses.join("\n")}`).toEqual([]);
});

it("ラウンドは画面の書き方でも CSV の表記でも、実カタログで同じ行を出す（SPEC §7）", () => {
  /* 表の種別セルは「第 N ラウンド」、CSV は `RN`。画面の語が検索で引けないと、
   * 複数ラウンドの会議（PVLDB や SIGMOD など）を絞り込めない。
   * 画面どおりにスペースを入れて写した入力が全件に化けていないこともここで見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const keys = (q) => { const m = Recommender.searchMatcher(q, now); return rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year + '#' + r.dl.kind + '#' + r.dl.round).sort(); };",
    "const out = [];",
    "for (const n of [1, 2, 3, 12]) {",
    "  const own = rows.filter((r) => Number(r.dl.round) === n)",
    "    .map((r) => r.conf.key + '@' + r.ed.year + '#' + r.dl.kind + '#' + r.dl.round).sort();",
    "  if (own.length === 0) continue;",
    "  const spaced = keys('第 ' + n + ' ラウンド');",
    "  const compact = keys('第' + n + 'ラウンド');",
    "  const csv = keys('R' + n);",
    "  const missing = own.filter((k) => compact.indexOf(k) < 0).length;",
    "  const csvMissing = own.filter((k) => csv.indexOf(k) < 0).length;",
    "  out.push({ n, own: own.length, spaced: spaced.length, compact: compact.length, csv: csv.length, missing, csvMissing });",
    "}",
    // 全件に化けていないこと（割れた語が緩いので、必ず上位桁で抑える）。
    "const all = rows.length;",
    "const wide = keys('第 2 ラウンド').length;",
    "console.log(JSON.stringify({ all, wide, out }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: number;
    wide: number;
    out: Array<{
      n: number;
      own: number;
      spaced: number;
      compact: number;
      csv: number;
      missing: number;
      csvMissing: number;
    }>;
  };
  expect(out.out.length, "ラウンド付きの行が数え上げられていない").toBeGreaterThan(2);
  for (const row of out.out) {
    expect(
      row.missing,
      `第 ${row.n} ラウンドの行が ${row.missing} 件届かない（画面の書き方）`,
    ).toBe(0);
    expect(
      row.csvMissing,
      `第 ${row.n} ラウンドの行が ${row.csvMissing} 件届かない（CSV の表記）`,
    ).toBe(0);
    // 寄せた形はきっちりそのラウンドの行だけ（他ラウンドを交えない）。
    expect(row.spaced, `第 ${row.n} ラウンド: スペース入り写しが件数の違う結果を出した`).toBe(
      row.compact,
    );
    expect(row.compact, `第 ${row.n} ラウンド: 寄せた形がそのラウンド以外も出した`).toBe(row.own);
  }
  expect(out.wide, "画面どおりに写した入力が全件に化けている").toBeLessThan(out.all / 4);
});

it("画面が・で並べた分野の語をそのまま写すと、その行に出会える（SPEC §7）", () => {
  /* 件数欄・CSV の分野列・行の詳細は `人工知能・データベース` の形で行を説明する。
   * 変更前は写した語が 0 件だったので、**その表記を実際に持つ行**が全部出ることを
   * 実データで見る（AND なので、持たない行が増えてよいことは要求しない）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const label = (r) => (r.cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・');",
    "const byLabel = new Map();",
    "rows.forEach((r) => {",
    "  const l = label(r);",
    "  if (l.indexOf('・') < 0) return;",
    "  if (!byLabel.has(l)) byLabel.set(l, []);",
    "  byLabel.get(l).push(r.conf.key + '@' + r.ed.year);",
    "});",
    // 件数の多い表記だけ見る（1 行の表記は収録欠落と区別できない）。
    "const labels = [...byLabel.entries()].filter(([, v]) => v.length >= 5).sort((a, b) => b[1].length - a[1].length).slice(0, 8);",
    "const out = labels.map(([l, own]) => {",
    "  const m = Recommender.searchMatcher(l);",
    "  const hit = rows.filter((r) => m(r.hay)).map((r) => r.conf.key + '@' + r.ed.year);",
    "  return { l, own: own.length, hit: hit.length, missing: own.filter((k) => hit.indexOf(k) < 0).length };",
    "});",
    "console.log(JSON.stringify({ kinds: byLabel.size, out }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    kinds: number;
    out: Array<{ l: string; own: number; hit: number; missing: number }>;
  };
  expect(out.kinds, "・ で並ぶ分野表記が数え上げられていない").toBeGreaterThan(3);
  expect(out.out.length).toBeGreaterThan(2);
  for (const row of out.out) {
    expect(row.missing, `「${row.l}」を写すとその表記を持つ行が ${row.missing} 件届かない`).toBe(0);
    // AND なので、ヒットはその表記を持つ行数以上（1 語だけの行も入る）。
    expect(row.hit, `「${row.l}」の当たり方が表記を持つ行数より少ない`).toBeGreaterThanOrEqual(
      row.own,
    );
  }
});

it("案内文に書いた実測値が、ビルド成果物に対して今も合っている（SPEC §7）", () => {
  /* 案内文は「既定画面 478 行のうち 15 行だけ」のような実測値を根拠に書いている。
   * それが収録や実装の change でズレると、案内文が噓をつく（画面の件数欄と合わない）。
   * 2026-09-23 に実際に 7 か所ズレていた（477→478 行、のぞく 462→463 件、
   * 2 ラウンド 387→378 件、`プライバシー` 20→16 件など）。
   * 測る基準は **オフラインビルド（収録 `data/snapshot.json` + 固定時刻 2026-08-09）**。
   * 上流キャッシュ込みのビルドは再現しないので、案内文の基準にしない。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  /* 測る基準は **固定時刻のオフラインビルド**。`tests/helpers.ts` の既定時刻だと
     窓に入る行数が変わるので、案内文が書いた時刻（2026-08-09）で組み直す。 */
  const basis = join(mkdtempSync(join(tmpdir(), "cfp-basis-")), "public");
  /* `tempCache()` は合成した fixture キャッシュを書く（収録が差し替わる）。
     案内文の実測値は **収録 `data/snapshot.json` から組んだ成果物**について書いたもの
     なので、空キャッシュ（= snapshot へフォールバック）で組む。ここを取り違えると
     既定画面が 306 行になって案内文と合わない（2026-09-23 に実測）。 */
  const emptyCache = mkdtempSync(join(tmpdir(), "cfp-empty-cache-"));
  const built = runCli(basis, {
    now: "2026-08-09T00:00:00Z",
    cache: emptyCache,
    extra: ["--no-embeddings"],
  });
  expect(built.status, built.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(basis, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(basis, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const rows = Recommender.candidateRows(DATA);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const hits = (q, pool) => { const m = Recommender.searchMatcher(q, now); return pool.filter((r) => m(r.hay)).length; };",
    "const online = view.filter((r) => Recommender.placeOffersOnline(r.ed.place)).length;",
    "const unknownPlace = view",
    "  .filter((r) => !Recommender.placeOffersOnline(r.ed.place))",
    "  .filter((r) => !String(r.ed.place || '').trim()).length;",
    "console.log(JSON.stringify({",
    "  catalog: rows.length,",
    "  view: view.length,",
    "  estimated: rows.filter((r) => r.ed.estimated).length,",
    "  onlineView: online,",
    "  onlineCatalog: rows.filter((r) => Recommender.placeOffersOnline(r.ed.place)).length,",
    "  unknownPlace,",
    "  in7d: view.filter((r) => r.t - now <= 7 * DAY).length,",
    "  ai: hits('人工知能', view),",
    "  astar: hits('A*', view),",
    "  round2: rows.filter((r) => Number(r.dl.round) === 2).length,",
    "  extendedView: view.filter((r) => Recommender.isExtendedDeadline(r.dl)).length,",
    "  extendedAll: rows.filter((r) => Recommender.isExtendedDeadline(r.dl)).length,",
    "  middleDot: rows.filter((r) =>",
    "    (r.cats || []).map((c) => Recommender.categoryLabelJa(c)).join('・').indexOf('・') >= 0).length,",
    "  cancun: rows.filter((r) => Recommender.kanaFold(String(r.ed.place || '')).indexOf('cancun') >= 0).length,",
    "  privacy: hits('プライバシー', view),",
    "  dataMining: hits('データマイニング', view),",
    "  dataAnalytics: hits('データ分析', view),",
    "  vr: hits('仮想現実', view),",
    "  realtime: hits('リアルタイム', view),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const m = JSON.parse(proc.stdout) as Record<string, number>;
  // 案内文が書いている数（左）と、いま測れる数（右）を突合する。
  const claims: Array<[string, string, number]> = [
    ["既定画面の行数", "478 行", m.view],
    ["推定で出さない行", "134 件", m.estimated],
    ["7 日以内の行", "39 行", m.in7d],
    ["7 日以内で窓の外", "439 行", m.view - m.in7d],
    ["人工知能の行", "182 行", m.ai],
    ["人工知能でのこり", "296 行", m.view - m.ai],
    ["A* の行", "61 行", m.astar],
    ["A* でのこり", "417 行", m.view - m.astar],
    ["オンラインに書ける行", "15 行", m.onlineView],
    ["オンラインでのぞく件", "463 件", m.view - m.onlineView],
    ["開催地が未確認の行", "110 件", m.unknownPlace],
    ["収録のオンライン可", "117 件", m.onlineCatalog],
    ["2 ラウンドの行", "378 件", m.round2],
    ["既定画面で延長の目印が付く行", "12 行", m.extendedView],
    ["収録全体の延長の目印", "36 件", m.extendedAll],
    ["・付きの分野表記を持つ行", "397 行", m.middleDot],
    ["Cancún の行", "23 行", m.cancun],
    ["プライバシー", "16 件", m.privacy],
    ["データマイニング", "22 件", m.dataMining],
    ["データ分析", "7 件", m.dataAnalytics],
    ["仮想現実", "6 件", m.vr],
    ["リアルタイム", "2 件", m.realtime],
  ];
  expect(claims.length).toBeGreaterThan(15);
  for (const [label, written, measured] of claims) {
    expect(measured, `案内文の「${label}」は ${written} と書いてあるが、いま ${measured}`).toBe(
      Number(written.replace(/[^0-9]/g, "")),
    );
    // 案内文の実際にその数を書いていることも見る（検査だけ先に緑になるのを防ぐ）。
    expect(template, `案内文に「${label}」の値 ${written} が書かれていない`).toContain(written);
  }
});

it("行の詳細の分野・主題・ランクは、一覧と同じ中黒で並び、写すとその行に出会える（SPEC §7）", () => {
  /* 一覧・CSV・件数欄は分野を中黒（・）で並べるのに、行の詳細だけ全角コンマ（，）で
   * 並べていた。同じ情報を 2 通りの書き方で見せるうえ、行の詳細から検索欄へ写した人が
   * 1 語扱いで 0 件に当たった（2026-09-23 実測: `人工知能，データベース` 0 件）。 */
  const runtime = siteRuntime();
  expect(runtime, "行の詳細がまだ全角コンマで並べている").not.toContain('join("，")');
  expect(
    runtime.match(/\.join\("・"\)/g)?.length,
    "分野・主題・ランクの並べ語が揃っていない",
  ).toBeGreaterThanOrEqual(3);
  // 写した形（中黒で並べた分野）が、実カタログでその行に戻ってくることは
  // 「画面が・で並べた分野の語をそのまま写すと」の検査が見ている。ここでは
  // 行の詳細がその形を出することだけ確かめる。
  const rows = spawnSync(
    "node",
    [
      "-e",
      [
        "(async () => {",
        "const { readFileSync } = await import('node:fs');",
        `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
        `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
        "const rows = Recommender.candidateRows(DATA);",
        "const multi = rows.filter((r) => (r.cats || []).length >= 2).length;",
        "console.log(JSON.stringify({ multi }));",
        "})();",
      ].join("\n"),
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(rows.status, rows.stderr).toBe(0);
  const out = JSON.parse(rows.stdout) as { multi: number };
  expect(out.multi, "分野を 2 つ以上持つ行が無いとこの検査が空振りする").toBeGreaterThan(20);
});

it("月・日の語は、和暦の語を持つ行だけを出す（隣の月日が混ざらない・SPEC §7）", () => {
  /* 照合は部分一致なので、変更前は `1月` が `11月` に当たって 1 月と無関係な行を
   * 526 件返していた（`2月` は 394 件・`1日` は 287 件）。実カタログで、
   * **当たり = 和暦の語を持つ行** であることを双方向で見る（多くも少なくも出ない）。 */
  // 収録の和暦年（2019〜2028 実測）を月語の展開範囲が含んでいることも見るので、
  // 空キャッシュ（= 収録 snapshot）で組み直した成果物で測る。
  const basis2 = join(mkdtempSync(join(tmpdir(), "cfp-month-")), "public");
  const builtMonth = runCli(basis2, {
    now: "2026-08-09T00:00:00Z",
    cache: mkdtempSync(join(tmpdir(), "cfp-empty-")),
    extra: ["--no-embeddings"],
  });
  expect(builtMonth.status, builtMonth.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(basis2, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(basis2, "data.json"))}, 'utf8'));`,
    "const rows = Recommender.candidateRows(DATA);",
    "const hasMonth = (hay, m) => new RegExp('(^| )\\\\d{4}年' + m + '月').test(hay);",
    // 日の語は `8月10日` と `2026年8月10日` の両方に出る（月語も `2026年8月`）。
    "const hasDay = (hay, d) =>",
    "  new RegExp('(^| )(\\\\d{4}年)?\\\\d{1,2}月' + d + '日').test(hay);",
    "const out = [];",
    "for (let m = 1; m <= 12; m += 1) {",
    "  const mt = Recommender.searchMatcher(m + '月');",
    "  const hit = rows.filter((r) => mt(r.hay));",
    "  const own = rows.filter((r) => hasMonth(r.hay, m));",
    "  out.push({",
    "    q: m + '月', hit: hit.length, own: own.length,",
    "    extra: hit.filter((r) => !hasMonth(r.hay, m)).length,",
    "    miss: own.filter((r) => !mt(r.hay)).length,",
    "  });",
    "}",
    "for (const d of [1, 2, 7, 11, 22, 31]) {",
    "  const mt = Recommender.searchMatcher(d + '日');",
    "  const hit = rows.filter((r) => mt(r.hay));",
    "  const own = rows.filter((r) => hasDay(r.hay, d));",
    "  out.push({",
    "    q: d + '日', hit: hit.length, own: own.length,",
    "    extra: hit.filter((r) => !hasDay(r.hay, d)).length,",
    "    miss: own.filter((r) => !mt(r.hay)).length,",
    "  });",
    "}",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{
    q: string;
    hit: number;
    own: number;
    extra: number;
    miss: number;
  }>;
  expect(out.length).toBe(18);
  for (const row of out) {
    expect(
      row.own,
      `「${row.q}」で和暦の語を持つ行が数えられていない（検査が空振り）`,
    ).toBeGreaterThan(20);
    expect(row.extra, `「${row.q}」は和暦の語を持たない行を ${row.extra} 件返す`).toBe(0);
    expect(row.miss, `「${row.q}」は和暦の語を持つ行を ${row.miss} 件落としている`).toBe(0);
  }
});

it("llms.txt に書いた検索の引き方が、ビルド成果物で実際に効く（SPEC §7）", () => {
  /* `llms.txt` は「サイトの日本語での引き方」を書く。ここは機械（検索支援・要約支援）が
   * 読むので、実装とズレた書き方を残すと、そのまま利用者に伝えられる。
   * ラウンド（第 76 回）・並べ語（第 77・80 回）・月語の和暦展開（第 81 回）は
   * 実装だけ先に進んでいて、llms.txt は知らなかった。本文と挙動を対で固定する。 */
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  for (const phrase of [
    "月語は和暦の語",
    "画面が中黒で並べる語",
    "ラウンドは画面の書き方",
    "略称と年を離して",
    // 第 81 回より前はこの 4 つが全部無かった。
  ]) {
    expect(text, `llms.txt に検索の案内として ${phrase} が無い`).toContain(phrase);
  }

  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA);",
    "const hits = (q) => rows.filter((r) => Recommender.searchMatcher(q, now)(r.hay)).length;",
    "const groups = (q) => Recommender.queryTokenGroups(q, now);",
    "console.log(JSON.stringify({",
    // 月: `1月` は和暦の語を持つ行だけを出す。
    "  monthExtra: rows",
    "    .filter((r) => Recommender.searchMatcher('1月', now)(r.hay))",
    "    .filter((r) => !/(^| )\\d{4}年1月/.test(r.hay)).length,",
    "  monthFound: hits('1月') > 0,",
    // 日: `1日` は 11日・21日・31日を混ぜない。
    "  dayExtra: rows",
    "    .filter((r) => Recommender.searchMatcher('1日', now)(r.hay))",
    "    .filter((r) => !/(^| )(\\d{4}年)?\\d{1,2}月1日/.test(r.hay)).length,",
    // 並べ語: 写した語が引けて、1語より狭い（AND）。
    "  dot: hits('人工知能・データベース'),",
    "  dotSingle: hits('人工知能'),",
    "  dotComma: hits('人工知能，データベース'),",
    "  dotPunctOnly: groups('，').length,",
    // ラウンド: 画面の書き方 = 詰めた形 = R 表記。
    "  roundSpaced: hits('第 2 ラウンド'),",
    "  roundJoined: hits('第2ラウンド'),",
    "  roundR: hits('r2'),",
    "  roundCombined: groups('スパコン・第 2 ラウンド').length,",
    // 略称と年: 離して打つと割れる。月日の裸の数字は割らない。
    "  abbrevGroups: groups('NSDI 27').length,",
    "  abbrevYear: groups('NSDI 27').some((g) => g.indexOf('2027') >= 0),",
    "  monthDayGroups: groups('8月 27').some((g) => g.indexOf('2027') >= 0),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, number | boolean>;
  expect(out.monthExtra, "`1月` が和暦の語を持たない行を返す（llms.txt の案内と違う）").toBe(0);
  expect(out.monthFound, "`1月` が 1 件も返さず検査が空振りしている").toBe(true);
  expect(out.dayExtra, "`1日` が 11日・21日・31日の行を返す").toBe(0);
  expect(out.dot, "中黒で並べた語が 0 件").toBeGreaterThan(0);
  expect(out.dotComma, "全角コンマで並べた語が中黒と違う結果になる").toBe(out.dot);
  expect(out.dot).toBeLessThanOrEqual(out.dotSingle as number);
  expect(out.dotPunctOnly, "並べ語だけの入力が語を作っている").toBe(0);
  expect(out.roundSpaced, "画面の書き方のラウンドが詰めた形と違う件数になる").toBe(out.roundJoined);
  expect(
    out.roundR,
    "R 表記が画面の書き方より少ない（打ち方が統一されていない）",
  ).toBeGreaterThanOrEqual(out.roundJoined as number);
  expect(out.roundCombined, "並べ語とラウンドの語を一緒に書くと壊れる").toBe(2);
  expect(out.abbrevGroups, "`NSDI 27` が 2 語に割れない").toBe(2);
  expect(out.abbrevYear, "`NSDI 27` の 27 が 2027 として引けない").toBe(true);
  expect(out.monthDayGroups, "月日の裸の数字（`8月 27`）を年に展開している").toBe(false);
});

it("health.md は日本語で書き、数値が health.json とずれていない（SPEC §7）", () => {
  /* 「health.md：health.json の人間向け要約」と案内しておきながら、本文は英語のままだった
   * （2026-09-23 確認: "# Build health" / "Tracked venues" / "| Metric | Value |"）。
   * 読むのは収録を確かめる人なので日本語に寄せた。機械可読の正は health.json なので、
   * 各見出しに JSON のキーを併記し、**md に出た数値が json と同じこと**をここで見る
   * （表示だけ先に古くなるのを防ぐ）。 */
  const md = readFileSync(join(site, "health.md"), "utf8");
  const json = JSON.parse(readFileSync(join(site, "health.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const rows: Array<[string, string]> = [
    ["収録している会議", "tracked_venues"],
    ["次回以降に確定した締切を持つ会議", "future_confirmed_venues"],
    ["確定した締切", "confirmed_deadlines"],
    ["推定締切", "estimated_deadlines"],
    ["次回以降の推定締切", "future_estimated_deadlines"],
    ["解析上の注意の件数", "parse_warning_count"],
  ];
  expect(rows.length).toBeGreaterThanOrEqual(6);
  for (const [label, key] of rows) {
    const value = json[key];
    expect(typeof value, `health.json に ${key} がない`).toBe("number");
    const line = `| ${label}（\`${key}\`） | ${String(value)} |`;
    expect(md, `health.md の ${label} の行が health.json と合わない（または行がない）`).toContain(
      line,
    );
  }
  // 「要約」の名に反して英語に戻していないこと（機械キーは併記してあってよい）。
  for (const stale of ["# Build health", "| Metric | Value |", "Tracked venues", "Source status"]) {
    expect(md, `health.md に英語のままの箇所が残っている: ${stale}`).not.toContain(stale);
  }
  // フォールバックの有無は、数値だけでなく意味が分かる形で書く。
  expect(md).toContain("収録 snapshot で組んだか（`snapshot_fallback`）");
  expect(md).toContain(
    json.snapshot_fallback
      ? "| 収録 snapshot で組んだか（`snapshot_fallback`） | はい |"
      : "| 収録 snapshot で組んだか（`snapshot_fallback`） | いいえ |",
  );
  expect(md, "結論が先に書いていない（まとめ章がない）").toContain("## まとめ");
});

it("キーボード操作は効き、入力中は効かない（SPEC §7）", () => {
  /* 一覧には j / k / ↑ / ↓ / Enter / d / Esc / `/` の既定操作があるが、**検査も
   * 説明も無かった**（2026-09-23 確認）。とくに「検索欄で j と打ったときに行が
   * 動くか」は、打つ人にとって効くと壊れる操作なので、効かない側を固定する。
   * ビルド成果物の `onKeydown` を取り出して、作り物の画面に対して実際に叩く。 */
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const src = ${JSON.stringify(keydownWithBlockers(runtime))};`,
    "const calls = { update: 0, open: [], drawer: [], close: 0, focus: [] };",
    // `onKeydown` の `d` と `updateRowSelection` は行の classList を見るので、作り物でも持つ。
    "const rows = [0, 1, 2].map((i) => ({",
    "  i,",
    "  selected: false,",
    "  classList: { contains: () => false, toggle() {} },",
    "  focus() { calls.focus.push('row' + i); },",
    "  scrollIntoView() {},",
    "  setAttribute(k, v) { calls.focus.push('aria' + i + ':' + k + '=' + v); },",
    "  removeAttribute(k) { calls.focus.push('aria' + i + ':-' + k); },",
    "}));",
    "const els = {",
    "  q: { focus() { calls.focus.push('q'); } },",
    "  tbody: { querySelectorAll: () => rows },",
    "};",
    "const $ = (id) => els[id] || null;",
    "const win = { open: (href) => calls.open.push(href) };",
    "const keydown = (key, target, mode, index) => {",
    "  let prevented = false;",
    "  const state = { mode: mode || 'list' };",
    "  const fn = new Function(",
    "    'state', 'shown', 'selectedIndex', 'updateRowSelection', 'openDrawer', 'closeDrawer',",
    "    'safeExternalUrl', '$', 'window',",
    "    src + ';return onKeydown;',",
    "  );",
    "  const e = {",
    "    key,",
    "    target: target || { tagName: 'BODY' },",
    "    preventDefault() { prevented = true; },",
    "  };",
    "  const handler = fn(",
    "    state,",
    "    [{ conf: { key: 'a', link: 'https://example.org/a' }, ed: { link: 'https://example.org/a' } },",
    "     { conf: { key: 'b', link: 'https://example.org/b' }, ed: { link: '' } },",
    "     { conf: { key: 'c', link: '' }, ed: { link: '' } }],",
    "    typeof index === 'number' ? index : 1,",
    "    () => { calls.update += 1; },",
    "    (r) => { calls.drawer.push(r && r.conf ? r.conf.key : null); },",
    "    () => { calls.close += 1; },",
    "    (u) => String(u || ''),",
    "    $,",
    "    win,",
    "  );",
    // `new Function` の戻り値は作られた関数そのもの。第 2 段で呼んで初めて発火する。
    "  handler(e);",
    "  return prevented;",
    "};",
    "const out = {};",
    "  // 入力中の打鍵で行を動かさない（検索語に j を含む入力は普通にある）。",
    "  out.inInput = keydown('j', { tagName: 'INPUT' });",
    "  out.inInputUpdate = calls.update;",
    "  out.inTextarea = keydown('k', { tagName: 'TEXTAREA' });",
    "  out.inSelect = keydown('/', { tagName: 'SELECT' });",
    "  out.editable = keydown('j', { tagName: 'DIV', isContentEditable: true });",
    "  calls.update = 0;",
    "  out.list = keydown('j');",
    "  out.listUpdate = calls.update;",
    "  calls.update = 0;",
    "  out.up = keydown('k');",
    "  out.upUpdate = calls.update;",
    "  calls.update = 0;",
    // 上端・下端ではこれ以上動かさない（周回しない。外れた選択が出ない）。
    "  out.topKey = keydown('k', null, 'list', 0);",
    "  out.topUpdate = calls.update;",
    "  calls.update = 0;",
    "  out.bottomKey = keydown('j', null, 'list', 2);",
    "  out.bottomUpdate = calls.update;",
    "  out.slash = keydown('/');",
    "  out.focusQ = calls.focus.indexOf('q') >= 0;",
    "  out.d = keydown('d');",
    "  out.drawer = calls.drawer.slice();",
    "  out.esc = keydown('Escape');",
    "  out.close = calls.close;",
    "  out.enter = keydown('Enter');",
    "  out.opened = calls.open.slice();",
    "  calls.update = 0;",
    "  out.recommend = keydown('j', null, 'recommend');",
    "  out.recommendUpdate = calls.update;",
    "  // 入力の中では Esc だけ効く（検索欄のフォーカスを外す）。",
    "  let blurred = 0;",
    // 本物の入力欄は tagName を持つので、同じ形で作る（tag が引けない要素は
    // handler の先頭でそのまま返る）。
    "  out.escInInput = keydown('Escape', { tagName: 'INPUT', blur: () => { blurred += 1; } });",
    "  out.escBlurred = blurred;",
    "console.log(JSON.stringify(out));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, unknown>;
  // 入力中は効かない（`j` を含む検索語を打てること。検索欄は IME の入力先でもある）。
  expect(out.inInput, "検索欄で j を打ったときに処理を止めていない").toBe(false);
  expect(out.inInputUpdate, "検索欄で j を打つと行の選択が動いた").toBe(0);
  expect(out.inTextarea, "概要欄で k を打つと行の選択が動いた").toBe(false);
  expect(out.inSelect, "選択欄で / を打つと検索欄に飛んだ").toBe(false);
  expect(out.editable, "編集中の欄で j を打つと行の選択が動いた").toBe(false);
  // 入力以外は効く。
  expect(out.list, "一覧で j が効かない").toBe(true);
  expect(out.listUpdate, "一覧で jを行を選ばない").toBe(1);
  expect(out.upUpdate, "一覧で k が行を選ばない").toBe(1);
  expect(out.topKey, "上端で k が処理を止めていない").toBe(true);
  expect(out.topUpdate, "上端で k を押すと選択が外れた（周回させない）").toBe(0);
  expect(out.bottomUpdate, "下端で j を押すと選択が外れた（周回させない）").toBe(0);
  expect(out.slash, "/ で検索欄に焦点が当たらない").toBe(true);
  expect(out.focusQ, "/ が検索欄以外に焦点を当てた").toBe(true);
  expect(out.drawer, "d で選択行の詳細が開かない").toEqual(["b"]);
  expect(out.close, "Esc で詳細が閉じない").toBe(1);
  // 選択行（2件目）は会期側のリンクが無いので会議本体のリンクを開く。
  expect(out.opened, "Enter で公式ページを開かない").toEqual(["https://example.org/b"]);
  // 推薦モードでは表用の操作を無効化する（論文の欄を打っている間に表が動かない）。
  expect(out.recommend, "推薦モードで j が処理を止めていない").toBe(true);
  expect(out.recommendUpdate, "推薦モードで j に行が動いた").toBe(0);
  expect(out.escBlurred, "入力欄の中では Esc が焦点を外さない").toBe(1);
});

it("キーボードの既定操作は、てびきに書いたとおりに実装されている（SPEC §7）", () => {
  /* 第 84 回まで既定操作が検査も説明も無かった。てびきに書いた以上、実装が同じキーを
   * 処理していることを対で見る（案内だけ先に変更しても、実装だけキーを増やしても落ちる）。
   * `Esc` のように画面での書き方が違うものは、対応表をここに置く。 */
  const runtime = siteRuntime();
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const keys: Array<[string, string]> = [
    ['key === "j"', "j"],
    ['key === "k"', "k"],
    ['key === "d"', "d"],
    ['key === "/"', "/"],
    ['key === "Enter"', "Enter"],
    ['key === "Escape"', "Esc"],
    ['key === "ArrowDown"', "↓"],
    ['key === "ArrowUp"', "↑"],
  ];
  expect(keys.length).toBeGreaterThanOrEqual(8);
  // 第 86 回でこの項には class が付いた（狭い画面では隠す）。なので語句ではなく
  // 項の名前で探して、その <dt> から dd の終わりまでを取り出す。
  const named = template.indexOf("キーボードで一覧を動かす");
  expect(named, "てびきにキーボードの項がない").toBeGreaterThan(0);
  const guide = template.slice(template.lastIndexOf("<dt", named));
  const entry = guide.slice(0, guide.indexOf("</dd>"));
  expect(entry.length, "てびきにキーボードの項がない").toBeGreaterThan(40);
  for (const [code, shown] of keys) {
    expect(runtime, `ビルド成果物が ${code} を処理していない`).toContain(code);
    expect(entry, `てびきのキーボードの項に ${shown} が書いていない`).toContain(
      `<code>${shown}</code>`,
    );
  }
  // 入力欄の中で効かないことも、案内と実装が揃っている。
  expect(entry).toContain("入力欄の中ではこれらのキーはただの文字");
  expect(runtime).toContain('tag === "INPUT"');
});

it("狭い画面でも並び替えできる（見出しを消すなら並べ替えの列を対で出す・SPEC §7）", () => {
  /* 640px 以下では `thead { display: none }`で行をカード化するが、並び替えの入口は
   * 見出ししかなかった（2026-09-23 実測: スマートフォンの幅で並び替えが operation
   * 不能だった。てびきは「列の見出しを押すと並び替わります」と書いている）。
   * 同じ `toggleSort` を呼ぶ列を表の上に増やし、**見出しを消す規則と並べ替えバーを
   * 対で**見る（どちらか一方だけ変わると落ちる）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const media = template.slice(template.indexOf("@media (max-width: 640px)"));
  const block = media.slice(0, media.indexOf("\n}"));
  expect(block, "狭い画面で見出しを隠す規則が無い（この検査の前提）").toContain(
    "thead { display: none; }",
  );
  expect(block, "見出しを隠すのに並べ替えの列を出していない（並び替え不能に戻る）").toContain(
    ".sortbar { display: flex; }",
  );
  // 並べ替えバーの列は、実装が並び替え可能な列とちょうど一致すること（双方向）。
  const bar = template.slice(template.indexOf('<div class="sortbar"'));
  const barBlock = bar.slice(0, bar.indexOf("</div>"));
  const barKeys = Array.from(barBlock.matchAll(/data-sort="([^"]+)"/g)).map((m) => m[1]);
  const headerKeys = Array.from(
    template
      .slice(template.indexOf("<thead>"), template.indexOf("</thead>"))
      .matchAll(/data-sort="([^"]+)"/g),
  ).map((m) => m[1]);
  expect(barKeys.length).toBeGreaterThanOrEqual(4);
  expect(barKeys.sort()).toEqual(headerKeys.sort());
  // 画面に出る語も見出しと同じ（別名にすると引けない語になる）。
  for (const label of ["残り", "日時（JST）", "会議", "ランク"]) {
    expect(barBlock, `並べ替えバーに ${label} の列がない`).toContain(`>${label}`);
  }
  /* キーボードの案内を消す条件は「幅」ではない（第 145 回で変更）。`j` / `k` / `d` / `/` の
   * 処理に幅の判定は無いので、狭い窓を開いた人からは案内だけが消えていた。タッチで狙う
   * 端末でだけ隠す。第 103 回まで見出ししか消しておらず、説明（`j`/`k`/`d`/`Esc` の書き方が
   * 残っていた）ので、隣接する説明も一緒に閉じる形を要求する要求はそのまま残す。*/
  const coarse = template.slice(template.indexOf("@media (hover: none), (pointer: coarse)"));
  const coarseBlock = coarse.slice(0, coarse.indexOf("\n}"));
  expect(coarseBlock, "キー操作の案内を操作手段で隠していない").toMatch(
    /\.count-kbd \{[^}]*display: none/,
  );
  expect(coarseBlock, "キーボードの案内を操作手段で隠していない").toMatch(
    /\.only-keyboard,\s*\.only-keyboard \+ dd \{[^}]*display: none/,
  );
  expect(
    block,
    "キーボードの案内を幅でも隠している（狭い窓で効いているキーの案内が消える）",
  ).not.toContain(".only-keyboard");
  expect(template).toContain('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  // てびきも同じことを書いている。
  const guide = template.slice(template.indexOf("<dt>並び順</dt>"));
  expect(guide.slice(0, guide.indexOf("</dd>"))).toContain("並べ替え");
});

it("並べ替えの目印は列見出しと並べ替えバーの両方に付く（SPEC §7）", () => {
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const src = ${JSON.stringify(jsFunction(runtime, "setSortAria"))};`,
    "const nodes = [];",
    "const mk = (tag, key) => ({",
    "  tagName: tag,",
    "  attrs: {},",
    "  text: (key === 'rem' ? '残り ↕' : 'ランク ↕'),",
    "  getAttribute(n) { return n === 'data-sort' ? key : null; },",
    "  setAttribute(n, v) { this.attrs[n] = v; },",
    "  get textContent() { return this.text; },",
    "  set textContent(v) { this.text = v; },",
    "});",
    "const th = mk('TH', 'rem');",
    "const button = mk('BUTTON', 'rank');",
    "const other = mk('BUTTON', 'rem');",
    "const document = { querySelectorAll: (sel) => (sel === '[data-sort]' ? [th, button, other] : []) };",
    "const fn = new Function('document', 'sortAsc', 'sortMarkJa', 'return (' + src + ')');",
    // `sortMarkJa` の実際の契約（見出しでは語に続けて置く。先頭スペースは付けない）。
    "const setSortAria = fn(document, false, (active, asc) => (active ? (asc ? '↑' : '↓') : '↕'));",
    "const out = [];",
    "setSortAria('rank');",
    "out.push({ th: [th.attrs['aria-sort'], th.text], button: [button.attrs['aria-pressed'], button.text], other: [other.attrs['aria-pressed'], other.text] });",
    "console.log(JSON.stringify(out[0]));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, [string, string]>;
  // 押している列だけ目印が変わる（見出しとバーで同じ規則）。
  expect(out.button).toEqual(["true", "ランク ↓"]);
  expect(out.th).toEqual(["none", "残り ↕"]);
  // 別の列のボタンが押したことにされないこと。
  expect(out.other).toEqual(["false", "残り ↕"]);
});

it("操作できる箇所に焦点の目印があり、隠した制御が操作不能になっていない（SPEC §7）", () => {
  /* 分野チップの checkbox は `.chips input { display: none }` で消していた
   * （2026-09-23 実測）。`display: none` はタブ順序からも外れるので、**分野での
   * 絞り込みがキーボードで到達不能**だった。期間・種別・ランクの `<select>` も
   * `outline: none` だけで焦点の目印を書いていなかった（入力欄は border-color が
   * 変わるが、select は変わらない）。印刷 CSS を除いて検査する。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const style = template.slice(template.indexOf("<style>"), template.indexOf("</style>"));
  // 印刷 CSS は操作要素を意図的に消す（印刷した紙で操作はしない）ので対象外。
  const printAt = style.indexOf("@media print");
  let css = style;
  if (printAt >= 0) {
    let depth = 0;
    let i = style.indexOf("{", printAt);
    while (i < style.length) {
      if (style[i] === "{") depth += 1;
      else if (style[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    css = style.slice(0, printAt) + style.slice(i + 1);
  }
  // CSS の注釈を落とす（注釈の中に `outline: none` と同じ語を書いているので、
  // 規則の選抜が注釈ごと拾って誤判した）。
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // ① 操作要素そのものに display: none を掛けていないこと（タブ順序から外れて
  //    操作不能になる。`display: none` と `opacity: 0` は見た目は同じだが違う）。
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g));
  expect(rules.length).toBeGreaterThan(40);
  for (const [, selector, body] of rules) {
    if (!/display:\s*none/.test(body)) continue;
    const sel = selector.trim();
    expect(
      /\b(input|select|textarea|button)\b/.test(sel),
      `操作要素を display:none にしている（キーボードで到達不能になる）: ${sel}`,
    ).toBe(false);
  }

  // ② 分野チップは「見えなくするだけ」でタブに残り、焦点がラベルに出ること。
  const chipRule = css.slice(css.indexOf(".chips input {"));
  expect(chipRule.slice(0, 240), "チップの checkbox が元に戻って消えている").toContain(
    "opacity: 0;",
  );
  expect(css, "チップの焦点の目印が無い").toContain(".chips label:has(input:focus-visible)");

  // ③ 焦点の目印を落としている制御が無いこと（`outline: none` を掛けたら、
  //    同じ要素に対する出す側の規則を書く。規則の有無を要素ごとに突き合わせる）。
  const focusRules = Array.from(css.matchAll(/([^{}]+)\{[^{}]*outline:[^{}]*\}/g))
    .filter(([, selector]) => /:focus/.test(selector))
    .map(([, selector]) => selector);
  expect(focusRules.length).toBeGreaterThanOrEqual(3);
  const dropped = Array.from(css.matchAll(/([^{}]+)\{([^{}]*outline:\s*none[^{}]*)\}/g)).map((m) =>
    m[1].trim(),
  );
  expect(dropped.length).toBeGreaterThanOrEqual(3);
  for (const sel of dropped) {
    for (const part of sel.split(",")) {
      const probe = part.trim().replace(/:focus.*$/, "");
      // `input[type=search]` なら要素名 + 属性まで、`select` なら要素名で探す。
      const needle = probe.replace(/\s+/g, "");
      const hit = focusRules.some((rule) =>
        rule.split(",").some((f) =>
          f
            .replace(/:focus(-visible)?/, "")
            .replace(/\s+/g, "")
            .startsWith(needle),
        ),
      );
      expect(hit, `${probe} は outline: none なのに焦点の目印の規則が無い`).toBe(true);
    }
  }
  for (const sel of ["select:focus-visible", "button:focus-visible", "textarea:focus-visible"]) {
    expect(css, `焦点の目印の規則に ${sel} が無い`).toContain(sel);
  }
});

it("表の列見出しと件数欄が支援技術に伝わる（SPEC §7）", () => {
  /* 列見出しの `<th>` に `scope` が無く、月見出し側は `scope="colgroup"` を使って
   * いた（2026-09-23 実測）。支援技術では 478 行のセルがどの列のものか伝えられない。
   * また絞り込みのたびに書き換わる件数欄（`#count`）と履歴状態（`#historyStatus`）に
   * `aria-live` が無く、**入力したのに画面がどう変わったか**が黙って入れ替わっていた。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const head = template.slice(template.indexOf("<thead>"), template.indexOf("</thead>"));
  const ths = Array.from(head.matchAll(/<th\b([^>]*)>/g));
  expect(ths.length).toBeGreaterThanOrEqual(7);
  for (const [, attrs] of ths) {
    expect(attrs, `<th> に scope が無い（${attrs.trim()}）`).toContain('scope="col"');
  }
  // 絞り込みのフィードバックを出す欄は、書き換わったことが分かる形にする。
  // 読み上げは専用の短い欄に出す（`#count` は「のぞく」の内訳まで載る長い欄なので、
  // 第 88 回でそのまま aria-live を付けると 1 打鍵ごとに数十語が流れた。第 89 回で分割）。
  for (const probe of [
    '<span id="countLive" class="sr-label" aria-live="polite">',
    '<div id="historyStatus" aria-live="polite"',
  ]) {
    expect(template, `支援技術に伝わらない欄がある: ${probe}`).toContain(probe);
  }
  expect(template, "長い件数欄そのものを aria-live に戻さない").not.toContain(
    '<span id="count" aria-live',
  );
  // 画面に出す長い内訳（「のぞく」）は読み上げない。件数と状態の通知だけを読み上げる。
  const runtimeLive = siteRuntime();
  expect(runtimeLive).toContain("cnt += ` ｜ のぞく");
  expect(runtimeLive).not.toContain("cntLive += ` ｜ のぞく");
  for (const note of ["全履歴を読み込み中", "意味検索を実行中", '$("countLive")']) {
    expect(runtimeLive, `読み上げ欄への書き込みが減っている: ${note}`).toContain(note);
  }
  // 月見出しは列グループの見出し（列見出しと同じ規則になっていること）。
  const runtime = siteRuntime();
  expect(runtime).toContain('th.scope = "colgroup"');
});

it("絞り込みの各欄に名前があり、支援技術から消していない（SPEC §7）", () => {
  /* 種別・ランク・締切までの見出しはただの `<span>` で、`<label for>` では無かった
   * （2026-09-23 実測）。支援技術では 3 つの選択欄が「すべて」としか読めず、どれが
   * 種別でどれがランクか分からない。検索欄は見出し自体を置いていなかった
   * （placeholder だけ。打つと消える）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const body = template.slice(template.indexOf("<body"));
  const controls = Array.from(body.matchAll(/<(?:select|input|textarea)\b[^>]*>/g)).map(
    (m) => m[0],
  );
  expect(controls.length).toBeGreaterThanOrEqual(12);
  const labelled = new Set(
    Array.from(body.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)).map((m) => m[1]),
  );
  const ids = new Set(Array.from(body.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));
  // ラベルで囲う型（`<label class="check"><input …></label>`）も名前を持つ。
  // タグ文字列だけ見ても分からないので、本文上の位置の前後を見て判定する。
  const wrappedInLabel = (id: string) => {
    const at = body.indexOf(`id="${id}"`);
    if (at < 0) return false;
    return body.lastIndexOf("<label", at) > body.lastIndexOf("</label>", at);
  };
  for (const tag of controls) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] || "";
    if (!id) continue;
    // 隠れた保持用（`paperText` など）やファイル選択は、ここでの点検対象から除く。
    if (/\shidden\b|type="hidden"|type="file"/.test(tag)) continue;
    const hasName = labelled.has(id) || /aria-label=|placeholder=/.test(tag) || wrappedInLabel(id);
    // 選択欄と検索欄は「名前がある」だけでは足りない（placeholder は打つと消える）。
    const needsLabel = /<select|type="search"/.test(tag);
    if (needsLabel) {
      expect(
        labelled.has(id),
        `id="${id}" に label[for] が無い（支援技術に名前が伝わらない）`,
      ).toBe(true);
    } else {
      // チェックボックスはラベルで囲われている（`<label class="check">`）。
      expect(hasName || labelled.has(id), `id="${id}" に名前が無い`).toBe(true);
    }
  }
  // `for` が居ない id を指していると、名前もクリックでの焦点も静かに切れる。
  for (const target of labelled) {
    expect(ids.has(target), `label[for="${target}"] が対応する欄を持たない`).toBe(true);
  }
  // 見えないラベルは `display: none` ではなく clip で消す（第 87 回と同じ教訓）。
  const sr = template.slice(template.indexOf(".sr-label {"));
  expect(sr.slice(0, 260)).toContain("clip-path:");
  expect(sr.slice(0, 260)).not.toContain("display: none");
  // 画面に出る見出しは従来どおりスタイルが当たる（見た目を壊していない）。
  expect(template).toContain(".field > span, .field > label");
});

it("CSV のランク列は画面と同じ書き方で、番兵の `N` を渡さない（SPEC §7）", () => {
  /* 画面と行の詳細はランクの無い所を「評価なし」と出す（第 47 回）が、CSV 書き出しは
   * 上流の番兵 `N` をそのまま出していた（2026-09-23 実測: 将来締切 917 行で 271 マス）。
   * 表計算で「N という等級」で絞り込めてしまい、空欄との違いも読めない。
   * 収録カタログから組んだ実データの CSV で検査する（合成 fixture では 0 マスになる）。 */
  const out = join(mkdtempSync(join(tmpdir(), "cfp-csv-rank-")), "public");
  const emptyCache = mkdtempSync(join(tmpdir(), "cfp-csv-rank-cache-"));
  const built = runCli(out, {
    now: "2026-08-09T00:00:00Z",
    cache: emptyCache,
    extra: ["--no-embeddings"],
  });
  expect(built.status, built.stderr).toBe(0);
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(out, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(out, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA).filter((r) => r.t > now);",
    "const csv = Recommender.deadlinesToCsv(rows, now);",
    "const split = (line) => { const out2 = []; let cur = ''; let q = false;",
    "  for (let i = 0; i < line.length; i += 1) { const c = line[i];",
    "    if (q) { if (c === '\\\"') { if (line[i + 1] === '\\\"') { cur += '\\\"'; i += 1; } else { q = false; } } else { cur += c; } }",
    "    else if (c === '\\\"') { q = true; }",
    "    else if (c === ',') { out2.push(cur); cur = ''; } else { cur += c; } }",
    "  out2.push(cur); return out2; };",
    "const lines = csv.split('\\r\\n').filter((l) => l.length > 0);",
    "const head = split(lines[0]);",
    "const body = lines.slice(1).map(split);",
    "const cols = head.length;",
    "const idx = ['CCF', 'CORE', 'THCPL'].map((h) => head.indexOf(h));",
    "let wrong = 0; let sentinelCells = 0; let unratedCells = 0;",
    "body.forEach((c) => { if (c.length !== cols) { wrong += 1; return; }",
    "  idx.forEach((i) => { if (c[i] === 'N') sentinelCells += 1; if (c[i] === '評価なし') unratedCells += 1; }); });",
    // 収録データ側の番兵の数を数え、CSV の「評価なし」と突き合わせる（双方向の検査）。
    "const absent = ['n', 'none', '-'];",
    "let sentinelData = 0;",
    "rows.forEach((r) => { const rk = (r.conf && r.conf.rank) || {};",
    "  ['ccf', 'core', 'thcpl'].forEach((k) => { const v = String(rk[k] ?? '').trim().toLowerCase();",
    "    if (v && absent.indexOf(v) >= 0) sentinelData += 1; }); });",
    "console.log(JSON.stringify({ rows: rows.length, cols, wrong, sentinelCells, unratedCells, sentinelData }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.rows).toBeGreaterThan(500);
  expect(got.cols).toBe(14);
  // 引用符で括った欄も含めて列がずれていないこと（表計算で化ける元）。
  expect(got.wrong, "CSV の列数が揃わない行がある").toBe(0);
  expect(
    got.sentinelData,
    "実データにランクの番兵が含まれていない（検査が空振り）",
  ).toBeGreaterThan(0);
  expect(got.sentinelCells, "ランクの番兵 `N` が表計算へそのまま出ている").toBe(0);
  // 番兵の数だけ「評価なし」が出ている（書き換え漏れと過剰変換の両方を見る）。
  expect(got.unratedCells).toBe(got.sentinelData);
});

it("日本語の案内に中国語の略語を混ぜない（SPEC §7）", () => {
  /* dropdown に当たる中国語表記を説明文に混入させては 3 回指摘している（2026-09-23 まで）。
   * 画面に出す語・案内に書く語は日本語で書く、という §7 の約束をファイル横断で検める。
   * 語列出典が自分自身を参照して落ちないよう、点検語は文字番号で書く。
   * 引用（実物の誤記をバッククォートで書いた記録）は対象外。
   * 第 97 回で、自分が案内に実際に混入させた語（中国語の簡体字表記と韓国語の活用の語）を
   * 点検語に足した。点検語の一覧はこのファイル自身も見るので、該当の語は引用しない。
   * ハングルは日本語の案内に出る用事が無いので文字範囲で抑える（会議名は日本語か現地表記、
   * 点検語自身のエスケープは文字範囲に掛からない）。 */
  const words = [
    "\u4e0b\u62c9",
    "\u6298\u53e0",
    "\u8fd9\u4e9b",
    "\u6279\u91cf",
    "\u8fc7\u53bb",
    "\u95ee\u9898",
    "\u663e\u793a",
    "\u53d8\u91cf",
    "\u51fd\u6570",
    "\u5df2\u7ecf",
    "\u8fd9\u91cc",
    // 簡体字専用の一字目（日本語の新字体・共用漢字と字形が別な物だけ。たとえば日本語の
    // 「状態」の状や「文章」は正常な日本語なので入れない – 実際に混ぜて検査を落としたり、
    // 誤検出で検査を信用できなくしたりするのはここの失敗なので、一字ずつ確認して足す）。
    "\u52b3",
    "\u9879",
    "\u8fc7",
    "\u53d1",
    "\u5b9e",
    "\u663e",
    "\u56fe",
    "\u5173",
    "\u7f51",
    "\u503c",
    "\u8ba9",
    "\u4ece",
    "\u8bf4",
    "\u8bf7",
    "\u4e1c",
    "\u8f66",
    "\u9a6c",
    "\u9e1f",
    "\u9c7c",
    "\u95e8",
    "\u957f",
    "\u98ce",
    "\u98de",
    "\u4e66",
    "\u7535",
    "\u5bf9",
    "\u65f6",
    "\u89c1",
    "\u89c2",
    "\u4e49",
    "\u6c14",
    "\u534e",
    "\u79cd",
    "\u7ebf",
    "\u672f",
    "\u8fd0",
    "\u8fdc",
    "\u8fb9",
    "\u5904",
    "\u4ea7",
    // 日本語の語として成り立たない二字目以上の語（同じ字を使う中華語）。
    "\u53c2\u6570",
    "\u5176\u4ed6",
    // 同じ運びの別の表記（二字目の文字番号が違う）。第 122 回でこちらの実物が
    // 案内とコメントに残っていたのに、上の表記しか点検していなくて黙っていた。
    "\u5176\u5b83",
    "\u6b67",
    // 「新しい」に当たる四字の語は日本語として立たない（第 120 回の手記に混入した）。
    "\u65b0\u7684",
    // 「データ」「ここ」に当たる語も同じ系統（上の二字語と同じ運びで混入する）。
    "\u6570\u636e",
    "\u8fd9\u91cc",
  ];
  const targets = [
    "README.md",
    "SPEC.md",
    "site/template.html",
    "site/app.ts",
    "site/recommender.ts",
    "tests/build_golden.test.ts",
    "tests/recommender.test.ts",
  ];
  for (const rel of targets) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8").replace(/`[^`\n]*`/g, "");
    for (const word of words) {
      expect(text, `${rel} に中国語の略語「${word}」が混入している`).not.toContain(word);
    }
    // 点検語は文字番号で書いているので、一文字でも間違えると検査が黙って通る
    // （第 122 回で、実際に混入していた語の二字目の文字番号を間違えていた）。
    // 意図した語が実際に点検されていることを、文字番号から組み立てた見本で確かめる。
    for (const points of [
      [0x5176, 0x5b83],
      [0x5176, 0x4ed6],
      [0x4e0b, 0x62c9],
      [0x65b0, 0x7684],
    ]) {
      const sample = String.fromCharCode.apply(null, points);
      const label = points.map((c) => `U+${c.toString(16)}`).join("+");
      expect(words, `点検語に ${label} の表記が無い（文字番号の書き間違い？）`).toContain(sample);
      // 見本の文が実際に点検で落ちることも見る。語列表に有っても、読み方が違いますと
      // 混入を検出できないので、ここが通って初めて検査が効いていると言える。
      const sampleText = `見本: ${sample} の混入`;
      expect(
        words.some((word) => sampleText.includes(word)),
        `見本 ${label} を検出できない`,
      ).toBe(true);
    }

    // 韓国語文字列の混入（第 97 回で動詞の活用形を実際に混入させた。日本語の案内に
    // 出る用事が無いので、ハングルは文字範囲で抑える。ここでは語を引用しない）。
    const hangul = /[\uac00-\ud55c]+/g;
    expect(text.match(hangul) || [], `${rel} にハングルが混入している`).toEqual([]);
  }
});

it("締切の時刻を持たない行を交ぜても日時順が崩れない（SPEC §7）", () => {
  /* `a.t < b.t` は片側が NaN だと常に false なので、締切の時刻を持たない行
   * （常時受付の学術誌など）を交ぜた並べ替えで比較の向きが定まらなかった。
   * 2026-09-23 実測（修正前のビルド成果物）: cmp(時刻なし, 時刻あり) = 1 かつ
   * cmp(時刻あり, 時刻なし) = 1 で反対称でなく、同じ集合を入力順を変えて sort すると
   * 結果が変わり、昇順では時刻の無い行が先頭に出て「いちばん近い締切」と誤読させた。
   * 収録カタログには現時点で時刻の無い行が 0 件（実測）なので今日の見え方は変わらないが、
   * 学術誌を 1 行追加するだけで日時順の表全体が崩れる形だった。ビルド成果物の比較関数で
   * 性質を検める。 */
  const rt = siteRuntime();
  // 会議名と種別の並びは本検査の本題ではないので、決定的な簡潔実装を渡す。
  // 比較関数はこれ以外の自由変数を持たせないこと（第 91 回でヘルパーを増やしたら、
  // 既存の抽出検査が `ReferenceError` で 6 件落ちた。渡す物を増やさない設計にする）。
  const compare = new Function(
    "conferenceNameCell",
    "kindSortIndex",
    `return (${jsFunction(rt, "compareDeadlineRows")});`,
  )(
    (r: { n?: string }) => String(r?.n ?? ""),
    () => 0,
  );

  type Row = { t: number; n: string; kind: string };
  const rows: Row[] = [
    { t: Number.NaN, n: "J1", kind: "journal" },
    { t: Number.NaN, n: "J2", kind: "journal" },
    { t: Date.parse("2026-09-03T00:00:00Z"), n: "p3", kind: "paper" },
    { t: Date.parse("2026-09-01T00:00:00Z"), n: "p1", kind: "paper" },
    { t: Date.parse("2026-09-02T00:00:00Z"), n: "p2", kind: "paper" },
  ];
  // ① 反対称性（比較関数の契約）。旧実装はここが 1 / 1 だった。
  for (const a of rows) {
    for (const b of rows) {
      expect(
        Math.sign(compare(a, b, 1)) + Math.sign(compare(b, a, 1)),
        `反対称でない: ${a.n} と ${b.n}`,
      ).toBe(0);
    }
  }
  // ② 入力順を変えても結果が同じ（NaN で順序が不定になっていたことの直接の検査）。
  const orders = [
    rows,
    rows.slice().reverse(),
    [rows[2], rows[0], rows[3], rows[1], rows[4]],
    [rows[1], rows[4], rows[3], rows[0], rows[2]],
  ];
  const asc = new Set(
    orders.map((o) =>
      o
        .slice()
        .sort((x, y) => compare(x, y, 1))
        .map((r) => r.n)
        .join(" "),
    ),
  );
  const desc = new Set(
    orders.map((o) =>
      o
        .slice()
        .sort((x, y) => compare(x, y, -1))
        .map((r) => r.n)
        .join(" "),
    ),
  );
  expect(asc.size, `昇順が入力順に依存している: ${[...asc].join(" / ")}`).toBe(1);
  expect(desc.size, `降順が入力順に依存している: ${[...desc].join(" / ")}`).toBe(1);
  // ③ 時刻の無い行は向きに関係なく最後尾（降順で先頭に反転すると「いちばん遠い」に化ける）。
  expect([...asc][0], "昇順で時刻の無い行が末尾に無い").toBe("p1 p2 p3 J1 J2");
  expect([...desc][0], "降順で時刻の無い行が末尾に無い").toBe("p3 p2 p1 J2 J1");
});

it("過去の締切も表示すると、過ぎた行が画面の先頭を埋め尽くさない（SPEC §7）", () => {
  /* 「過去の締切も表示」を入れると、既定の並び（残りの昇順）では過ぎた行がそのまま
   * 先頭に来る。収録カタログは締切時刻が過ぎた行が 2,318 行（総 3,235 行。2026-09-23 実測）
   * で、2019 年 5 月の行が画面の先頭になり、これからの締切はすべてその下に沈んでいた。
   * 過ぎた行を後ろの塊へ寄せ、塊の切り替わりに見出しを出すことを、ビルド成果物の
   * `filter` で検査する（並びの契約そのものを見るため、行は合成する。件数の実測値は
   * 上のコメントに書いたとおり）。 */
  const app = siteRuntime();
  const filterSrc = jsFunction(app, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-09T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    // 3 行はこれからの締切、2 行は過ぎた締切（古い順に 2019, 2026-08-08）。
    "function row(key, t) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: key,",
    "    t: t, tLast: t, dateOnly: false, localDate: '',",
    "    ed: { year: 2026, deadlines: [], place: '', date_text: '', event_start: '', event_end: '' },",
    "    dl: { kind: 'paper', round: 1 }, conf: { key: key, title: key, link: '' } };",
    "}",
    "const rows = [",
    "  row('near', now + DAY), row('mid', now + 30 * DAY), row('far', now + 400 * DAY),",
    "  row('just-closed', now - DAY), row('old', Date.parse('2019-05-25T00:00:00Z')),",
    "];",
    'const state = { q: "", cats: [], kind: "", rank: "", win: "all", est: false, past: true };',
    FILTER_RUNTIME_STUBS,
    'const filter = new Function("Date", "DAY", "rows", "state", "sortAsc", "sortKey",',
    '                            "return (" + FILTER + ")")(FakeDate, DAY, rows, state, true, "rem");',
    "const out = filter();",
    "console.log(JSON.stringify({",
    "  order: out.map((r) => r.conf.key),",
    "  flags: out.map((r) => r._pastBlock),",
    " }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // これからの 3 行が先頭、過ぎた 2 行が後ろの塊（変更前は古い 2019 年の行が画面の先頭だった）。
  // 塊の**内側**は選んだ列の向きそのまま（残りの昇順なので、過ぎた塊は古い順になる）。
  // 塊の中で向きを反転させると列見出しの ↑ と食い違うので、そこは正直に保つ。
  expect(got.order).toEqual(["near", "mid", "far", "old", "just-closed"]);
  expect(got.flags).toEqual([0, 0, 0, 1, 1]);
  // 塊の切り替わりに見出し行を出す（`month-row` を併せ持つのは、列を跨ぐ見出しとして
  // 支援技術に同じ扱いをさせるため。キーボード移動が飛ばすのと同じ規則でもある）。
  expect(app).toContain('tr.className = "month-row section-row"');
  expect(app).toContain('"過ぎた締切"');
  expect(app).toContain("過ぎた締切 ${countJa(pastBlockTotal)} 件は下にまとめました");
});

it("「本日終了」は JST の暦日で決まる（SPEC §7）", () => {
  /* 経過日数の floor で決めていたため、JST で昨日終わった締切が「本日終了」になっていた
   * （2026-09-23 実測: JST 15:00 に見た JST 前日 19:00 締切 = 20 時間前 → 「本日終了」）。
   * 「今日の締切だと思って開いたら昨日だった」になり、一覧が JST を単位にしている約束とも
   * 食い違う。暦日の差で数えることにして、てびきにもその旨を書いた。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    'const now = Date.parse("2026-08-10T06:00:00Z"); // JST 2026-08-10 15:00',
    "class FakeDate extends Date { static now() { return now; } }",
    // 関数本体はテンプレートリテラルを含むので、JSON 化して渡す（素で埋めると
    // 外側のテンプレートが壊れる。2026-09-23 に実発生）。
    `const REMAIN_SRC = ${JSON.stringify(jsFunction(app, "remain"))};`,
    'const remain = new Function("Date", "DAY", "return (" + REMAIN_SRC + ")")(FakeDate, 86400000);',
    "const H = 3600000;",
    "const at = (hoursAgo) => remain(now - hoursAgo * H).text;",
    "console.log(JSON.stringify({",
    "  sameDay1h: at(1),            // JST 同日 14:00",
    "  sameDay8h: at(8),            // JST 同日 07:00",
    "  sameDay14h: at(14),          // JST 同日 01:00（日付は同じ）",
    "  yesterdayJst20h: at(20),     // JST 前日 19:00 ← 旧実装は「本日終了」",
    "  yesterdayJst26h: at(26),     // JST 前日 13:00",
    "  twoDays: at(50),             // JST 2 日前 13:00",
    "  futureNow: remain(now + 30 * 60000).text,",
    "  futureHours: remain(now + 5 * H).text,",
    "  futureDays: remain(now + 3 * 86400000).text,",
    "  soonClass: remain(now + 3 * 86400000).cls,",
    "  farClass: remain(now + 20 * 86400000).cls,",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.sameDay1h).toBe("本日終了");
  expect(got.sameDay8h).toBe("本日終了");
  expect(got.sameDay14h).toBe("本日終了");
  // 暦日で数えるので、20 時間前（JST では昨日）は「1 日前」。
  expect(got.yesterdayJst20h).toBe("1 日前に終了");
  expect(got.yesterdayJst26h).toBe("1 日前に終了");
  expect(got.twoDays).toBe("2 日前に終了");
  // 先の側は今までどおり（境界を同時に抑える）。
  expect(got.futureNow).toBe("まもなく");
  expect(got.futureHours).toBe("あと 5 時間");
  expect(got.futureDays).toBe("あと 3 日");
  expect(got.soonClass).toBe("soon");
  expect(got.farClass).toBe("");
  // 実装が暦日で数えることを、てびきが同じ約束で書いている（案内と実装のズレ検出）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("日数は JST の暦日");
});

it("収録状況の四つ組は、何を数えているかと単位がラベルに出る（SPEC §7）", () => {
  /* 画面上部の四つの数は、単位を書かないまま会議の数と締切の件数を並べていた
   * （2026-09-23 実測: 「追跡会議数 680」と「直近30日締切 176」が同じ物だと読める）。
   * 「穴場/特化誌」はラベルだけ 2 つの集まりを騙っていた（実数を入れていたのは
   * niche タグの会議 63 だけで、journal タグは数えていない）。国内もチェックボックスは
   * 「国内研究会・国内シンポジウム」なのに、ここは「国内研究会」だった。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const barStart = template.indexOf('<div class="summary-bar">');
  expect(barStart).toBeGreaterThan(0);
  const bar = template.slice(barStart, template.indexOf("</header>", barStart));
  // 絞り込みで動かない数なので、その旨をキャプションに書く。
  expect(bar).toContain("絞り込み前の収録全体");
  expect(bar).toContain("収録している会議:");
  expect(bar).toContain("これからの30日間の締切:");
  expect(bar, "締切の件数に単位が無い").toContain('class="stat-unit">件<');
  // ラベルと実数がズレていた 2 件を戻さない。
  expect(bar).not.toContain("穴場/特化誌");
  expect(bar).toContain("穴場として収録した会議:");
  expect(bar).not.toContain("<span>国内研究会:</span>");
  expect(bar).toContain("国内研究会・国内シンポジウム:");
  // 開発よりの語だった「追跡会議数」を戻さない。
  expect(bar).not.toContain("追跡会議数");
  // てびきに単位と数え方の説明がある（画面が示す語をてびきが説明していないと調べられない）。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("画面上部の四つの数");
  expect(guide, "四つ組が絞り込みで動かないことをてびきが書いていない").toContain(
    "絞り込み前の収録全体",
  );
  expect(guide).toContain("niche");
  expect(guide).toContain("domestic-jp");
  // id はそのまま（JS 側の更新先が生きていること）。
  const runtime = siteRuntime();
  for (const id of ["statConfs", "statUpcoming", "statNiche", "statDomestic"]) {
    expect(runtime, `収録状況の更新先が消えている: ${id}`).toContain(`"${id}"`);
  }
});

it("早め絞り込みのボタンは、同じ条件を出す欄と同じ語で書かれている（SPEC §7）", () => {
  /* ボタンの語が、同じ条件を出す欄と割れていた（2026-09-23 実測）。
   * 分野チップは「高性能計算」なのに、ボタンだけ内部キーの HPC を出していた。
   * チェック欄は「国内研究会・国内シンポジウムのみ」なのに、ボタンは「国内研究会」だけで、
   * プリセットの方が狭い条件だと読めた（中身は同じ domestic-jp）。
   * てびきが並べる語も実装と食い違っていた。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const barStart = template.indexOf('<div class="presets-bar');
  expect(barStart).toBeGreaterThan(0);
  const bar = template.slice(barStart, template.indexOf("</div>", barStart));
  const buttons = Array.from(bar.matchAll(/data-preset="([a-z_0-9]+)"[^>]*>([^<]*)<\/button>/g));
  expect(buttons.length, "早め絞り込みのボタンが見つからない").toBe(5);
  const labels = new Map(buttons.map((m) => [m[1], m[2]]));

  // 分野のボタンは、分野チップと同じ日本語の語を使う（内部キーを画面に出さない）。
  const rec = siteRuntime("recommender.js");
  const catLabel = (key: string) => {
    const at = rec.indexOf("CATEGORY_LABELS_JA");
    expect(at, "CATEGORY_LABELS_JA が見つからない").toBeGreaterThan(0);
    const m = new RegExp(`\\b${key}: "([^"]+)"`).exec(rec.slice(at, at + 2000));
    expect(m, `分野の語が見つからない: ${key}`).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  const hpc = catLabel("hpc");
  const systems = catLabel("systems");
  expect(labels.get("hpc_sys")).toBe(`${hpc}・${systems}`);
  expect(bar, "内部キーの HPC を画面に出している").not.toContain("HPC");

  // 国内のボタンは、チェック欄と同じ集まり名を使う（同じ物に二つの名前を付けない）。
  const checkbox = /<span title="[^"]*">([^<]*国内研究会[^<]*)<\/span>/.exec(template);
  expect(checkbox, "国内のチェック欄の語が見つからない").not.toBeNull();
  const domestic = labels.get("domestic") || "";
  expect(checkbox![1], `ボタンの語がチェック欄と違う集まり名: ${domestic}`).toContain(domestic);

  // てびきが並べる語が実装と同じ（案内と実装のズレ検出）。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  for (const [, , label] of buttons) {
    expect(guide, `てびきにボタン「${label}」が実装と同じ語で書かれていない`).toContain(
      `「${label}」`,
    );
  }
});

it("「データ生成」の時刻は JST と曜日で出る（SPEC §7）", () => {
  /* 生成時刻は UTC の `...Z` で来るため、そのまま出していた（2026-09-23 実測:
   * 「データ生成: 2026-08-09T00:00:00Z」）。一覧は JST + 曜日を単位にしているので、
   * この欄だけ別単位だと、夜ビルドで日付が一日ずれて見える（UTC 8/8 20:00 は
   * JST では 8/9 の朝）。読めない値には嘘の日付を作らない。 */
  const app = siteRuntime();
  const weekday = app.match(/const WEEKDAY_JA = \[[^\]]*\];/)?.[0];
  expect(weekday, "WEEKDAY_JA が見つからない").toBeTruthy();
  const script = [
    "(async () => {",
    weekday,
    // 抽出した関数本体は、引用符の中へ素で埋めると壊れる（JSON 化して別の変数に置く）。
    `const PAD_SRC = ${JSON.stringify(jsFunction(app, "pad"))};`,
    `const FMT_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    `const GEN_SRC = ${JSON.stringify(jsFunction(app, "generatedAtLabel"))};`,
    'const pad = new Function("return (" + PAD_SRC + ")")();',
    'const fmtJst = new Function("WEEKDAY_JA", "pad", "return (" + FMT_SRC + ")")(WEEKDAY_JA, pad);',
    'const generatedAtLabel = new Function("fmtJst", "return (" + GEN_SRC + ")")(fmtJst);',
    "console.log(JSON.stringify({",
    "  night: generatedAtLabel('2026-08-08T20:00:00Z'),",
    "  morning: generatedAtLabel('2026-08-09T00:00:00Z'),",
    "  broken: generatedAtLabel('未取得'),",
    " }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // UTC では 8/8 の夜でも、JST では 8/9 の朝（一日進んだ日付を出す）。
  expect(got.night).toMatch(/^データ生成: 2026-08-09\([日月火水木金土]\) 05:00 JST$/);
  expect(got.night).not.toContain("2026-08-08");
  expect(got.morning).toMatch(/^データ生成: 2026-08-09\([日月火水木金土]\) 09:00 JST$/);
  // 時刻として読めない値は原文を残す（嘘の日付を作らない）。
  expect(got.broken).toBe("データ生成: 未取得");
  // てびきは「右上の更新時刻」と書いている。実際のレイアウト（見出し行の右端）と合うこと。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const brand = template.slice(template.indexOf(".brand-row {"));
  expect(brand.slice(0, 240)).toContain("justify-content: space-between");
  const genat = template.slice(template.indexOf('id="genat"'));
  expect(genat.slice(0, 80), "生成時刻の欄が見出し行に無い").toContain("</div>");
  // てびきが「右上の更新時刻」とだけ書いていた（実際の語は「データ生成」で、単位も
  // 出さなかった）。画面に出る語と単位をそのまま引けるようにする。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("右上");
  expect(guide, "てびきが画面の語「データ生成」を挙げていない").toContain("データ生成");
  expect(guide, "てびきが生成時刻の単位を書いていない").toContain("JST");
});

it("データ源の行は内部の実装語を出さず、上流は一次資料へ飛べる（SPEC §7）", () => {
  /* 以前は `ccfddl (ccfddl/ccf-deadlines, MIT) / aideadlines (…) / local (data/extra.yaml, MIT)`
   * と出していた（2026-09-23 実測）。自前の入力の内部ファイル名を画面に出すうえ、
   * 上流の配布物と並ぶ欄で、自分の入力にも「MIT」と付いて見えた（配布物のライセンス表記に見える）。
   * 名前はリンクでもなく、出典を確かめられなかった。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    'const safeExternalUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? u : null);',
    `const SRC_SRC = ${JSON.stringify(jsFunction(app, "dataSourceLabels"))};`,
    'const dataSourceLabels = new Function("safeExternalUrl", "return (" + SRC_SRC + ")")(safeExternalUrl);',
    "const got = dataSourceLabels([",
    "  { name: 'ccfddl', repo: 'ccfddl/ccf-deadlines', license: 'MIT', url: 'https://github.com/ccfddl/ccf-deadlines' },",
    "  { name: 'local', repo: 'data/extra.yaml', license: 'MIT', url: 'https://github.com/ten82e/kamiyobi' },",
    "  { name: 'unknown', url: 'javascript:alert(1)' },",
    " ]);",
    "console.log(JSON.stringify(got));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]");
  // 上流はそのまま（誰の配布物か、何のライセンスかが分かる）。
  expect(got[0].label).toBe("ccfddl（ccfddl/ccf-deadlines、MIT）");
  expect(got[0].url).toBe("https://github.com/ccfddl/ccf-deadlines");
  // 自分の入力は、内部ファイル名とライセンスを出さない。
  expect(got[1].label, "内部ファイル名を画面に出している").not.toContain("data/extra.yaml");
  expect(got[1].label, "自前の入力にライセンスを付けている").not.toContain("MIT");
  expect(got[1].label).toBe("このサイトで収録した分（上流に無いもの）");
  // https 以外はリンクにしない（`safeExternalUrl` の結果だけを渡す）。
  expect(got[2].url).toBeNull();
  // てびきに画面の語そのままの説明がある（26 項目あっても「データ源」だけ無かった）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  expect(guide).toContain("<dt>データ源</dt>");
  expect(guide).toContain("このサイトで収録した分（上流に無いもの）");
  expect(guide).toContain("一次資料");
});

it("一致評価の行内展開は、開閉状態を支援技術に伝える（SPEC §7）", () => {
  /* `aria-expanded` がビルド成果物に 1 箇所も無かった（2026-09-23 実測）。
   * トリガが `<span>` + `onclick` のときはキーボードで開けず、支援技術には
   * 「押せる物」「今開いている物」として伝わらなかった。ボタン化に合わせて、
   * 開いたとき true / 閉じたとき false をトリガに載せる。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    "const mkRow = () => {",
    "  const trigger = {",
    "    tagName: 'BUTTON', attrs: { 'aria-expanded': 'false' },",
    "    setAttribute(k, v) { this.attrs[k] = v; },",
    "  };",
    "  const parentNode = { inserted: [], insertBefore(node, ref) { this.inserted.push([node, ref]); } };",
    "  return {",
    "    tagName: 'TR', parentNode, nextSibling: null, attrs: trigger.attrs,",
    "    nextElementSibling: null, // 最初は次の行が無い（= 閉じている）",
    "    querySelector: () => trigger,",
    "    remove() {},",
    "  };",
    "};",
    `const TOGGLE_SRC = ${JSON.stringify(jsFunction(app, "toggleDetail"))};`,
    "const detailRows = [];",
    "const makeDetailRow = () => {",
    "  const row = { className: 'detail-row', removed: false, nextElementSibling: null,",
    "    classList: { contains: (c) => c === 'detail-row' },",
    "    remove() { this.removed = true; } };",
    "  detailRows.push(row);",
    "  return row;",
    "};",
    'const toggleDetail = new Function("makeDetailRow", "return (" + TOGGLE_SRC + ")")(makeDetailRow);',
    "const tr = mkRow();",
    "const state = () => tr.attrs['aria-expanded'];",
    "const before = state();",
    "toggleDetail({}, tr); // 開く",
    "const opened = state();",
    "const inserted = tr.parentNode.inserted.length;",
    "tr.nextElementSibling = detailRows[0]; // 挿直後の並び（次の行が行内展開）",
    "toggleDetail({}, tr); // 閉じる",
    "const closed = state();",
    "const removed = detailRows[0].removed;",
    "console.log(JSON.stringify({ before, opened, closed, inserted, removed }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.before).toBe("false");
  expect(got.opened, "開いても aria-expanded が変わらない").toBe("true");
  expect(got.closed, "閉じても aria-expanded が変わらない").toBe("false");
  expect(got.inserted, "行内展開が挿さっていない（検査が空振り）").toBe(1);
  expect(got.removed, "2 回目の押しが閉じていない").toBe(true);
  // てびきの書き方が実装とズレていない（「Tab で Enter」を実際に効かせるのはボタンだから）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("Tab でチップに移動して Enter");
  // チップの見た目を崩さないためのリセットが入っていること。
  expect(template).toMatch(/button\.tag \{[\s\S]{0,160}appearance: none;/);
  // てびきの用語集が構造的に壊れていないこと。第 98 回で、ある項に `</dd>` が余分に
  // 含まれていて、追記した文章が最初の閉じタグの後ろにぶら下がっていた（実測 27 個に対し
  // 閉じタグ 28 個）。画面に出る説明文が化けないための最低限の点検。
  const help = template.slice(template.indexOf('id="helpPanel"'));
  const guide = help.slice(0, help.indexOf("</dl>"));
  const ddOpen = (guide.match(/<dd>/g) || []).length;
  const ddClose = (guide.match(/<\/dd>/g) || []).length;
  expect(ddOpen, "てびきの語が説明を持っていない").toBeGreaterThan(20);
  expect(ddClose, `てびきの </dd> が <dd> と揃わない（開き ${ddOpen} / 閉じ ${ddClose}）`).toBe(
    ddOpen,
  );
  const dtCount = (guide.match(/<dt[ >]/g) || []).length;
  expect(dtCount, "てびきの見出しが減っている").toBe(ddOpen - 1); // 1 項だけ dd を 2 つ持つ
});

it("閉じた行の詳細は、支援技術からもタブ順序からも消える（SPEC §7）", () => {
  /* 閉じたドロワーは `opacity: 0` と画面外スライド（`right: -480px`）だけで消していた
   * （2026-09-23 実測）。`pointer-events: none` はマウス専用で、Tab は素通りしない。
   * なので閉じている状態で「閉じる」ボタンがタブ順序に残り、見えない箇所にフォーカスが
   * 飛んでいた。さらに中身は `role="dialog" aria-modal="true"` なので、閉じたまま
   * ツリーに出ると「ページ全体が背景」として扱われる支援技術がある。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const strip = (block: string) => block.replace(/\/\*[\s\S]*?\*\//g, "");

  const closedStart = template.indexOf(".drawer-backdrop {");
  expect(closedStart).toBeGreaterThan(0);
  const closed = strip(template.slice(closedStart, template.indexOf("}", closedStart)));
  expect(closed, "閉じたドロワーが支援技術から消えない").toContain("visibility: hidden");
  // フェードアウトを潰さない遅延（閉じる側だけ遅らせる）。
  expect(closed, "visibility を即時に切り替えて遷移を潰している").toMatch(
    /visibility 0s linear 0\.[1-9]/,
  );

  const activeStart = template.indexOf(".drawer-backdrop.active");
  expect(activeStart).toBeGreaterThan(0);
  const active = strip(template.slice(activeStart, template.indexOf("}", activeStart)));
  expect(active, "開いたドロワーが見えない").toContain("visibility: visible");
  expect(active, "表示に遅れが出て開きが重い").toMatch(/visibility 0s(?![ .\d])/);

  // タブで届く物が全部ドロワーの内側に有ること（＝この CSS でタブ順序も塞がる）。
  // ドロワーは本文の後ろ（`</footer>` の後）に有るので、そこから後ろを洗う。
  const drawerStart = template.indexOf('<div class="drawer-backdrop"');
  expect(drawerStart).toBeGreaterThan(0);
  const tail = template.slice(drawerStart);
  const drawerBlock = tail.slice(
    0,
    tail.indexOf("<script") > 0 ? tail.indexOf("<script") : tail.length,
  );
  expect(
    drawerBlock.match(/<button/g) || [],
    "ドロワーに閉じる手段が無い（検査が空振り）",
  ).toHaveLength(1);
  const rest = tail.slice(drawerBlock.length);
  expect(rest.match(/<button/g) || [], "ドロワーの後ろに閉じた状態で残る操作がある").toEqual([]);
  // ダイアログとしての行儀（閉じたときに消えることが前提の属性）。
  expect(template).toContain('role="dialog"');
  expect(template).toContain('aria-modal="true"');

  // 実装は `.active` を外すだけで閉じる（CSS の可視性が効く形）。
  const app = siteRuntime();
  const script = [
    "(async () => {",
    "const touched = [];",
    "const el = (id) => ({ id, classList: { remove: (c) => touched.push([id, 'remove', c]),",
    "  add: (c) => touched.push([id, 'add', c]) } });",
    `const CLOSE_SRC = ${JSON.stringify(jsFunction(app, "closeDrawer"))};`,
    'const closeDrawer = new Function("$", "window", "writeUrl", "return (" + CLOSE_SRC + ")")(el, {}, () => {});',
    "closeDrawer();",
    "console.log(JSON.stringify(touched));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const touched = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]");
  expect(touched).toContainEqual(["drawerBackdrop", "remove", "active"]);
});

it("てびきのキーボード表記が、実装が扱うキーと欠けずに合う（SPEC §7）", () => {
  /* 自分が案内文に「j/k + Enter でドロワーが開く」と誤記した（2026-09-23。実際は `Enter` は
   * 公式ページ、`d` が行の詳細）。キーの操作説明は、一度ズレると画面の挙動と案内が別物を
   * 指したまま永aku。ビルド成果物から実際に扱うキーを洗って、てびきが全て挙げているかを見る。
   * キーの名前はテスト側に書き写さず、実装側から作る（語を二重化しない）。 */
  const app = siteRuntime();
  const keys = Array.from(
    new Set(
      Array.from(jsFunction(app, "onKeydown").matchAll(/\be\.key === "([^"]+)"/g), (m) => m[1]),
    ),
  );
  expect(keys.length, "キー処理が見当たらない（検査が空振り）").toBeGreaterThan(5);
  const NAMED: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", Escape: "Esc" };
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // 見出しには `class="only-keyboard"` が付く（狭い画面ではショートカットを使えないため）。
  const dtAt = template.indexOf("キーボードで一覧を動かす</dt>");
  expect(dtAt).toBeGreaterThan(0);
  const keyGuide = template.slice(dtAt, template.indexOf("</dd>", dtAt));
  for (const key of keys) {
    const shown = NAMED[key] || key;
    expect(keyGuide, `てびきがキー「${key}」（画面では ${shown}）を挙げていない`).toContain(shown);
  }
  // キーの名前が揃っても、**何をするキーか**がズレると案内が噓をつく（自分の誤記はこれ）。
  // 実装側: `d` は行の詳細を開き、`Enter` は公式ページを開く（行の詳細は開かない）。
  const script = [
    "(async () => {",
    "const calls = { openUrl: 0, drawer: 0 };",
    "const row = { conf: { link: 'https://example.org' }, ed: { link: 'https://example.org/e' } };",
    "const rowEl = { classList: { contains: () => false }, focus() {} };",
    `const KEY = ${JSON.stringify(jsFunction(app, "onKeydown"))};`,
    // 第 273 回: 行の選び方を `dataRows` にまとめたので、式として作って渡す。
    `const DATA_ROWS = ${JSON.stringify(jsFunction(app, "dataRows"))};`,
    "const rowsForKeys = [rowEl, rowEl];",
    "const $keys = () => ({ querySelectorAll: () => rowsForKeys });",
    "const dataRows = new Function('$', 'return (' + DATA_ROWS + ')')($keys);",
    // onKeydown はキーの振り分け関数を呼ぶので、抜き出した 2 つを一緒に作る。
    `const KEYBLOCK = ${JSON.stringify(jsFunction(app, "keyBlockedByTarget"))};`,
    'const onKeydown = new Function("state", "window", "document", "$", "selectedIndex", "shown",',
    '  "openDrawer", "closeDrawer", "ensureRowsDrawn", "safeExternalUrl", "dataRows",',
    '  KEYBLOCK + ";" + KEY + ";return onKeydown;")(',
    "  { mode: 'deadlines' },",
    "  { open: () => { calls.openUrl++; } },",
    "  { activeElement: null },",
    "  $keys, 1, [row, row],",
    "  () => { calls.drawer++; }, () => {}, () => {},",
    "  (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null), dataRows,",
    ");",
    "const fire = (key) => onKeydown({ key, target: { tagName: 'BODY', isContentEditable: false }, preventDefault() {} });",
    "fire('d');",
    "const afterD = { drawer: calls.drawer, openUrl: calls.openUrl };",
    "fire('Enter');",
    "const afterEnter = { drawer: calls.drawer, openUrl: calls.openUrl };",
    "console.log(JSON.stringify({ afterD, afterEnter }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  expect(got.afterD.drawer, "d が行の詳細を開いていない").toBe(1);
  expect(got.afterD.openUrl, "d が公式ページも開いている").toBe(0);
  // `window.open` は Enter のぶんだけ（d では開かないので計 1 回）。
  expect(got.afterEnter.openUrl, "Enter が公式ページを開いていない").toBe(1);
  expect(got.afterEnter.drawer, "Enter が行の詳細も開いている（案内と違う動き）").toBe(1);
  // 案内側: 同じ対応で書けていること。
  expect(keyGuide).toMatch(/<code>Enter<\/code>[^。]*公式ページ/);
  expect(keyGuide).toMatch(/<code>d<\/code>[^。]*行の詳細/);
  // 「行の詳細」の項（今回追加）: 開き方（押す / `d`）と閉じ方（`Esc`）を書く。
  const detailAt = template.indexOf("<dt>行の詳細</dt>");
  expect(detailAt).toBeGreaterThan(0);
  const detailGuide = template.slice(detailAt, template.indexOf("</dd>", detailAt));
  for (const word of ["行を押す", "<code>d</code>", "<code>Esc</code>", "公式サイト", "✕"]) {
    expect(detailGuide, `行の詳細の説明に ${word} が無い`).toContain(word);
  }
  // 狭い画面ではキーの案内が出せない（押す/✕ の話だけが残る）。
  const keyboardSpan = /<span class="only-keyboard">([\s\S]*?)<\/span>/.exec(detailGuide);
  expect(keyboardSpan, "行の詳細の説明でキー操作を狭い画面向けに括っていない").not.toBeNull();
  expect(keyboardSpan![1]).toContain("<code>d</code>");
  expect(keyboardSpan![1], "押さなくて良い操作が混ざっている").not.toContain("行を押す");
  expect(detailGuide.slice(0, detailGuide.indexOf('<span class="only-keyboard">'))).toContain("✕");
});

it("狭い画面ではキー操作の案内は見出しも説明も閉じる（SPEC §7）", () => {
  /* 狭い画面（ほぼスマホ）ではショートカットが使えないので案内も消す方針で、第 85 回に
   * 一度「閉じ忘れ」を直している。しかし閉じていたのは `.only-keyboard` を付けた **見出しだけ**
   * で、直後の `<dd>`（`j`/`k`/`d`/`Esc` の書き方そのもの）はそのまま出ていた（2026-09-23 実測）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("@media (max-width: 640px)");
  expect(at).toBeGreaterThan(0);
  const mediaBlocks = template.slice(at);
  expect(mediaBlocks).toMatch(/\.only-keyboard,\s*\.only-keyboard \+ dd \{[^}]*display: none/);
  // キーの項は、見出しを失っても説明が独り歩きしていないこと。
  const dtAt = template.indexOf('<dt class="only-keyboard">');
  expect(dtAt).toBeGreaterThan(0);
  const afterDd = template.slice(template.indexOf("</dt>", dtAt) + 5);
  expect(afterDd.trimStart().startsWith("<dd>"), "キーの項の説明が直後に無い").toBe(true);
});

it("二つの画面の呼び方が、切り替えボタンの語と揃っている（SPEC §7）", () => {
  /* 切り替えボタンは「投稿先を探す」／「締切を検索」なのに、てびきだけ別の呼び方
   * （「論文から探す」）で 3 か所書いていた（2026-09-23 実測）。案内を読んだ人が
   * どのボタンか特定できない。第 94 回の収録状況、第 95 回の早め絞り込みと同じ型なので、
   * ボタンの語を正本にして検査に入れる（テスト側に語を書き写さない）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const label = (id: string) => {
    const at = template.indexOf(`id="${id}"`);
    expect(at, `切り替えボタンが見つからない: ${id}`).toBeGreaterThan(0);
    const open = template.indexOf(">", at);
    const m = />([^<]+)<\/button>/.exec(template.slice(open, open + 200));
    expect(m, `ボタンの語が取れない: ${id}`).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  const recommend = label("modeRecommend");
  const deadlines = label("modeDeadlines");
  expect(recommend.length).toBeGreaterThan(0);
  // 見出し・案内はボタンと同じ語を使う。
  const guide = template.slice(template.indexOf('id="helpPanel"'));
  expect(guide).toContain(recommend);
  // 「締切を検索」側は既定の画面で、案内は表その物の語（「一覧」）で書いているので
  // 画面名の一致は要求しない（締切一覧＝表の意味で使っていて、誤りではない）。
  expect(deadlines.length).toBeGreaterThan(0);
  // 別の呼び方に寄せる書き方を戻さない（第 95 回の検査と同じ趣旨）。
  expect(guide, "ボタンに無い画面名を案内に書かない").not.toContain("論文から探す");
  // 画面の下（CSV の説明など）も同じ。
  const csvDd = template.slice(template.indexOf("<dt>CSV</dt>"));
  expect(csvDd.slice(0, csvDd.indexOf("</dd>"))).toContain(recommend);
});

it("PDF 読み込みの失敗は日本語と打ち手で出る（SPEC §7）", () => {
  /* 失敗時に内部の英語文字列をそのまま画面へ出していた（2026-09-23 実測）。
   * 「PDF 読込に失敗しました: pdfjs unavailable」「: file is too large」
   * 「: PDF has too many pages」「: PDF extraction timed out」など。
   * 日本語の利用者には何が起きたか直せない。特に `pdfjs unavailable` は、
   * 学内のプロキシで CDN が塞がれると起きる一番よくある失敗だった。 */
  const app = siteRuntime();
  const maxBytes = 20 * 1024 * 1024;
  const script = [
    "(async () => {",
    `const FAIL_SRC = ${JSON.stringify(jsFunction(app, "pdfFailureMessageJa"))};`,
    `const MAX_BYTES = ${maxBytes};`,
    'const f = new Function("PDF_MAX_BYTES", "PDF_MAX_PAGES", "return (" + FAIL_SRC + ")")(MAX_BYTES, 100);',

    "const cases = {",
    "  cdn: new Error('pdfjs unavailable'),",
    "  large: new Error('file is too large'),",
    "  pages: new Error('PDF has too many pages'),",
    "  slow: new Error('PDF extraction timed out'),",
    "  broken: new Error('Invalid PDF structure.'),",
    "  unknown: new Error('boom'),",
    " };",
    "const out = {};",
    "for (const k of Object.keys(cases)) out[k] = f(cases[k]);",
    "const aborted = new Error(' aborted');",
    "aborted.name = 'AbortError';",
    "out.aborted = f(aborted);",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // 内部の英語をそのまま出さない。
  for (const key of Object.keys(got)) {
    const text = got[key];
    expect(text, `${key} が日本語になっていない`).toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(text, `${key} が内部の英語文字列を写している`).not.toMatch(
      /pdfjs unavailable|file is too large|too many pages|timed out|Invalid PDF/i,
    );
    expect(text, `${key} に打ち手が無い（何が起きたかだけで終わる）`).toMatch(
      /貼|キャンセル|確かめる|指定して/,
    );
  }
  // 上限値は実装の定数から出る（テスト側に数字を書き写していない証明）。
  expect(got.large).toContain("20 MB");
  expect(got.pages).toContain("100 ページ");
  expect(got.aborted).toBe("PDF 読込をキャンセルしました");
  // 未発表の論文を預ける操作なので、送信しないことを画面に書く。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("選んだファイルは送信しません");
});

it("推薦のカードの行が、てびきの数と名前と合う（SPEC §7）", () => {
  /* 推薦のカードは、同じ値に二つの名前を付けていた（頭のチップは「一致評価」、その下の
   * 行は「研究適合度」で、どちらも `r._fitLabel`・2026-09-23 実測）。てびきは
   * 「4行並べます」と書きながら、実際は 5 行で、しかも載っていない行が1つ有った
   * （「締切と種別」）。第 100 回のキー操作と同じ型なので、**行のラベルをビルド成果物から
   * 洗って**てびきと突き合わせる（語も件数もテスト側に書き写さない）。 */
  const app = siteRuntime();
  const card = jsFunction(app, "makeRecommendationCard");
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const labels = Array.from(
    new Set(
      Array.from(
        card.matchAll(/`([^`\n$]{2,20})[^`]*`,\s*\n?\s*"card-section recommendation-axes"/g),
        // ラベルは最初の読点・コロンまで（「締切の確認状況: 日付 …」の行がある）。
        (m) => m[1].split(/[:：]/)[0].trim(),
      ),
    ),
  );
  expect(labels.length, "カードの行が見当たらない（検査が空振り）").toBeGreaterThan(2);
  // 同じ値の言い替えを戻さない。画面に出る語はテンプレートとランタイムの文字列から出る
  // （`public/` は CI ではテスト後にビルドするので、ビルド成果物を読まない）。
  expect(card, "同じ評価に二つ目の名前を付けた").not.toContain("研究適合度");
  expect(template, "画面に二つ目の名前が残っている").not.toContain("研究適合度");
  const at = template.indexOf("カードの頭にある<strong>一致評価</strong>");
  expect(at).toBeGreaterThan(0);
  const guide = template.slice(template.lastIndexOf("<dd>", at), template.indexOf("</dd>", at));
  // てびきが数える行数と、実装の行数が合うこと。
  const counted = /判断材料を(\d+)行/.exec(guide);
  expect(counted, "てびきがカードの行数を数えていない").not.toBeNull();
  expect(Number(counted![1]), "てびきの行数と実装の行数が割れている").toBe(labels.length);
  for (const label of labels) {
    expect(guide, `てびきがカードの行「${label}」を挙げていない`).toContain(label);
  }
  // 一致評価はカードの頭に出る語として説明する（行として数えない）。
  expect(guide).toContain("一致評価");
});

it("推薦のカードの締切は表と同じ向き（JST と曜日）で出る（SPEC §7）", () => {
  /* 表は JST を主表記にしている（AoE 23:59 締切は JST では翌日の夜になるため、UTC 優先だと
   * 日本で何時までに出せばよいか分からない – `makeRow` のコメント）。ところが推薦のカードの
   * 受付状況は `fmtDate(ts) + " UTC / " + fmtAoE(ts)` で、UTC 主表記だった（2026-09-23 実測:
   * 「次回締切: 2026-10-05 23:59 UTC / 2026-10-05 15:59 AoE」）。同じ画面の表では
   * 「2026-10-06(火) 08:59 JST」が出るので、同じ締切に二つの時刻が並んでいた。
   * 加えて同じ値を「締切:」でもう一行出していて、「締切: 次回締切: …」の二重ラベルだった。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    `const AVAIL_SRC = ${JSON.stringify(jsFunction(app, "recommendationAvailability"))};`,
    `const FMTJST_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    `const FMTDATE_SRC = ${JSON.stringify(jsFunction(app, "fmtDate"))};`,
    `const FMTAOE_SRC = ${JSON.stringify(jsFunction(app, "fmtAoE"))};`,
    // 抽出関数の自由変数は正本から揃える（`pad` を自作すると書式がズレる）。
    `const PAD_SRC = ${JSON.stringify(jsFunction(app, "pad"))};`,
    "const pad = new Function('return (' + PAD_SRC + ')')();",
    // `fmtJst` の自由変数（曜日の配列）も正本の宣言から作る。
    `const WEEKDAY_DECL = ${JSON.stringify((app.match(/const WEEKDAY_JA = \[[^\]]*\];/) || [""])[0])};`,
    "const WEEKDAY_JA = new Function('return ' + WEEKDAY_DECL.replace(/^const WEEKDAY_JA = /, '').replace(/;$/, ''))();",
    "if (!Array.isArray(WEEKDAY_JA) || WEEKDAY_JA.length !== 7) throw new Error('曜日の配列が取れていない');",
    "const fmtJst = new Function('WEEKDAY_JA', 'pad', 'return (' + FMTJST_SRC + ')')(WEEKDAY_JA, pad);",
    "const fmtDate = new Function('pad', 'return (' + FMTDATE_SRC + ')')(pad);",
    "const fmtAoE = new Function('pad', 'return (' + FMTAOE_SRC + ')')(pad);",
    // 表で使う曜日の語はビルド成果物から取る（テスト側に書き写さない）。
    `const WEEKDAY_SRC = ${JSON.stringify(jsFunction(siteRuntime("recommender.js"), "weekdayJaFromDate"))};`,
    // helper の自由変数（暦日の曜日の配列）も正本から揃える。
    `const CAL_DECL = ${JSON.stringify((siteRuntime("recommender.js").match(/const CALENDAR_DATE_JA = \[[^\]]*\];/) || [""])[0])};`,
    "const CALENDAR_DATE_JA = new Function('return ' + CAL_DECL.replace(/^const CALENDAR_DATE_JA = /, '').replace(/;$/, ''))();",
    "if (!Array.isArray(CALENDAR_DATE_JA) || CALENDAR_DATE_JA.length !== 7) throw new Error('暦日の曜日の配列が取れていない');",
    "const weekdayJaFromDate = new Function('CALENDAR_DATE_JA', 'return (' + WEEKDAY_SRC + ')')(CALENDAR_DATE_JA);",
    // 「分からない」の語（未確認）も正本から取る（テスト側に書き写さない）。
    // 関数は宣言済みの語を返すだけなので、語の宣言そのものを取りに出す。
    `const UNCONFIRMED_DECL = ${JSON.stringify(
      (siteRuntime("recommender.js").match(/const UNCONFIRMED_LABEL_JA = [^;]*;/) || [""])[0],
    )};`,
    "const UNCONFIRMED_JA = new Function('return ' + UNCONFIRMED_DECL.replace(/^const UNCONFIRMED_LABEL_JA = /, '').replace(/;$/, ''))();",
    "if (typeof UNCONFIRMED_JA !== 'string' || !UNCONFIRMED_JA.length) throw new Error('未確認の語が取れない（検査が空振り）');",
    "const Recommender = {",
    "  officialZone: (dl) => Recommender.zone,",
    "  weekdayJaFromDate,",
    "  zone: 'AoE',",
    "};",
    "const avail = new Function('fmtJst', 'fmtDate', 'fmtAoE', 'Recommender', 'UNCONFIRMED_JA',",
    "  'return (' + AVAIL_SRC + ')')(fmtJst, fmtDate, fmtAoE, Recommender, UNCONFIRMED_JA);",
    // UTC では 10/5、JST では 10/6 になる締切（AoE 23:59 型の例）。
    "const ts = Date.UTC(2026, 9, 5, 15, 59);",
    "const jstShown = fmtJst(new Date(ts));",
    "const aoe = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'JST';",
    "const jst = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "Recommender.zone = 'UTC';",
    "const utc = avail({ _availability: { status: 'open', timestamp: ts }, dl: {} });",
    "const dateOnly = avail({ _availability: { status: 'open', local_date: '2026-10-06' }, dl: {} });",
    // 受付状況が確認できない行の語（第 142 回）。画面 other 箇所と同じ語に揃える。
    "const noAvail = avail({});",
    "const ongoing = avail({ _availability: { status: 'ongoing' }, dl: {} });",
    "const openNoDate = avail({ _availability: { status: 'open' }, dl: {} });",
    "const uncertainNoDate = avail({ _availability: { status: 'uncertain' }, dl: {} });",
    "const weirdStatus = avail({ _availability: { status: 'someday' }, dl: {} });",
    "console.log(JSON.stringify({",
    "  jstShown,",
    "  aoe,",
    "  jst,",
    "  utc,",
    "  dateOnly,",
    "  noAvail,",
    "  ongoing,",
    "  openNoDate,",
    "  uncertainNoDate,",
    "  weirdStatus,",
    "  unconfirmed: UNCONFIRMED_JA,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // JST（曜日付き）が主表記で、表と同じ文字列になる。
  expect(got.aoe, "JST の主表記が出ていない").toContain(got.jstShown);
  expect(got.aoe.startsWith(`次回締切: ${got.jstShown}`), "JST が先頭ではない").toBe(true);
  // AoE 併記は AoE 宣言の会議だけ。
  expect(got.aoe).toContain("公式 AoE");
  expect(got.jst, "JST 宣言の締切に AoE を併記している").not.toContain("AoE");
  expect(got.jst).toContain("公式 JST 締切");
  expect(got.utc).toContain("UTC");
  // 暦日だけの締切も曜日を添える（表と同じ）。
  expect(got.dateOnly, "暦日だけの締切に曜日が無い").toMatch(
    /^次回締切: 2026-10-06\(.+\)（時刻未確認）$/,
  );
  // 同じ値をカード内で二回出さない（「締切: 次回締切: …」の二重ラベルを戻さない）。
  const card = jsFunction(app, "makeRecommendationCard");
  expect(
    card.match(/recommendationAvailability\(r\)/g) || [],
    "同じ値を二行に出している",
  ).toHaveLength(1);
  expect(card).not.toMatch(/締切: \$\{recommendationAvailability/);
  /* 受付状況が確認できない行の語。画面の「分からない」は 未確認 / 該当なし / 評価なし の
   * 3 つに揃えてあって、てびきの「空欄の出し方」に同じ約束を書いている。カードだけが
   * 「受付状況不明」を出していた（2026-09-23 実測）。てびきにも無い語だったので、
   * 画面で見た人が意味を引けない語だった。 */
  expect(got.noAvail).toBe(`受付状況${got.unconfirmed}`);
  expect(got.noAvail).not.toContain("不明");
  expect(got.weirdStatus).toBe(`受付状況${got.unconfirmed}`);
  expect(got.uncertainNoDate).toBe(`受付状況${got.unconfirmed}`);
  // 受け付け中なのに日付が出ていない行は、分からない部分だけを書く。
  expect(got.openNoDate).toBe(`次回締切の日付が${got.unconfirmed}`);
  // 「常時受付」は実在する状態（2026-09-23 実測: プール 3,257 行で 4 件）で、てびきが書く語。
  expect(got.ongoing).toBe("常時受付");
  const guide = readFileSync(join(site, "index.html"), "utf8");
  for (const word of [
    `受付状況${got.unconfirmed}`,
    `次回締切の日付が${got.unconfirmed}`,
    "常時受付",
  ]) {
    expect(guide, `カードに出す「${word}」がてびきから引けない`).toContain(word);
  }
  // 表示文に「不明」を戻さない（コメントには出てよいので、文字列リテラルだけ見る）。
  expect(got.aoe + got.jst + got.utc + got.dateOnly + got.noAvail + got.openNoDate).not.toContain(
    "不明",
  );
  expect(jsFunction(app, "recommendationAvailability")).not.toMatch(/"[^"]*不明[^"]*"/);
});

it("支援技術に本文の位置と表の名前を伝え、跳ぶ導線を置く（SPEC §7）", () => {
  /* 検索欄・プリセット・分野チップを全部 Tab で辿らないと表に届かず、本文へ飛ぶ導線が
   * 無かった。`<table>` にも名前が無く（`<caption>` も `aria-label` も無し）、支援技術には
   * 「表」だとだけ伝わっていた（2026-09-23 実測）。結果のまとまりを示すランドマークも無い。 */
  const html = siteHtmlRuntime();
  const body = html.slice(html.indexOf("<body>"));
  // 跳ぶ導線が最初の操作可能な要素であること（後から足すと意味が無い）。
  const focusables = Array.from(body.matchAll(/<(a|button|input|select)\b/g));
  expect(focusables.length).toBeGreaterThan(5);
  expect(focusables[0][1], "最初の操作可能要素が跳ぶ導線ではない").toBe("a");
  const skip = /<a class="skip-link" href="#([^"]+)">([^<]*)<\/a>/.exec(body);
  expect(skip, "本文へ跳ぶ導線が有らない").not.toBeNull();
  expect(skip![2]).toContain("締切の一覧");
  // 飛び先が実在し、フォーカスを当てられること（`tabindex="-1"` が無いと飛んでも読まない）。
  const target = new RegExp(`<(main|div|section)[^>]*id="${skip![1]}"[^>]*>`).exec(body);
  expect(target, `跳ぶ導線の飛び先 ${skip![1]} が無い`).not.toBeNull();
  expect(target![0], "飛び先にフォーカスを当てられない").toContain('tabindex="-1"');
  // 結果のまとまりのランドマークは一つだけ。
  expect((body.match(/<main\b/g) || []).length, "main が重複している").toBe(1);
  // 画面に描画しない支援技術向けの語を、`display: none` で消していないこと。
  const caption = /<caption class="only-sr">([^<]*)<\/caption>/.exec(body);
  expect(caption, "表に名前が無い").not.toBeNull();
  expect(caption![1]).toContain("締切");
  const onlySr = /\.only-sr \{([^}]*)\}/.exec(html);
  expect(onlySr, "支援技術向けの語の隠し方が無いか、壊れている").not.toBeNull();
  expect(onlySr![1], "display: none にすると読み上げ自体が消える").not.toContain("display: none");
  const skipRule = /\.skip-link \{([^}]*)\}/.exec(html.slice(html.indexOf(".skip-link {")));
  expect(skipRule, "跳ぶ導線の基準の style が無いか、壊れている").not.toBeNull();
  expect(skipRule![1], "跳ぶ導線を display: none で消している").not.toContain("display: none");
  // フォーカスしたら画面に出てくること（見えない導線はキーボードでは使えない）。
  expect(html).toMatch(/\.skip-link:focus \{[^}]*left: ?(?!-9999)/);
});

it("見出しの並び替えは Enter・Space で効き、行用の Enter と衝突しない（SPEC §7）", () => {
  /* 「sortable headers are keyboard-operable」という検査が有ったが、実際にキーを押す所を
   * 一度も見ておらず、`tabindex` と `aria-sort` の有無だけを見ていた（2026-09-23 確認）。
   * 実装は `th` に keydown を張る形なので、その張られた handler をビルド成果物から
   * 抜き出して本当に押す（検査が画面の挙動を語っている形に戻す）。 */
  const app = siteRuntime();
  const at = app.indexOf('th.addEventListener("keydown"');
  expect(at, "見出しのキーボード処理が見当たらない").toBeGreaterThan(0);
  const head = 'th.addEventListener("keydown", ';
  const start = at + head.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < app.length; i++) {
    const ch = app[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth) {
        end = i + 1;
        break;
      }
    }
  }
  const handler = app.slice(start, end);
  const script = [
    "(async () => {",
    `const HANDLER = ${JSON.stringify(handler)};`,
    "const out = [];",
    "const window = { toggleSort: (k) => out.push(['toggle', k]) };",
    "const th = { getAttribute: (a) => (a === 'data-sort' ? 'date' : null) };",
    "const onKey = new Function('th', 'window', 'return (' + HANDLER + ')')(th, window);",
    "const fire = (key) => {",
    "  let prevented = false, stopped = false;",
    "  onKey({ key, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });",
    "  out.push([key, prevented, stopped]);",
    "};",
    "fire('Enter');",
    "fire(' ');",
    "fire('j');",
    "console.log(JSON.stringify(out));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  // 混ざった組（['toggle', 列] と ['Enter', 停止, 伝搬]）なので型を寄せておく。
  const out = JSON.parse(proc.stdout.trim().split("\n").pop() || "[]") as Array<
    [string, unknown, unknown?]
  >;
  const toggled = out.filter((x) => x[0] === "toggle").map((x) => x[1]);
  // Enter と Space の両方が、押した列の並び替えを呼ぶ（Space が抜けている実装はよくある）。
  expect(toggled, "Enter・Space で並び替えが起きていない").toEqual(["date", "date"]);
  // `j` は選択行を動かすキーなので、見出しが食ってはいけない。
  expect(
    out.some((x) => x[0] === "j" && x[1] === false),
    "j キーを止めている",
  ).toBe(true);
  // グローバルの「Enter = 選択行の公式ページを開く」に奪われないよう、止めてから渡す。
  const enter = out.find((x) => x[0] === "Enter");
  expect(enter, "Enter を押した記録が無い（検査が空振り）").toBeDefined();
  expect(enter![1], "Enter で既定動作を止めていない").toBe(true);
  expect(enter![2], "Enter がグローバル側に伝わる（公式ページが開いてしまう）").toBe(true);
});

it("並び替えの状態は読み上げに伝わる（見出しの矢印だけだった・SPEC §7）", () => {
  /* 並び順は見出しの語尾の矢印（↑/↓/↕）にしか出ていなかった（2026-09-23 実測）。
   * キーボードでヘッダーを押して並びが変わっても読み上げは何も言わない。過ぎた締切を
   * 下にまとめたときは件数欄に書く（黙って並びを変えない）ので、その方針と同じにする。
   * 画面は混むので読み上げ専用の短い欄にだけ足す（第 89 回で分けた仕組み）。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    `const LABEL_SRC = ${JSON.stringify(jsFunction(app, "sortColumnLabel"))};`,
    `const NOTE_SRC = ${JSON.stringify(jsFunction(app, "sortNoteJa"))};`,
    'const LABELS = { rem: "残り ↕", date: "日時（JST） ↓", conf: "会議 ↕", rank: "ランク ↑" };',
    "const document = {",
    "  querySelector: (sel) => {",
    `    const k = /data-sort="([^"]+)"/.exec(sel);`,
    "    if (!k || !(k[1] in LABELS)) return null;",
    "    return { textContent: LABELS[k[1]] };",
    "  },",
    "};",
    "const sortColumnLabel = new Function('document', 'return (' + LABEL_SRC + ')')(document);",
    "const note = new Function(",
    "  'document',",
    "  'sortColumnLabel',",
    "  'return (' + NOTE_SRC + ')'",
    ")(document, sortColumnLabel);",
    "console.log(JSON.stringify({",
    "  rem: note('rem', true),",
    "  dateDesc: note('date', false),",
    "  rank: note('rank', false),",
    "  none: note('', true),",
    "  unknown: note('other', true),",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}");
  // 語尾の矢印を落とした見出しの語を使い、向きを日本語で書く。
  expect(got.rem).toBe(" ｜ 並び順: 残り 昇順");
  expect(got.dateDesc).toBe(" ｜ 並び順: 日時（JST） 降順");
  expect(got.rank).toBe(" ｜ 並び順: ランク 降順");
  expect(got.none, "並び順が無いのに文を出す").toBe("");
  expect(got.unknown, "見出しの無い列の語をこしらえている").toBe("");
  // 画面に出す文には足さない（読み上げ専用の欄にだけ入れる）。読み上げ欄の語を
  // てびきにも書いておくので、三者がズレないようにする。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("<dt>並び順</dt>");
  expect(at).toBeGreaterThan(0);
  const guide = template.slice(at, template.indexOf("</dd>", at));
  expect(guide, "てびきを読み上げの語と揃えないと、画面の説明が噓になる").toContain(
    "並び順: 残り 昇順",
  );
});

it("URL に書く条件は、URL から読みもする（共有画面で条件が消えない・SPEC §7）", () => {
  /* `writeUrl` は 12 種類の条件を書く。読み側 `readUrl` が 1 つでも忘れていると、
   * 共有した相手の画面でその条件だけ黙って外れる（画面には「絞り込み済み」らしく
   * 出てしまう）。両方の関数からキー名を洗って照合する（キーをテスト側に書き写さない）。 */
  const app = siteRuntime();
  const keys = (fn: string, re: RegExp) => {
    const body = jsFunction(app, fn);
    expect(body, `${fn} が見当たらない（検査が空振り）`).not.toBe("");
    return new Set(Array.from(body.matchAll(re), (m) => m[1]));
  };
  const written = keys("writeUrl", /\.set\("([a-z]+)"/g);
  const read = keys("readUrl", /\.get\("([a-z]+)"/g);
  expect(written.size, "URL に書く条件が見当たらない").toBeGreaterThan(6);
  for (const key of written) {
    expect(read, `URL には ${key} を書くのに読まない（共有先で条件が消える）`).toContain(key);
  }
  // 読むだけで書かないキーは許す（古い URL の受け皿など）が、空いていたら記録する。
  const onlyRead = Array.from(read).filter((k) => !written.has(k));
  expect(onlyRead, "読み-only のキーが増えたら意図を確認する").toEqual([]);
});

it("表の公式表記に出る語（時刻未確認・AoE・JST）はその語で引ける（SPEC §7）", () => {
  /* 一覧の 2 行目は公式ページの表記を出すが、その語が検索要素に入っていなかった
   * （2026-09-23 実測）。日付だけの行 188 件が「時刻未確認」の印を出すのにその語は
   * 0 件、AoE 宣言の行 1,908 件が「公式 AoE …」と出すのに「AoE」は 2 件だけ
   * （上流の締切名に偶々入っていた物で、AoE 締切自体は 1 件も出ていなかった）。
   * 「画面に出ている語で検索できる」状態を保つ（SPEC §2 の表示と検索の約束事）。 */
  const rows = Recommender.candidateRows(data);
  expect(rows.length).toBeGreaterThan(100);
  const dateOnly = rows.filter((r) => r.dateOnly === true);
  const aoe = rows.filter((r) => Recommender.officialZone(r.dl) === "AoE");
  const jst = rows.filter((r) => Recommender.officialZone(r.dl) === "JST");
  // 検査が空振りしないこと（収録が変わって 0 行になたら、この検査は何も言えなくなる）。
  expect(dateOnly.length, "日付だけの行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(aoe.length, "AoE 宣言の行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(jst.length, "JST 宣言の行が無い（検査が空振り）").toBeGreaterThan(0);
  /* 画面が出す語をビルド成果物から取る（表示の語をテスト側に書き写すと、表示だけが
   * 変わったときに検査が緑のまま残る）。`残り` 列の badge の語を見る。 */
  const app = siteRuntime();
  const badge = /text: "([^"]*未確認[^"]*)", cls: ""/.exec(app);
  expect(badge, "一覧の badge の語が見つからない").not.toBeNull();
  const badgeWord = String(badge![1]).replace(/[（）。]/g, "");
  expect(badgeWord).toContain("時刻未確認");
  // 日付だけの行は、画面と同じ語で全部引ける。
  for (const r of dateOnly) {
    expect(
      Recommender.hayMatches(r.hay, badgeWord),
      `${String(r.hay).slice(0, 24)} が「${badgeWord}」で引けない`,
    ).toBe(true);
  }
  // AoE 宣言の行は「AoE」で引ける。逆に JST 宣言の行が混ざると、実在しない AoE 締切を
  // 探したことになる（表示で AoE を出さない行と同じ向き）。
  for (const r of aoe) {
    expect(
      Recommender.hayMatches(r.hay, "AoE"),
      `${String(r.hay).slice(0, 24)} が「AoE」で引けない`,
    ).toBe(true);
  }
  for (const r of jst) {
    expect(
      Recommender.hayMatches(r.hay, "AoE"),
      `${String(r.hay).slice(0, 24)} は AoE 締切でない`,
    ).toBe(false);
    expect(
      Recommender.hayMatches(r.hay, "JST"),
      `${String(r.hay).slice(0, 24)} が「JST」で引けない`,
    ).toBe(true);
  }
  // 全行に出る「公式」の二字は検索語にしない（入れても絞れず、絞れたと誤信させる。
  // 「確認できたものだけ」はチェックボックスの側で絞る）。
  expect(rows.filter((r) => Recommender.hayMatches(r.hay, "公式")).length).toBe(0);
});

it("キーボードで選んだ行にフォーカスが動く（支援技術に読まれる・SPEC §7）", () => {
  /* `j` / `k` は行のクラス目印だけ変えてスクロールしていた（2026-09-23 実測）。
   * てびきは「キーボードで一覧を動かす」と案内しているので、支援技術を使う人にも
   * 選んだ行が読める形（フォーカスを移す）にする。なめらかスクロールは「動きを抑える」
   * 設定を見ないまま効いていたので、その向きも見る。 */
  const app = siteRuntime();
  const script = [
    "(async () => {",
    // 第 273 回: 行の選び方を `dataRows` にまとめたので、呼び先も併れる。
    `const DATA_ROWS = ${JSON.stringify(jsFunction(app, "dataRows"))};`,
    `const UPDATE = ${JSON.stringify(jsFunction(app, "updateRowSelection"))};`,
    // shown[] と 1:1 の行のほかに、展開行と月見出し行が混ざる（除外されないと行がズレる）。
    "const mk = (name, classes) => {",
    "  return {",
    "    name,",
    "    classList: { contains: (c) => classes.indexOf(c) >= 0, toggle: () => {} },",
    "    focused: 0,",
    "    focusArgs: null,",
    "    scrollArgs: null,",
    "    attrs: {},",
    "    focus(o) { this.focused++; this.focusArgs = o || null; },",
    "    scrollIntoView(o) { this.scrollArgs = o || null; },",
    "    setAttribute(k, v) { this.attrs[k] = v; },",
    "    removeAttribute(k) { delete this.attrs[k]; },",
    "  };",
    "};",
    'const rows = [mk("row0", ["row"]), mk("detail", ["detail-row"]), mk("row1", ["row"]), mk("row2", ["row"])];',
    "const mkWindow = (reduce) => ({",
    "  matchMedia: (q) => ({ matches: reduce && q.indexOf('prefers-reduced-motion') >= 0 }),",
    "});",
    // 実装の関数宣言を、自由変数（`$`・`window`・`selectedIndex`）を渡して呼ぶ。
    "const run = (index, reduce) => {",
    "  const window = mkWindow(reduce);",
    "  rows.forEach((r) => { r.focused = 0; r.focusArgs = null; r.scrollArgs = null; });",
    "  const fn = new Function('$', 'window', 'selectedIndex',",
    "    DATA_ROWS + '; ' + UPDATE + '; return updateRowSelection();');",
    "  fn(() => ({ querySelectorAll: () => rows }), window, index);",
    "};",
    // shown[] の 2 番目（実体 3 行目の row2 を index 2 で選ぶ。除外行を数えるとズレる）。
    "run(1, false);",
    "const a = rows.map((r) => [r.name, r.focused, JSON.stringify(r.focusArgs), JSON.stringify(r.scrollArgs)]);",
    "run(2, true);",
    "const b = rows.map((r) => [r.name, r.focused, JSON.stringify(r.scrollArgs)]);",
    "console.log(JSON.stringify({ a, b }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const { a, b } = JSON.parse(proc.stdout.trim().split("\n").pop() || "{}") as {
    a: unknown[][];
    b: unknown[][];
  };
  const focused = a.filter((x) => Number(x[1]) > 0).map((x) => String(x[0]));
  // 選んだ行だけフォーカスされる（除外行ではないこと – 除外が効くと 1 行ズレる）。
  expect(focused, "選んだ行にフォーカスが動いていない").toEqual(["row1"]);
  const row1 = a.find((x) => x[0] === "row1");
  expect(row1, "row1 の記録が無い（検査が空振り）").toBeDefined();
  // なめらかスクロールと二重にスクロールしないよう、フォーカスはスクロールを抑える。
  expect(String(row1![2]), "フォーカスが画面を動かして二重にスクロールする").toContain(
    "preventScroll",
  );
  // 「動きを抑える」設定が無ければなめらか、あれば瞬間移動。
  expect(String(row1![3])).toContain("smooth");
  const row2 = b.find((x) => x[0] === "row2");
  expect(row2, "row2 の記録が無い（検査が空振り）").toBeDefined();
  expect(String(row2![2]), "「動きを抑える」設定でもなめらかに動く").toContain("auto");
  // てびきにも、選んだ行が読まれることを書いておく（案内と実装のズレを防ぐ）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const at = template.indexOf("<code>d</code> で行の詳細を出します。");
  expect(at).toBeGreaterThan(0);
  expect(template.slice(at, at + 260), "てびきに読み上げの説明が無い").toContain("支援技術");
});

it("締切が延びていた行は、一覧・CSV・検索で同じ語が揃う（SPEC §7）", () => {
  /* 上流の締切名に "Extended"（延長）と付く行が収録 3,235 行のうち 33 行（将来締切 15 行）
   * あったが、その事実は画面のどこにも出ておらず、検索も英語の `extended` でしか引けなかっ
   * た（「延長」は偶然日本語の締切名を持っていた 3 件だけ – 2026-09-23 実測）。
   * 締切が延びたかどうかは動作計画に直結するので、一覧のチップ・CSV の取得状態・検索語が
   * 同じ語になることを実データで見る。 */
  const rows = Recommender.candidateRows(data);
  const extended = rows.filter((r) => Recommender.isExtendedDeadline(r.dl));
  expect(extended.length, "延長の行が無い収録では検査が空振りする").toBeGreaterThan(0);
  expect(extended.length).toBeLessThan(rows.length);
  for (const r of extended) {
    expect(
      Recommender.hayMatches(r.hay, "延長"),
      `${r.hay.slice(0, 24)} が「延長」で引けない`,
    ).toBe(true);
  }
  // 延長していない行が混ざってはいけない（語を広く入れると誤検出になる）。
  const others = rows.filter((r) => !Recommender.isExtendedDeadline(r.dl));
  expect(
    others.filter((r) => Recommender.hayMatches(r.hay, "延長")).length,
    "延長していない行が「延長」で引ける",
  ).toBe(0);
  // CSV の取得状態にも同じ語を入れる（表計算に落とすと情報が消えないようにする）。
  // 型は行の欄を広く取る API なので、テスト側の行型は寄せる（実装の検査ではない）。
  const csv = Recommender.deadlinesToCsv(
    extended as unknown as Record<string, unknown>[],
    Date.UTC(2026, 7, 9),
  );
  expect(csv).toContain(Recommender.extendedLabelJa());
  // チップの語は日本語にする（上流の英語ラベルをそのままチップにしない – 公式ページの
  // 表記そのものを出す欄は別に有るが、あれは意図して原表記を残している欄なので別物）。
  expect(Recommender.extendedLabelJa()).not.toMatch(/[A-Za-z]/);
});

it("語を並べた検索で 0 件のとき、原因の語を名指す（SPEC §7）", () => {
  /* 「ネットワーク 福岡 GPU」も「人工知能 だけ」も 0 件だったが、画面は原因の語を言わず
   * 「検索語を短くする」しか出さなかった（2026-09-23 実測）。語ごとの当たり数を数えて、
   * 収録データに無い語を名指すか、語をすべて含む行が無いことを件数で示す。 */
  const rows = Recommender.candidateRows(data);
  const hays = rows.map((r) => r.hay);
  const counts = Recommender.queryTermCounts("ネットワーク 福岡 GPU", hays);
  expect(counts.length, "語に分けていない").toBeGreaterThan(1);
  const gpu = counts.find((c) => c.term === "gpu");
  expect(gpu, "GPU の語が数え上げられていない").toBeDefined();
  expect(gpu!.count, "この収録に GPU の行があるなら検査の前提が変わった").toBe(0);
  expect(
    counts.filter((c) => c.count > 0).length,
    "当たる語が 1 つも無い（検査が空振り）",
  ).toBeGreaterThan(0);
  /* 展開される語は、生の語ではなく展開後で数える（「九州」は会場地名に漢字で書かれて
   * いないことがある – 1 語だけで数ると「無い」と誤らせる）。 */
  const kyushu = Recommender.queryTermCounts("九州", hays);
  expect(kyushu.length).toBe(1);
  expect(kyushu[0].count, "展開後の語で数えていない").toBeGreaterThan(0);

  // 0 件案内の文面（ビルド成果物の関数を使う）。
  const app = siteRuntime();
  const hint = new Function(
    "Recommender",
    `${app.match(/const KIND_ALL_LABEL_JA = [^\n]*;/)?.[0] ?? ""}
     return (${jsFunction(app, "emptyDeadlineHint")});`,
  )(Recommender) as (f: object) => string;
  const base = {
    window: "all",
    past: true,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    query: "ネットワーク 福岡 GPU",
    hiddenKindWords: [],
    queryMatch: { catalog: 0, journal: 0 },
    // 収録データは入っている前提の検査（無いときの説明は別の検査で見る）。
    catalogConferences: 12,
  };
  const dead = hint({
    ...base,
    termCounts: [
      { term: "ネットワーク", count: 258 },
      { term: "福岡", count: 1 },
      { term: "gpu", count: 0 },
    ],
  });
  expect(dead, "収録に無い語を名指していない").toContain("「gpu」");
  expect(dead).toContain("収録データにも見当たりません");
  // 原因の語が分かったときは、的外れな「検索語を短くする」を出さない。
  expect(dead).not.toContain("検索語を短くする");
  // 語が全部当たっている場合は、語ごとの件数を出す（「人工知能 だけ」のような形）。
  const all = hint({
    ...base,
    query: "機械学習 のみ",
    termCounts: [
      { term: "機械学習", count: 494 },
      { term: "のみ", count: 1 },
    ],
  });
  expect(all).toContain("語をすべて含む行はありません");
  expect(all).toContain("「機械学習」494件");
  // 1 語だけの検索では出さない（語を並べた人が対象）。
  const one = hint({
    ...base,
    query: "データベース",
    termCounts: [{ term: "データベース", count: 456 }],
    catalogConferences: 12,
  });
  expect(one).not.toContain("語をすべて含む行はありません");
  expect(one).not.toContain("収録データにも見当たりません");
});

it("0 件の理由は読み上げにも短的に出る（長い文を aria-live に流さない・SPEC §7）", () => {
  /* 0 件の理由（どの語が足りなかったか等）は `#emptyText` に書くだけで、支援技術には
   * 読まれていなかった（2026-09-23 実測: 読み上げ専用の欄は件数だけを言っていた）。
   * とはいえ長い説明文を aria-live に流すと 1 打鍵ごとに数十語が読まれる（第 88 回で
   * 実際に起きた）。同じ原因を短い形で読み上げに出す。 */
  const app = siteRuntime();
  const note = new Function(
    "Recommender",
    `${jsFunction(app, "countJa")};
     return (${liveNoteSource(app)});`,
  )(Recommender) as (f: {
    hiddenKindWords: string[];
    termCounts: Array<{ term: string; count: number }>;
    catalogConferences: number;
    queryMatch: { catalog: number; journal: number };
    query: string;
  }) => string;
  const empty = {
    hiddenKindWords: [],
    termCounts: [],
    // 表その物を指す語を打っていない前提の検査（打ったときは別の検査で見る）。
    query: "",
    queryMatch: { catalog: 0, journal: 0 },
    // データは入っている前提の検査（無いときの説明は別の検査で見る）。
    catalogConferences: 12,
  };
  // 収録に無い語が最優先（その語を外さないと何も変わらないので）。
  const dead = note({
    ...empty,
    termCounts: [
      { term: "ネットワーク", count: 258 },
      { term: "gpu", count: 0 },
    ],
  });
  expect(dead).toContain("gpu");
  expect(dead).toContain("収録データにありません");
  // 表に出さない種別に当たったケース。
  const kindHit = note({ ...empty, hiddenKindWords: ["採否通知"] });
  expect(kindHit).toContain("採否通知");
  expect(kindHit).toContain("種別");
  /* 行先も短い形で言う（60 字の上限は別の検査が見ている – 第 247 回）。 */
  expect(kindHit).toContain("upcoming.html");
  // 収録では当たるがいまの条件で 0 件、は件数を書く（「kamiyobi に無い」と誤らせない）。
  const inCatalog = note({ ...empty, queryMatch: { catalog: 31, journal: 0 } });
  expect(inCatalog).toContain("31 件");
  expect(inCatalog).toContain("いまの条件では 0 件");
  // どの原因でも無いときの受け皿。
  const plain = note(empty);
  /* 「緩められる」という言いぶりは、下に「外せる条件」が並んでいる画面では
   * その案内を指す文に変わった（外せる条件が残っていない画面では言わない – 第 141 回）。*/
  expect(plain).toContain("下に外せる条件も書いてあります");
  // 読み上げなので短い（画面に出す説明文は別。1 打鍵ごとに読まれる長さにする）。
  for (const text of [dead, kindHit, inCatalog, plain]) {
    expect(text.length, `読み上げの文が長い: ${text}`).toBeLessThanOrEqual(60);
  }
  // 読み上げ専用の欄にだけ入れ、画面に出す件数欄には足さない（画面は元の文のままで良い）。
  expect(app, "0 件の理由を読み上げに足していない").toContain("cntLive += zeroResultLiveNote(");
  expect(app, "画面の件数欄に 0 件の理由を二重に書いている").not.toContain(
    "cnt += zeroResultLiveNote(",
  );
  // 判定自体が「表が出て 0 件のときだけ」発火することも見る（推薦のカードでは出さない）。
  const guard = /const zeroFilter =[\s\S]{0,120}?\? \{/.exec(app);
  expect(guard, "0 件の判定の組み方が変わって検査が空振りしている").not.toBeNull();
  expect(guard![0], "0 件以外でも数え上げている").toContain("!shown.length");
  expect(guard![0], "推薦のカードでも数え上げている").toContain("!recMode");
});

it("手引きが名指すファイルは、画面から押して辿れる（SPEC §7）", () => {
  /* てびきと 0 件の注記は「会期だけ確定の会は upcoming.html に載せます」と何回も言うが、
   * ファイル名を書くだけだと、画面を読む人はそこにたどれない（URL を打ち込むだけになる）。
   * 同じビルドの中に有るファイルなので、押せる形にする（2026-09-23 実測: リンク 0 本）。 */
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const mentions = template.match(/<code>upcoming\.html<\/code>/g) || [];
  expect(
    mentions.length,
    "てびきがファイルを名指す箇所が数え上げられていない",
  ).toBeGreaterThanOrEqual(2);
  const linked =
    template.match(/<a href="upcoming\.html"[^>]*><code>upcoming\.html<\/code><\/a>/g) || [];
  expect(linked.length, "てびきのファイル名が押せる形になっていない").toBe(mentions.length);
  // 印刷物でもファイル名は残る（リンクの文字自体が名前なので、印刷で消える書き方はしない）。
  expect(template, "印刷でリンク欄を丸ごと消すと名前が読めない").not.toContain(
    "main a { display: none",
  );
  // 画面の 0 件注記（ビルド後のコード）も同じファイルを指す。
  const app = siteRuntime();
  expect(app, "0 件の注記がファイルをまだ文字列に埋めている").toContain('href = "upcoming.html"');
  expect(app).not.toContain("会期は upcoming.html にも掲載");
  // 指す先がビルド成果物に本当に有る（リンク切れを防ぐ）。読みやすい版と Markdown 版の両方。
  const builder = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(builder, "ビルドが upcoming.md を出さなくなったらリンクが死ぬ").toContain(
    'write("upcoming.md"',
  );
  expect(builder, "ビルドが upcoming.html を出さなくなったらリンクが死ぬ").toContain(
    'write("upcoming.html"',
  );
});
