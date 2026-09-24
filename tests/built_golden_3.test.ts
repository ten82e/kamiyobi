import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { buildAll } from "../src/build.ts";
import {
  cssBlocks,
  data,
  effectiveCss,
  keydownWithBlockers,
  site,
  siteHtmlRuntime,
  verificationLabelsSource,
} from "./built_golden_shared.ts";
import { makeConference, makeDeadline, makeEdition, NOW, REPO_ROOT, utc } from "./helpers.ts";
import {
  jsFunction,
  liveNoteSource,
  siteRuntime,
  vmSafeSource,
  wholeTableQueryStubs,
} from "./runtime_extract.ts";

it("表に行が出ていても、会期だけ確定の該当件数が件数欄に出る（SPEC §7）", () => {
  /* 「会期だけが確定している会」の存在は、表が 0 件のときの案内にしか出ていなかった。
   * だから表に 1 行でも出た人は「これで全部だ」と受け取る（2026-09-23 実測:
   * 「研究会」は表 16 件に対して会期だけの該当 28 件、「ネットワーク」は 39 件に対し 31 件が
   * 画面に出ていなかった）。件数欄に出す。 */
  const runtime = siteRuntime();
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const DAY = 86400000;",
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    // 時計を止める（この検査機の実際の日付は 2026-09 以降なので、止めないと窓の検査が
    // 実際の日付で走って空振りする – 2026-09-23 に実測）。
    "Date.now = () => now;",
    // 会期だけ確定の回を 3 件（合致 / 過去 / 国内限定で落ちる）。
    "const DATA = { conferences: [",
    "  { key: 'a', title: 'Alpha WS', categories: ['hpc'], tags: [], editions: [",
    "    { event_start: '2026-09-30', event_end: '2026-10-01', place: 'Kyoto, Japan', deadlines: [] }] },",
    "  { key: 'b', title: 'Beta WS', categories: ['hpc'], tags: [], editions: [",
    "    { event_start: '2026-07-01', event_end: '2026-07-02', place: 'Osaka, Japan', deadlines: [] }] },",
    "  { key: 'c', title: 'Gamma WS', categories: ['hpc'], tags: ['domestic-jp'], editions: [",
    "    { event_start: '2026-10-20', event_end: '2026-10-21', place: '松江テルサ（島根県）', deadlines: [] }] },",
    "] };",
    "let searchQuery = '';",
    `${jsFunction(runtime, "windowLimitMs")}`,
    `${jsFunction(runtime, "scheduleOnlyMatches")}`,
    "const all = scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false });",
    "searchQuery = 'Alpha';",
    "const q = scheduleOnlyMatches({ window: 'all', cats: [], domestic: false, online: false });",
    "searchQuery = '';",
    "const domestic = scheduleOnlyMatches({ window: 'all', cats: [], domestic: true, online: false });",
    "const win = scheduleOnlyMatches({ window: '30d', cats: [], domestic: false, online: false });",
    "console.log(JSON.stringify({",
    "  all: all.map((m) => m.name), q: q.map((m) => m.name),",
    "  domestic: domestic.map((m) => m.name), win: win.map((m) => m.name),",
    " }));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    all: string[];
    q: string[];
    domestic: string[];
    win: string[];
  };
  // 過去の回は数えない（表と同じ「これからの会」の目盛り）。
  expect(out.all).toEqual(["Alpha WS", "Gamma WS"]);
  // 検索語でも絞れる（表と同じ目盛りであることの確認）。
  expect(out.q).toEqual(["Alpha WS"]);
  // 国内チェックをかければ国内の会だけになる。
  expect(out.domestic).toEqual(["Gamma WS"]);
  // 「締切まで」の窓も掛かる。
  expect(out.win).toEqual([]);

  // 件数欄への出し方（ビルド後）。表に行が有るときだけ出し、読み上げにも同じ語を流す。
  expect(runtime, "件数欄に会期だけ確定の件数を出していない").toContain(
    "同じ条件で会期だけが確定している会",
  );
  expect(runtime, "0 件のときと二重に出している").toContain(
    "if (shown.length && scheduleOnly.length)",
  );
  expect(runtime, "読み上げに伝えていない").toContain("cntLive += scheduleNote");
});

it("画面に出る曜日が検索の語になり、週末・平日も寄せた先を出す（SPEC §7）", () => {
  /* 一覧の日付欄は JST の曜日を一文字で出しているのに（既定画面 478 行は全て曜日付き）、
   * 「金曜日」で引くと 0 件だった（2026-09-23 実測）。画面に出る語は検索でも引ける、
   * という規則を曜日に適用する。一文字（`土`）は他の語を巻くので入れない。 */
  const rows = Recommender.candidateRows(data);
  const now = Date.UTC(2026, 7, 9);
  const view = rows.filter(
    (r) => (r.kind === "abstract" || r.kind === "paper") && r.t >= now && !r.ed.estimated,
  );
  const hits = (q: string) => {
    const m = Recommender.searchMatcher(q, now);
    return view.filter((r) => m(r.hay)).length;
  };
  const days = ["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"];
  const per = days.map((w) => hits(w));
  days.forEach((w, i) => {
    expect(per[i], `${w} の行が引けない`).toBeGreaterThan(0);
  });
  // 各行は必ずちょうど一日に当たる（合計が行数と一致 = 漏れも重複もない）。
  expect(
    per.reduce((a, b) => a + b, 0),
    "曜日の当たり方が行数と合わない",
  ).toBe(view.length);
  // 週末・平日は寄せた先を件数欄に出す（語を増やしたことを隠さない）。
  expect(hits("週末")).toBe(hits("土曜") + hits("日曜"));
  expect(hits("平日")).toBe(view.length - hits("週末"));
  // 寄せたことを件数欄のおしらせで言う（語を増やしたことを隠さない）。
  expect(Recommender.querySynonymNotes("週末").join("")).toContain("土曜日の行と日曜日の行");
  expect(Recommender.querySynonymNotes("平日").join("")).toContain("月曜日から金曜日の行");
  // 曜日の寄せ先は、分野などを画面に出るラベルへ寄せる表には混ぜていない（別の検査が
  // あの表の展開語を「列にそのまま出るラベル」に限定しているため）。
  const rec = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
  const labelTable = /const QUERY_SYNONYMS_JA[\s\S]*?\n {2}\];/.exec(rec);
  expect(labelTable, "寄せ語の対応表が読めない").not.toBeNull();
  expect(labelTable![0], "曜日の語を分野などの表に混ぜている").not.toContain("週末");
  expect(rec, "曜日の寄せ語の表が無い").toContain("WEEKDAY_QUERY_SYNONYMS_JA");
  // 一文字の語を入れなかった理由（「土木」が曜日で引えるようになってはいけない）。
  expect(hits("土木")).toBe(0);
  // 時刻未確認の行は、表示している暦日（local_date）の曜日で引ける。
  const dateOnly = view.filter((r) => String(r.localDate || "").trim());
  expect(dateOnly.length, "時刻未確認の行が無く検査が空振りする").toBeGreaterThan(0);
  for (const r of dateOnly.slice(0, 40)) {
    const term = Recommender.weekdaySearchTerms(r.localDate).split(" ")[0];
    expect(term, `${String(r.localDate)} の曜日が作れない`).not.toBe("");
    expect(
      Recommender.searchMatcher(term, now)(r.hay),
      `表示の暦日 ${String(r.localDate)} の曜日でその行が引けない`,
    ).toBe(true);
  }
  // 手引きが曜日の引き方を説明している（語の形も実装と同じものを使う）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template, "てびきが曜日の検索を説明していない").toContain("曜日も引けます");
  expect(template).toContain("「週末」（土曜日・日曜日）");
});

it("「視差効果を減らす」設定では動きが消え、開閉自体はそのまま効く（SPEC §7）", () => {
  /* OS の設定で動きを抑えている人。第 110 回で JS のスクロールはこの設定を見たが、
   * CSS の遷移は見ていなかった（2026-09-23 実測: `prefers-reduced-motion` の扱いが
   * スタイル内に 0 箇所で、行の詳細は 0.25 秒で滑り込んでいた）。*/
  const html = siteHtmlRuntime();
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  const blocks = cssBlocks(style);
  const reduced = blocks.filter((b) => /prefers-reduced-motion/.test(b.media || ""));
  expect(reduced.length, "動きを抑える設定の扱いがスタイルに無い").toBeGreaterThan(0);
  const star = reduced.find((b) => b.selector === "*");
  expect(star, "要素全体の動きを止めていない").toBeDefined();
  expect(star!.body, "遷移の長さを短くしていない").toContain("transition-duration: 0.01ms");
  // 待ち受けの安全のため `none` ではなく 0.01ms にする（0 にすると遷移終了が来ない）。
  expect(star!.body).not.toMatch(/transition[^:]*:\s*none/);
  // 解決関数（メディアクエリの条件は幅だけを見る）でも、動きが消えた値になること。
  expect(effectiveCss(style, "*", "transition-duration", 1200)).toContain("0.01ms");
  // 通常時の動きまで潰していたら意味が無い（既定は従来のままだこと）。
  expect(effectiveCss(style, ".drawer", "transition", 1200)).toContain("0.25s");
  expect(effectiveCss(style, ".drawer-backdrop", "transition", 1200)).toContain("0.2s");
  // 開閉はクラスの宣言で決まり、遷移の完了に依存しない（動きを消しても開く・閉じるが
  // そのまま効くことを、宣言そのもので見る）。
  expect(effectiveCss(style, ".drawer-backdrop", "visibility", 1200)).toBe("hidden");
  expect(effectiveCss(style, ".drawer-backdrop.active", "visibility", 1200)).toBe("visible");
  expect(effectiveCss(style, ".drawer", "right", 1200)).toBe("-480px");
  expect(effectiveCss(style, ".drawer-backdrop.active .drawer", "right", 1200)).toBe("0");
  // JS 側（行のスクロール）も同じ設定を見ている – 片方だけ守る形に戻さない。
  expect(siteRuntime()).toContain("prefers-reduced-motion");
});

it("検索欄で Esc を押すと、語を消さずに欄を出て選択行に戻る（SPEC §7）", () => {
  /* `/` で検索欄に飛び、打ち終わって `j` / `k` を打ちたい、というのが実際の動きだった。
   * 入力欄にいる間の `j` / `k` は文字入力になるので、Esc で欄を出る必要がある。
   * Esc 自体は入力欄で効いていたが、フォーカスが body に落ちるだけだった
   * （2026-09-23 実測: 選択行に返していなかった – 行の詳細を閉じるときだけ戻す形）。
   * 支援技術では「どこを読めばいいのか」が分からなくなる。*/
  const html = siteRuntime();
  const keySrc = keydownWithBlockers(html);
  const selectSrc = jsFunction(html, "updateRowSelection");
  const script = [
    "const calls = [];",
    "function row(name) {",
    "  return {",
    "    name,",
    "    classList: { contains: () => false, toggle: (c, on) => calls.push(name + ':' + c + ':' + on) },",
    "    focus() { calls.push('focus:' + name); },",
    "    scrollIntoView() { calls.push('scroll:' + name); },",
    "    setAttribute(k, v) { calls.push(name + ':' + k + '=' + v); },",
    "    removeAttribute(k) { calls.push(name + ':-' + k); },",
    "  };",
    "}",
    "const rows = [row('row0'), row('row1')];",
    // 検索欄（id は q）。フォーカスを戻す対象と区別できるので、blur を数える。
    "const search = { tagName: 'INPUT', blur() { calls.push('blur:q'); }, focus() {} };",
    "const paper = { tagName: 'TEXTAREA', blur() { calls.push('blur:paper'); }, focus() {} };",
    "const els = { q: search, tbody: { querySelectorAll: () => rows } };",
    "const document = { activeElement: null, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { matchMedia: () => ({ matches: false }) };",
    "const shown = [{ key: 'A' }, { key: 'B' }];",
    `const KEY = ${JSON.stringify(keySrc)};`,
    `const SELECT = ${JSON.stringify(selectSrc)};`,
    "const make = (selectedIndex) =>",
    "  new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'updateRowSelection', KEY + ';return onKeydown;')(",
    "    window, document, $, selectedIndex, shown, () => {}, () => {}, updateRowSelection);",
    "const updateRowSelection = new Function('window', 'document', '$', 'selectedIndex', 'return (' + SELECT + ')')(window, document, $, 1);",
    // ① 検索欄で Esc → 欄を出て（blur）、選んでいた行にフォーカスが戻る。
    "calls.length = 0;",
    "make(1)({ key: 'Escape', preventDefault() {}, target: search });",
    "const fromSearch = calls.slice();",
    // ② 他の入力欄（論文の本文など）で Esc → 欄は出るが、表の行に奪わない。
    "calls.length = 0;",
    "make(1)({ key: 'Escape', preventDefault() {}, target: paper });",
    "const fromPaper = calls.slice();",
    // ③ 行を選んでいないとき（まだ 0 件・未選択）は行にフォーカスを移さない。
    "calls.length = 0;",
    "make(-1)({ key: 'Escape', preventDefault() {}, target: search });",
    "const noRow = calls.slice();",
    // ④ そのほかの鍵では何もしない（入力の内容を壊さない）。
    "calls.length = 0;",
    "make(1)({ key: 'x', preventDefault() {}, target: search });",
    "const other = calls.slice();",
    "console.log(JSON.stringify({ fromSearch, fromPaper, noRow, other }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, string[]>;
  expect(out.fromSearch, "検索欄から出られていない").toContain("blur:q");
  expect(out.fromSearch, "選択行にフォーカスが戻っていない").toContain("focus:row1");
  // 検索語を消す実装に戻っていないこと（blur 以外の操作を足していない）。
  expect(out.fromSearch.filter((c) => c.startsWith("blur:"))).toEqual(["blur:q"]);
  // 他の入力欄では表の行を奪わない（論文の本文に打っていて Esc を押した人が、表の行に
  // 飛ばされることがあってはいけない）。
  expect(out.fromPaper).toContain("blur:paper");
  expect(
    out.fromPaper.filter((c) => c.startsWith("focus:")),
    "他の入力欄で Esc を押した人が表の行に飛ばされている",
  ).toEqual([]);
  // 行が未選択のときはフォーカスを移さない（存在しない行を触らない）。
  expect(out.noRow.filter((c) => c.startsWith("focus:"))).toEqual([]);
  // 他の鍵は入力欄では素通り（文字が入るだけ）。
  expect(out.other).toEqual([]);
  // 手引きが二つの導線を説明している（ショートカットの一覧は件数欄にもある）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template, "てびきが / と Esc の導線を説明していない").toContain(
    "<code>/</code> で検索欄に飛び",
  );
  expect(template).toContain("検索語を消さずに欄を出て");
});

it("幅を持つ行の残り・並び・月は、画面に出している暦日で決まる（SPEC §7）", () => {
  /* 時刻未確認の行は `t` が「最も早く締切る瞬間」（UTC+14 の始まり）だった。それを
   * 残り・並び・月の基準に使うと、同じ行の日付欄と食い違う（2026-09-23 実測:
   * 既定画面 478 行で表示暦日が戻る隣接ペア 27 件。CSV の残り列は既定画面の該当 175 行
   * すべてで日付欄より 1 日少ない値。収録全体では 13 行が前の月のグループに落ち、例は
   * 表示 2026-09-01 の行が 2026年8月に入っていた）。画面の「残り」はこれらの行では数値を
   * 出さず「時刻未確認」の語を出すので、画面にずれは出ていなかった。*/
  const recPath = join(site, "recommender.js");
  const dataPath = join(site, "data.json");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${recPath}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const jstDay = (ms) => Math.floor((ms + 9 * 3600000) / DAY);",
    "const jstMonth = (ms) => { const d = new Date(ms + 9 * 3600000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };",
    "const displayDay = (r) => String(r.localDate || '').trim() || new Date(r.t + 9 * 3600000).toISOString().slice(0, 10);",
    "const rows = Recommender.candidateRows(DATA, NOW);",
    "const view = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= NOW && !r.est);",
    "const dateOnly = view.filter((r) => String(r.localDate || '').trim());",
    "const inversions = (list, key) => { const s = [...list].sort((a, b) => key(a) - key(b)); let n = 0; for (let i = 1; i < s.length; i++) if (displayDay(s[i - 1]) > displayDay(s[i])) n++; return n; };",
    // ① 並び: 表示している暦日が戻る場所が無いこと（従来の基準では実在した）。
    "const shownInversions = inversions(view, (r) => r.tShown);",
    "const oldInversions = inversions(view, (r) => r.t);",
    // ② 基準: 時刻未確認の行の `tShown` は日付欄の日そのもの（CSV の残り列はここから数える）。
    "const remainWrong = dateOnly.filter((r) => jstDay(r.tShown) !== jstDay(Date.parse(String(r.localDate) + 'T00:00:00+09:00'))).length;",
    // ③ 月グループ: 表示している暦日の月に入る（従来の基準では前の月に落ちていた）。
    "const monthWrong = rows.filter((r) => String(r.localDate || '').trim() && jstMonth(r.tShown) !== String(r.localDate).slice(0, 7)).length;",
    "const monthWrongOld = rows.filter((r) => String(r.localDate || '').trim() && jstMonth(r.t) !== String(r.localDate).slice(0, 7)).length;",
    // ④ 終了判定の幅はそのまま（幅の最早 < 表示の暦日 < 幅の終り）。
    "const widthOk = dateOnly.every((r) => r.t < r.tShown && r.tShown <= r.tLast);",
    // ⑤ CSV の残り列も同じ基準。
    "const sample = dateOnly[0];",
    "const csv = Recommender.deadlinesToCsv([sample], NOW);",
    "const csvLeft = Number(csv.split('\\n')[1].split(',')[2]);",
    "const csvExpected = jstDay(Date.parse(String(sample.localDate) + 'T00:00:00+09:00')) - jstDay(NOW);",
    "console.log(JSON.stringify({ view: view.length, dateOnly: dateOnly.length, shownInversions, oldInversions, remainWrong, monthWrong, monthWrongOld, widthOk, csvLeft, csvExpected }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, number | boolean>;
  expect(out.view, "既定画面が空").toBeGreaterThan(100);
  expect(out.dateOnly, "時刻未確認の行が無い").toBeGreaterThan(50);
  expect(out.shownInversions, "日時順で表示している暦日が戻る行がある").toBe(0);
  expect(out.oldInversions, "基準を変えても何も変わらないなら検査は無意味").toBeGreaterThan(0);
  expect(out.remainWrong, "残りの基準が日付欄と違う時刻未確認の行がある").toBe(0);
  expect(out.monthWrong, "月グループが日付欄と違う月に入る行がある").toBe(0);
  expect(out.monthWrongOld, "従来の基準でも月は狂っていなかったはず").toBeGreaterThan(0);
  expect(out.widthOk, "幅の両端が壊れている").toBe(true);
  expect(out.csvLeft, "CSV の残り列が日付欄から数えた日数と違う").toBe(out.csvExpected);
});

it("並びの比較は表示している暦日を使い、その値を持たない行も落とさない（SPEC §7）", () => {
  const app = siteRuntime();
  const cmpSrc = jsFunction(app, "compareDeadlineRows");
  const monthSrc = jsFunction(app, "monthKey");
  const remainSrc = jsFunction(app, "remain");
  const script = [
    "const DAY = 86400000;",
    "const name = (r) => r.name;",
    "const kindIndex = (k) => (k === 'abstract' ? 0 : k === 'paper' ? 1 : 2);",
    `const CMP = ${JSON.stringify(cmpSrc)};`,
    `const MONTH = ${JSON.stringify(monthSrc)};`,
    `const REMAIN = ${JSON.stringify(remainSrc)};`,
    "const cmp = new Function('conferenceNameCell', 'kindSortIndex', 'return (' + CMP + ')')(name, kindIndex);",
    "const pad = (n) => String(n).padStart(2, '0');",
    "const monthKey = new Function('pad', 'return (' + MONTH + ')')(pad);",
    "const now = Date.UTC(2026, 7, 9);",
    "const DateNow = now;",
    "const remain = new Function('DAY', 'Date', 'return (' + REMAIN + ')')(DAY, { now: () => DateNow });",
    // 表示 8月14日 23:00 JST（確定）と、表示 8月15日（時刻未確認・幅の最早は 8月14日 19:00 JST）。
    "const sure = { name: 'A', kind: 'paper', t: Date.UTC(2026, 7, 14, 14, 0), tShown: Date.UTC(2026, 7, 14, 14, 0), tLast: Date.UTC(2026, 7, 14, 14, 0) };",
    "const wide = { name: 'B', kind: 'paper', t: Date.UTC(2026, 7, 14, 10, 0), tShown: Date.UTC(2026, 7, 15, 3, 0), tLast: Date.UTC(2026, 7, 15, 15, 0), localDate: '2026-08-15' };",
    // 従来の基準（t）なら B が先だったが、表示している暦日では A が先。
    "const oldOrder = wide.t < sure.t;",
    "const shownOrder = cmp(sure, wide) < 0;",
    // 降順でも逆向きになる（塊の反転を再現しない）。
    "const descOrder = cmp(sure, wide, -1) > 0;",
    // tShown を持たない行（古い呼び出し側・検査が組んだ行）は t で並ぶ。末尾には落ちない。
    "const legacy = { name: 'C', kind: 'paper', t: Date.UTC(2026, 7, 20), tLast: Date.UTC(2026, 7, 20) };",
    "const legacyFirst = cmp(legacy, sure) > 0;",
    "const legacyVsTail = cmp(legacy, { name: 'D', kind: 'paper', t: Number.NaN, tLast: Number.NaN }) < 0;",
    // 月も表示している暦日。幅の最早が前の月でも、表示の月に入る。
    "const monthWide = { name: 'E', kind: 'paper', t: Date.UTC(2026, 8, 30, 10, 0), tShown: Date.UTC(2026, 9, 1, 3, 0), tLast: Date.UTC(2026, 9, 1, 15, 0), localDate: '2026-10-01' };",
    "const month = monthKey(monthWide);",
    "const monthFromT = new Date(monthWide.t + 9 * 3600000).getUTCMonth();",
    "const monthJournal = monthKey({ kind: 'journal', name: 'J', t: now, tShown: now, tLast: now });",
    // 残りは tShown から。持たない行は t から数え、NaN を画面に出さない。
    "const remainWide = remain(wide.tShown).text;",
    "const remainLegacy = remain(legacy.t).text;",
    "const remainNoNaN = remain(Number.NaN).text.indexOf('NaN') < 0;",
    "console.log(JSON.stringify({ oldOrder, shownOrder, descOrder, legacyFirst, legacyVsTail, month, monthFromT, monthJournal, remainWide, remainLegacy, remainNoNaN }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, unknown>;
  expect(out.oldOrder, "前提が崩れた（従来の基準なら B が先では無い）").toBe(true);
  expect(out.shownOrder, "表示している暦日で並んでいない").toBe(true);
  expect(out.descOrder, "降順で逆向きになっていない").toBe(true);
  expect(out.legacyFirst, "tShown の無い行を末尾に落としている").toBe(true);
  expect(out.legacyVsTail, "tShown の無い行と時刻不明の行の前後が壊れている").toBe(true);
  expect(out.month, "月グループが表示の暦日から決まっていない").toBe("2026-10");
  expect(out.monthFromT, "従来の基準でも 10 月なら検査は無意味").toBe(8);
  expect(out.monthJournal, "常時受付が月グループに入っている").toBe("");
  expect(out.remainWide, "残りが表示している暦日から数えていない").toBe("あと 6 日");
  expect(out.remainLegacy).toBe("あと 11 日");
  expect(out.remainNoNaN, "残りに NaN が出ている").toBe(true);
});

it("印刷物に、条件・並び順・件数・日時が残り、画面では見えない（SPEC §7）", () => {
  /* 印刷は「研究室に貼る・グループ会議で回覧する」用途（スタイルのコメントに書いた需要）。
   * ところが画面の絞り込み欄は印刷で落ちるため、紙のうえに「どんな条件で絞った一覧か」が
   * 残っていなかった（2026-09-23 実測: 印刷時に条件を書く箇所はどこにも無い。データ生成日
   * だけがヘッダーに残る）。受け取った人は収録全体の一覧と取り違える。*/
  const app = siteRuntime();
  const describeSrc = jsFunction(app, "describeFilters");
  const script = [
    `const DESCRIBE_SRC = ${JSON.stringify(describeSrc)};`,
    "const DESCRIBE = new Function('return (' + DESCRIBE_SRC + ')')();",
    "const kind = (k) => ({ abstract: '概要締切', paper: '論文締切' })[k] || k;",
    "const cat = (c) => ({ net: 'ネットワーク', hpc: '高性能計算' })[c] || c;",
    "const sl = (k) => ({ rem: '残り', date: '日時（JST）', event: '会期', conf: '会議', rank: 'ランク' })[k] || '';",
    "const f = (over, win, sort) =>",
    "  DESCRIBE(",
    "    Object.assign(",
    "      { q: '', cats: [], kind: '', rank: '', est: false, domestic: false, online: false, past: false },",
    "      over,",
    "    ),",
    "    kind,",
    "    (g) => (g === 'N' ? '評価なし' : g),",
    "    cat,",
    "    win || '',",
    "    sort || { key: 'rem', asc: true },",
    "    sl,",
    "  );",
    "const nothing = f({});",
    // 空白だけの検索語は条件にしない（打つ途中の欄で「検索語「」」と出さない）。
    "const blank = f({ q: '   ' });",
    "const many = f({ q: '研究会', kind: 'paper', cats: ['net', 'hpc'], domestic: true, online: true, past: true, est: true }, '30日以内');",
    // ランクは画面に出る等級そのものを書く（内部の番兵を書かない）。
    "const ranked = f({ rank: 'A*' });",
    // 「評価なし」を選ぶと紙に「ランク: N」と出ていた（選択欄は日本語に出すと同じ語にする）。
    "const unrated = f({ rank: 'N' });",
    // 並び順は絞り込みではないが、紙には要る（並べ替えて配ることもある）。
    "const byEvent = f({ q: '研究会' }, '', { key: 'event', asc: true });",
    "const byDateDesc = f({}, '', { key: 'date', asc: false });",
    // 既定の並びでも書く（「締切の新しい順で印刷した」が分からないと読み手が困る）。
    "const byDefault = f({}, '', { key: 'rem', asc: true });",
    // 見出しに見当たらない鍵のときは並び順を書かない（噓を書かない）。
    "const unknownKey = f({}, '', { key: 'nope', asc: true });",
    "console.log(JSON.stringify({ nothing, blank, many, ranked, unrated, byEvent, byDateDesc, byDefault, unknownKey }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, string>;
  expect(out.nothing, "何も絞っていないときの書き方が無い").toContain("絞り込みなし");
  expect(out.blank, "空の検索語を条件にしている").toBe(out.nothing);
  expect(out.many).toContain("検索語「研究会」");
  expect(out.many).toContain("種別: 論文締切");
  expect(out.many).toContain("分野: ネットワーク・高性能計算");
  expect(out.many).toContain("締切まで: 30日以内");
  expect(out.many).toContain("推定締切を含める");
  expect(out.many).toContain("国内研究会・国内シンポジウムのみ");
  expect(out.many).toContain("オンライン参加可のみ");
  expect(out.many).toContain("過去の締切も表示");
  expect(out.ranked).toContain("ランク: A*");
  // 「評価なし」は選択欄と同じ語で紙に書く。N はデータ内部の番兵で、紙で意味が読めない。
  expect(out.unrated, "条件の書き下ろしが評価なしを日本語で出さない").toContain("ランク: 評価なし");
  expect(out.unrated, "条件の書き下ろしが内部の番兵 N を書いている").not.toMatch(/ランク: N(\D|$)/);
  // 並び順（第 126 回で会期順が増えたので、紙で区別できる必要がある）。
  expect(out.byEvent).toContain("検索語「研究会」");
  expect(out.byEvent).toContain("並び順: 会期 昇順");
  expect(out.byDateDesc).toContain("並び順: 日時（JST） 降順");
  expect(out.byDefault, "既定の並びが紙に残っていない").toContain("並び順: 残り 昇順");
  expect(out.byDefault).toContain("絞り込みなし");
  // 見出しに見当たらない鍵のときは並び順を書かない（噓の列名を紙に残さない）。
  expect(out.unknownKey, "画面に無い列名を並び順として書いた").toBe(
    "絞り込みなし（収録全体の一覧）",
  );
  expect(out.unknownKey).not.toContain("並び順");
  // 画面のチェック欄・セレクトと同じ語を書いている（別の名前を付けない）。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  for (const label of [
    "推定締切を含める",
    "過去の締切も表示",
    "国内研究会・国内シンポジウムのみ",
    "オンライン参加可のみ",
  ]) {
    expect(template, `画面に出ている条件の語がない: ${label}`).toContain(label);
  }

  // 紙にのこる見出し: 画面では `display: none`（支援技術からもタブ順序からも消す）、
  // 印刷のときだけ出る。幅解決の補助関数は print を見ないので、節を直接読む。
  const html = siteHtmlRuntime();
  const style = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  expect(effectiveCss(style, ".print-meta", "display", 1200)).toBe("none");
  const blocks = cssBlocks(style);
  const printed = blocks.filter((b) => b.selector === ".print-meta" && /print/.test(b.media || ""));
  expect(printed.length, "印刷のときに出る規則が無い").toBeGreaterThan(0);
  expect(printed[0].body, "印刷のときに block になっていない").toContain("display: block");
  // 表の直前にあること（印刷で表より後ろに落ちると「誰の一覧か」分からない）。
  expect(
    template.indexOf('id="printMeta"') < template.indexOf('id="deadlineTableWrap"'),
    "見出しが表より後ろにある",
  ).toBe(true);
  // 印刷の前に入れて、後で消す（画面の DOM に古い条件を残さない）。
  expect(app).toContain("beforeprint");
  expect(app).toContain("fillPrintMeta();");
  expect(app).toContain('$("printMeta")');
  // 呼び出し側が、今の並びを実際に渡していること（上の抜き出し検査だけでは実画面は変わらない）。
  expect(app).toContain("{ key: sortKey, asc: sortAsc },");
  // 列名を取り出す関数も印刷の組み立てに使っている（見出しの語を二箇所に書かない）。
  expect(app).toContain("sortColumnLabel");
  const labelSrc = jsFunction(app, "sortColumnLabel");
  // 列名は画面の見出しから取る（書き写さない）。見出しは目印の矢印まで書き換えるので、
  // そこを落として紙に出せる語だけを取り出すことを、見出しの実物に近い形で確認する。
  const labelProc = spawnSync(
    "node",
    [
      "-e",
      vmSafeSource(
        [
          `const SRC = ${JSON.stringify(labelSrc)};`,
          // 見出しの実物は「会期 ↕」のように語と目印が一体になっている。
          "const run = (text, key) => {",
          "  const doc = {",
          "    querySelector: (sel) => (sel.indexOf(key) >= 0 ? { textContent: text } : null),",
          "  };",
          "  return new Function('document', 'return (' + SRC + ')')(doc)(key);",
          "};",
          "console.log(JSON.stringify([",
          "  run('会期 ↕', 'event'),",
          "  run('日時（JST） ↓', 'date'),",
          "  run('残り ↑', 'rem'),",
          "  run('', 'conf'),",
          "]));",
        ].join("\n"),
      ),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(labelProc.status, labelProc.stderr).toBe(0);
  const labels = JSON.parse(labelProc.stdout) as string[];
  // 見出しの語だけを取り、目印の矢印は紙に書かない（空の見出しは空のまま）。
  expect(labels).toEqual(["会期", "日時（JST）", "残り", ""]);
  expect(app, "印刷した日時を残していない").toContain("印刷した日時");
  expect(app, "データ生成日時を残していない").toContain("generatedAtLabel(genAt)");
  // てびきが印刷の説明を持っている（押せる場所が無いと分からない）。
  expect(template).toContain("<dt>印刷</dt>");
});

it("選んだ行は支援技術にも伝わる（視覚の目印だけで状態を出さない・SPEC §7）", () => {
  /* 選んだ行は `selected` クラスの切り替えだけを変えていた（2026-09-23 実測: ビルド
   * 成果物に `aria-current`・`aria-selected` は 1 箇所も無い）。クラスは色と枠でしか
   * 伝わらないので、キーボードで何行目を選んでいるかが支援技術に読めない。*/
  const app = siteRuntime();
  const selectSrc = jsFunction(app, "updateRowSelection");
  const script = [
    "function mk(name, cls) {",
    "  return {",
    "    name,",
    "    attrs: {},",
    "    classes: cls.slice(),",
    "    classList: {",
    "      contains: (c) => cls.indexOf(c) >= 0,",
    "      toggle: (c, on) => {",
    "        const at = cls.indexOf(c);",
    "        if (on && at < 0) cls.push(c);",
    "        if (!on && at >= 0) cls.splice(at, 1);",
    "      },",
    "    },",
    "    setAttribute(k, v) { this.attrs[k] = String(v); },",
    "    removeAttribute(k) { delete this.attrs[k]; },",
    "    focus() {},",
    "    scrollIntoView() {},",
    "  };",
    "}",
    "const rows = [mk('r0', ['row']), mk('detail', ['detail-row']), mk('r1', ['row']), mk('r2', ['row'])];",
    "const document = { getElementById: (id) => (id === 'tbody' ? tbody : null) };",
    "const tbody = { querySelectorAll: () => rows };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { matchMedia: () => ({ matches: true }) };",
    `const SELECT = ${JSON.stringify(selectSrc)};`,
    "const run = (index) => {",
    "  const fn = new Function('window', 'document', '$', 'selectedIndex', 'return (' + SELECT + ')')(window, document, $, index);",
    "  fn();",
    "  return rows.filter((r) => r.attrs['aria-current']).map((r) => r.name + '=' + r.attrs['aria-current']);",
    "};",
    "const one = run(1);",
    "const clsAfterOne = rows.map((r) => r.name + ':' + (r.classList.contains('selected') ? 1 : 0)).join(' ');",
    // クラスの付き方はこの時点で写す（後に選び直すと消える）。
    "const moved = run(2);",
    "const none = run(-1);",
    "const cls = clsAfterOne;",
    "console.log(JSON.stringify({ one, moved, none, cls }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    one: string[];
    moved: string[];
    none: string[];
    cls: string;
  };
  // 選んだ行だけが行番号を宣言する（クラスと同じ一行）。
  expect(out.one, "選んだ行が支援技術に分かる属性を持っていない").toEqual(["r1=row"]);
  // 選び直したら前の行の宣言は消える（二行が「今選んでいる行」になる形を許さない）。
  expect(out.moved, "選び直したあと前の行が宣言を残している").toEqual(["r2=row"]);
  // 未選択（再描画直後）は宣言が残らない。
  expect(out.none, "未選択なのに宣言が残っている").toEqual([]);
  // 展開行・月見出し行は対応表から除外されている（属性も付けない）。
  // 展開行（detail）は対応表から除外されているので、選んでもいないのに印を付けられない。
  expect(out.cls).toBe("r0:0 detail:0 r1:1 r2:0");
  // 実物のビルド成果物にも属性の操作が入っていること（上の抜き出しが空振りでないこと）。
  expect(app).toContain('setAttribute("aria-current", "row")');
  expect(app).toContain('removeAttribute("aria-current")');
});

it("常時受付ジャーナルに当たる語を、読み上げが「収録データにありません」と言わない（SPEC §7）", () => {
  /* 語の数え上げ（`queryTermCounts`）は表の行だけを見ていて、常時受付のジャーナルを
   * 読まない。`常時受付` は表 0 件・ジャーナル 22 件なのに、読み上げは
   * 「語「常時受付」は収録データにありません」と言っていた（2026-08-09 生成ビルドで実測）。
   * 同じ画面の案内は「収録済みの行 22 件に当たります（いずれも常時受付のジャーナルで…）」と
   * 出していて、目の字と読み上げが逆のことを並べていた。てびきは「種別の選択欄に並ぶのは、
   * 選べば結果が返る種別（概要・論文・常時受付）だけ」と先に書いているので、噓は読み上げ側。 */
  const app = siteRuntime("app.js");
  const rec = siteRuntime("recommender.js");
  const real = JSON.parse(readFileSync(join(site, "data.json"), "utf8")) as {
    conferences: unknown;
  };
  const tableRows = Recommender.candidateRows(real) as Array<{ hay: string }>;
  const journals = Recommender.journalRows(
    real.conferences,
    Date.parse("2026-08-09T00:00:00Z"),
  ) as Array<{ hay: string }>;
  const matcher = Recommender.searchMatcher("常時受付");
  const tableHits = tableRows.filter((row) => matcher(String(row.hay))).length;
  const journalHits = journals.filter((row) => matcher(String(row.hay))).length;
  expect(tableHits, "表にも常時受付の語が出るようになった（検査の前提が変わった）").toBe(0);
  expect(journalHits, "ジャーナルの行が読めない（検査が空振り）").toBeGreaterThan(0);

  const live = new Function(
    "Recommender",
    `${jsFunction(app, "countJa")};\nreturn (${liveNoteSource(app)});`,
  )(Recommender) as (f: object) => string;
  const hint = new Function(
    "Recommender",
    `${(rec.match(/const KIND_ALL_LABEL_JA = [^\n]*;/) || app.match(/const KIND_ALL_LABEL_JA = [^\n]*;/) || ['""'])[0]}
     ${jsFunction(app, "countJa")};
     return (${jsFunction(app, "emptyDeadlineHint")});`,
  )(Recommender) as (f: object) => string;
  const base = {
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "",
    hidden: {},
    hiddenKindWords: [],
    urlQuery: false,
    query: "常時受付",
    termCounts: [{ term: "常時受付", count: 0 }],
    catalogConferences: tableRows.length,
    clearable: true,
    pastShown: false,
  };
  const journalMatch = { queryMatch: { catalog: 0, journal: journalHits } };

  const spoken = live({ ...base, ...journalMatch });
  expect(spoken, "表に出ない語を『収録データにありません』と言った").not.toContain(
    "収録データにありません",
  );
  expect(spoken, "当たっている側の話をしている").toContain("当たります");
  expect(spoken, "ジャーナルの件数を出していない").toContain("常時受付ジャーナル");
  expect(spoken).toContain(`${journalHits} 件`);
  // 出しかたまで読む（「いまの条件では 0 件です」で止めると、ここで読む人はやめる）。
  expect(spoken, "外し方を出していない").toContain("種別");
  /* 同じ 0 件画面の案内と読み上げが、同じ方向を向いていること（数字の内訳まで
   * 同じであることは別の検査で既にしているので、ここでは噓の矛盾だけを見る）。 */
  const shown = hint({ ...base, ...journalMatch });
  expect(shown, "画面の案内がジャーナルを言っていない").toContain("ジャーナル");
  expect(shown).toContain("当たります");

  // 収録のどこにも当たらないときは、従来どおり語を名指す（外すと何が変わるか伝えるため）。
  const nowhere = live({ ...base, queryMatch: { catalog: 0, journal: 0 } });
  expect(nowhere, "当たらない語を名指さなくなった").toContain("収録データにありません");
  expect(nowhere).toContain("常時受付");

  // 表に当たりがある語も、従来どおり「いまの条件では 0 件」側の話を続ける。
  const catalogHit = live({
    ...base,
    query: "〆切",
    termCounts: [{ term: "〆切", count: 4 }],
    queryMatch: { catalog: 4, journal: 0 },
  });
  expect(catalogHit, "表に当たりがある語の話が変わった").toContain(
    "収録で 4 件に当たりますが、いまの条件では 0 件です",
  );
  const gpu = live({
    ...base,
    query: "ネットワーク GPU",
    termCounts: [
      { term: "ネットワーク", count: 39 },
      { term: "gpu", count: 0 },
    ],
    queryMatch: { catalog: 0, journal: 0 },
  });
  expect(gpu, "収録に無い語を名指さなくなった").toContain("語「gpu」");
  expect(gpu).toContain("収録データにありません");
});

it("「締め切り」のように表その物を指す語を打った人に、0 件の理由と打ち直し方を出す（SPEC §7）", () => {
  /* この表は締切を並べた物なので「締め切り」は全行に当てはまるが、欄の文字列には
   * 現れない（種別の欄に出る語は「論文締切」などで違う）。直し前は 0 件画面が
   * 「該当する締切はありません。多いのは 検索語を短くする」とだけ出し、読み上げも
   * 「語がありません」と言っていた（2026-08-09 生成ビルドで実測 – 収録 863 行）。
   * この表に締切が無いように読めるので、その場で理由と打ち直し方を書く（第 239 回）。 */
  const app = siteRuntime("app.js");
  const rec = siteRuntime("recommender.js");
  const real = JSON.parse(readFileSync(join(site, "data.json"), "utf8")) as Parameters<
    typeof Recommender.candidateRows
  >[0];
  const rows = Recommender.candidateRows(real) as Array<{ hay: string }>;
  expect(rows.length, "ビルド成果物の行が読めない（検査が空振り）").toBeGreaterThan(100);

  const words = ["締め切り", "締切り", "しめきり", "締切日", "提出期限"];
  words.forEach((word) => {
    const matches = Recommender.searchMatcher(word);
    const hits = rows.filter((row) => matches(String(row.hay))).length;
    expect(hits, `${word} が当たるようになった（この検査の前提が変わった）`).toBe(0);
    expect(Recommender.wholeTableQueryWordJa(word), `${word} を表その物の語としていない`).toBe(
      word,
    );
  });
  /* 絞り込みとして効く語、他の語を足した打ち方には立てない。`〆切` は収録の 4 行に
   * 本当に当たるので、「絞れません」と言うのは噓になる（実測）。 */
  ["論文締切", "セキュリティ", "〆切", "締切", "締め切り 関西", ""].forEach((word) => {
    expect(Recommender.wholeTableQueryWordJa(word), `${word} に立ててしまった`).toBe("");
  });

  // 画面の 0 件案内と読み上げは、ビルド成果物の関数をそのまま動かす（正本を注入する）。
  const stubs = [
    (app.match(/const KIND_ALL_LABEL_JA = [^\n]*;/) || ['""'])[0],
    jsFunction(app, "countJa"),
    wholeTableQueryStubs(rec),
    "const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
  ].join("\n");
  const hint = new Function(`${stubs}\nreturn (${jsFunction(app, "emptyDeadlineHint")});`)() as (
    f: object,
  ) => string;
  const live = new Function(`${stubs}\nreturn (${liveNoteSource(app)});`)() as (
    f: object,
  ) => string;
  const base = {
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "",
    // 「外せる条件」が 1 つある画面（原因が分かっているときに余計な助言を出さないことを
    // 見るには、助言が出る側の形で使う必要がある）。
    hidden: { past: 5 },
    hiddenKindWords: [],
    urlQuery: false,
    termCounts: [],
    catalogConferences: rows.length,
    queryMatch: { catalog: 0, journal: 0 },
    clearable: true,
    pastShown: false,
  };

  const shown = hint({ ...base, query: "締め切り" });
  expect(shown, "0 件になる理由を書いていない").toContain("全行にあてはまる語");
  expect(shown).toContain("検索では絞り込めません");
  expect(shown, "打ち直しの例を書いていない").toContain("会議名");
  expect(shown, "原因が分かっているのに『検索語を短くする』を出した").not.toContain(
    "検索語を短くする",
  );

  const spoken = live({ ...base, query: "締め切り" });
  expect(spoken, "読み上げに理由を出していない").toContain("検索では絞れません");
  expect(spoken.length, `読み上げが長い（${spoken.length} 字）`).toBeLessThan(90);
  expect(
    spoken.length,
    `読み上げが画面の文より長い（読み上げ ${spoken.length} 字 / 画面 ${shown.length} 字）`,
  ).toBeLessThan(shown.length);

  // 当たり数が 0 のときだけ立てる（当たっているときに「絞れません」と言うのは噓）。
  const withHits = { query: "セキュリティ", queryMatch: { catalog: 149, journal: 0 } };
  expect(hint({ ...base, ...withHits })).not.toContain("全行にあてはまる語");
  expect(live({ ...base, ...withHits })).not.toContain("検索では絞れません");

  // 数値だけの打ち直し方は、他の欄と同じ「締切日」で書く（崩れた語を残さない）。
  const narrow = Recommender.queryNarrowHintJa("25");
  expect(narrow).toContain("締切日");
  expect(narrow, "崩れた語が残っている").not.toContain("締め切日");

  // てびきも同じ説明を書く（画面の外でも同じ話をさせる）。
  expect(siteHtmlRuntime(), "てびきにこの話を書いていない").toContain("この表その物を指す語");
});

it("締切のデータが無い画面は、それを条件の話より先に言う（SPEC §7）", () => {
  /* データが差し込まれていない HTML を開いたとき、画面は「該当する締切はありません。
   * 条件を緩めると出ます」と言っていた（2026-09-23 実測）。緩めても何も出ないので、
   * 的外れの案内になる。ヘッダーの「データ生成」も、値が欠けていると語だけ残る
   * （空文字 → 「データ生成: 」、`undefined` → その英字、`null` → 1970-01-01）。
   * 締切のサイトで間違った日付を「データ生成」として見せるのが最悪だった。*/
  const app = siteRuntime();
  const script = [
    `const LABEL_SRC = ${JSON.stringify(jsFunction(app, "generatedAtLabel"))};`,
    `const HINT_SRC = ${JSON.stringify(jsFunction(app, "emptyDeadlineHint"))};`,
    `const LIVE_SRC = ${JSON.stringify(liveNoteSource(app))};`,
    // fmtJst はビルド成果物から取る（表示形式をここにもう一度書かない）。
    `const FMT_SRC = ${JSON.stringify(jsFunction(app, "fmtJst"))};`,
    "const fmtJst = new Function(",
    "  'WEEKDAY_JA',",
    "  'pad',",
    "  'return (' + FMT_SRC + ')'",
    ")(['日','月','火','水','木','金','土'], (n) => String(n).padStart(2, '0'));",
    "const generatedAtLabel = new Function('fmtJst', 'UNCONFIRMED_JA', 'return (' + LABEL_SRC + ')')(fmtJst, '未確認');",
    wholeTableQueryStubs(siteRuntime("recommender.js")),
    "const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
    "const hint = new Function('Recommender', 'return (' + HINT_SRC + ')')(Recommender);",
    "const live = new Function('Recommender', 'return (' + LIVE_SRC + ')')(Recommender);",
    "const empty = {",
    "  window: 'all', past: false, cats: 0, domestic: false, online: false, rank: '',",
    "  kind: '', query: '', hiddenKindWords: [], queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [], catalogConferences: 0,",
    "};",
    "const labels = ['', undefined, null, 'junk'].map((v) => generatedAtLabel(v));",
    "const goodLabel = generatedAtLabel('2026-08-09T00:00:00Z');",
    "const noData = hint(empty);",
    "const noDataLive = live(empty);",
    // 同じ画面でデータが入っていれば、従来どおり条件の話をする（空振りでないこと）。
    "const withData = hint(",
    "  Object.assign({}, empty, {",
    "    catalogConferences: 12,",
    "    query: '人工知能 gpu',",
    "    // 語を並べて打った形（原因の語を名指す案内は二語以上のときに出る）。",
    "    termCounts: [{ term: '人工知能', count: 12 }, { term: 'gpu', count: 0 }],",
    "    queryMatch: { catalog: 0, journal: 0 },",
    "  }),",
    ");",
    "const withDataLive = live(Object.assign({}, empty, { catalogConferences: 12, termCounts: [{ term: 'gpu', count: 0 }] }));",
    "console.log(JSON.stringify({ labels, goodLabel, noData, noDataLive, withData, withDataLive }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    labels: string[];
    goodLabel: string;
    noData: string;
    noDataLive: string;
    withData: string;
    withDataLive: string;
  };
  // 値が欠けている三类（空欄・`undefined`・`null`）で、語だけの空欄・英字・1970 年を
  // 画面に出さない。
  for (const label of out.labels.slice(0, 3)) {
    expect(label, "データ生成の表示に値の欠け方が漏れている").toBe("データ生成: 未確認");
  }
  // 読めるのに日付ではない値（運営が置く「未取得」などの印字）はそのまま出す –
  // 「未確認」に潰すと、運営側の切り分けができなくなる（別の検査が実物を見ている）。
  expect(out.labels[3], "日付として読めない印字を潰している").toBe("データ生成: junk");
  expect(out.goodLabel).toContain("2026-08-09");
  expect(out.goodLabel).not.toContain("undefined");
  // データが無いときは、条件を緩める案内を出さない。
  expect(out.noData).toContain("締切のデータが入っていません");
  expect(out.noData).not.toContain("条件を緩める");
  expect(out.noData).not.toContain("外せる条件");
  expect(out.noData).not.toContain("外せる条件");
  expect(out.noDataLive, "読み上げがデータが無いことを言っていない").toContain(
    "データが入っていません",
  );
  // データが入っているときは従来の案内が生きている。
  expect(out.withData).toContain("該当する締切はありません");
  expect(out.withData).toContain("gpu");
  expect(out.withDataLive).toContain("gpu");
  // 呼び出し側が収録件数を通していること（上だけ見ていても実画面は変わらない）。
  expect(app).toContain("catalogConferences: DATA.conferences.length");
});

it("意味検索が使えない理由は、画面では日本語で出る（英字の符号を混ぜない・SPEC §7）", () => {
  /* 件数の欄に出す「意味検索は利用不可（語彙検索のみ・原因: …）」に、失敗の識別子を
   * そのまま挟んでいた（2026-09-23 実測: 「原因: embeddings unavailable」「原因:
   * model load failed」…）。識別子は #711（8 通りの失敗が 1 文言に潰れて原因追跡不能に
   * なった）で入れたもので、捨てると調査に戻れない。画面は日本語、識別子は属性で残す。*/
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(
      `file://${join(site, "recommender.js")}`,
    )});`,
    "const labels = Recommender.semanticReasonLabelsJa;",
    "const codes = Object.keys(labels);",
    "const ascii = codes.filter((c) => /[A-Za-z]/.test(labels[c]));",
    "const shown = codes.map((c) => Recommender.semanticReasonJa(c));",
    "const other = Recommender.semanticReasonJa('some free text from upstream');",
    "const passthrough = Recommender.semanticReasonJa('モデルの読み込みに失敗しました（詳しい注記）');",
    "const blank = [undefined, null, '   '].map((v) => Recommender.semanticReasonJa(v));",
    "console.log(JSON.stringify({ codes: codes.length, ascii, shown, other, passthrough, blank, labels }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    codes: number;
    ascii: string[];
    shown: string[];
    other: string;
    passthrough: string;
    blank: string[];
    labels: { [code: string]: string };
  };
  // ラベルは全部日本語（英字の符号が混じると、それ自体が読めない語になる）。
  expect(out.ascii, "日本語の理由に英字が残っている").toEqual([]);
  expect(out.codes).toBeGreaterThan(10);
  expect(out.shown.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  // 未知の値（上流が返す自由文）は「その他の問題」に寄せる。ただし日本語で書かれた
  // 説明を英語扱いで潰さない。
  expect(out.other).toBe("その他の問題");
  expect(out.passthrough).toContain("モデルの読み込みに失敗しました");
  // 値が欠けているときは「特定できなかった」と言う（空欄を出さない）。
  for (const label of out.blank) expect(label).toBe("原因を特定できませんでした");

  // 画面の文に識別子を混ぜないこと、識別子は属性で残すこと（原因追跡の要件）。
  expect(app).not.toContain("原因: ${semanticReason");
  expect(app).toContain("Recommender.semanticReasonJa(");
  expect(app).toContain('setAttribute("data-semantic-reason"');
  expect(app).toContain('removeAttribute("data-semantic-reason")');
  // 識別子を打ち忘れた符号が出ないか、ビルド成果物側も照合する（上のラベル表は人が
  // 写した表なので、実装が新しい符号を足したときにここで気づく）。
  const built = [
    { name: "app.js", text: app },
    { name: "publish.js", text: siteRuntime("publish.js") },
  ];
  const missing: string[] = [];
  for (const item of built) {
    const pattern = /(?:semanticReason|reason)\s*[:=]\s*"([^"]+)"/g;
    for (const match of item.text.matchAll(pattern)) {
      const code = match[1];
      if (/[\u3041-\u309f\u30a1-\u30ff\u4e00-\u9fff]/.test(code)) continue; // 日本語の注記はそのまま通す
      if (!Object.hasOwn(out.labels, code)) missing.push(`${code} (${item.name})`);
    }
  }
  expect(missing, "ラベルの無い失敗の識別子がある").toEqual([]);

  // 画面に出る語をてびきが説明していること。
  const guide = readFileSync(join(site, "index.html"), "utf8");
  expect(guide).toContain("意味検索が使えないとき");
  expect(guide).toContain("意味検索は利用不可");
});

it("会期でも並び替えられる（出張の計画は「いつ開かれるか」で見ることが多い・SPEC §7）", () => {
  /* 並び替えられたのは 残り・日時・会議・ランク の 4 列だけで、表示している「会期」の列は
   * 押せなかった（2026-09-23 実測: `SORTABLE_KEYS = ["rem", "date", "conf", "rank"]`）。
   * 出張の計画は「いつ開かれるか」順で見ることが多く、締切順では会期が飛び飛びになる
   * （既定画面 478 行を締切順で見たまま会期の昇順を数えると 707 箇所の逆転）。*/
  const app = siteRuntime();
  const cmp = jsFunction(app, "compareEventRows");
  const due = jsFunction(app, "dueShown");
  const group = jsFunction(app, "shouldGroupMonths");
  const script = [
    `const DUE_SRC = ${JSON.stringify(due)};`,
    `const CMP_SRC = ${JSON.stringify(cmp)};`,
    `const GROUP_SRC = ${JSON.stringify(group)};`,
    "const dueShown = new Function('return (' + DUE_SRC + ')')();",
    "const cmp = new Function('dueShown', 'return (' + CMP_SRC + ')')(dueShown);",
    "const groups = new Function('return (' + GROUP_SRC + ')')();",
    "const row = (name, event, due) => ({",
    "  title: name, tEvent: event ? Date.parse(event + 'T00:00:00Z') + 3 * 3600000 : Number.NaN,",
    "  t: due ? Date.parse(due + 'T15:00:00Z') : Number.NaN, tShown: due ? Date.parse(due + 'T15:00:00Z') : Number.NaN,",
    "});",
    "const rows = [row('a', '2026-10-01', '2026-05-01'), row('b', '2026-09-01', '2026-06-01'), row('c', '', '2026-04-01')];",
    "const asc = rows.slice().sort((x, y) => cmp(x, y, 1)).map((r) => r.title).join('');",
    "const desc = rows.slice().sort((x, y) => cmp(x, y, -1)).map((r) => r.title).join('');",
    // 会期が同じ行は締切の近い順に揃う（同日に複数開く研究会で並びが揺れない）。
    "const tied = [row('x', '2026-09-01', '2026-07-01'), row('y', '2026-09-01', '2026-03-01')]",
    "  .sort((p, q) => cmp(p, q, 1)).map((r) => r.title).join('');",
    "const groupingFor = (key) => groups({ sortKey: key, sortAsc: true, paper: false });",
    "console.log(JSON.stringify({ asc, desc, tied, groupEvent: groupingFor('event'), groupDate: groupingFor('date') }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    asc: string;
    desc: string;
    tied: string;
    groupEvent: boolean;
    groupDate: boolean;
  };
  // 会期が決まっている行は会期順。未確認は向きに関係なく末尾（画面で「未確認」と
  // 読める行が先頭に来る形を許さない）。
  expect(out.asc).toBe("bac");
  expect(out.desc).toBe("abc");
  expect(out.tied).toBe("yx");
  // 月のまとめ見出しは、締切の日付順をまとめるもの。会期順では出さない。
  expect(out.groupDate, "締切順の月のまとめまで消えている").toBe(true);
  expect(out.groupEvent, "会期順で締切月の見出しが出ている").toBe(false);

  // 入口が三つ（見出し・狭い画面のボタン・実装の鍵）そろっていること。1 つ欠けると
  // 押せない列になるか、押せない鍵を URL が受け付けることになる。
  expect(app).toContain('SORTABLE_KEYS = ["rem", "date", "event", "conf", "rank"]');
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain('data-sort="event"');
  expect(
    (html.match(/data-sort="event"/g) || []).length,
    "見出しと並び替えバーの両方に入口が必要",
  ).toBe(2);
  expect(html).toContain("会期 ↕");
  // てびきが画面に出る語を説明していること。
  expect(html).toContain("会期</strong>の順は出張の計画に向きます");
  expect(html).toContain("昇順・降順のどちらでも<strong>末尾</strong>");
});

it("実データで会期順が並びとして成立している（未確認が末尾に固まる・SPEC §7）", () => {
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(
      `file://${join(site, "recommender.js")}`,
    )});`,
    `const CMP_SRC = ${JSON.stringify(jsFunction(app, "compareEventRows"))};`,
    `const DUE_SRC = ${JSON.stringify(jsFunction(app, "dueShown"))};`,
    "const fs = await import('node:fs');",
    "const data = JSON.parse(fs.readFileSync(process.env.DSH_SITE_DATA || '', 'utf8'));",
    "const dueShown = new Function('return (' + DUE_SRC + ')')();",
    "const cmp = new Function('dueShown', 'return (' + CMP_SRC + ')')(dueShown);",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(data, now).filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && r.t >= now && !r.ed.estimated);",
    "const known = rows.filter((r) => Number.isFinite(r.tEvent)).length;",
    "const sorted = rows.slice().sort((a, b) => cmp(a, b, 1));",
    "let bad = 0, seenUnknown = false, prev = -Infinity;",
    "for (const r of sorted) {",
    "  if (!Number.isFinite(r.tEvent)) { seenUnknown = true; continue; }",
    "  if (seenUnknown) bad++;",
    "  if (r.tEvent < prev) bad++;",
    "  if (r.tEvent > prev) prev = r.tEvent;",
    "}",
    // 並び替える前（既定の締切順）は同じ指標でどれくらい飛んでいるかも出す（空振りでないこと）。
    "let before = 0, prev2 = -Infinity;",
    "for (const r of rows) { if (!Number.isFinite(r.tEvent)) continue; if (r.tEvent < prev2) before++; if (r.tEvent > prev2) prev2 = r.tEvent; }",
    "console.log(JSON.stringify({ total: rows.length, known, unknown: rows.length - known, bad, before }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DSH_SITE_DATA: join(site, "data.json") },
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    total: number;
    known: number;
    unknown: number;
    bad: number;
    before: number;
  };
  expect(out.total).toBeGreaterThan(100);
  // 会期が決まっている行と未確認の行、両方が実際に有ること（片だけなら検査が空振りする）。
  expect(out.known).toBeGreaterThan(100);
  expect(out.unknown).toBeGreaterThan(0);
  expect(out.bad, "会期順に並べても逆転か未確認の先頭混入がある").toBe(0);
  // 並べる前は飛んでいる（＝この並びが実際に効いている）。
  expect(out.before).toBeGreaterThan(0);
});

it("てびきのキーボード欄が同じ操作を二度書いていない（SPEC §7）", () => {
  /* 「キーボードで一覧を動かす」の説明で、`/`（検索欄へ飛ぶ）と `Esc` の説明が
   * 一続きの文章の中に二回あった（2026-09-23 実測: 「`/` で検索欄に飛び…（`Esc` は行の
   * 詳細を閉じるのにも使います）」と、同じ項の後ろの方に「`/` を押すと検索欄に飛び、
   * `Esc` で詳細を閉じます」）。読者は二つの文が同じ操作を指しているのか、別々の操作が
   * あるのかを確かめられない。同じ欄の中で同じ言い回しを繰り返さない。*/
  const html = readFileSync(join(site, "index.html"), "utf8");
  const at = html.indexOf("<dt>印刷</dt>");
  const kb = html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  expect(kb, "キーボードの項が無くなった").toBeGreaterThan(-1);
  const block = html.slice(kb, html.indexOf("</div>", kb));
  for (const phrase of ["検索欄に飛び", "行の詳細を閉じる"]) {
    const hits = block.split(phrase).length - 1;
    expect(hits, `「${phrase}」の説明が同じ項に ${hits} 回ある`).toBe(1);
  }
  // 印刷の項は、並び順が紙に残ることを説明している（第 127 回）。
  expect(at, "印刷の項が無くなった").toBeGreaterThan(-1);
  const print = html.slice(at, html.indexOf("</dd>", at));
  expect(print).toContain("並び順");
});

it("古いデータを開いた人に、生成から経った日数を伝える（SPEC §7）", () => {
  /* 更新は日次の運用（`.github/workflows/update-data.yml` の cron: 17 20 * * *）。
   * それが止まっているとき、画面は「データ生成: 2026-08-09(日) 09:00 JST」と出すだけで、
   * それが何日前なのかも言わなかった（2026-09-23 実測: ヘッダーの文字列は生成時刻だけ）。
   * 締切のサイトで古い一覧を最新と誤って使い、投稿の機会を逃すのが一番悪い失敗。 */
  const rec = join(site, "recommender.js");
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const gen = Date.parse('2026-08-09T00:00:00Z');",
    "const DAY = 86400000;",
    "const at = (days) => new Date(gen + days * DAY).toISOString();",
    // 生成時刻は固定し、閲覧側の現在時刻だけを動かす（生成時刻もずらすと経過年数が 0 になる）。
    "const note = (days) => Recommender.dataAgeNoteJa(at(0), gen + days * DAY);",
    "const cases = [0.1, 1, 2, 3, 5, 11].map((d) => [d, note(d)]);",
    // 生成より過去（閲覧側の時計がずれている）で警告を出さない。
    "const past = Recommender.dataAgeNoteJa(at(0), gen - DAY);",
    // 生成時刻が読めない値のときは空（別経路で「未確認」と出るので二重に言わない）。
    "const broken = ['', '未取得', undefined, null].map((v) => Recommender.dataAgeNoteJa(v, gen));",
    "const noNow = Recommender.dataAgeNoteJa(at(30), Number.NaN);",
    "console.log(JSON.stringify({",
    "  threshold: Recommender.dataStaleDaysJa,",
    "  silentBelow: cases.filter(([d]) => d < 3).every(([, t]) => t === ''),",
    "  firedAt3: cases.find(([d]) => d === 3)[1],",
    "  firedAt11: cases.find(([d]) => d === 11)[1],",
    "  at0: cases.find(([d]) => d === 0.1)[1],",
    "  past, broken, noNow,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    threshold: number;
    silentBelow: boolean;
    firedAt3: string;
    firedAt11: string;
    at0: string;
    past: string;
    broken: string[];
    noNow: string;
  };
  // 閾値はてびきと README に書いた値と同じ（書き写さず、実装の正本から取る）。
  expect(out.threshold).toBe(3);
  expect(out.at0).toBe("");
  expect(out.silentBelow, "閾値より前で警告が出ている").toBe(true);
  expect(out.firedAt3, "閾値の日で警告が出ていない").toContain(
    "データは 3 日前に生成されたものです",
  );
  // 日数は実際の経過日数を出す（「古い」の一言で済ませない）。
  expect(out.firedAt11).toContain("データは 11 日前");
  // 締切の推測ではなく、公式確認の依頼として締める。
  expect(out.firedAt3).toContain("公式サイトの募集要項");
  // 時計のズレ・読めない値で根拠の無い警告を出さない。
  expect(out.past).toBe("");
  expect(out.noNow).toBe("");
  for (const text of out.broken) expect(text).toBe("");

  // 実画面への配線（上の検査だけではヘッダーは何も変わらない）。
  expect(app).toContain("dataAgeNoteJa(DATA.generated_at, Date.now())");
  expect(app).toContain('"stale"');
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 色だけに頼らず本文で言うが、視覚の目印も付ける。
  expect(html).toContain(".meta-info .stale");
  expect(
    html.slice(html.indexOf(".meta-info .stale"), html.indexOf(".meta-info .stale") + 200),
  ).toContain("var(--warn)");
  // てびきが画面に出る語を説明していること。
  expect(html).toContain("日次で更新する運用");
  expect(html).toContain("3 日以上");
});

it("常時受付の行の会期・開催地は「該当なし」と出す（SPEC §7）", () => {
  /* 「未確認」は kamiyobi が公式で裏を取れていないという意味だと、てびきが説明している。
   * 常時受付のジャーナル（tag: journal で締切なし）は会期も会場も存在しないのに、表・行の
   * 詳細ともに「未確認」と出していた（2026-09-23 実測: 実データ 22 行が 未確認 扱い。
   * ラベルは 0 件にならない）。読者は公式の発表を待つ情報だと誤り、発表を待ってしまう。*/
  const rec = join(site, "recommender.js");
  const app = siteRuntime();
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // `node -e` のソースは require とトップレベル await を同時に持てない（AGENTS.md）。
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const yes = (rows) => rows.filter((r) => Recommender.fieldNotApplicableJa(r)).length;",
    // 壊れた行（null など）で落ちないこと。
    "const broken = [null, undefined, {}, { kind: 'paper' }].map((v) => Recommender.fieldNotApplicableJa(v));",
    // 画面に出る語は検索でも引ける（他の状態の語と同じ約束）。
    "const m = Recommender.searchMatcher('該当なし', now);",
    "const found = deadlines.concat(journals).filter((r) => m(r.hay)).length;",
    "console.log(JSON.stringify({",
    "  na: Recommender.notApplicableLabelJa(),",
    "  unconfirmed: Recommender.unconfirmedLabelJa(),",
    "  journalRows: journals.length,",
    "  journalYes: yes(journals),",
    "  deadlineYes: yes(deadlines),",
    "  deadlineTotal: deadlines.length,",
    // 「未確認」の出番が残っていることも見る（置き換えてしまったら検査が無意味になる）。
    "  unknownEvent: deadlines.filter((r) => !r.ed.event_start).length,",
    "  titles: [Recommender.notApplicableTitleJa('event'), Recommender.notApplicableTitleJa('place'), Recommender.notApplicableTitleJa('rank')],",
    "  broken,",
    "  found,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    na: string;
    unconfirmed: string;
    journalRows: number;
    journalYes: number;
    deadlineYes: number;
    deadlineTotal: number;
    unknownEvent: number;
    titles: string[];
    broken: boolean[];
    found: number;
  };
  expect(out.na).toBe("該当なし");
  // 「未確認」とは別の語であることが検査の意味（同じ語なら区別できない）。
  expect(out.na).not.toBe(out.unconfirmed);
  expect(out.journalRows, "常時受付の行が実データに無い").toBeGreaterThan(0);
  expect(out.journalYes, "常時受付の行が「該当なし」になっていない").toBe(out.journalRows);
  // 締切行では出さない（誤って「該当なし」にすると、確認待ちの情報を消してしまう）。
  expect(out.deadlineYes, "締切行に「該当なし」が出ている").toBe(0);
  expect(out.deadlineYes).toBeLessThan(out.deadlineTotal);
  expect(out.unknownEvent, "「未確認」を出す行が消えて検査が無意味になっている").toBeGreaterThan(0);
  // 理由を title に書く。知らない欄には空を返す（でたらめな理由を書かない）。
  expect(out.titles[0]).toContain("会期");
  expect(out.titles[1]).toContain("開催地");
  expect(out.titles[2]).toBe("");
  for (const v of out.broken) expect(v).toBe(false);
  expect(out.found, "画面に出す語が検索で引けない").toBe(out.journalRows);

  // 実画面への配線（表と行の詳細の両方）。
  expect(app).toContain("Recommender.notApplicableLabelJa()");
  expect(app).toContain('notApplicableTitleJa("event")');
  expect(app).toContain('notApplicableTitleJa("place")');
  const guide = readFileSync(join(site, "index.html"), "utf8");
  // てびきが「未確認」との区別を説明していること。
  const at = guide.indexOf("<dt>未確認</dt>");
  expect(at, "未確認の説明が無くなった").toBeGreaterThan(-1);
  const entry = guide.slice(at, guide.indexOf("</dd>", at));
  expect(entry).toContain("該当なし");
  expect(entry).toContain("常時受付");
});

it("upcoming.md は、表のうえで列の意味が分かる（SPEC §7）", async () => {
  /* この表は `index.html` と違い、条件欄もてびきもない単体のファイルとして読まれる
   * （チャットに貼る・grep する・他ツールに食わせる）。ところが列の見出しが
   * `| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |` で、**「R」が何なのか表のどこにも
   * 書いていなかった**（2026-09-23 実測: 値は `R1`・`R2`・`-`。会期行の「残り」が
   * 「本日開催」「開催中(残り1日)」になることも、種別「開催」が締切でないことも、
   * 表のうえでは説明が無かった）。 */
  const confs = [
    makeConference({
      key: "run",
      title: "RUN",
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "run26",
          source: "local",
          event_start: utc(2026, 8, 7),
          event_end: utc(2026, 8, 11),
          deadlines: [makeDeadline("paper", "Paper submission", utc(2026, 8, 20), "AoE", 2)],
        }),
      ],
    }),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-md-legend-"));
  await buildAll(confs, { categories: { hpc: "HPC" } }, outdir, NOW, { noEmbeddings: true });
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  const lines = text.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("| 日付 |"));
  expect(headerAt, "表の見出し行が無い").toBeGreaterThan(-1);
  const above = lines.slice(0, headerAt).join("\n");
  const cells = lines[headerAt]
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  // 一文字だけの見出しは、単体で開いた人に読めない（`R` が通ると検査が空振りする）。
  for (const cell of cells) {
    expect(/^[A-Za-z]$/.test(cell), `読み替えないと分からない見出し「${cell}」`).toBe(false);
  }
  // 見出しはサイトと同じ語（一覧の列名は「ラウンド」）。
  expect(cells).toContain("ラウンド");
  expect(above, "列の意味を表のうえで説明していない").toContain("列の意味");
  // 実際に画面（表）に出る語で説明する – 略語の説明だけで分からないようにする。
  for (const word of ["ラウンド", "残り", "推定", "本日開催", "開催中"]) {
    expect(above, `列の意味のうち「${word}」を説明していない`).toContain(word);
  }
  // 種別「開催」は締切ではないことを書く（締切表だと信じて読む人を誤らせない）。
  expect(above).toContain("会期そのもの");
  // 列の数と見出しは常に揃う（列が増えて説明が漏れた日に気づけるようにする）。
  const sep = lines[headerAt + 1];
  expect(sep.split("|").slice(1, -1).length).toBe(cells.length);
});

it("CSV の状態の列に、画面の「未確認」「該当なし」を残す（SPEC §7）", () => {
  /* 一覧のセルは空欄を作らないので「未確認」「該当なし」と書く（第 129 回で「該当なし」を
   * 分けた）。ところが CSV に書き出すと、値の列（会期・開催地・ランク）が空になるだけで、
   * その状態は消えていた（2026-09-23 実測: 会期が未知の締切行で状態・会期・開催地の各列が
   * すべて空。常時受付の行も、画面は「該当なし」と読むのに CSV では同じ空欄）。
   * 表計算に持ち出した人は「収録が無いのか、まだ確認できていないのか」を区別できない。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const fields = (rows) => rows.filter((r) => Recommender.unconfirmedFieldsJa(r).length);",
    // 条件（行の値）から期待する件数をその場で作る（数字を書き写さない）。
    "const unknownEvent = deadlines.filter((r) => !String(r.ed.event_start || '').trim());",
    "const withTerm = unknownEvent.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期未確認'));",
    "const journalNa = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期該当なし'));",
    "const journalUnconfirmed = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('会期未確認'));",
    // ランクは常時受付にも付き得るので「該当なし」にはならない。
    "const journalNaRank = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).includes('ランク該当なし'));",
    // CSV の実物を読む（列名で見出しから洗う）。
    "const parse = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (ch === '\"') {",
    "      if (quoted && line[i + 1] === '\"') {",
    "        cur += '\"';",
    "        i++;",
    "      } else {",
    "        quoted = !quoted;",
    "      }",
    "    } else if (ch === ',' && !quoted) {",
    "      out.push(cur);",
    "      cur = '';",
    "    } else {",
    "      cur += ch;",
    "    }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const csv = Recommender.deadlinesToCsv(unknownEvent.slice(0, 5).concat(journals.slice(0, 5)), now);",
    // 改行は CRLF の可能性があるので両方受ける。
    "const lines = csv.split(/\\r?\\n/);",
    "const cols = parse(lines[0].replace(/^\\\\uFEFF/, ''));",
    "const at = (name) => cols.indexOf(name);",
    "const rows = lines.slice(1).filter(Boolean).map(parse);",
    "console.log(JSON.stringify({",
    "  headers: cols,",
    "  unknownEvent: unknownEvent.length,",
    "  withTerm: withTerm.length,",
    "  fieldsOfUnknown: Recommender.unconfirmedFieldsJa(unknownEvent[0]),",
    "  journalRows: journals.length,",
    "  journalNa: journalNa.length,",
    "  journalUnconfirmed: journalUnconfirmed.length,",
    "  journalNaRank: journalNaRank.length,",
    "  statusCells: rows.map((r) => [r[at('種別')], r[at('会期')], r[at('状態')]]),",
    "  broken: [null, undefined, {}].map((v) => Recommender.unconfirmedFieldsJa(v).length > 0),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    headers: string[];
    unknownEvent: number;
    withTerm: number;
    fieldsOfUnknown: string[];
    journalRows: number;
    journalNa: number;
    journalUnconfirmed: number;
    journalNaRank: number;
    statusCells: string[][];
    broken: boolean[];
  };
  // 状態の列は元からある（列を増やさず、この列が区別を引き受ける）。
  expect(out.headers).toContain("状態");
  expect(out.headers).toContain("会期");
  expect(out.unknownEvent, "会期が未知の行が実データに無い").toBeGreaterThan(0);
  expect(out.withTerm, "画面が「未確認」と出す行が CSV で区別できない").toBe(out.unknownEvent);
  expect(out.fieldsOfUnknown).toContain("会期未確認");
  expect(out.journalRows).toBeGreaterThan(0);
  expect(out.journalNa, "常時受付の行が「該当なし」として出ていない").toBe(out.journalRows);
  // 第 129 回の区別が書き出し後も保つか（確認待ちと混ざらない）。
  expect(out.journalUnconfirmed, "常時受付の行が「未確認」に化けている").toBe(0);
  expect(out.journalNaRank, "ランクを「該当なし」にしている").toBe(0);
  // CSV の実物: 状態の列に語があり、値の列は空のまま。
  const deadlineCells = out.statusCells.filter((c) => c[0] !== "常時受付");
  expect(deadlineCells.length).toBeGreaterThan(0);
  for (const [, eventCell, status] of deadlineCells) {
    expect(eventCell, "値の列まで語で埋めた（空のままが正しい）").toBe("");
    expect(status).toContain("会期未確認");
  }
  const journalCells = out.statusCells.filter((c) => c[0] === "常時受付");
  expect(journalCells.length).toBeGreaterThan(0);
  for (const [, , status] of journalCells) {
    expect(status).toContain("会期該当なし");
    // 「ランク未確認」は有り得るので、会期・開催地が確認待ちに化けていないことを見る。
    expect(status).not.toContain("会期未確認");
    expect(status).not.toContain("開催地未確認");
  }
  // 壊れた行で落ちない（値が無い行は未確認として扱う）。
  for (const ok of out.broken) expect(ok).toBe(true);
  // てびきが状態の列の説明を持っている（画面に出る語をてびきが説明する約束）。
  const guide = readFileSync(join(site, "index.html"), "utf8");
  const at = guide.indexOf("<dt>CSV</dt>");
  expect(at, "CSV の項が無くなった").toBeGreaterThan(-1);
  const entry = guide.slice(at, guide.indexOf("</dd>", at));
  expect(entry).toContain("状態");
  expect(entry).toContain("該当なし");
});

it("CSV の状態の列に書いた語は、そのまま検索で引ける（SPEC §7）", () => {
  /* 第 133 回で CSV の状態の列に「会期未確認」「会期該当なし」を書けるようにした。
   * ここで問題になるのが、その語を画面の検索欄に打ったとき – 検索語（行の `hay`）に
   * 同じ語が無ければ「CSV に載っていたのに 0 件」になる（画面に出る語は検索でも引ける、
   * という SPEC §2 の約束）。実測で常時受付の行は `会期該当なし` が 0 件、
   * `ランク未確認` も 0 件だった（画面のセルには出ているのに）。 */
  const rec = join(site, "recommender.js");
  // 検索語も CSV も recommender の側で作るので、組み立てが一箇所かはそちらを見る。
  const recSrc = siteRuntime("recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const deadlines = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const parse = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (ch === '\"') {",
    "      if (quoted && line[i + 1] === '\"') {",
    "        cur += '\"';",
    "        i++;",
    "      } else {",
    "        quoted = !quoted;",
    "      }",
    "    } else if (ch === ',' && !quoted) {",
    "      out.push(cur);",
    "      cur = '';",
    "    } else {",
    "      cur += ch;",
    "    }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const sample = deadlines.slice(0, 400).concat(deadlines.slice(-400)).concat(journals);",
    "const csv = Recommender.deadlinesToCsv(sample, now);",
    "const lines = csv.split(/\\r?\\n/).filter(Boolean);",
    "const cols = parse(lines[0].replace(/^\\\\uFEFF/, ''));",
    "const at = (name) => cols.indexOf(name);",
    // プロパティ: CSV の状態の列に書いた語は、その行の検索語に入っている。
    "const rows = [];",
    "const bad = [];",
    "let checked = 0;",
    "lines.slice(1).forEach((line, i) => {",
    "  if (!line.trim()) return;",
    "  const row = sample[i];",
    "  rows.push(row);",
    "  parse(line)[at('状態')].split('・').filter(Boolean).forEach((word) => {",
    "    checked += 1;",
    "    if (!Recommender.searchMatcher(word, now)(row.hay)) bad.push(word);",
    "  });",
    "});",
    "const hits = (word, rows) => rows.filter((r) => Recommender.searchMatcher(word, now)(r.hay)).length;",
    "const naJournals = journals.filter((r) => Recommender.unconfirmedFieldsJa(r).some((f) => f === '会期該当なし'));",
    "const unrankedJournals = journals.filter((r) => !(r.rankPairs || []).length);",
    "console.log(JSON.stringify({",
    "  checked,",
    "  bad: bad.slice(0, 5),",
    "  badCount: bad.length,",
    "  journalRows: journals.length,",
    "  naJournalRows: naJournals.length,",
    "  eventNa: hits('会期該当なし', journals),",
    "  eventNaInDeadlines: hits('会期未確認', journals),",
    "  eventUnconfirmed: hits('会期未確認', deadlines),",
    "  unconfirmedDeadlines: deadlines.filter((r) => !String(r.ed.event_start || '').trim()).length,",
    "  rankUnconfirmedJournals: hits('ランク未確認', journals),",
    "  unrankedJournals: unrankedJournals.length,",
    "  naInDeadlines: hits('該当なし', deadlines),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    checked: number;
    bad: string[];
    badCount: number;
    journalRows: number;
    naJournalRows: number;
    eventNa: number;
    eventNaInDeadlines: number;
    eventUnconfirmed: number;
    unconfirmedDeadlines: number;
    rankUnconfirmedJournals: number;
    unrankedJournals: number;
    naInDeadlines: number;
  };
  // 検査が無意味にならないこと（状態の列が空ばかりなら何も見ていない）。
  expect(out.checked, "CSV の状態の列が空で、検査が空振りしている").toBeGreaterThan(50);
  expect(out.bad, `CSV に書いた語が引けない: ${out.bad.join(", ")}`).toEqual([]);
  // 常時受付の行は「該当なし」の語で引ける（第 129 回の語が検索にも残る）。
  expect(out.naJournalRows).toBeGreaterThan(0);
  expect(out.eventNa).toBe(out.naJournalRows);
  // 締切行と常時受付の行が混ざらない（逆も同じ）。
  expect(out.eventNaInDeadlines, "常時受付の行が「会期未確認」で引ける").toBe(0);
  expect(out.naInDeadlines, "締切行が「該当なし」で引ける").toBe(0);
  expect(out.eventUnconfirmed).toBe(out.unconfirmedDeadlines);
  // ランクが空の常時受付の行は、そのまま引ける。
  expect(out.rankUnconfirmedJournals).toBe(out.unrankedJournals);
  // 検索語の組み立ては一箇所（項目別の古い実装が残っていないことも見る）。
  expect(recSrc, "検索語の組み立てが二重実装になっている").not.toContain("unconfirmedSearchTerms");
  // 締切行と常時受付の行、両方の検索語が同じ関数から出ている。
  expect((recSrc.match(/unconfirmedHayJa\(/g) || []).length).toBeGreaterThanOrEqual(3);
});

it("ボタンを押した直後も快捷键が効く（SPEC §7）", () => {
  /* 完成した画面の `onKeydown` をビルド成果物から抜き出して動かした（2026-09-23 実測）。
   * 入力欄・選択欄・ボタン・編集できる欄ではすべてのキーを止める作りだったので、
   * **画面をクリックするたびに快捷键が死んでいた**: 「過去の締切も表示」のボタンを
   * クリックした直後、`/` は検索欄にフォーカスを移さず、`j` は行を動かさなかった
   * （飲み込まれることも無く無反応）。`j` / `k` を使う人はボタンを踏んだ直後である
   * ことが多いので、ボタンが本当に受け取るキー（Enter と Space）だけ残して通す。 */
  const app = siteRuntime("app.js");
  const keyFn = jsFunction(app, "keyBlockedByTarget");
  const keydownFn = jsFunction(app, "onKeydown");
  expect(keyFn, "キーの振り分け関数が見当たらない（検査が空振り）").not.toBe("");
  expect(keydownFn, "onKeydown が見当たらない").not.toBe("");
  const script = [
    // 抜き出した 2 つの関数を、画面と同じ外部の値と一緒に作って動かす。
    "const fn = new Function(",
    "  '$',",
    "  'state',",
    "  'shown',",
    "  'selectedIndex',",
    "  'updateRowSelection',",
    "  'openDrawer',",
    "  'closeDrawer',",
    "  'safeExternalUrl',",
    "  'window',",
    "  " +
      JSON.stringify(
        `const ensureRowsDrawn = () => {};\n${keyFn}\n${keydownFn}\nreturn { onKeydown, keyBlockedByTarget };`,
      ) +
      ",",
    ");",
    "let moved = 0;",
    "let closed = 0;",
    "const log = [];",
    "const qEl = { tagName: 'INPUT', focus: () => log.push('検索欄にfocus'), blur: () => log.push('blur') };",
    "const made = fn(",
    "  () => qEl,",
    "  { mode: 'deadlines' },",
    // 選択行が末尾だと `j` は行を動かさない（画面と同じ）ので、3 行渡す。
    "  [{ ed: {}, conf: {} }, { ed: {}, conf: {} }, { ed: {}, conf: {} }],",
    "  0,",
    "  () => { moved += 1; log.push('行が動いた'); },",
    "  () => {},",
    "  () => { closed += 1; },",
    "  (x) => x,",
    "  { open: () => {}, matchMedia: () => ({ matches: false }) },",
    ");",
    "const run = (tag, key, inSearch) => {",
    "  log.length = 0;",
    "  moved = 0;",
    "  const target = inSearch ? qEl : { tagName: tag, blur: () => log.push('blur') };",
    "  let prevented = 0;",
    "  made.onKeydown({",
    "    target,",
    "    key,",
    "    preventDefault: () => {",
    "      prevented += 1;",
    "      log.push('飲み込み');",
    "    },",
    "  });",
    "  return { log: log.slice(), prevented };",
    "};",
    "const blocked = made.keyBlockedByTarget;",
    "console.log(JSON.stringify({",
    "  table: {",
    "    input: blocked('INPUT', 'j', false),",
    "    select: blocked('SELECT', 'j', false),",
    "    textarea: blocked('TEXTAREA', '/', false),",
    "    editable: blocked('BODY', 'j', true),",
    "    buttonEnter: blocked('BUTTON', 'Enter', false),",
    "    buttonSpace: blocked('BUTTON', ' ', false),",
    "    buttonJ: blocked('BUTTON', 'j', false),",
    "    buttonSlash: blocked('BUTTON', '/', false),",
    "    bodyJ: blocked('BODY', 'j', false),",
    "  },",
    "  buttonSlash: run('BUTTON', '/', false),",
    "  buttonJ: run('BUTTON', 'j', false),",
    "  buttonSpace: run('BUTTON', ' ', false),",
    "  buttonEnter: run('BUTTON', 'Enter', false),",
    "  textareaSlash: run('TEXTAREA', '/', false),",
    "  searchEscape: run('INPUT', 'Escape', true),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    table: { [k: string]: boolean };
    buttonSlash: { log: string[]; prevented: number };
    buttonJ: { log: string[]; prevented: number };
    buttonSpace: { log: string[]; prevented: number };
    buttonEnter: { log: string[]; prevented: number };
    textareaSlash: { log: string[]; prevented: number };
    searchEscape: { log: string[]; prevented: number };
  };
  // 欄ではすべてのキーを欄に渡す（論文の本文に `/` が打てるようにする）。
  expect(out.table.input).toBe(true);
  expect(out.table.select).toBe(true);
  expect(out.table.textarea).toBe(true);
  expect(out.table.editable).toBe(true);
  // ボタンが本当に受け取るキーだけボタンに残す。
  expect(out.table.buttonEnter, "ボタンの Enter をショートカットに取った").toBe(true);
  expect(out.table.buttonSpace, "ボタンの Space をショートカットに取った").toBe(true);
  // 他はショートカットに渡す（ここが直しどころ）。
  expect(out.table.buttonJ, "ボタン押下後に j が死んでいる").toBe(false);
  expect(out.table.buttonSlash, "ボタン押下後に / が死んでいる").toBe(false);
  expect(out.table.bodyJ).toBe(false);
  // 実際に `onKeydown` を通しても同じ（`/` が検索欄へ飛び、`j` が行を動かす）。
  expect(out.buttonSlash.log).toContain("検索欄にfocus");
  expect(out.buttonJ.log).toContain("行が動いた");
  expect(out.buttonSpace.prevented, "ボタンの Space を飲み込んだ").toBe(0);
  expect(out.buttonEnter.prevented, "ボタンの Enter を飲み込んだ").toBe(0);
  expect(out.textareaSlash.prevented, "論文欄の / をショートカットに取った").toBe(0);
  // 検索欄での Esc は従来のまま（欄を出て、選んでいた行に返す）。
  expect(out.searchEscape.log).toContain("blur");
  expect(out.searchEscape.log).toContain("行が動いた");
  // てびきが同じ約束を書いているか（画面の挙動と案内をズレさせない）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const at = html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>');
  expect(at, "キーボードの項が無くなった").toBeGreaterThan(-1);
  expect(html.slice(at, html.indexOf("</dd>", at))).toContain("ボタンを押した直後も");
});

it("0 件の案内が、各条件で今何行が隠れているかを並べて書く（SPEC §7）", () => {
  /* 0 件の画面は「外せる条件」を実名で並べる（第 66 回以降で整えてきた）。しかし条件の
   * 名前だけが並び、6 項目のどれから外す価値があるかは書かれていなかった（2026-09-23 実測:
   * 窓を 7 日・評価を A* に絞った 0 件画面の案内は「外せる条件: …」の羅列だけ）。
   * 同じ画面上の件数欄は、同じ条件で消えた行数を内訳として書いているので、その数字を
   * 項目に添って、案内と件数欄が同じ行の話をするようにする。 */
  const app = siteRuntime("app.js");
  const hintFn = jsFunction(app, "emptyDeadlineHint");
  expect(hintFn, "0 件案内の関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    `const countJa = (${jsFunction(app, "countJa")});`,
    "const KIND_ALL_LABEL_JA = 'すべての種別';",
    // 評価の語は正本から取る（件数欄と同じ語を見るために）。
    (siteRuntime("recommender.js").match(/const RANK_UNRATED_LABEL_JA = [^\n]*;/) || [""])[0],
    wholeTableQueryStubs(siteRuntime("recommender.js")),
    "const Recommender = { rankUnratedLabelJa: () => RANK_UNRATED_LABEL_JA, wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
    jsFunction(app, "rankFilterLabelJa"),
    jsFunction(app, "rankDropWordsJa"),
    `${hintFn.replace("function emptyDeadlineHint", "const emptyDeadlineHint = function")}`,
    "const base = {",
    "  window: '7d',",
    "  past: false,",
    "  cats: 2,",
    "  domestic: true,",
    "  online: true,",
    "  rank: 'A*',",
    "  kind: 'paper',",
    "  est: false,",
    "  query: '',",
    "  hiddenKindWords: [],",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [],",
    "  catalogConferences: 40,",
    "};",
    "const counted = emptyDeadlineHint({",
    "  ...base,",
    "  hidden: {",
    "    window: 438,",
    "    past: 1231,",
    "    est: 134,",
    "    rank: 416,",
    "    cats: 88,",
    "    domestic: 61,",
    "    online: 462,",
    "    kind: 900,",
    "  },",
    "});",
    // どの条件も行を隠していないとき、外し直しの案内を並べても打ち直しが増えるだけ。
    "const plain = emptyDeadlineHint({ ...base, hidden: {} });",
    "const noData = emptyDeadlineHint({ ...base, catalogConferences: 0, hidden: { past: 5 } });",
    // 外していない条件の数字は書かない（窓を「かまわない」にしているのに
    // 「締切まで」の項目を並べないのと同じ扱い）。
    "const allWindow = emptyDeadlineHint({",
    "  ...base,",
    "  window: 'all',",
    "  hidden: { window: 9999, past: 3 },",
    "});",
    "console.log(JSON.stringify({ counted, plain, noData, allWindow }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    counted: string;
    plain: string;
    noData: string;
    allWindow: string;
  };
  // 各項目に、件数欄と同じ名前で同じ数字が添わる。
  expect(out.counted).toContain("「締切まで 7 日以内」を超える 438 件");
  expect(out.counted).toContain("「過去の締切も表示」をオン（過去の締切 1,231 件）");
  expect(out.counted).toContain("「推定締切を含める」をオン（推定 134 件）");
  expect(out.counted).toContain("評価「A*」を持たない行 416 件");
  expect(out.counted).toContain("選んだ分野を持たない行 88 件");
  expect(out.counted).toContain("国内研究会・国内シンポジウム以外 61 件");
  expect(out.counted).toContain("オンライン参加の記載がない 462 件");
  expect(out.counted).toContain("投稿締切以外の種別 900 件");
  // どの条件も行を隠していないなら、外し直しの案内を並べない（打ち直しが増えるだけ）。
  // 「（ 0 件）」を出すのは画面の噓にもなる。
  expect(out.plain).not.toContain("件）");
  expect(out.plain).not.toContain("過去の締切も表示");
  expect(out.plain).not.toContain("推定締切を含める");
  // データその物が無いときの文は条件の話に埋もれない（先にそれを言う）。
  expect(out.noData).toContain("締切のデータが入っていません");
  expect(out.noData).not.toContain("過去の締切");
  // 隠している行数が 0 の条件を勧めない（窓を外し切っているのに「締切まで」を出さない）。
  expect(out.allWindow).not.toContain("9999");
  expect(out.allWindow).not.toContain("締切まで");
  expect(out.allWindow).toContain("過去の締切 3 件");
  // 呼び出し側が内訳を渡していること（渡さなければ上の数字は永遠に 0 のまま）。
  expect(app).toContain("hidden: hiddenDeadlineCounts()");
  expect(app).toContain("est: state.est");
});

it("行をまたぐ見出しの列数と、外せる条件の数え上げを実際の列と揃える（SPEC §7）", () => {
  /* 月見出し・過ぎた締切の見出し・行の詳細は `colSpan` で列をまたぐ。以前は 7 を
   * 3 箇所に直書きしていた（2026-09-23 実測: `colSpan = 7` がビルド成果物に 3 件）。
   * 列を増やした日に見出しの跨ぎが足りなくなると、画面では見出しの右に列が余って
   * 「表示が欠けた」ように見え、支援技術では見出しが列に紐づかない。同じ数は
   * 表の見出し（`site/template.html`）と行のラベル（`data-label`）にも出ていたので、
   * 三者が本当に同じかを検査で結ぶ。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const headAt = html.indexOf("<thead>");
  expect(headAt, "表の見出しが見当たらない").toBeGreaterThan(-1);
  const head = html.slice(headAt, html.indexOf("</thead>", headAt));
  // `<thead>` を抓わないように `<th\b` にし、閉じタグを書く列（種別・開催地）も取る。
  const headerLabels = [...head.matchAll(/<th\b[^>]*>([^<\n]*)/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  expect(headerLabels.length, "見出しの列が読めない").toBeGreaterThan(4);
  // 行側も同じ数のラベルを持っている（カード化ではこの語が列名になる）。
  const cellLabels = [...app.matchAll(/td\(tr, "([^"]+)"(?:, "[^"]*")?\)/g)].map((m) => m[1]);
  expect(cellLabels.length, "行のラベルが読めない").toBe(headerLabels.length);
  expect([...new Set(cellLabels)].length, "行のラベルが重複している").toBe(cellLabels.length);
  // 跨ぎの列数は 1 箇所に寄せてある（直書きに戻ると、列を変えた日に静かに壊れる）。
  expect((app.match(/colSpan = 7/g) || []).length, "列数の直書きが残っている").toBe(0);
  const tableColumns = /const TABLE_COLUMNS_JA = (\d+);/.exec(app);
  expect(tableColumns, "列数の定数が見当たらない").not.toBeNull();
  expect(Number(tableColumns?.[1]), "列数の定数が見出しと違う").toBe(headerLabels.length);

  /* 「条件をまとめて外す」が出る条件の数え上げに、推定が入っていない状態を見る。
   * 0 件案内（第 136 回）は推定を「外せる条件」として並べるので、同じ数え上げに
   * していないと、案内は外せるというのにボタンは出ない。 */
  const clearFn = jsFunction(app, "filtersClearable");
  expect(clearFn, "filtersClearable が見当たらない").not.toBe("");
  const script = [
    // 抜き出した関数ソースは文字列ではなく式としてそのまま入れる（JSON.stringify すると
    // 関数ではなく文字列になり、`f is not a function` になる）。
    `const f = (${clearFn});`,
    "const clear = {",
    "  window: 'all',",
    "  cats: 0,",
    "  domestic: false,",
    "  online: false,",
    "  rank: 'all',",
    "  kind: '',",
    "  est: false,",
    "  query: '',",
    "};",
    "console.log(JSON.stringify({",
    "  nothing: f(clear),",
    "  estOnly: f({ ...clear, est: true }),",
    "  kindOnly: f({ ...clear, kind: 'paper' }),",
    "  windowOnly: f({ ...clear, window: '7d' }),",
    "  rankOnly: f({ ...clear, rank: 'A*' }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { [k: string]: boolean };
  expect(out.nothing, "条件を一切掛けていないのに外せることになる").toBeFalsy();
  expect(out.kindOnly).toBeTruthy();
  expect(out.windowOnly).toBeTruthy();
  expect(out.rankOnly).toBeTruthy();
  expect(out.estOnly, "推定だけを外せない（0 件案内は外せる条件に並べる）").toBeTruthy();
});

it("投稿先を探すモードの一致評価の語を、画面で説明している語に限定する（SPEC §7）", () => {
  /* カードの chips は `一致評価 <語> ▾` と出す。以前は「情報不足」がほぼ全ての行に出て、
   * 論文を最後まで入力しても同じだった（2026-09-23 実測: 画面に出る 25 件のうち 23 件、
   * 意味検索の得点を_synthetic に足しても 122 件のうち 120 件）。
   * 「論文の情報が足りない」と読める語が常に出るため、実際に測った人が入力をやめる
   * 恐れがあった。ここは (a) 常に出る語を画面で説明しているか、(b) 説明文が無い語を
   * 出していないか、を検査する（ラベルは実装から取り、テストに書き写さない）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const papers = [",
    "  'タイトル: 分散 GPU 学習の通信最適化',",
    "  'タイトル: ゼロコピー転送を用いた分散 GPU 学習のための通信最適化\\n概要: RDMA と集合通信ライブラリの性能を計測し、学習反復あたり短縮を確認した。\\nキーワード: 分散学習 ネットワーク',",
    "];",
    "const labels = new Set();",
    "let shownRows = 0;",
    "let mostCommon = { label: '', count: 0 };",
    "const tally = {};",
    "for (const p of papers) {",
    "  const lines = R.parsePaperLines(p);",
    "  const scores = {};",
    "  for (const x of R.venueRecommendations(rows, lines, scores, NOW, { fieldedLexical: true })) {",
    "    labels.add(x.fit.label);",
    "    // 一覧に出る行だけを数える（しきい値は app.js の式から取る）。",
    "    if (x.fit.score >= 10) {",
    "      shownRows += 1;",
    "      tally[x.fit.label] = (tally[x.fit.label] || 0) + 1;",
    "    }",
    "  }",
    "}",
    "for (const [label, count] of Object.entries(tally)) if (count > mostCommon.count) mostCommon = { label, count };",
    "console.log(JSON.stringify({ labels: [...labels], shownRows, tally, mostCommon }));",
  ].join("\n");
  // Node 26 は `node -e` のソースを ESM として見るので、静的 import がそのまま使える。
  const proc = spawnSync("node", ["-e", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    labels: string[];
    shownRows: number;
    tally: { [k: string]: number };
    mostCommon: { label: string; count: number };
  };
  expect(out.shownRows, "推薦の行が 1 も出ず、検査が空振り").toBeGreaterThan(10);
  expect(out.labels.length, "ラベルが 1 種類しか出ず、検査が空振り").toBeGreaterThan(1);
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 画面に出る語は、てびきで説明している語だけにする。
  for (const label of out.labels) {
    expect(html, `「${label}」が一覧に出るのに、画面のどこにも説明が無い`).toContain(label);
  }
  // 常に出る語は、説明文が「その語がほぼ全行に出る」ことを正直に書いている。
  const noteAt = html.indexOf(out.mostCommon.label);
  expect(noteAt).toBeGreaterThan(-1);
  const note = html.slice(Math.max(0, noteAt - 400), noteAt + 400);
  expect(note).toMatch(/実測|ほとんど/);
  // 以前の語は画面から消えている（論文を入力しても消えない警告に見えていた）。
  expect(html).not.toContain("情報不足");
});

it("内訳の項目に、足して読むように見える数字を出さない（SPEC §7）", () => {
  /* 推薦の行の内訳（`一致評価 … ▾` を押すと出る）は、以前 `+18` などの数字を並べていた。
   * しかしその数字は手作業で決めた信号重みで、**画面に出すスコアとは別の計算**だった
   * （2026-09-23 実測: 「一致スコア 65点」の行の内訳は +18 と +9 が並ぶだけで合計 27、
   * 63 点的な行は合計 21、59 点的な行は合計 57）。`+` 付きの数字は足して読むものに見え、
   * てびきも「どの要素でどれだけ合ったか」と書いていたため、画面の噓になっていた。
   * 内訳は「当たった要素」の名前だけを出し、スコアとの関係を明文化する。 */
  const app = siteRuntime("app.js");
  expect(app).toContain("この会議で当たった要素");
  /* 項目は名前だけ。以前は「ラベルの直後に + と値を繋ぐ古い形」だけを禁じていたため、
   * ラベルを先に書いて後ろへ足す書き方で数字が戻っていた（2026-08-09 実測: 内訳を持つ候補
   * 29 件すべてで内訳の和とスコアが違い、例はスコア 58 点 / 内訳の和 45、52 点 / 15）。
   * なので書き方に依存しない形で見る。内訳を出す 3 箇所の関数に、値を足す形が 1 つも
   * 入っていないこと（画面に出る語と数字の対応は、ここで決める）。 */
  const surfaces = ["makeRow", "makeDetailRow", "makeRecommendationCard"];
  for (const name of surfaces) {
    const body = jsFunction(app, name);
    expect(body.length, `${name} が見つからない（内訳の実装が消えた）`).toBeGreaterThan(0);
    expect(body, `${name} が内訳の項目に足し算に見える数字を出している`).not.toContain("+" + "${");
  }
  expect(app, "内訳に足し算に見える数字を残している").not.toContain('"+10"');
  const html = readFileSync(join(site, "index.html"), "utf8");
  // スコアと内訳の関係を書いておく（点を足した値だと誤解させない）。
  expect(html).toMatch(/スコア（点）はこの内訳を足した値ではありません/);

  /* 「数字を足すとスコアになる」が成立しないことの実測（直した理由の記録として残す。
   * 成立する日が来ても、項目は名前だけを出し続ける）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const lines = R.parsePaperLines(",
    "  'タイトル: ゼロコピー転送を用いた分散 GPU 学習のための通信最適化\\n概要: RDMA と集合通信ライブラリの性能を計測した。\\nキーワード: 分散学習 ネットワーク HPC',",
    ");",
    "const kept = R.venueRecommendations(rows, lines, {}, NOW, { fieldedLexical: true }).filter(",
    "  (x) => x.fit.score >= 10,",
    ");",
    "let checked = 0;",
    "let differs = 0;",
    "for (const x of kept) {",
    "  const agg = x.match.agg || {};",
    "  const sum = ['domain', 'name', 'paper', 'jp', 'tags'].reduce(",
    "    (s, k) => s + (agg[k] || 0),",
    "    0,",
    "  );",
    "  if (!sum) continue;",
    "  checked += 1;",
    "  if (sum !== x.fit.lexicalScore) differs += 1;",
    "}",
    "console.log(JSON.stringify({ checked, differs, shown: kept.length }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { checked: number; differs: number; shown: number };
  expect(out.shown, "推薦の行が出ず、検査が空振り").toBeGreaterThan(5);
  expect(out.checked, "内訳の項目がある行が出ず、検査が空振り").toBeGreaterThan(5);
  // 内訳の重みの合計は、スコアと**ほとんどの行で一致しない**（足してスコアになるのでは
  // ない）。ここで「全行で一致しない」を主張するのは強すぎる。スコアはこれらの信号から
  // 計算されるので、低い点の行では重みの合計がたまたまスコアと同じ値になることがある
  // （2026-08-09 実測: 入力論文を日本語ラベルで書くと 1 論文として読めるようになり（第 168
  // 回）、推薦される行の組みが変わって 30 点の行が 1 件一致した）。利用者への実際の約束は
  // 上の変側（`+<数>` を作らない・てびきの「スコア（点）はこの内訳を足した値ではありません」）
  // が持っていて、ここは「合計＝スコアと読むのがほとんどの行で噓になる」の実測として残す。
  expect(out.differs, "内訳の合計がスコアと一致する行が過半（前提が変わった）").toBeGreaterThan(
    Math.floor(out.checked / 2),
  );
});

it("画面に出る文へ markdown の記号を混ぜない（SPEC §7）", () => {
  /* `site/template.html` に `**強調**` の形で書いた行が実際に有った（2026-09-23 実測:
   * 「残り」の項に `**日数は JST の暦日**` がそのまま画面に出ていた）。Markdown を書く
   * 癖が HTML に残っても検査が通っていたので、表示される本文だけを見て弾く。
   * CSS・スクリプト・HTML コメントの中は画面に出ないので見る必要がない。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const visible = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 要素に囲まれた文字（`<code>` の中も画面に出る）だけを見る。
    .replace(/<[^>]+>/g, " ");
  expect(visible, "画面に出る文に markdown の強調記号が残っている").not.toContain("**");
  /* バッククォートも同じ。てびきの本文中に `NSDI 2027` / `cryptography` / `Tokyo, 日本` の形で
   * 書いた行が実際に有った（2026-09-23 実測: 画面に記号がそのまま出ていた）。HTML では
   * `<code>` で囲むのがこの画面の書き方で、てびきの他の項目はそうなっている（第 143 回）。*/
  expect(visible, "画面に出る文に markdown の code 記号が残っている").not.toContain("`");
  expect(visible).not.toMatch(/__\S[^_]*__\s/);
  expect(visible).not.toMatch(/\[[^\]\n]{1,40}\]\([^)\n]{1,80}\)/);
  /* 吹き出し（`title`）も画面に出る文。折り返し形式の指定は効かず記号がそのまま出る
   * （2026-09-23 実測: 「 kamiyobi の内部表記では `N`」）。画面の語だけで書かせる。*/
  const app = siteRuntime("app.js");
  const titleDecl = (app.match(/RANK_UNRATED_TITLE_JA\s*=\s*"[^"]*"/) || [""])[0];
  expect(titleDecl, "「評価なし」の吹き出しが見つからない（検査が空振り）").not.toBe("");
  expect(titleDecl).not.toContain("`");
  expect(titleDecl, "画面に無い開発寄りの語を吹き出しに混ぜない").not.toContain("内部表記");
  const guide = visible;
  // 吹き出しが画面の語を使う限り、てびき側にもその語の説明が要る。
  for (const word of titleDecl.match(/「[^」]+」/g) || []) {
    expect(guide, `吹き出しの語 ${word} がてびきから引けない`).toContain(word);
  }
});

it("閉じたままのてびきの入口に、中身とズレた見出しを置かない（SPEC §7）", () => {
  /* 「見方のてびき」は `<details>` で畳んだまま開く。閉じた `<details>` の中はブラウザの
   * ページ内検索（Ctrl+F）で出てこない（WebKit の既知の制限:
   * https://bugs.webkit.org/show_bug.cgi?id=239940）。だから見出し（summary）だけが
   * 常に読める案内になっていて、そこにうたった語が中身に見当たらないと、
   * 「書いてあるはずなのに見つからない」で人が止まる。見出しの引用符の中の語を
   * そのままてびき本文と突き合わせる。
   * 併せて、開いた状態をリンクで引き継ぐ `?help=1` が画面の案内にもあることを見る。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const headAt = html.indexOf("<summary>");
  expect(headAt, "てびきの見出しが見当たらない").toBeGreaterThan(-1);
  const summary = html.slice(headAt, html.indexOf("</summary>", headAt));
  const advertised = [...summary.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  expect(advertised.length, "てびきの見出しが語をうたっていない（検査が空振り）").toBeGreaterThan(
    2,
  );
  const guideStart = html.indexOf('<details class="help"');
  const guide = html.slice(guideStart, html.indexOf("</details>", guideStart));
  expect(guide.length, "てびきの本文が読めない").toBeGreaterThan(1000);
  for (const word of advertised) {
    expect(guide, `てびきの見出しが「${word}」とうたっているが、中にその語の説明が無い`).toContain(
      word,
    );
  }
  // 開いた状態を渡せることを、画面の案内も書く（知り合いにリンクで教えられる形に）。
  expect(guide).toContain("?help=1");
  // 読み書きが対でないと、開いて共有したリンクを受けた人の画面で畳まれている。
  const app = siteRuntime("app.js");
  expect(app).toContain('p.set("help", "1")');
  expect(app).toContain('p.get("help")');
});

it("0 件の読み上げが、画面に出ている案内の有無と緩められる条件の有無を正直に言う（SPEC §7）", () => {
  /* 0 件画面の下には「外せる条件」を並べるが、読み上げには短い理由だけを流していた
   * （2026-09-23 実測: 「 ｜ いまの条件では行がありません。条件を緩めると出ます」）。
   * 支援技術では下に出ている案内が見えないので、0 件とだけ聞いて操作をやめる人が出る。
   * 逆に、外せる条件が 1 つも残っていない画面で「緩めると出ます」と言うのは噓だった。 */
  const app = siteRuntime("app.js");
  const liveFn = liveNoteSource(app);
  expect(liveFn, "0 件の読み上げ文言が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    // 0 件案内と読み上げが同じ語列表を見るので、正本を注入する（第 239 回）。
    wholeTableQueryStubs(siteRuntime("recommender.js")),
    "const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
    // 抜き出した関数は式としてそのまま入れる（JSON.stringify すると文字列になる）。
    `const live = (${liveFn});`,
    "const base = {",
    "  hiddenKindWords: [],",
    "  termCounts: [],",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  catalogConferences: 40,",
    "  clearable: false,",
    "  pastShown: false,",
    "  hidden: {},",
    "};",
    "const run = (over) => live({ ...base, ...over });",
    "console.log(JSON.stringify({",
    "  // 窓で絞って 0 件（今日は実際に踏める形）。",
    "  windowed: run({ clearable: true, hidden: { window: 34 } }),",
    "  // 何も絞っていないのに 0 件で、過去の締切だけが出ない形。",
    "  onlyPast: run({ hidden: { past: 2317 } }),",
    "  // 過去も表示し終えて 0 件（緩める条件が残っていない）。",
    "  exhausted: run({ pastShown: true }),",
    "  noData: run({ catalogConferences: 0 }),",
    "  // 原因が特定できても、下に案内があることは同じように伝える。",
    "  hiddenKind: run({ hiddenKindWords: ['採否通知'], clearable: true, hidden: { kind: 603 } }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { [k: string]: string };
  // 下に出ている案内を指し示す（支援技術では下の塊が見えない）。
  expect(out.windowed).toContain("下に外せる条件も書いてあります");
  expect(out.hiddenKind).toContain("下に外せる条件も書いてあります");
  expect(out.hiddenKind).toContain("種別に当たります");
  // 括弧を二重に重ねない（読み上げで「（…）（…）」と続くのは聞こえない）。
  expect(out.hiddenKind).not.toContain("）（");
  // 緩められない画面で「緩めると出ます」と言わない。
  expect(out.exhausted).not.toMatch(/緩め|外せる条件/);
  expect(out.exhausted).toContain("収録にいま以降の締切");
  expect(out.onlyPast).toContain("収録の締切はすべて過ぎています");
  expect(out.onlyPast).toContain("過去の締切も表示");
  // データその物が無い話は、条件の話より先にそのまま出す（第 118 回以降の方針）。
  expect(out.noData).toContain("締切のデータが入っていません");
  // 呼び出し側が、0 件案内と同じ数え合わせを渡していること。
  expect(app).toContain("clearable: filtersClearable(");
  expect(app).toContain("pastShown: state.past");
});

it("画面の件数は 3 桁ごとに区切り、てびきの書き方と揃える（SPEC §7）", () => {
  /* 既定画面の件数欄は「478 件 / 全 3235 件」、0 件の案内は「過去の締切 2317 件」と出ていた
   * （2026-09-23 実測）。一方てびきは同じ数を「全 3,235 件」と書いていて、同じ数が画面と
   * 案内で二つの形になっていた。4 桁以上の数を素で出すと、表示件数と収録総数を見比べたとき
   * に桁の大きさが取り出しにくい。`toLocaleString` は環境で区切り文字が変わるので、
   * 区切りは自前で書く。 */
  const app = siteRuntime("app.js");
  const fnSrc = jsFunction(app, "countJa");
  expect(fnSrc, "件数の数え合わせの関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    `const countJa = (${fnSrc});`,
    "console.log(JSON.stringify({",
    "  small: countJa(478),",
    "  edge999: countJa(999),",
    "  edge1000: countJa(1000),",
    "  pool: countJa(3235),",
    "  past: countJa(2317),",
    "  big: countJa(1234567),",
    "  negative: countJa(-5),",
    "  zero: countJa(0),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.small).toBe("478");
  expect(got.edge999).toBe("999");
  expect(got.edge1000, "4 桁目から区切れていない").toBe("1,000");
  expect(got.pool).toBe("3,235");
  expect(got.past).toBe("2,317");
  expect(got.big).toBe("1,234,567");
  // 残り日数などでも使うので、符号と区切りを壊さない。
  expect(got.negative).toBe("-5");
  expect(got.zero).toBe("0");
  // 1 箇所でも素の数値があると、その欄だけ区切りの無い数になる。
  const unwrapped = [...app.matchAll(/\$\{([^{}"]+)\} 件/g)].filter(
    (m) => !m[1].trim().startsWith("countJa("),
  );
  expect(
    unwrapped.map((m) => m[1]),
    "countJa を経ずに件数を出している個所がある",
  ).toEqual([]);
  // 案内側の書き方と実際の画面が同じであることを、実行した結果で結ぶ。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain(`全 ${got.pool} 件`);
  const guideCounts = [...html.matchAll(/([0-9][0-9,]{3,}) 件/g)].map((m) => m[1]);
  expect(guideCounts.length, "てびきに 4 桁以上の件数が出ていない（検査が空振り）").toBeGreaterThan(
    0,
  );
  for (const c of guideCounts) {
    expect(c, `てびきの「${c} 件」が画面の数え方と違う形になっている`).toMatch(
      /^[0-9]{1,3}(,[0-9]{3})*$/,
    );
  }
});

it("キー操作の案内は幅ではなく操作手段で出し、効いている画面から案内を消さない（SPEC §7）", () => {
  /* `j` / `k` / `d` / `/` の処理に幅の判定は無い（`onKeydown` に `innerWidth` 等の参照は
   * 無い）。ところが案内の方は 640px 未満という「幅」の条件で隠れていた（2026-09-23 実測:
   * パソコンの窓を左右に分割して狭くした人は、キーが効いているのに件数欄の案内とてびきの
   * 「キーボードで一覧を動かす」の項が消えた画面を開く）。タッチで狙う端末で隠すのが
   * 意図なので、操作手段（`pointer` / `hover`）で分ける。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
  // コメントの中に条件らしい語を書いても誤読しないよう、実装と同じく先に落とす。
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Array<{ query: string; body: string }> = [];
  const re = /@media[^{]*\{/g;
  for (let m = re.exec(noComments); m !== null; m = re.exec(noComments)) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < noComments.length && depth > 0) {
      if (noComments[j] === "{") depth += 1;
      else if (noComments[j] === "}") depth -= 1;
      j += 1;
    }
    blocks.push({
      query: m[0].slice(0, -1).replace(/\s+/g, " ").trim(),
      body: noComments.slice(m.index + m[0].length, j),
    });
  }
  expect(blocks.length, "@media のブロックが読めない（検査が空振り）").toBeGreaterThan(2);
  const selectors = [".count-kbd", ".only-keyboard"];
  for (const sel of selectors) {
    const hiding = blocks.filter((b) => b.body.includes(`${sel} {`) || b.body.includes(`${sel},`));
    expect(hiding.length, `${sel} を隠す規則が見当たらない（検査が空振り）`).toBeGreaterThan(0);
    for (const b of hiding) {
      expect(
        b.query,
        `${sel} を幅で隠している（狭い窓を開いた人から、効いているキーの案内が消える）`,
      ).toMatch(/\((pointer|hover)\s*:/);
    }
  }
  // キー処理その物に幅の判定が無いことも見る（案内だけ消える食い違いの根本）。
  const app = siteRuntime("app.js");
  const handler = jsFunction(app, "onKeydown");
  expect(handler, "キー処理本体が見当たらない（検査が空振り）").not.toBe("");
  expect(handler).not.toMatch(/innerWidth|clientWidth|offsetWidth|matchMedia/);
});

it("収録元の締切名は「原表記」と書いて、画面の種別と混ざらないようにする（SPEC §7）", () => {
  /* 種別欄の本筋は「概要締切」「論文締切」だが、その下に収録元がその締切に付けた名前を
   * 併記している。既定画面 478 行はすべて原表記を持ち、無印で並べていた（2026-09-23 実測:
   * 「Submission deadline」129 行、「Paper submission」56 行、「Submission」34 行で、国内分は
   * 「発表申込締切」など日本語）。印の無い別分類が同じ列に並んで見えたため、会期で既に
   * 使っている「原表記」の語をここでも使う。表と行の詳細で式を共有する（式が二つあると
   * 片方だけ直す – 第 128 回）。 */
  const app = siteRuntime("app.js");
  const fnSrc = jsFunction(app, "kindDetailJa");
  expect(fnSrc, "締切名の併記を作る関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    `const kindDetailJa = (${fnSrc});`,
    "console.log(JSON.stringify({",
    "  roundAndLabel: kindDetailJa(2, 'Paper submission'),",
    "  firstRound: kindDetailJa(1, 'Submission deadline'),",
    "  japanese: kindDetailJa(null, '発表申込締切'),",
    "  blank: kindDetailJa(3, '   '),",
    "  nothing: kindDetailJa(null, null),",
    "  numericString: kindDetailJa('2', 'Abstract registration'),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.roundAndLabel).toBe("第 2 ラウンド / 原表記: Paper submission");
  // 第 1 ラウンドは旧来どおり書かない（毎行に付いて読みにくくなる）。
  expect(got.firstRound).toBe("原表記: Submission deadline");
  expect(got.japanese).toBe("原表記: 発表申込締切");
  expect(got.blank).toBe("第 3 ラウンド");
  expect(got.nothing).toBe("");
  expect(got.numericString, "数値が文字列で来るとラウンドが消える").toBe(
    "第 2 ラウンド / 原表記: Abstract registration",
  );
  // 表のセルと行の詳細が同じ式を使う（どちらかだけ直す変更を落ちるようにする）。
  expect((app.match(/kindDetailJa\(/g) || []).length, "併記の呼び出し箇所").toBe(3);
  expect(app).not.toMatch(/detail\.push\(\s*r\.dl\.label\s*\)/);
  // 画面に出る語として、てびきにも同じ語で書いてある。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "原表記という語がてびきから引けない").toContain("原表記:");
});

it("投稿先を探す画面で印刷すると、紙に出る但し書きが実際の内容と一致する（SPEC §7）", () => {
  /* 印刷物の但し書き（`#printMeta`）は表用の文言を常時書いていた。推薦画面では
   * `shown` が空になる（`render` の `shown = recMode && !recommendationData ? [] : filter()`）
   * ので、候補のカードが並んだ紙に「表示 0 件」と刷れていた（2026-09-23 実測）。
   * 紙が自分を噓をつく形なので、画面の実物（モードのボタン名）を使った文にする。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 画面のモード名は正本から取る（テスト側に書き写すと、呼び方が変わったときに気づけない）。
  const modeBtn = /id="modeRecommend"[^>]*>([^<]+)</.exec(html);
  expect(modeBtn, "モードの切替ボタンが見当たらない（検査が空振り）").not.toBeNull();
  const modeWord = String(modeBtn![1]).trim();
  expect(modeWord).not.toBe("");

  const app = siteRuntime("app.js");
  // 但し書きは `state` を直読みするので、モードごとに組み直して 2 回走らせる。
  const run = (mode: string, shownCount: number, cardCount: number) => {
    const body = [
      "function countJa(n) { const int = Math.trunc(Number(n) || 0); const d = String(Math.abs(int)).replace(/\\B(?=(\\d{3})+$)/g, ','); return int < 0 ? '-' + d : d; }",
      "const meta = { textContent: '' };",
      `const cards = { children: ${JSON.stringify(new Array(cardCount).fill(null).map(() => ({})))} };`,
      // 印刷前には候補のカードがぜんぶ描画されている（第 204 回）。だからこの検査では
      // 画面が候補として持つ一覧も同じ長さにする（枚数だけを渡すと、見出しは総数と
      // 枚数の違いを書き分ける側に通る）。
      `let recommendationList = { length: ${cardCount} };`,
      "const $ = (id) => (id === 'printMeta' ? meta : id === 'recommendationCards' ? cards : null);",
      "const valueElement = () => ({ options: [{ text: '30 日以内' }], selectedIndex: 0 });",
      "function describeFilters() { return '投稿締切（概要・論文）／締切まで 30 日以内'; }",
      "const fmtJst = () => '2026-08-09 (日) 09:00 JST';",
      "function generatedAtLabel(v) { return 'データ生成: ' + v; }",
      "const KIND_LABEL = { paper: '論文締切' };",
      // 語の正本はビルドした `recommender.js`。印刷の但し書きが使う語も本物から借りる
      // （検査に語を書き写すと、画面の語が変わっても気づけない）。
      `const { default: REAL } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
      "const Recommender = {",
      "  categoryLabelJa: (c) => c,",
      "  unconfirmedLabelJa: () => REAL.unconfirmedLabelJa(),",
      "  rankUnratedLabelJa: () => REAL.rankUnratedLabelJa(),",
      "  extendedLabelJa: () => REAL.extendedLabelJa(),",
      "  notApplicableLabelJa: () => REAL.notApplicableLabelJa(),",
      "};",
      "const DATA = { generated_at: '2026-08-09T09:00:00Z' };",
      "let sortKey = 'deadline', sortAsc = true, sortColumnLabel = '日時（JST）';",
      `let shown = ${JSON.stringify(new Array(shownCount).fill(null))};`,
      `let state = { mode: ${JSON.stringify(mode)}, win: '30d', kind: '', cats: [], rank: '', past: false };`,
      // 条件の書き下ろしに渡すラベル関数（この検査は describeFilters をスタブにするので
      // 呼ばれないが、名前だけは必要）。語の正本は注入済みの Recommender 側にある。
      jsFunction(app, "rankFilterLabelJa"),
      verificationLabelsSource(),
      jsFunction(app, "printLegendJa"),
      jsFunction(app, "fillPrintMeta"),
      "fillPrintMeta();",
      "console.log(JSON.stringify({ out: meta.textContent }));",
    ].join("\n");
    const proc = spawnSync("node", ["-e", vmSafeSource(body)], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return (JSON.parse(proc.stdout) as { out: string }).out;
  };
  const rec = run("recommend", 0, 3);
  expect(rec, "推薦画面の印刷物に表の件数が刷れている").not.toContain("表示 0 件");
  expect(rec).toContain(modeWord);
  expect(rec, "候補の数が紙に残っていない").toContain("候補 3 件");
  expect(rec).toContain("2026-08-09 (日) 09:00 JST");
  const recEmpty = run("recommend", 0, 0);
  expect(recEmpty).toContain("候補 0 件");
  const dl = run("deadlines", 10, 0);
  expect(dl).toContain("表示 10 件");
  /* 見張るのは推薦画面の枚数表記の方（第 212 回まで「候補」の二字で見ていたが、
     状態列に「複数候補のため要確認」が正しく入るようになったので、二字では見れなくなった）。 */
  expect(dl, "締切一覧の但し書きまで推薦の枚数表記が出ている").not.toMatch(/候補 \d+ 件/);

  // 紙に候補が残ること自体は従来どおり（印刷で隠している規則が無いこと）。
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1].replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const printBlocks: string[] = [];
  const re = /@media[^{]*\{/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const query = m[0].slice(0, -1).replace(/\s+/g, " ").trim();
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    if (query.includes("print")) printBlocks.push(css.slice(m.index + m[0].length, j));
  }
  expect(printBlocks.length, "印刷用の規則が読めない（検査が空振り）").toBeGreaterThan(0);
  const printCss = printBlocks.join("\n");
  expect(printCss, "候補のカードが印刷で消えている").not.toMatch(
    /#recommendationCards[^{]*\{[^}]*display:\s*none/,
  );
  // 紙では URL を押せない。表と同じく候補のカードにもアドレスを併記する。
  expect(printCss).toMatch(/#tbody a\[href\^="http"\]::after/);
  expect(printCss, "候補のカードだけ公式ページのアドレスが紙に残らない").toMatch(
    /#recommendationCards a\[href\^="http"\]::after/,
  );
  // てびきにも同じ事実を書く（画面の語を引けるようにする）。
  expect(html).toContain("投稿先を探す画面 ／ 候補 N 件");
});

it("開いていた行の詳細まで共有し、てびきの説明と実際の引き継ぎをズレさせない（SPEC §7）", () => {
  /* 「画面を共有する」は絞り込み・並び順・てびきの開閉を URL に載せる（第 99 回・第 140 回）。
   * 一方で、いちばん共有したい単位である「この締切」が行として残っておらず、送られた側は
   * 表のなかから同じ行を探さなければならなかった（2026-09-23 実測: ビルド成果物の URL の
   * 書き出しに行に関する引数は 1 つも無かった）。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 書き出しと読み取りが対で存在すること（片方だけの実装は黙って消える）。
  expect(app).toContain('p.set("row", rowShareKeyJa(');
  expect(app).toContain('p.get("row")');
  // 起動時は `render()` の後に復元する（`shown` が揃う前だと行を探せない）。
  // 起動時の並び: `readUrl()` → 描き込み → 行の詳細の復元（`shown` が揃う前では探せない）。
  // ビルド後はインデントが変わるので、行の並びで見つける。
  const wired = /\n\s*render\(\);\n\s*restoreDrawerFromUrl\(\);/.exec(app);
  expect(wired, "描き込みの後で行の詳細を開いていない（URL を受け取らない画面）").not.toBeNull();
  const firstRead = app.lastIndexOf("readUrl();", (wired as RegExpExecArray).index);
  expect(firstRead, "URL を読む前に開こうとしている").toBeGreaterThan(0);
  // 行の鍵は同じ会議の別締切を区別できる（概要/論文・年違い）。
  const script = [
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    "const a = { conf: { key: 'SC' }, ed: { year: 2026 }, kind: 'paper', t: 1794883140000 };",
    "console.log(JSON.stringify({",
    "  a: rowShareKeyJa(a),",
    "  same: rowShareKeyJa({ ...a }) === rowShareKeyJa(a),",
    "  kind: rowShareKeyJa({ ...a, kind: 'abstract', t: 1 }) !== rowShareKeyJa(a),",
    "  year: rowShareKeyJa({ ...a, ed: { year: 2027 } }) !== rowShareKeyJa(a),",
    "  sparse: rowShareKeyJa({ conf: {}, ed: {}, kind: '', t: NaN }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { [k: string]: string };
  expect(got.same).toBe(true);
  expect(got.kind).toBe(true);
  expect(got.year).toBe(true);
  expect(got.a).toBe("SC|2026|paper|1794883140000");
  // 情報が無い行でも例外にはせず、空の欄を残す（照合にしか使わない）。
  expect(got.sparse).toBe("|||");
  // 案内にも同じ事実を書く（画面の語を引けるようにする）。
  expect(html, "?row= のことがてびきに無い").toContain("<code>?row=</code>");
});

it("読めない形式のファイルを PDF のせいにしない（SPEC §7）", () => {
  /* 論文を選ぶ欄は `accept=".pdf,.txt"` だが、ピッカーは「すべてのファイル」に切り替えられる
   * ので他の形式も運ばれてくる。従来は拡張子を見ておらず、Word なども PDF として pdf.js に
   * 渡していた（2026-09-23 実測: `.docx` を選ぶと pdf.js が `Invalid PDF structure.` を落とし、
   * 画面は「PDF から文字を読み取れませんでした（文字が入っていない PDF や、パスワード付きは
   * 読めません）」と言った。自分の PDF の文字化けを疑って、直せない方向へ探してしまう）。 */
  const app = siteRuntime("app.js");
  const script = [
    "const PDF_MAX_BYTES = 20 * 1024 * 1024;",
    "const PDF_MAX_PAGES = 3;",
    `const unsupportedPaperFormatJa = (${jsFunction(app, "unsupportedPaperFormatJa")});`,
    `const message = (${jsFunction(app, "pdfFailureMessageJa")});`,
    "const names = ['paper.docx', 'ronbun.doc', 'talk.odp', 'TALK.ODP', 'notes.txt', 'paper.pdf', 'paper.PDF', 'summary', 'book.epub'];",
    "console.log(JSON.stringify({",
    "  verdicts: names.map((n) => {",
    "    const u = unsupportedPaperFormatJa(n);",
    "    return { name: n, msg: u ? message(new Error(u)) : '' };",
    "  }),",
    "  // PDF の失敗の言い方は従来どおり残る（増やした分岐が既存の案内を潰していないこと）。",
    "  invalid: message(new Error('Invalid PDF structure.')),",
    "  cancelled: message(Object.assign(new Error('x'), { name: 'AbortError' })),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    verdicts: Array<{ name: string; msg: string }>;
    invalid: string;
    cancelled: string;
  };
  const byName: { [k: string]: string } = {};
  for (const v of got.verdicts) byName[v.name] = v.msg;
  for (const n of ["paper.docx", "ronbun.doc", "talk.odp", "TALK.ODP", "book.epub"]) {
    expect(byName[n], `${n} が読み取れることになっている（検査が空振り）`).not.toBe("");
    // 「あなたの PDF が壊れている」とは言わない。拡張子を実名で出して、次を指示する。
    expect(byName[n]).not.toMatch(/PDF (から|を)(文字)?が?読み取れ/);
    expect(byName[n]).toContain("対応しているのは PDF と TXT です");
    expect(byName[n]).toContain("貼り付けてください");
  }
  expect(byName["TALK.ODP"], "大文字の拡張子を取りこぼしている").toContain(".odp");
  for (const n of ["notes.txt", "paper.pdf", "paper.PDF", "summary"]) {
    expect(byName[n], `${n} を弾いている（従来読めていたものを壊した）`).toBe("");
  }
  expect(got.invalid).toContain("PDF から文字を読み取れませんでした");
  expect(got.cancelled).toBe("PDF 読込をキャンセルしました");
  // 弾く場所: 大きさの判定より前で、ファイル名を見る（読みに行かない）。
  expect(app).toContain("unsupportedPaperFormatJa(file.name)");
  // 欄の注記にも対応形式を書いておく（押す前に分かるようにする）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "対応形式の注記が無い").toContain("Word などの文書形式は読めません");
});

it("条件クリアは論文の入力を消さず、消す操作は名前の書いたボタンが受け持つ（SPEC §7）", () => {
  /* 「条件クリア」は絞り込みだけをまとめる操作だが、論文のタイトル・概要・参考論文の欄と
   * 選んだファイルまで消していた（2026-09-23 実測: `#reset` の節に `paperText` と
   * `paperReferences` への代入が残っていた）。てびきは CSV を条件なしで出す手順として
   * 「条件クリアを押してください」と案内しているので、絞り込みを直したいだけの人が
   * Confirmation も Undo も無く打ち込んだ概要を失っていた。 */
  const app = siteRuntime("app.js");
  // `#reset` の節に論文の入力を消す代入が残っていないこと（節の範囲は次の addEventListener まで）。
  const resetAt = app.indexOf('$("reset").addEventListener');
  expect(resetAt, "条件クリアの処理が見当たらない（検査が空振り）").toBeGreaterThan(0);
  // 自分自身の `addEventListener("click"` を飛ばしてから、次の節の開始を探す。
  const selfAt = app.indexOf('addEventListener("click"', resetAt);
  const nextAt = app.indexOf('addEventListener("click"', selfAt + 22);
  const resetBody = app.slice(resetAt, nextAt > 0 ? nextAt : resetAt + 1600);
  expect(resetBody).toContain('q: ""');
  for (const paperField of [
    "paperText",
    "paperReferences",
    "paperPrimaryTitle",
    "paperFileLabel",
  ]) {
    expect(
      resetBody,
      `条件クリアが ${paperField} を消している（概要を失う操作のまま）`,
    ).not.toContain(paperField);
  }
  // 実行検証: 論文の入力を消す操作は、五つの欄をまとめて白紙にする。
  const script = [
    "const vals = {",
    "  paperText: '打った本文',",
    "  paperPrimaryTitle: 'タイトル',",
    "  paperPrimaryAbstract: '概要',",
    "  paperPrimaryKeywords: 'キーワード',",
    "  paperReferences: 'ref | k | v',",
    "};",
    "const valueElement = (id) => ({",
    "  get value() {",
    "    return vals[id];",
    "  },",
    "  set value(v) {",
    "    vals[id] = v;",
    "  },",
    "});",
    "let paperPrimaryVenue = 'ICDE';",
    "let invalidated = 0;",
    "const invalidateSemantic = () => { invalidated += 1; };",
    jsFunction(app, "setPrimaryRecord").replace(
      "function setPrimaryRecord",
      "const setPrimaryRecord = function",
    ),
    "const label = { textContent: 'paper.docx' };",
    "const $ = (id) => (id === 'paperFileLabel' ? label : {});",
    "const paperFiles = { value: 'stale' };",
    // 「論文の入力を消す」は下書きの記憶も消す（消した物が次の刷新で戻ってくる形を作らない）。
    // そこで記憶の側も本物と同じ形で生やす（第 222 回）。
    "const PAPER_DRAFT_KEY = 'draft.key';",
    "const store = new Map([['draft.key', JSON.stringify({ title: '打った本文' })]]);",
    "const window = {",
    "  sessionStorage: {",
    "    setItem: (k, v) => { store.set(k, String(v)); },",
    "    getItem: (k) => (store.has(k) ? store.get(k) : null),",
    "    removeItem: (k) => { store.delete(k); },",
    "  },",
    "};",
    jsFunction(app, "paperInputHasText"),
    jsFunction(app, "readPaperInput"),
    jsFunction(app, "savePaperDraft"),
    jsFunction(app, "clearPaperInput").replace(
      "function clearPaperInput",
      "const clearPaperInput = function",
    ),
    "clearPaperInput();",
    "console.log(JSON.stringify({ vals, venue: paperPrimaryVenue, file: paperFiles.value, label: label.textContent, invalidated, draft: store.size }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    vals: { [k: string]: string };
    venue: string;
    file: string;
    label: string;
    invalidated: number;
    draft: number;
  };
  expect(got.vals).toEqual({
    paperText: "",
    paperPrimaryTitle: "",
    paperPrimaryAbstract: "",
    paperPrimaryKeywords: "",
    paperReferences: "",
  });
  expect(got.venue, "PDF から取った掲載先の想定が残っている").toBe("");
  expect(got.file).toBe("");
  expect(got.label).toBe("未選択");
  expect(got.draft, "欄を消したのに下書きの記憶が残っている（刷新で戻ってくる）").toBe(0);
  expect(got.invalidated, "意味検索の使い回しを無効化していない").toBe(1);
  // 消す操作は、その名前のボタンが受け持つ（てびきの説明と同じ語で出す）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const btn = /<button id="paperReset"[^>]*>([^<]+)<\/button>/.exec(html);
  expect(btn, "論文の入力を消すボタンが無い").not.toBeNull();
  expect(html, "てびきがボタンの語で案内していない").toContain(`ボタン「${btn![1]}」`);
});

it("キーボードで選んだ行がまだ描画されていなくても、その場で続きを描く（SPEC §7）", () => {
  /* 選択は `shown`（絞り込み後の全行）まで進むが、表に描いてある行は `drawn` 行だけだった
   * （2026-09-23 実測: 既定の PAGE は 40 行で、`j` を 40 回押すとハイライトとフォーカスは
   * 40 行目に残ったまま、内部の選択だけ 41 行目以降へ進んだ）。`d` を押すと画面に出ていない
   * 行の詳細が開き、キーが効かなくなったように見えていた。共有リンクで受け取った側も
   * 同じ状態で、しかも `render()` が先頭で選択を解くため開いた行に目印も付かなかった。 */
  const app = siteRuntime("app.js");
  const body = (name: string) => {
    const at = app.indexOf(`function ${name}(`);
    expect(at, `function ${name} が見つからない（検査が空振り）`).toBeGreaterThan(0);
    let depth = 0;
    let started = false;
    for (let i = at; i < app.length; i++) {
      if (app[i] === "{") {
        depth++;
        started = true;
      } else if (app[i] === "}") {
        depth--;
        if (started && depth === 0) return app.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced: ${name}`);
  };
  // 前提: render() は選択と描画位置を戻す（顺序の要求はこれに由来する）。
  const renderBody = body("render");
  expect(renderBody).toContain("drawn = 0;");
  expect(renderBody).toContain("selectedIndex = -1;");
  // `j` / ↓: 選択を進めたら、描画をそれから追いつかせてから目印を動かす。
  const jBranch = /selectedIndex\+\+;[\s\S]{0,160}/.exec(app)?.[0] ?? "";
  expect(jBranch, "j の選択移動が描画に追いついていない（見えない行を選ぶまま）").toContain(
    "ensureRowsDrawn(selectedIndex)",
  );
  expect(jBranch.indexOf("ensureRowsDrawn")).toBeLessThan(jBranch.indexOf("updateRowSelection"));
  // `d`: フォーカス先の行が存在する必要がある。
  expect(
    /e\.key === "d" && selectedIndex >= 0[\s\S]{0,600}?ensureRowsDrawn\(selectedIndex\);/.test(app),
    "d が未描画の行に対してフォーカス先を探している",
  ).toBe(true);
  /* 共有リンクの受け取り側: render → 選択 → 描画 → 目印 → 詳細 の順。
   * 第 156 回で render は分岐の中に置く形になった（既定に出ていない行は条件を外して
   * 作り直すため）。守るべきは「render の後に目印を付ける」なので、render の呼び出しが
   * 何箇所あっても最後に走る物が選択より前であることを見る。 */
  const restore = body("restoreDrawerFromUrl");
  const marks = [
    restore.lastIndexOf("render();"),
    restore.indexOf("selectedIndex = idx;"),
    restore.indexOf("ensureRowsDrawn(idx);"),
    restore.indexOf("updateRowSelection();"),
    // 表に出さない種別の枝にも `openDrawer` がある（第 156 回）。見るのは末尾の
    // 「描き終えた後に目印を付けてから詳細を開く」手順なので最後を見る。
    restore.lastIndexOf("openDrawer("),
  ];
  expect(marks, "受け取り側の復元の手順が揃っていない").toEqual(
    [...marks].map((_, i) => (i === 0 ? marks[0] : marks[i])).map((v) => v),
  );
  for (let i = 1; i < marks.length; i++) {
    expect(marks[i], `復元の手順 ${i} 番目が見当たらない`).toBeGreaterThan(marks[i - 1]);
  }
  // 実行検証: 描画済みを越えるindexを頼むと、足りるまで描き、末尾では以上描かない。
  const script = [
    "let drawn = 0;",
    "const shown = { length: 95 };",
    "const PAGE = 40;",
    "let calls = 0;",
    "function drawMore() {",
    "  calls += 1;",
    "  if (calls > 200) throw new Error('ended rows keep drawing');",
    "  drawn = Math.min(drawn + PAGE, shown.length);",
    "}",
    `const ensureRowsDrawn = (${jsFunction(app, "ensureRowsDrawn")});`,
    "const steps = [];",
    "ensureRowsDrawn(5);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(41);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(94);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(94);",
    "steps.push([drawn, calls]);",
    "ensureRowsDrawn(500);",
    "steps.push([drawn, calls]);",
    "console.log(JSON.stringify(steps));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  // 40 行ずつ描かれる: 5 → 40、41 → 80、94 → 95（全行）、リピートでも増えない、
  // 全体より遠いindexを頼んでも 95 行で止まる（絞り込み後の行数を越えて描かない）。
  expect(JSON.parse(proc.stdout)).toEqual([
    [40, 1],
    [80, 2],
    [95, 3],
    [95, 3],
    [95, 3],
  ]);
});

it("公式ページの URL を検索欄に貼るとその会議が見つかる（SPEC §7）", () => {
  /* メーリングリストで CFP のリンクを受け取った人が、検索欄にその URL を貼って収録確認を
   * していた。会議の検索語（hay）に URL が無く、照合側も URL を語に分解してしまうので
   * 0 件になり、収録されていないと誤解していた（2026-09-23 実測: ビルド後の `searchMatcher` で
   * 「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」は 0 行）。 */
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  // 実行検証 1: URL からホストの成分を取り出す式そのもの。
  const script = [
    `const hostFromUrl = (${jsFunction(rec, "hostFromUrl")});`,
    `const hostLabels = (${jsFunction(rec, "hostLabels")});`,
    `const linkSearchTerms = (${jsFunction(rec, "linkSearchTerms")});`,
    "const urls = [",
    "  'https://warwick.ac.uk/fac/sci/dcs/aamas2027/',",
    "  'http://www.kyoto.example.ac.jp/index.html',",
    "  'https://asiaccs2027.cityu.edu.mo:8443/index.html',",
    "  'ftp://mail.server.example.org/pub',",
    "  '',",
    "];",
    "console.log(JSON.stringify({",
    "  hosts: urls.map((u) => hostFromUrl(u)),",
    "  terms: urls.map((u) => linkSearchTerms(u)),",
    "  // 2 文字以下の成分（`ac`・`jp`・`www`）を入れない約束。",
    "  shortKept: urls.some((u) => hostLabels(hostFromUrl(u)).some((p) => p.length < 3)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as { hosts: string[]; terms: string[]; shortKept: boolean };
  expect(got.hosts).toEqual([
    "warwick.ac.uk",
    "www.kyoto.example.ac.jp",
    "asiaccs2027.cityu.edu.mo",
    "mail.server.example.org",
    "",
  ]);
  expect(got.terms[0].split(" ")).toEqual(["warwick"]);
  expect(got.terms[2]).toBe("asiaccs2027 cityu edu");
  expect(got.shortKept, "2 文字以下の成分が混ざっている（短い略称の検索が誤爆する）").toBe(false);
  // 実行検証 2: ビルド後の検索で、URL を貼った人が該当会議にたどり着けるか。
  const script2 = [
    "const { default: Recommender } = await import(" +
      JSON.stringify(`file://${join(site, "recommender.js")}`) +
      ");",
    "const fs = await import('node:fs');",
    "const data = JSON.parse(fs.readFileSync(" +
      JSON.stringify(join(site, "data.json")) +
      ", 'utf8'));",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(data.conferences, now);",
    "const targets = [];",
    "for (const r of rows) {",
    "  const link = String((r.ed && r.ed.link) || '');",
    "  if (/^https?:\\/\\/[a-z0-9.-]+\\.[a-z]{2,}/i.test(link)) targets.push({ link, key: r.conf.key });",
    "  if (targets.length >= 4) break;",
    "}",
    "const out = [];",
    "for (const t of targets) {",
    "  const bare = t.link.replace(/^https?:\\/\\//, '').replace(/\\/$/, '');",
    "  const host = bare.split('/')[0];",
    "  for (const q of [t.link, bare, host]) {",
    "    const m = Recommender.searchMatcher(q, now);",
    "    const hit = rows.filter((r) => m(r.hay));",
    "    out.push({ q, hits: hit.length, self: hit.some((r) => r.conf.key === t.key) });",
    "  }",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc2 = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script2)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc2.status, proc2.stderr).toBe(0);
  const found = JSON.parse(proc2.stdout) as Array<{ q: string; hits: number; self: boolean }>;
  expect(found.length, "検査対象の URL が無かった").toBeGreaterThanOrEqual(9);
  for (const f of found) {
    expect(f.hits, `URL 検索「${f.q}」で 0 行（収録なしと誤解されるまま）`).toBeGreaterThan(0);
    expect(f.self, `URL 検索「${f.q}」で該当会議が引けない`).toBe(true);
  }
  // 案内にも同じ操作が書いてある（画面だけで増えて、てびきが古い状態を残さない）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain("URL をそのまま貼っても引けます");
});

it("URL で引いて 0 件のときは「語が無い」とは言わず収録の範囲を言う（SPEC §7）", () => {
  /* 第 153 回で URL 検索を通したので、URL を貼って 0 件になるのは「その会議が収録に無い」という
   * 意味になった。ところが 0 件案内は従来「語「〜」は収録データにありません」の形で、打った
   * 文字列を語として扱う案内をしていた（2026-09-23 実測: URL を貼った場合もこの文が出ていた）。
   * 収録の範囲（何を収めていて何が無いのか）が伝わらず、検索の仕方が悪いと誤解される。 */
  const app = siteRuntime("app.js");
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  const script = [
    "const countJa = (n) => String(n);",
    `const looksLikeUrlQuery = (${jsFunction(rec, "looksLikeUrlQuery")});`,
    `const urlLikeQueryTerms = (${jsFunction(rec, "urlLikeQueryTerms")});`,
    `const hostFromUrl = (${jsFunction(rec, "hostFromUrl")});`,
    `const hostLabels = (${jsFunction(rec, "hostLabels")});`,
    wholeTableQueryStubs(rec),
    "const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
    `const note = (${liveNoteSource(app)});`,
    // URL の形とそれ以外（日付・会議名・語の羅列）を混同しないこと。
    "const yes = ['https://www.example-university.edu/symposium-2027/cfp', 'example.ac.jp/workshop27', 'easychair.org/cfp/x'];",
    "const no = ['機械学習', 'ICDE 2026', '3/5', '研究会', ''];",
    "const mk = (q, term) => ({",
    "  hiddenKindWords: [],",
    "  termCounts: [{ term, count: 0 }],",
    "  urlQuery: looksLikeUrlQuery(q),",
    "  queryMatch: { catalog: 0, journal: 0 },",
    "  catalogConferences: 1880,",
    "  clearable: false,",
    "  pastShown: false,",
    "  hidden: { past: 10 },",
    "});",
    "console.log(JSON.stringify({",
    "  yes: yes.map((q) => [q, looksLikeUrlQuery(q)]),",
    "  no: no.map((q) => [q, looksLikeUrlQuery(q)]),",
    "  urlNote: note(mk('example.ac.jp/workshop27', 'example-university')),",
    "  wordNote: note(mk('機械学習', '機械学習')),",
    // データその物が無いときは、URL でもやはりそれを先に言う。
    "  emptyData: note({ ...mk('example.ac.jp'), catalogConferences: 0 }),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    yes: Array<[string, boolean]>;
    no: Array<[string, boolean]>;
    urlNote: string;
    wordNote: string;
    emptyData: string;
  };
  for (const [q, flag] of got.yes) expect(flag, `URL の形を URL と見分けていない: ${q}`).toBe(true);
  for (const [q, flag] of got.no)
    expect(flag, `URL ではない語を URL 扱いしている: ${q}`).toBe(false);
  expect(got.urlNote).toContain("URL の会議は収録に見当たりません");
  // 打った文字列を「語」と呼ばない（長文の URL を「語」と出してもしゃべらない）。
  expect(got.urlNote, "URL を語として扱う案内のまま").not.toContain("語「");
  // 収録の中心と、次に何を打つかも書く（0 件で操作をやめないようにする）。
  expect(got.urlNote).toContain("ランク付けの一覧");
  expect(got.urlNote).toContain("国内研究会");
  expect(got.urlNote).toContain("会議名");
  // 「下に外せる条件も書いてあります」の言いぶりは他の 0 件案内と同じ（検査で語を固定している）。
  expect(got.urlNote).toContain("下に外せる条件も書いてあります");
  // URL 以外の従来の文は変わっていない。
  expect(got.wordNote).toContain("語「機械学習」は収録データにありません");
  expect(got.emptyData).toBe(" ｜ 締切のデータが入っていません");
  // 組み込み: 検索語から判定を渡している（渡していないとこの枝は死んだまま）。
  expect(app).toContain("urlQuery: Recommender.looksLikeUrlQuery(searchQuery)");
  // てびきにも収録の範囲を書く（画面だけが増えて、案内が古いままにならないようにする）。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).toContain("URL で引いて出てこないときは、その会議は収録していません");
});

it("0 件案内の画面側も URL を「語」と呼ばず、読み上げと同じことを言う（SPEC §7）", () => {
  /* 第 154 回は読み上げ側（`zeroResultLiveNote`）だけを直した。画面に出る 0 件案内
   * （`emptyDeadlineHint`）は URL を知らず、検索語その物を引用した（2026-09-23 実測:
   * ビルド後の関数に「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」を渡すと
   * `検索語「https://warwick.ac.uk/fac/sci/dcs/aamas2027/」は収録済みで 6 件に当たります`
   * と出し、同じ画面の読み上げは「収録に見当たりません」と言っていた）。同じ画面の中で
   * 目の字と読み上げが逆のことを言い、数十文字のアドレスが読み上げられる。
   * また収録に無い URL には「その語を外すと増えます」と出していて、URL には外せる語が
   * 無いので実行不能な案内だった。 */
  const app = siteRuntime("app.js");
  const script = [
    "const countJa = (n) => String(n);",
    wholeTableQueryStubs(siteRuntime("recommender.js")),
    "const Recommender = { wholeTableQueryWordJa, wholeTableQueryNoteJa, columnQueryNoteJa, columnQueryLiveNoteJa, uiWordNoteJa, uiWordLiveNoteJa, dayRangeNoteJa, dayRangeLiveNoteJa };",
    `const hint = (${jsFunction(app, "emptyDeadlineHint")});`,
    `const note = (${jsFunction(app, "zeroResultLiveNote")});`,
    "const mk = (o) => Object.assign({",
    "  window: '', past: false, cats: 0, domestic: false, online: false,",
    "  rank: '', kind: '', est: false, hidden: {}, query: '',",
    "  hiddenKindWords: [], queryMatch: { catalog: 0, journal: 0 },",
    "  termCounts: [], urlQuery: false, catalogConferences: 1880,",
    "  clearable: false, pastShown: false,",
    "}, o);",
    "const url = 'https://warwick.ac.uk/fac/sci/dcs/aamas2027/';",
    "const cases = {",
    "  // ドメインが収録に無い URL。",
    "  missing: mk({",
    "    query: 'https://www.example-university.edu/symposium-2027/cfp',",
    "    urlQuery: true,",
    "    termCounts: [{ term: 'example-university', count: 0 }, { term: 'edu', count: 40 }],",
    "  }),",
    "  // ドメインが収録に当たっているのに、いまの条件で 0 件の URL。",
    "  present: mk({",
    "    query: url,",
    "    urlQuery: true,",
    "    queryMatch: { catalog: 6, journal: 0 },",
    "    termCounts: [{ term: 'warwick', count: 6 }],",
    "  }),",
    "  // 語を並べた従来の検索語（挙動を変えない）。",
    "  words: mk({",
    "    query: '機械学習 福岡 GPU',",
    "    termCounts: [",
    "      { term: '機械学習', count: 494 },",
    "      { term: '福岡', count: 8 },",
    "      { term: 'GPU', count: 0 },",
    "    ],",
    "  }),",
    "};",
    "const out = {};",
    "for (const [k, f] of Object.entries(cases)) out[k] = { screen: hint(f), live: note(f) };",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as Record<string, { screen: string; live: string }>;
  // 画面側も URL を「語」と呼ばない。
  expect(got.missing.screen).toContain("URL の会議は収録に見当たりません");
  expect(got.missing.screen, "URL を語として外す案内のまま").not.toContain(
    "その語を外すと増えます",
  );
  expect(got.missing.screen).toContain("ランク付けの一覧");
  // 同じ画面の読み上げと目の字が同じことを言う（前回までの矛盾）。
  expect(got.missing.live).toContain("URL の会議は収録に見当たりません");
  // ドメインが収録済みなら「収録に無い」とは言わない（前回まで読み上げ側が噓をついていた）。
  expect(got.present.screen).toContain("その URL のドメインは収録済みで 6 件");
  expect(got.present.screen).not.toContain("収録に見当たりません");
  expect(got.present.live).not.toContain("収録に見当たりません");
  // 数十文字のアドレスをそのまま引用しない（読み上げでも目の字でも読みにくい）。
  expect(got.present.screen, "URL をそのまま引用している").not.toContain("warwick.ac.uk/fac");
  expect(got.missing.screen).not.toContain("example-university.edu/symposium");
  // 語の検索語の案内はそのまま。
  expect(got.words.screen).toContain("検索語のうち「GPU」は収録データにも見当たりません");
  expect(got.words.live).toContain("語「GPU」は収録データにありません");
  // 両方に同じ判定が渡っている（片方だけ直す状態を許さない）。
  expect(jsFunction(app, "emptyDeadlineHint")).toContain("filter.urlQuery");
  expect(jsFunction(app, "zeroResultLiveNote")).toContain("filter.urlQuery");
});

it("既定に出ていない行の共有リンクを踏んだら、条件を外してその行を開く（SPEC §7）", () => {
  /* 行の詳細のURL（`?row=`）は、その行が既定の一覧に出ていないと黙って何もしなかった
   * （2026-09-23 実測: `restoreDrawerFromUrl` の本体は `shown` に見当たらなければ `return`
   * するだけ。ビルド後のデータで数えると、行の共有キー 3,207 件のうち既定の一覧に
   * 出る物は 475 件だけで、残り 2,732 件 – 過ぎた締切 2,295 件・推定 134 件・表に出さない
   * 種別 303 件 – へのリンクを踏んでも一覧が出るだけだった）。論文のメモに残った
   * 去年の締切のリンクを踏む操作は普通にあるので、外せる条件は自分で外して見せる。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    // 抜き出した app の関数は `Recommender.` を呼ぶので、同じ 1 本を別名でも置いてやる（第 225 回）。
    "const Recommender = Rec;",
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const loosenSharedRowConditions = (${jsFunction(app, "loosenSharedRowConditions")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    // 抜き出した関数が参照する自由変数は、必ず上のスコープに置く（第 143 回の教訓）。
    /const SELECTABLE_KINDS = \[[^\]]*\];/.exec(app)?.[0],
    "const rows = Rec.candidateRows(data.conferences, now);",
    // 分類が画面の判定（rowIsPast）と食い違わないこと。
    "let disagree = 0;",
    "for (const r of rows) {",
    "  const want = rowIsPast(r, now) ? 'past' : r.est ? 'est' : 'other';",
    "  if (sharedRowState(r, now) !== want) disagree += 1;",
    "}",
    // 配線の実行。一覧の作り直し（render）は画面と同じ規則 – 推定を含まない・
    // 表に出す種別だけ・過ぎた締切はチェックがオンのときだけ – で、判定自体は
    // ビルド済みの `rowIsPast` を使う。
    "globalThis.Date = { now: () => now };",
    // `mode` は締切の一覧の画面（行の詳細を開ける画面）で受け取った場合。
    "let state = { past: false, est: false, mode: 'deadlines' };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "let selectedIndex = -1;",
    "const toForm = () => { calls.push('toForm:' + state.past + '/' + state.est); };",
    "const render = () => {",
    "  selectedIndex = -1;",
    "  shown = rows.filter((r) =>",
    "    (state.est || !r.est) &&",
    "    ['abstract', 'paper', 'journal'].includes(r.kind) &&",
    "    (state.past || !rowIsPast(r, now)));",
    "};",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select:' + selectedIndex); };",
    "const openDrawer = (r) => { calls.push('open:' + rowShareKeyJa(r)); };",
    "const live = {};",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const run = (key, initial) => {",
    "  state = { past: false, est: false, mode: 'deadlines' };",
    "  shown = initial;",
    "  calls = [];",
    "  delete live.v;",
    "  pendingDrawerKey = key;",
    "  restoreDrawerFromUrl();",
    "  return { state, calls, live: live.v || '' };",
    "};",
    "const first = (pred) => rows.filter(pred)[0];",
    "const pastRow = first((r) => !r.est && rowIsPast(r, now) && r.kind === 'paper');",
    "const estRow = first((r) => r.est && r.kind === 'paper');",
    "const hiddenKindRow = first((r) => !r.est && !rowIsPast(r, now) && r.kind === 'notification');",
    "const out = {};",
    "out.disagree = disagree;",
    "out.past = run(rowShareKeyJa(pastRow), []);",
    "out.pastKey = rowShareKeyJa(pastRow);",
    "out.est = run(rowShareKeyJa(estRow), []);",
    "out.estKey = rowShareKeyJa(estRow);",
    "out.hiddenKind = run(rowShareKeyJa(hiddenKindRow), []);",
    "out.hiddenKindKey = rowShareKeyJa(hiddenKindRow);",
    "out.missing = run('kaminari-2099-not-recorded#x', []);",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    disagree: number;
    past: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    pastKey: string;
    est: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    estKey: string;
    hiddenKind: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
    hiddenKindKey: string;
    missing: { state: { past: boolean; est: boolean }; calls: string[]; live: string };
  };
  expect(got.disagree, "行の分類が画面の「過ぎた締切」の判定と食い違っている").toBe(0);
  // 過ぎた締切のリンク: 「過去の締切も表示」を外して（チェック欄にも出して）行を開く。
  expect(got.past.state.past, "過ぎた締切のリンクで「過去の締切も表示」が入らない").toBe(true);
  expect(got.past.state.est, "推定まで巻き込んで外している").toBe(false);
  expect(got.past.calls, "チェック欄を書き直していない（外れたことが画面に出ない）").toContain(
    "toForm:true/false",
  );
  expect(got.past.calls).toContain(`open:${got.pastKey}`);
  expect(got.past.live, "見つかっているのに「見つかりません」を流している").toBe("");
  // 推定のリンク: 同じやり方で「推定締切を含める」だけを外す。
  expect(got.est.state.est).toBe(true);
  expect(got.est.state.past, "過ぎた締切まで巻き込んで外している").toBe(false);
  expect(got.est.calls).toContain(`open:${got.estKey}`);
  // 表に出さない種別（採否通知・カメラレディなど）: 絞り込みの問題ではないので、
  // 「条件を確認してください」とは言わず、その行を開く。
  expect(got.hiddenKind.state.past, "表に出さない種別で過去表示を外している").toBe(false);
  expect(got.hiddenKind.state.est, "表に出さない種別で推定を外している").toBe(false);
  expect(got.hiddenKind.calls).toContain(`open:${got.hiddenKindKey}`);
  expect(got.hiddenKind.live).toContain("表に出さない種別");
  expect(got.hiddenKind.live).not.toContain("絞り込み");
  // 収録に無いキー: 開かず、その旨をそのまま出す（黙ったままにしない）。
  expect(got.missing.calls).toEqual([]);
  expect(got.missing.live).toContain("この収録に見当たりません");
  // てびきにも同じ振る舞いを書く。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "共有リンクの振る舞いがてびきに無い").toContain(
    "その行のために条件を自分から外して",
  );
});

it("投稿先を探す画面に切り替えると行の詳細を閉じ、その URL を受け取っても噓を言わない（SPEC §7）", () => {
  /* 行の詳細（`?row=`）を開いたまま「投稿先を探す」に切り替えると、ドロワーは閉じられず
   * `?row=` が推薦画面の URL に残った（`writeUrl` はモードを見ずに `row`を書く – 2026-08-09
   * 実測: `setMode` の本体にドロワーを閉じる箇所が無かった）。その URL を受け取った人は、
   * 表が描かれない画面で行を探そうとして、収録されている行なのに
   * 「共有された行はこの収録に見当たりません。データの更新で無くなった可能性があります」
   * と読まされていた（第 156 回で入れた「見つかりません」の文が、画面をまたぐと
   * むしろ噓になった）。条件（過去の締切も表示）を勝手に外してもいた。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  // 配線の検査: 推薦画面で受け取ったときに何もしないこと。
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    // 抜き出した app の関数は `Recommender.` を呼ぶので、同じ 1 本を別名でも置いてやる（第 225 回）。
    "const Recommender = Rec;",
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    "const rows = Rec.candidateRows(data.conferences, now);",
    "globalThis.Date = { now: () => now };",
    "let state = { past: false, est: false, mode: 'recommend' };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "const toForm = () => { calls.push('toForm'); };",
    "const render = () => { calls.push('render'); };",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select'); };",
    "const openDrawer = () => { calls.push('open'); };",
    "const live = {};",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const pastRow = rows.filter((r) => !r.est && rowIsPast(r, now) && r.kind === 'paper')[0];",
    "pendingDrawerKey = rowShareKeyJa(pastRow);",
    "restoreDrawerFromUrl();",
    "console.log(JSON.stringify({",
    "  recorded: rows.some((r) => rowShareKeyJa(r) === pendingDrawerKey),",
    "  calls, live: live.v || '', pastFlipped: state.past, estFlipped: state.est,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    recorded: boolean;
    calls: string[];
    live: string;
    pastFlipped: boolean;
    estFlipped: boolean;
  };
  expect(got.recorded, "検査に使える収録済みの行が無かった").toBe(true);
  // 収録されている行について「収録に無い」と言わない（噓の文を流さない）。
  expect(got.live).not.toContain("この収録に見当たりません");
  expect(got.live).toContain("投稿先を探す画面では行を開きません");
  // 表の画面に戻れば開けることを言う（操作を止めない）。
  expect(got.live).toContain("締切の一覧に戻すと開けます");
  // 条件を勝手に外さない。
  expect(got.pastFlipped, "推薦画面で「過去の締切も表示」を外している").toBe(false);
  expect(got.estFlipped, "推薦画面で「推定締切を含める」を外している").toBe(false);
  expect(got.calls, "表の無い画面で一覧を描き直している").toEqual([]);
  // 発生源: モードを変えたら開いていた行を閉じる（`?row=` を推薦画面の URL に残さない）。
  const setMode = jsFunction(app, "setMode");
  // ビルド後の整形で改行が入るので、形では見る（開いていた行を閉じる呼び出しがあること）。
  expect(
    /if \(drawerRow\)\s*\n?\s*closeDrawer\(\);/.test(setMode),
    "モード変更時にドロワーを閉じていない",
  ).toBe(true);
  expect(setMode.indexOf("closeDrawer()")).toBeLessThan(setMode.indexOf("state.mode ="));
});

it("語に付いた疑問符・括弧で検索が 0 件にならない（SPEC §7）", () => {
  /* 画面の文字列は括弧や句読点を含む（`Lodz, Po (Poland)`、種別セルの「(AoE)」など）。
   * 従来はそれらを語の成分として扱っていたので、文末に疑問符を打ちただけで 0 件になった
   * （2026-08-09 実測: `ICDE` は 18 行、`ICDE？` と `ICDE?` は 0 行、`ICDE (2027)` と
   * `ICDE（2027）` も 0 行、`sigcomm.` も 0 行）。0 件案内は収録されているのに
   * `語「icde？」は収録データにありません` と出し、検索の仕方のせいだと誤解させた。
   * 逆に記号だけを入力に含む絞りは効いてしまい（`-` は 3,123 行・`（）` は 504 行・
   * `＋` は 85 行）、同じ種類の入力が三通りに割れていた。 */
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Rec.candidateRows(data.conferences, now);",
    "const hays = rows.map((r) => r.hay);",
    "const count = (q) => {",
    "  const m = Rec.searchMatcher(q, now);",
    "  return rows.filter((r) => m(r.hay)).length;",
    "};",
    // ビルド後の収録から語を取り出して、その周りに記号を置く（語を hardcoded しない）。
    "const withTerm = rows.find((r) => {",
    "  const t = String(r.conf.key || '').split('-').find((p) => /^[a-z]{4,}$/.test(p));",
    "  return !!t && count(t) > 0 && count(t) < rows.length;",
    "});",
    "const term = String(withTerm.conf.key).split('-').find((p) => /^[a-z]{4,}$/.test(p));",
    "const forms = [term, '？' + term, term + '？', term + '?', '（' + term + '）', '(' + term + ')', term + '.', term + '。'];",
    "const hits = forms.map((q) => ({ q, n: count(q), self: (() => { const m = Rec.searchMatcher(q, now); return rows.some((r) => m(r.hay) && r.conf.key === withTerm.conf.key); })() }));",
    // 記号だけの入力は「何も打っていない」と同じ（三通りに割れない）。
    "const symbols = ['-', '（）', '()', '...', '＋', '？', '?', '；', '～'];",
    "const symCounts = symbols.map((q) => count(q));",
    // 語の成分になり得る記号（`+`）は端にあっても削らない。
    "const plus = { c: count('c'), cpp: count('c++') };",
    // 0 件案内は語を名指すが、記号だけの入力で「語」を作らない。",
    "const symTerms = Rec.queryTermCounts('（）', hays, now);",
    "const termNote = Rec.queryTermCounts(term + '？', hays, now).map((t) => t.term);",
    "console.log(JSON.stringify({ term, hits, symCounts, total: rows.length, plus, symTerms, termNote }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    term: string;
    hits: Array<{ q: string; n: number; self: boolean }>;
    symCounts: number[];
    total: number;
    plus: { c: number; cpp: number };
    symTerms: Array<{ term: string }>;
    termNote: string[];
  };
  expect(got.hits[0].n, "基準の語その物が引けない").toBeGreaterThan(0);
  for (const h of got.hits) {
    expect(h.n, `語に記号を付けただけの検索語「${h.q}」が 0 行`).toBeGreaterThan(0);
    expect(h.self, `検索語「${h.q}」で元の行が引けない`).toBe(true);
  }
  // 記号だけ（・記号だけを重ねた入力）は全件。全部が同じ数になる。
  for (const [i, n] of got.symCounts.entries()) {
    expect(n, `記号だけの入力の件数がバラバラ（${i} 番目）`).toBe(got.total);
  }
  expect(got.symTerms, "記号だけから語を作って 0 件案内に載せる").toEqual([]);
  // 疑問符を取った語として数える（案内が「語「icde？」」にならない）。
  expect(got.termNote).toEqual([got.term]);
  // `C++` の語尾の `+` を削ると `c` に化けて別物になる（実測で 0 件 → 745 行）。
  expect(got.plus.cpp, "語尾の + が削られて `c` と同じ検索になっている").not.toBe(got.plus.c);
});

it("行の詳細の公式確認は内部表記のまま見せない（SPEC §7）", () => {
  /* 行の詳細の「公式確認」欄は、収録データの値をそのまま出していた（2026-08-09 実測:
   * ビルド後の data.json で `verification.source_class` が `unknown` の締切 236 件は
   * 「確認元: unknown」と出ていた。`verifiedFields` は項目名そのもので
   * `date・kind・round` 15 件、`date` 8 件、`date・kind` 5 件など 33 件。
   * 項目その物が無い行の既定値は「日付・時刻・タイムゾーン」と日本語なので、
   * 同じ欄の中で日本語と機械の表記が混ざっていた。 */
  const app = siteRuntime("app.js");
  const script = [
    verificationLabelsSource(),
    "const esc = (x) => String(x);",
    `const verificationSummary = (${jsFunction(app, "verificationSummary")});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    // ビルド後の収録すべてに対して、画面に出る語を集める。
    "const src = {}; const fld = {}; let n = 0;",
    "for (const c of data.conferences)",
    "  for (const ed of c.editions || [])",
    "    for (const dl of ed.deadlines || []) {",
    "      const v = dl.verification; if (!v) continue; n += 1;",
    "      const html = verificationSummary(dl);",
    "      const a = (html.match(/確認元<\\/b> ([^<]*)/) || [, '(なし)'])[1];",
    "      const b = (html.match(/確認範囲<\\/b> ([^<]*)/) || [, '(なし)'])[1];",
    "      src[a] = (src[a] || 0) + 1;",
    "      fld[b] = (fld[b] || 0) + 1;",
    "    }",
    // 知らない項目名を勝手に翻訳しない約束（合成の入力で見る）。
    "const mystery = verificationSummary({",
    "  verification: { status: 'verified', source_class: 'mystery-source' },",
    "  evidence: [{ verifiedFields: ['date', 'mystery_field'] }],",
    "});",
    "const onlySelector = verificationSummary({",
    "  verification: { status: 'verified', selector_or_field: 'table-row:deadline' },",
    "  evidence: [],",
    "});",
    "console.log(JSON.stringify({ n, src, fld, mystery, onlySelector }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    n: number;
    src: Record<string, number>;
    fld: Record<string, number>;
    mystery: string;
    onlySelector: string;
  };
  expect(got.n, "検査できる確認付きの締切が無かった").toBeGreaterThan(0);
  // 英文字だけの語（機械の表記）をそのまま出さない。`公式CFP` のように和英混在は許す。
  const asciiOnly = (value: string) => /^[a-z0-9 ._:/+-]+$/i.test(value);
  const badSrc = Object.keys(got.src).filter(asciiOnly);
  expect(badSrc, `確認元に内部表記が残っている: ${badSrc.join(" / ")}`).toEqual([]);
  const badFld = Object.keys(got.fld).filter(asciiOnly);
  expect(badFld, `確認範囲に内部表記が残っている: ${badFld.join(" / ")}`).toEqual([]);
  // `unknown` を機械の表記のまま出さない（中身を推測して「記録なし」などとは書かない）。
  const countOf = (map: Record<string, number>, key: string): number => map[key] ?? 0;
  expect(countOf(got.src, "unknown"), "unknown がそのまま出ている").toBe(0);
  /* 「分からない」を出す語は 未確認 / 該当なし / 評価なし に揃える画面の約束がある
   * （てびきの「未確認」の項）。第 159 回では一時「不明」を入れてしまった
   * （2026-08-09 実測: ビルド後に利用者へ出る「不明」はその 1 箇所だけで、てびきに無い語。
   * 同じ種の欠陥は 2026-09-23 にもある – カードだけが「受付状況不明」と出て直している）。 */
  expect(countOf(got.src, "不明"), "てびきに無い「不明」を出している").toBe(0);
  expect(countOf(got.fld, "不明"), "てびきに無い「不明」を出している").toBe(0);
  expect(
    countOf(got.src, "未確認"),
    "unknown をてびきの語（未確認）に寄せていない",
  ).toBeGreaterThan(0);
  // てびきが、公式確認の欄で同じ語を使うことを載せている（画面の語が案内に有る）。
  const help = readFileSync(join(site, "index.html"), "utf8");
  const entry = help.slice(help.indexOf("<dt>未確認</dt>"));
  const dd = entry.slice(0, entry.indexOf("</dd>"));
  expect(dd.replace(/<[^>]*>/g, ""), "てびきが確認元で同じ語を使うことを書いていない").toContain(
    "確認元",
  );
  // 収録の実データで確認範囲が日本語化されている。
  expect(
    Object.keys(got.fld).filter((k) => k.includes("日付")).length,
    "確認範囲が日本語化されていない",
  ).toBeGreaterThan(0);
  // 知らない語は翻訳せずそのまま残す（無い語を作らない）。
  expect(got.mystery).toContain("日付・mystery_field");
  expect(got.mystery).toContain("mystery-source");
  // 機械の判定名しか無い行は、それが読み取り箇所だと分かる言い方にする。
  expect(got.onlySelector).toContain("公式ページ内の表の締切欄");
});

it("行の詳細の公式確認の日時は利用者の端末の時刻合わせに左右されない（SPEC §7）", () => {
  /* 表の日時は `fmtJst` が +09:00 固定で計算し、ヘッダーにも「日時は JST で出しています」と
   * 書いてある。行の詳細の公式確認の欄だけが `toLocaleString("ja-JP")` を使っていて、
   * これは利用者の端末の時刻合わせで変わる（2026-08-09 実測: `2026-08-01T18:30:00Z` が
   * TZ=UTC で `2026/8/1 18:30:00`、TZ=Asia/Tokyo で `2026/8/2 3:30:00`、
   * TZ=America/Los_Angeles で `2026/8/1 11:30:00`。次回確認予定は
   * `2026/8/9 21:00` と `2026/8/10 6:00` に分かれ、日付その物がずれた）。
   * 出張先で端末を現地に合わせる人は珍しくなく、そのとき同じ行の表と詳細が違う日時を
   * 書く。`toLocaleString` は数の区切りでも既に避けることにしてある（`countJa` の comment）。 */
  const app = siteRuntime("app.js");
  const script = [
    verificationLabelsSource(),
    "const esc = (x) => String(x);",
    // `fmtJst` は `pad` と `WEEKDAY_JA` を使うので、もろもろビルド成果から取る。
    /const WEEKDAY_JA = \[[^\]]*\]/.exec(app)?.[0] ?? "",
    `const pad = (${jsFunction(app, "pad")});`,
    `const fmtJst = (${jsFunction(app, "fmtJst")});`,
    `const verificationSummary = (${jsFunction(app, "verificationSummary")});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    // 1) 表示の語: JST のラベルを付けて、一覧と同じ形（`2026-08-02(日) 03:30 JST`）で出す。
    "const probe = verificationSummary({",
    "  verification: {",
    "    last_verified_at: '2026-08-01T18:30:00Z',",
    "    next_check_at: '2026-08-09T21:00:00Z',",
    "    source_class: 'official-cfp',",
    "    status: 'verified',",
    "  },",
    "  evidence: [],",
    "});",
    "const shown = (label) => (probe.match(new RegExp('<b>' + label + '</b> ([^<]*)')) || [, ''])[1];",
    // 2) 収録の全タイムスタンプで `fmtJst` と同じ結果になること（書き写しのズレを見る）。
    "const stamps = [];",
    "let compared = 0; let agreed = 0;",
    "for (const c of data.conferences)",
    "  for (const ed of c.editions || [])",
    "    for (const dl of ed.deadlines || []) {",
    "      const v = dl.verification; if (!v) continue;",
    "      for (const key of ['last_verified_at', 'next_check_at']) {",
    "        const raw = v[key]; if (typeof raw !== 'string' || !raw) continue;",
    "        compared += 1;",
    "        const out = verificationSummary({ verification: v, evidence: [] });",
    "        const want = fmtJst(new Date(raw));",
    "        if (out.includes(want)) agreed += 1;",
    "        else if (stamps.length < 3) stamps.push({ key, raw, want });",
    "      }",
    "    }",
    "console.log(JSON.stringify({",
    "  tz: process.env.TZ || '', 確認: shown('公式確認'), 次回: shown('次回確認予定'),",
    "  compared, agreed, stamps,",
    "}));",
  ].join("\n");
  const run = (tz: string) =>
    spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, TZ: tz },
    });
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];
  const results = zones.map((tz) => {
    const proc = run(tz);
    expect(proc.status, `${tz}: ${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout) as {
      tz: string;
      確認: string;
      次回: string;
      compared: number;
      agreed: number;
      stamps: unknown[];
    };
  });
  // 端末の時刻合わせが変わっても、出る日時が変わらない。
  const first = results[0];
  for (const [i, got] of results.entries()) {
    expect(got.確認, `${zones[i]} で公式確認の日時が変わった`).toBe(first.確認);
    expect(got.次回, `${zones[i]} で次回確認予定の日時が変わった`).toBe(first.次回);
  }
  // 一覧と同じ形（`-` 区切りの日付・曜日・時刻・JST の語）。
  expect(first.確認, "JST を名乗らない、または一覧と違う形の日時になっている").toMatch(
    /^\d{4}-\d{2}-\d{2}\([日月火水木金土]\) \d{2}:\d{2} JST$/,
  );
  // 収録の実データで一覧の計算式と一致する（内側の書き写しがズレていない）。
  expect(first.compared, "検査できるタイムスタンプが無かった").toBeGreaterThan(0);
  expect(first.agreed, `fmtJst と違う日時を出している: ${JSON.stringify(first.stamps)}`).toBe(
    first.compared,
  );
});

it("CSV のファイル名の日は端末の時刻合わせに左右されない（SPEC §7）", () => {
  /* ファイル名 `kamiyobi-deadlines-<YYYYMMDD>.csv` の日付は `new Date()` のローカル日付を
   * 使っていた（2026-08-09 実測: JST で 8/10 0:30 の瞬間に保存すると、UTC の端末では
   * `kamiyobi-deadlines-20260809.csv`、日本の端末では `kamiyobi-deadlines-20260810.csv`）。
   * このサイトは「日時は JST で出しています」と宣言し、一覧の日付も JST 固定で計算して
   * いるので、同じ日に保存したファイルの日付が人によってズレた（夜に締切をまとめる、
   * 出張先で端末を現地に合わせる、で起きます）。 */
  const app = siteRuntime("app.js");
  const script = [
    "const RealDate = Date;",
    // 保存した瞬間を固定する（この瞬間は JST と UTC で日付が違うことを下に確かめる）。
    "const FIXED = RealDate.parse('2026-08-09T15:30:00Z');",
    "globalThis.Date = class extends RealDate {",
    "  constructor(...a) { if (a.length) super(...a); else super(FIXED); }",
    "  static now() { return FIXED; }",
    "};",
    "let downloaded = '';",
    "globalThis.Blob = class { constructor(parts) { this.parts = parts; } };",
    "globalThis.URL = { createObjectURL: () => 'blob:fake' };",
    "globalThis.document = {",
    "  createElement: () => ({ click() {}, set download(v) { downloaded = v; }, get download() { return downloaded; } }),",
    "  body: { appendChild() {}, removeChild() {} },",
    "};",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const exportShownCsv = (${jsFunction(app, "exportShownCsv")});`,
    "const shown = [{ t: FIXED, conf: { key: 'demo', title: 'Demo', categories: [] }, ed: { year: 2026 }, dl: { kind: 'paper' }, kind: 'paper' }];",
    "exportShownCsv();",
    // 基準: 同じ瞬間の JST の日付（+09:00 で数える。画面の日時の数え方と同じ）。
    "const jst = new RealDate(FIXED + 9 * 3600000);",
    "const utc = new RealDate(FIXED);",
    // 注入する文字列の中ではテンプレート相当の記号を使わない（lint の指摘が増えるため、
    // 連結で同じ日付の組み立てを書く）。
    "const pad2 = (n) => String(n).padStart(2, '0');",
    "const fmt = (x) => String(x.getUTCFullYear()) + pad2(x.getUTCMonth() + 1) + pad2(x.getUTCDate());",
    "console.log(JSON.stringify({",
    "  tz: process.env.TZ || '', downloaded, jst: fmt(jst), utc: fmt(utc),",
    "}));",
  ].join("\n");
  const zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];
  const results = zones.map((tz) => {
    const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, TZ: tz },
    });
    expect(proc.status, `${tz}: ${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout) as { tz: string; downloaded: string; jst: string; utc: string };
  });
  // 基準の瞬間が JST と UTC で違う日であること（検査が空振りしない）。
  expect(results[0].jst === results[0].utc, "基準の瞬間が JST と UTC で同じ日になっている").toBe(
    false,
  );
  const first = results[0];
  for (const [i, got] of results.entries()) {
    expect(got.downloaded, `${zones[i]} でファイル名が変わった`).toBe(first.downloaded);
  }
  // JST の日付を使う（UTC の日付ではない）。
  expect(first.downloaded).toBe(`kamiyobi-deadlines-${first.jst}.csv`);
  expect(first.downloaded).not.toBe(`kamiyobi-deadlines-${first.utc}.csv`);
});

it("リンクについていた検索語で行が落ちていても、種別のせいにせずその行を開く（SPEC §7）", () => {
  /* `?q=…&row=…` のように、検索語行と行の目印を同時に含む URL がある（`writeUrl` は
   * モードを問わず両方を書き出す。/detail を開いたまま検索を打ち直す動きでも生まれる）。
   * 従来はその行が一覧に無い理由を「過ぎた締切」「推定」「表に出さない種別」の三つで
   * しか見ておらず、それ以外（検索語・ランク・期間窓・分野などの絞り込み）は種別のせいと
   * 誤解する文を出していた（2026-08-09 実測: 表に出る `paper` の行へのリンクで
   * 「その行は表に出さない種別（採否通知・カメラレディなど）なので…」が出ていた）。
   * 送った人の画面では出ていた行なので、受け取った側で必要最小限の条件を外して開く。 */
  const app = siteRuntime("app.js");
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    // 抜き出した app の関数は `Recommender.` を呼ぶので、同じ 1 本を別名でも置いてやる（第 225 回）。
    "const Recommender = Rec;",
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    `const rowDateOnlyState = (${jsFunction(app, "rowDateOnlyState")});`,
    `const rowIsPast = (${jsFunction(app, "rowIsPast")});`,
    `const rowShareKeyJa = (${jsFunction(app, "rowShareKeyJa")});`,
    `const sharedRowState = (${jsFunction(app, "sharedRowState")});`,
    `const sharedRowNotice = (${jsFunction(app, "sharedRowNotice")});`,
    `const loosenSharedRowConditions = (${jsFunction(app, "loosenSharedRowConditions")});`,
    `const restoreDrawerFromUrl = (${jsFunction(app, "restoreDrawerFromUrl")});`,
    // 表に出る種別の正本はセレクトの選択肢と同じ（書き写さない）。
    /const SELECTABLE_KINDS = \[[^\]]*\];/.exec(app)?.[0],
    "const rows = Rec.candidateRows(data.conferences, now);",
    "globalThis.Date = { now: () => now };",
    // 画面と同じ条件で `shown` を組み直す（`render` の代わり。検索語・推定・過去・種別）。
    // 抜き出した関数が参照する自由変数は、必ず上のスコープに置く（第 143 回の教訓）。
    "let state = { mode: 'deadlines', q: '', kind: '', rank: '', win: 'all',",
    "  est: false, domestic: false, online: false, past: false, cats: [] };",
    "let shown = [];",
    "let calls = [];",
    "let pendingDrawerKey = '';",
    "let selectedIndex = -1;",
    "const live = {};",
    // 常時受付のジャーナル行は「種別」で選んだときだけ出るので、ここでも同じにしておく。
    "const redraw = () => {",
    "  const m = Rec.searchMatcher(state.q, now);",
    "  return rows.filter((r) => (state.est || !r.est)",
    "    && (state.past || !rowIsPast(r, now))",
    "    && SELECTABLE_KINDS.indexOf(r.kind) >= 0",
    "    && (state.kind ? r.kind === state.kind : r.kind !== 'journal')",
    "    && m(r.hay));",
    "};",
    "const toForm = () => { calls.push('toForm'); };",
    "const render = () => { calls.push('render'); shown = redraw(); };",
    "const ensureRowsDrawn = () => { calls.push('draw'); };",
    "const updateRowSelection = () => { calls.push('select'); };",
    "const openDrawer = (r) => { calls.push('open:' + (r && r.kind)); };",
    "const $ = () => ({ set textContent(v) { live.v = v; }, get textContent() { return live.v || ''; } });",
    "const make = (pastRow) => {",
    "  const target = rows.filter((r) => r.kind === 'paper' && !r.est",
    "    && (pastRow ? rowIsPast(r, now) : !rowIsPast(r, now)))[0];",
    "  state = { mode: 'deadlines', q: 'zzzありえない検索語zzz', kind: '', rank: '',",
    "    win: 'all', est: false, domestic: false, online: false, past: false, cats: [] };",
    "  calls = [];",
    "  live.v = '';",
    "  shown = redraw();",
    "  pendingDrawerKey = rowShareKeyJa(target);",
    "  selectedIndex = -1;",
    "  restoreDrawerFromUrl();",
    "  return {",
    "    見つかる: shown.some((r) => rowShareKeyJa(r) === pendingDrawerKey),",
    "    calls: calls.slice(), live: live.v || '', q: state.q, past: state.past,",
    "    est: state.est, 種別: target.kind,",
    "  };",
    "};",
    "console.log(JSON.stringify({ 未来: make(false), 過去: make(true) }));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  type Got = {
    見つかる: boolean;
    calls: string[];
    live: string;
    q: string;
    past: boolean;
    est: boolean;
    種別: string;
  };
  const got = JSON.parse(proc.stdout) as { 未来: Got; 過去: Got };
  for (const key of ["未来", "過去"] as const) {
    const one = got[key];
    expect(one.種別, "検査に使った行の種別がおかしい").toBe("paper");
    // 噓の文を出さない（表に出る種別なのに種別のせいにしない）。
    expect(one.live, `${key}の行で種別のせいにしている`).not.toContain("表に出さない種別");
    expect(one.live, `${key}の行で「収録に無い」と噓を言っている`).not.toContain(
      "この収録に見当たりません",
    );
    // 外したものを名指しで書く（黙って条件を変えない）。
    expect(one.live, `${key}の行で条件を外したことを書いていない`).toContain(
      "その行を開くために、リンクについていた条件を自分から外しました",
    );
    expect(one.live, `${key}の行で検索語を名指ししていない`).toContain("検索語");
    // 本当にその行が一覧へ戻る（「行の目印が出ない」扱いにしない）。
    expect(one.見つかる, `${key}の行が一覧に戻っていない`).toBe(true);
    expect(one.calls, `${key}の行に選択の目印を付けていない`).toContain("draw");
    expect(one.calls).toContain("select");
    expect(one.calls[one.calls.length - 1]).toBe("open:paper");
    expect(one.q, "検索語が残ったままだった").toBe("");
    // 最小限だけ触る（推定の行を外していない）。
    expect(one.est, "推定の行まで外している").toBe(false);
  }
  // 過ぎた行のリンクでは「過去の締切も表示」が必要なので、それは入る。
  expect(got.過去.past, "過ぎた行のリンクで「過去の締切も表示」が入っていない").toBe(true);
  // 未来の行のリンクでまで過去表示を勝手に外さない。
  expect(got.未来.past, "未来の行のリンクで「過去の締切も表示」まで外している").toBe(false);
});

it("投稿先を探す画面の順位が無い行を横棒の記号にしない（SPEC §7）", () => {
  /* 内訳の chip と比較文は、順位が無いとき横棒（U+2014）を出していた。順位は上位の
   * 候補にだけ付く（語彙検索の順位は言葉が重なった行にだけ、意味検索の順位は上位にだけ
   * 付く）ので、この状態は珍しくない（2026-08-09 実測: ビルドした `venueRecommendations`
   * に意味検索の点を与えて候補を 200 件出すと、44 件が「順位 —」、3 件が
   * 「言葉の一致（語彙検索）で — 位」になっていた。例は `cade` で語彙 0 点・
   * 意味の近さ 0.899・意味検索 1 位）。横棒は支援技術で読まれず、値が壊れたのか
   * 順位が無いのか利用者には判別できない。 */
  const app = siteRuntime("app.js");
  const detail = jsFunction(app, "makeDetailRow");
  // 抜き出した内訳の組み立ての中に、記号だけの値が残っていないこと。
  expect(detail, "内訳に横棒の記号が値として残っている").not.toContain(`"—"`);
  expect(detail, "内訳に縦棒の記号が値として残っている").not.toContain(`"―"`);
  // 語で出す方に切り替わっている（ビルド後の成果物で確かめる）。
  expect(detail, "順位が無いことを語で書いていない").toContain("順位は出ていません");
  expect(detail, "語彙検索の点が無いことを語と実数で書いていない").toContain("点で順位は無く");
  // 記号を使わない方針は、行の詳細の比較文にも及んでいる（他の箇所に横棒が残って
  // いないか、ビルド全体を一度見る）。
  const quoted = app.match(/["'`]—["'`]/g) || [];
  expect(
    quoted,
    `ビルド後のコードに横棒だけを値にした箇所が残っている: ${quoted.length} 箇所`,
  ).toHaveLength(0);

  // 上の書き方が正しいための条件を、ビルドした検索で確かめる。
  //  (1) 語彙検索の順位は「言葉が重なった行（語彙の点が 0 より大きい行）」にだけ付く。
  //      これが崩れると「N 点で順位は無く」という文が噓になる（N が 0 ではなくなる）。
  //  (2) 順位は上位 `topN` までしか付かないので、点があっても順位が無い行が生まれる
  //      （`topN` を小さくして、収録の大きさに関わらず必ず起きることを確かめる）。
  const recPath = `file://${join(site, "recommender.js")}`;
  const dataPath = join(site, "data.json");
  const script = [
    `const { default: Rec } = await import(${JSON.stringify(recPath)});`,
    "const fs = await import('node:fs');",
    `const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Rec.candidateRows(data.conferences, now);",
    "const paper = [",
    "  'Title: Storage-efficient checkpointing for large-scale LLM training on clusters',",
    "  'Abstract: Periodic state saving with erasure coding across object stores reduces',",
    "  'bandwidth at the expense of recovery latency in HPC environments.',",
    "  'Keywords: fault tolerance, checkpointing, storage systems',",
    "].join('\\n');",
    "const lines = Rec.parsePaperLines(paper);",
    // 意味検索が動いている状態を再現する（鍵から決まる値なので実行のたびに同じになる）。
    "const sem = {};",
    "for (const r of rows) {",
    "  const key = String((r.conf && r.conf.key) || '');",
    "  if (!key) continue;",
    "  let h = 0;",
    "  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) % 10007;",
    "  sem[key] = (h % 900) / 1000;",
    "}",
    "const run = (topN) =>",
    "  Rec.venueRecommendations(rows, lines, sem, now, {",
    "    venueCats: ['hpc', 'system'],",
    "    fieldedLexical: true,",
    "    topN,",
    "  })",
    "    .filter((x) => x.fit.score >= 10)",
    "    .slice(0, 200);",
    "const wide = run(200);",
    "const narrow = run(3);",
    // (1) 語彙の順位が欠ける行は、語彙の点が 0 の行だけ。
    "let lexMismatch = 0;",
    "let lexNoRank = 0;",
    "for (const x of wide) {",
    "  if (!x.fit.lexicalRank) lexNoRank += 1;",
    "  if (Boolean(x.fit.lexicalRank) !== x.fit.lexicalScore > 0) lexMismatch += 1;",
    "}",
    // (2) 点があるのに順位が無い行（`topN` の外）。
    "let semNoRank = 0;",
    "for (const x of narrow) {",
    "  if ((x.fit.semanticScore || 0) > 0 && !x.fit.semanticRank) semNoRank += 1;",
    "}",
    "console.log(JSON.stringify({",
    "  shown: wide.length,",
    "  lexNoRank,",
    "  lexMismatch,",
    "  narrowShown: narrow.length,",
    "  semNoRank,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["--input-type=module", "-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const got = JSON.parse(proc.stdout) as {
    shown: number;
    lexNoRank: number;
    lexMismatch: number;
    narrowShown: number;
    semNoRank: number;
  };
  expect(got.shown, "候補が一件も出ない画面では検査できない").toBeGreaterThan(0);
  // (1) 「N 点で順位は無く」が噓にならないこと（順位が無い行の語彙の点は必ず 0）。
  expect(got.lexMismatch, "語彙の順位の有無と点の一致が崩れた（文を見直す）").toBe(0);
  // (2) 点があっても順位が無い行が実際に生まれる（無くなったら語で書く案内ごと見直す）。
  expect(got.narrowShown, "候補が出ない画面では検査できない").toBeGreaterThan(0);
  expect(got.semNoRank, "順位が欠ける行が生まれなくなった（案内ごと見直す）").toBeGreaterThan(0);
});

it("効いているキーと画面のショートカット案内・てびきの並び替えの導線がズレない（SPEC §7）", () => {
  /* `onKeydown` は `j` / `k` のほかに `ArrowUp` / `ArrowDown` も選択行の移動に使って
   * いるのに、画面の案内（「ショートカット: j / k 選択 | …」）とてびきのキーボードの項の
   * どちらにも矢印が出ていなかった（2026-08-09 実測: 処理しているキーは
   * `/`・`ArrowDown`・`ArrowUp`・`Enter`・`Escape`・`d`・`j`・`k` の 8 種で、案内は 6 種）。
   * また列の見出しは `tabindex="0"` + `Enter` / `スペース` で並び替えが効くのに、
   * てびきはマウスで「押す」話しか書いておらず、キーボードだけの利用者には
   * 並び替えの導線が届いていなかった。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 1) ビルド後のコードが実際に受け取っているキーの集合。
  const handler = jsFunction(app, "onKeydown");
  const handled = [
    ...new Set(
      [...handler.matchAll(/e\.key === "([^"]+)"/g)].map((m) => (m[1] === undefined ? "" : m[1])),
    ),
  ].filter((k) => k !== "");
  expect(handled.sort(), "想定していないキーの受け取り方になった（案内も直す）").toEqual(
    ["/", "ArrowDown", "ArrowUp", "Enter", "Escape", "d", "j", "k"].sort(),
  );
  // 2) 画面に出るショートカット案内が、受け取っているキーを全部書いている。
  const hint = html.slice(
    html.indexOf("ショートカット:"),
    html.indexOf("</span>", html.indexOf("ショートカット:")),
  );
  expect(hint.length, "画面のショートカット案内が見つからない").toBeGreaterThan(0);
  // 読み方の対応（矢印キーは画面では ↑ / ↓、Esc は Esc と書く）。
  const notation: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
  };
  for (const key of handled) {
    expect(hint, `画面の案内に ${key}（${notation[key] || key}）が書かれていない`).toContain(
      notation[key] || key,
    );
  }
  // 3) 並び替えの導線: 見出しがフォーカス出来て、Enter / スペースで効くこと。
  const ths = [...html.matchAll(/<th\b[^>]*data-sort="[^"]*"[^>]*>/g)].map((m) => m[0]);
  expect(ths.length, "並び替え出来る列の見出しが見つからない").toBeGreaterThan(0);
  for (const th of ths) {
    expect(th.includes('tabindex="0"'), `見出しがタブで移動できない: ${th}`).toBe(true);
  }
  expect(
    /e\.key === "Enter" \|\| e\.key === " "/.test(app),
    "見出しの Enter / スペースで並び替えが効かない",
  ).toBe(true);
  // 4) てびきのキーボードの項に、並び替えの導線が書かれていること。
  const kb = html.slice(html.indexOf('<dt class="only-keyboard">キーボードで一覧を動かす</dt>'));
  const entry = kb.slice(0, kb.indexOf("</dd>") + 5);
  expect(entry.length, "てびきのキーボードの項が見つからない").toBeGreaterThan(0);
  for (const word of ["Tab", "見出し", "並び替え", "スペース", "↑", "↓"]) {
    expect(entry, `てびきのキーボードの項に ${word} が無い`).toContain(word);
  }
  // ソートできる列の正本と見出しが一致している（案内に列名を書いたので、ズレたら気づく）。
  const keys = JSON.parse(/const SORTABLE_KEYS = (\[[^\]]*\])/.exec(app)?.[1] || "[]") as string[];
  const thKeys = ths.map((th) => /data-sort="([^"]*)"/.exec(th)?.[1] || "");
  expect([...thKeys].sort()).toEqual([...keys].sort());
});

it("データ生成からの日数は JST の暦日で数える（SPEC §7）", () => {
  /* 「データは N 日前に生成されたものです」の N が経過 24 時間で数えていた。
   * この画面は生成時刻も一覧の日時も JST で出していて、「残り」も JST の暦日が正本
   * なので、生成時刻の直後に並ぶ「N 日前」だけ別単位で数えると隣に書いた日時と
   * 合わなかった。ビルドした `dataAgeNoteJa` で実測:
   *   JST 8/6 23:00 生成 → JST 8/9 01:00 閲覧: 経過 2 日（旧: 警告なし）/ 暦日 3 日（新: 警告）
   *   JST 8/6 23:00 生成 → JST 8/10 00:30 閲覧: 経過 3 日（旧: 「3 日前」）/ 暦日 4 日（新: 「4 日前」）
   * 警告が遅くとも約一日遅れて届くと、古い一覧を最新と誤る失敗を防げない。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // 生成は JST 2026-08-06 23:00（UTC では 8/6 14:00。暦日だけ跨界隈に置く）。
    "const gen = Date.parse('2026-08-06T14:00:00Z');",
    "const note = (iso) => Recommender.dataAgeNoteJa(new Date(gen).toISOString(), Date.parse(iso));",
    // 経過 24 時間と JST 暦日がズレる 2 点を見る。
    "const earlyMorning = note('2026-08-08T16:00:00Z'); // JST 8/9 01:00, 経過2日/暦日3日",
    "const lateNight = note('2026-08-09T15:30:00Z'); // JST 8/10 00:30, 経過3日/暦日4日",
    // 生成当日（JST で同日）は何も言わない。
    "const sameDay = note('2026-08-06T14:30:00Z'); // JST 8/6 23:30, 暦日 0 日",
    "console.log(JSON.stringify({",
    "  threshold: Recommender.dataStaleDaysJa,",
    "  earlyMorning,",
    "  lateNight,",
    "  sameDay,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    threshold: number;
    earlyMorning: string;
    lateNight: string;
    sameDay: string;
  };
  // 暦日 3 日目で警告が出る（経過 2 日では出ない旧挙動に戻ったら落ちる）。
  expect(
    out.earlyMorning,
    "JST 暦日 3 日目で警告が出ていない（経過 24 時間で数え直した？）",
  ).toContain("データは 3 日前");
  // 暦日 4 日目は「4 日前」（経過 3 日の「3 日前」で止まっていたら落ちる）。
  expect(out.lateNight, "日数が JST 暦日ではなく経過 24 時間で止まっている").toContain(
    "データは 4 日前",
  );
  expect(out.lateNight).not.toContain("3 日前");
  // 生成当日（JST 暦日で同日）は何も言わない。閾値はてびきの値（書き写さず実装から取る）。
  expect(out.sameDay, "生成当日に警告が出ている").toBe("");
  expect(out.threshold).toBe(3);
  // てびきが数え方（JST の暦日）を宣言していること。
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html, "てびきが日数の数え方（JST の暦日）を書いていない").toContain("JST の暦日");
});

it("CSV の種別列は画面と同じ日本語の語で、英字の内部表記を書かない（SPEC §7）", () => {
  /* deadlinesToCsv は種別を 3 件だけの表（abstract/paper/journal）で訳していて、それ
   * 以外の種別は内部表記をそのまま出していた（2026-08-09 実測: `notification` /
   * `camera_ready` / `rebuttal_end` / `other` / `rebuttal_start` / `review_release` /
   * `registration` / `supplementary`）。**正直な到達性の記録**: 収録のそれらの行は
   * 一覧に出さない種別（`SELECTABLE_KINDS` は abstract/paper/journal のみ）で、画面の
   * CSV は `shown` を渡すため、現時点で利用者が英字の入った CSV を得る経路は無い。
   * ビルドが書く `data.csv`（全収録のフラット表）は正本の `kindLabelTable` を使って
   * 既に正しく、ここだけが古い表を別に持つ唯一の経路だった。種別を表に出す変更をした
   * 瞬間に英字が漏れる地雷なので、分野列が `categoryLabelJa` を使うのと同じ形で正本に
   * 揃えた。この検査は「既知の種別なら内部表記を書かない」という関数の契約を見る。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(new URL("../data/snapshot.json", import.meta.url).pathname)}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    // RFC4180 の読み方で 1 行ずつ分ける（会議名などにカンマが入る）。
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
    "const at = header.indexOf('種別');",
    "const cells = lines.slice(1).map((l) => splitLine(l)[at]);",
    "const widths = new Set(lines.map((l) => splitLine(l).length));",
    "const labels = Recommender.kindLabelTable();",
    "const kinds = lines.slice(1).map((l) => {",
    "  const c = splitLine(l);",
    "  return c[at];",
    "});",
    // 内部表記のまま（日本語を含まない）セルが残っていないか。
    "const asciiCells = [...new Set(cells.filter((c) => c && !/[ぁ-んァ-ン一-龥]/.test(c)))];",
    // CSV の種別列が、その行の種別から画面のラベル表で引いた語と一致するか。
    "const kindsInData = lines.slice(1).map((l, i) => String((rows[i].dl && rows[i].dl.kind) || rows[i].kind || ''));",
    "const mismatch = kindsInData",
    "  .map((k) => labels[k] || k)",
    "  .filter((want, i) => want !== cells[i]).length;",
    // 直前の 3 件の表では訳せなかった種別（= 旧バグで英字が出ていた行）が実際に有ること。
    "const oldTableKinds = { abstract: 1, paper: 1, journal: 1 };",
    "const wasAscii = kindsInData.filter((k) => k && !oldTableKinds[k] && labels[k]).length;",
    "console.log(JSON.stringify({",
    "  header, at, dataRows: lines.length - 1, widths: [...widths],",
    "  distinct: [...new Set(cells)].sort(),",
    "  asciiCells, mismatch, wasAscii,",
    "  allLabeled: [...new Set(cells)].every((c) => Object.values(labels).includes(c)),",
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
    distinct: string[];
    asciiCells: string[];
    mismatch: number;
    wasAscii: number;
    allLabeled: boolean;
  };
  expect(out.header, "CSV の見出しに種別がない").toContain("種別");
  expect(out.at).toBeGreaterThan(0);
  expect(out.dataRows).toBeGreaterThan(1000);
  expect(out.widths, "行によって列数が違う").toEqual([out.header.length]);
  // 種別列の語はすべて画面のラベル表の語（= 表計算で画面と同じ語で絞り込める）。
  expect(out.allLabeled, "CSV の種別列に画面に無い語が出ている").toBe(true);
  // 旧バグ（英字の内部表記）が 0 件であること。
  expect(
    out.asciiCells,
    `種別列に日本語でない内部表記が混ざっている: ${out.asciiCells.join(", ")}`,
  ).toEqual([]);
  expect(out.mismatch, "種別列が画面と同じ語になっていない行がある").toBe(0);
  // 空振り防止: 3 件の表では訳せなかった種別の行が実データに有ること。
  expect(out.wasAscii, "種別列の英字化を踏む行が無い（検査が空振り）").toBeGreaterThan(0);
});

it("論文の貼り付けは日本語の項目名でも 1 論文として読める（SPEC §7）", () => {
  /* 投稿先を探す画面は日本語で「タイトルと概要を…貼り付けてください」と言い、参考論文欄も
   * 日本語ラベル（タイトル | キーワード | 掲載先）を載せているのに、構造化パーサは英語の
   * 項目名（title:/abstract:）しか見ていなかった。そのため「タイトル:」「概要:」で書いた
   * 1 論文が各行に分裂し、ラベルごと title に入る壊れた候補が並んだ（2026-08-09 実測:
   * 英語ラベルの同じ内容は 1 論文に読めるのに、日本語ラベルだと 4 論文に化け、それぞれ
   * title="タイトル: …" のようになった）。参考論文欄（可視）と .txt アップロードは
   * parsePaperLines を通るので、到達経路は有る。全角コロンも吸う。ラベル表を増やさず、
   * 項目名の別名として日本語を受ける。 */
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const P = (t) => Recommender.parsePaperLines(t);",
    // 日本語ラベル（半角コロン）: 1 論文として全項目が分かれること。
    "const ja = P(['タイトル: Attention Is All You Need',",
    "  '概要: We propose the Transformer.',",
    "  'キーワード: transformer, attention',",
    "  '掲載先: NeurIPS'].join('\\n'));",
    // 全角コロン + 抄録/検索語の別名。
    "const jaWide = P('タイトル：深層学習\\n抄録：データ並列の最適化\\n検索語：ml').length;",
    // 英語ラベルは従来どおり 1 論文。
    "const en = P(['Title: X', 'Abstract: Y', 'Keywords: z'].join('\\n'));",
    // 従来動作の維持: 参考論文欄のパイプ書式（タイトル | キーワード | 掲載先）。
    "const pipe = P('SC 2026 | hpc, storage | SC');",
    // 従来動作の維持: ラベル無しの 1 行はそのまま 1 論文（title=その行）。
    "const bare = P('分散学習の高速化');",
    // タイトル行が 1 つも無い貼り付けは構造化入力とみなさない（各行に落ちる＝ゲートの維持）。
    "const noTitle = P('概要: 本文のみ\\nキーワード: x').length;",
    "console.log(JSON.stringify({",
    "  jaCount: ja.length,",
    "  jaTitle: ja[0] && ja[0].title,",
    "  jaAbs: ja[0] && ja[0].abstract,",
    "  jaKw: ja[0] && ja[0].keywords,",
    "  jaVenue: ja[0] && ja[0].venue,",
    "  jaWide, enCount: en.length, enTitle: en[0] && en[0].title,",
    "  pipeVenue: pipe[0] && pipe[0].venue, pipeCount: pipe.length,",
    "  bareCount: bare.length, bareTitle: bare[0] && bare[0].title,",
    "  noTitle,",
    "}));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    jaCount: number;
    jaTitle: string;
    jaAbs: string;
    jaKw: string;
    jaVenue: string;
    jaWide: number;
    enCount: number;
    enTitle: string;
    pipeVenue: string;
    pipeCount: number;
    bareCount: number;
    bareTitle: string;
    noTitle: number;
  };
  // 日本語ラベルでも 1 論文にまとまり、ラベルが title に混ざらない。
  expect(out.jaCount, "日本語ラベルの 1 論文が各行に分裂している").toBe(1);
  expect(out.jaTitle).toBe("Attention Is All You Need");
  expect(out.jaAbs).toContain("Transformer");
  expect(out.jaKw).toContain("transformer");
  expect(out.jaVenue).toBe("NeurIPS");
  expect(out.jaWide, "全角コロンや抄録/検索語の別名が効かない").toBe(1);
  // 英語ラベルは維持。
  expect(out.enCount).toBe(1);
  expect(out.enTitle).toBe("X");
  // 参考論文欄のパイプ書式と、ラベル無し 1 行の従来動作を壊していない。
  expect(out.pipeCount, "パイプ書式の参考論文が壊れた").toBe(1);
  expect(out.pipeVenue).toBe("SC");
  expect(out.bareCount).toBe(1);
  expect(out.bareTitle).toBe("分散学習の高速化");
  // タイトル行の無い貼り付けは構造化しない（ゲートを緩めすぎていない）。
  expect(out.noTitle, "タイトル行の無い入力を 1 論文に潰してしまった").toBeGreaterThan(1);
});

it("会期は一覧・行の詳細・CSV で同じ式を使い、行の詳細が公式の英語表記を主語にしない（SPEC §7）", () => {
  /* 会期の式を一覧・行の詳細・CSV が別々に持っていた。行の詳細だけ公式ページの原文を先に
   * 出していたので、一覧が `2024-03-18(月) 〜 2024-03-21(木)` の行を開くと詳細は
   * `March 18-21, 2024` と英語だけが出ていた（2026-08-09 実測: 会期に ISO を持つ 2,971 行の
   * うち 2,933 行でズレ、既定画面にも 338 行あった）。てびきの「日時」は「表と詳細で同じ
   * 式を使う」と書いているので、案内と実装のずれでもあった。正式な日付が読める行は必ず
   * 一覧と同じ式に直し、公式表記は「原表記」として別に残す（開催地と同じ作法）。 */
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    "const HAS_ASCII_ALPHA = /[A-Za-z]/; // \\b は文字列リテラル内で不可視のバックスペースになるため使わない",
    // 壊れていた行が実際に何件有ったか（検査が空振りでないことの証明）。
    "let wasEnglish = 0;",
    "let englishNow = 0;",
    "let fallback = 0;",
    "for (const r of rows) {",
    "  const start = String((r.ed && r.ed.event_start) || '').trim();",
    "  const raw = String((r.ed && r.ed.date_text) || '').trim();",
    "  if (start && raw && HAS_ASCII_ALPHA.test(raw)) wasEnglish += 1;",
    "  const shown = R.eventCellJa(r);",
    "  if (start && HAS_ASCII_ALPHA.test(shown)) englishNow += 1;",
    "  if (!start && shown) fallback += 1;",
    "}",
    // 行単位の式: 1日だけ・期間・ISO 無し（原文）。
    "const single = R.eventCellJa({ ed: { event_start: '2026-01-05', event_end: '2026-01-05' } });",
    "const range = R.eventCellJa({ ed: { event_start: '2026-12-03', event_end: '2026-12-04' } });",
    "const rawOnly = R.eventCellJa({ ed: { date_text: 'TBD 2027' } });",
    "const nothing = R.eventCellJa({ ed: {} });",
    // CSV の会期列が画面と同じ式か（表計算へ出したときだけ書き方が違う、を弾く）。
    "const SEL = ['abstract', 'paper', 'journal'];",
    "const shownRows = rows.filter((r) => SEL.indexOf(r.kind) >= 0);",
    "const csv = R.deadlinesToCsv(shownRows, NOW);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === '\"') {",
    "        if (line[i + 1] === '\"') { cur += '\"'; i++; } else q = false;",
    "      } else cur += ch;",
    "    } else if (ch === '\"') q = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const lines = csv.split('\\r\\n').filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "const evIdx = head.indexOf('会期');",
    "const csvVals = new Set(lines.slice(1).map((l) => parseLine(l)[evIdx]));",
    "let csvChecked = 0;",
    "let csvMiss = 0;",
    "for (const r of shownRows) {",
    "  const want = R.eventCellJa(r);",
    "  if (!want) continue;",
    "  csvChecked += 1;",
    "  if (!csvVals.has(want)) csvMiss += 1;",
    "}",
    "console.log(JSON.stringify({ rowCount: rows.length, wasEnglish, englishNow, fallback, single, range, rawOnly, nothing, evIdx, csvChecked, csvMiss }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rowCount: number;
    wasEnglish: number;
    englishNow: number;
    fallback: number;
    single: string;
    range: string;
    rawOnly: string;
    nothing: string;
    evIdx: number;
    csvChecked: number;
    csvMiss: number;
  };
  // 壊れていた行は大量に有った（＝この検査は空振りではない）。
  // 閾値は絶対値で書かない。テストハーネスのビルドは自分自身の固定時刻で走るため、
  // 候補行数は締切の過ぎ具合で大きく変わる（2026-08-09 固定の検査用ビルドでは 3,235 行、
  // ハーネスのビルドでは 510 行だった。割合で書かないと時刻が動いた日に検査が壊れる）。
  expect(out.rowCount, "候補行が出ていない").toBeGreaterThan(200);
  expect(out.wasEnglish, "公式表記が英語の行が見つからず、検査が空振り").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  // 直後は正式な日付が読める行で英語の原文を主語にしない。
  expect(out.englishNow, "行の詳細と同じ式なのに会期が英語の原文になっている").toBe(0);
  // ISO が無い行だけ原文を主語にする（12 行あるうちの何行かは選択可能種別で画面に出る）。
  expect(out.fallback, "ISO の無い行の原文フォールバックが消えている").toBeGreaterThan(0);
  // 式の形。1日だけの行は期間を書かない。
  expect(out.single).toBe("2026-01-05(月)");
  expect(out.range).toBe("2026-12-03(木) 〜 2026-12-04(金)");
  expect(out.rawOnly).toBe("TBD 2027");
  expect(out.nothing).toBe("");
  // CSV の会期列が画面と同じ式。
  expect(out.evIdx, "CSV に対象の会期列が無い").toBeGreaterThan(-1);
  expect(out.csvChecked, "CSV と突き合わせる行が出ていない").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  expect(out.csvMiss, `CSV の会期列が画面と違う行が ${out.csvMiss} 件`).toBe(0);

  // 行の詳細（ドロワー）は同じ式を呼び、公式表記を主語にしないこと。
  const runtime = siteRuntime();
  const start = runtime.indexOf("function openDrawer");
  const openBody = runtime.slice(start, runtime.indexOf("window.openDrawer", start));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(openBody).toContain("Recommender.eventCellJa(r)");
  expect(openBody, "公式表記を主語に戻していた").not.toMatch(
    /r\.ed\.date_text\s*\|\|\s*r\.ed\.event_start/,
  );
  expect(openBody).toContain("原表記: ");
});

it("会議名は CSV と同じ語が出る（表計算で画面の語が引ける。SPEC §7）", () => {
  /* 会議名列は画面で行の詳細で「タイトル + 開催年」を出す（`3DV 2024`）。CSV だけは年の
   * 足し算を持たない別実装（素の `conf.title`）で、同じ行が `3DV` になっていた（2026-08-09
   * 実測: 候補行 3,235 件のうち 2,996 件で画面と CSV の会議名が違い、既定画面の 478 行中
   * 422 件が該当）。CSV には年の列が無いので、表計算で画面で見た名前や西暦で絞り込むと
   * 0 行になり、同じ会議の別回も一つの語に潰れていた。組み立て式を
   * `site/recommender.ts` の `titleWithYearJa` に寄せて CSV を同じ語にした
   * （md を作る src/build.ts も同じ正本を呼ぶ）。 */
  const app = siteRuntime();
  const script = [
    "import fs from 'node:fs';",
    `import Recommender from ${JSON.stringify(`file://${join(site, "recommender.js")}`)};`,
    // 画面側の組み立てはビルドした app.js の実装をそのまま使う（書き写さない）。
    jsFunction(app, "titleWithYear"),
    jsFunction(app, "conferenceNameCell"),
    "const R = Recommender;",
    `const DATA = JSON.parse(fs.readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = R.candidateRows(DATA, NOW);",
    // エスケープの事故（第 169 回で \\b が不可視のバックスペースになった）を呼ばないよう、
    // 引用符と改行は文字組みで作る。
    "const Q = String.fromCharCode(34);",
    "const CR = String.fromCharCode(13);",
    "const LF = String.fromCharCode(10);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === Q) {",
    "        if (line[i + 1] === Q) { cur += Q; i++; } else { q = false; }",
    "      } else { cur += ch; }",
    "    } else if (ch === Q) { q = true; }",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else { cur += ch; }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    // CSV は入力行と 1:1 で並ぶ（実測で確認済み）ので位置で突き合わせる。
    "const csv = R.deadlinesToCsv(rows, NOW);",
    "const lines = csv.split(CR + LF).filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "const nameIdx = head.indexOf('会議');",
    "const cells = lines.slice(1).map((l) => parseLine(l)[nameIdx]);",
    "let mismatch = 0;",
    "let emptyCell = 0;",
    "let withYear = 0;",
    "let wasBare = 0;",
    "const miss = [];",
    "for (let i = 0; i < rows.length; i++) {",
    "  const r = rows[i];",
    "  const shown = conferenceNameCell(r);",
    "  const cell = cells[i];",
    "  if (shown !== cell) {",
    "    mismatch += 1;",
    "    if (miss.length < 3) miss.push('画面=「' + shown + '」 CSV=「' + cell + '」');",
    "  }",
    "  if (shown && !cell) emptyCell += 1;",
    // 年が添えられていること（直前はここが空だった）。
    "  const y = r.ed && r.ed.year ? String(r.ed.year) : '';",
    "  if (y && cell.slice(-y.length) === y && cell.length > y.length) withYear += 1;",
    // 素の title と違う行＝直し前は壊れていた行（検査が空振りでない証明）。
    "  if (cell !== String(r.conf.title || '')) wasBare += 1;",
    "}",
    "console.log(JSON.stringify({ rowCount: rows.length, csvRows: cells.length, nameIdx, mismatch, emptyCell, withYear, wasBare, miss }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rowCount: number;
    csvRows: number;
    nameIdx: number;
    mismatch: number;
    emptyCell: number;
    withYear: number;
    wasBare: number;
    miss: string[];
  };
  expect(out.rowCount, "候補行が出ていない").toBeGreaterThan(200);
  expect(out.csvRows, "CSV と候補行が 1:1 で並ばない（突き合わせの前提が変わった）").toBe(
    out.rowCount,
  );
  expect(out.nameIdx, "CSV に会議名欄が無い").toBeGreaterThan(-1);
  // 直し前は画面と CSV で会議名が違っていた（＝この検査は空振りではない）。
  expect(out.wasBare, "年が添えられた行が無く、検査が空振り").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
  // 画面と同じ語が CSV に出る。
  expect(out.mismatch, `画面と CSV の会議名が違う行: ${out.miss.join(" / ")}`).toBe(0);
  expect(out.emptyCell, "画面は名前を出すのに CSV は空欄の行がある").toBe(0);
  expect(out.withYear, "CSV の会議名に年が添えられていない").toBeGreaterThan(
    Math.floor(out.rowCount / 10),
  );
});

it("upcoming.md へのリンクは、ブラウザで表に整形されないことを正直に書く（SPEC §7）", () => {
  /* 締切が未定で会期だけ決まっている会は `upcoming.md` にしか載らず、画面・てびきの両方から
   * そのリンクを送っている。リンクの説明が「ブラウザでは文章で開きます」と言っていたが、
   * 実測は違った。配信先の HEAD は `content-type: text/markdown` を返し（2026-08-09 実測:
   * `https://ten82e.github.io/kamiyobi/upcoming.md`）、ビルドした `upcoming.md` は
   * 1,117 行が `|` の表組みで、会議名は 1,115 行が `[名前](URL)` のマークダウン記号のまま。
   * ブラウザは `text/markdown` を表として描画しないので、記号が並んだ文章で見えるか
   * ダウンロードされる – 「文章で開きます」は噓で、しかも押した人が表を見つけられない。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const links = [...html.matchAll(/<a\b[^>]*href="upcoming\.md"[^>]*>/g)];
  expect(
    links.length,
    "upcoming.md へのリンクが無くなった（案内の実体が変わった）",
  ).toBeGreaterThan(0);
  for (const m of links) {
    const tag = m[0];
    expect(tag, "リンクに説明が無い").toContain("title=");
    // 「文章で開きます」という旧い噓だけを書いていないこと。
    expect(tag).not.toMatch(/文章で開きます/);
    // 実態（マークダウンの表であること・整形されない／ダウンロードされ得ること）を書くこと。
    expect(tag, "リンクの説明がマークダウンの表だと伝えていない").toContain("マークダウン");
    expect(tag, "リンクの説明がダウンロードされ得ると伝えていない").toContain("ダウンロード");
  }

  // `title` はマウスを載せたときだけ出る。触る端末では読めないので、てびきの本文にも
  // 同じ実態を書く（案内と実装のずれは画面の外側でも起きる）。
  const gStart = html.indexOf("<dt>会期のみ・締切未定</dt>");
  expect(gStart, "てびきの該当項が無い").toBeGreaterThan(-1);
  const guideNote = html.slice(gStart, html.indexOf("</dd>", gStart));
  expect(guideNote, "てびきの本文がマークダウンの表だと伝えていない").toContain("マークダウン");
  expect(guideNote, "てびきの本文がダウンロードされ得ると伝えていない").toContain("ダウンロード");
  expect(guideNote).not.toMatch(/文章で開きます/);

  // 画面の中のリンク（0 件・会期だけ確定の案内）も同じ説明を持つ。
  const runtime = siteRuntime();
  expect(runtime).toContain('upcoming.href = "upcoming.md"');
  const notice = runtime.slice(
    runtime.indexOf('upcoming.href = "upcoming.md"'),
    runtime.indexOf('upcoming.href = "upcoming.md"') + 1400,
  );
  expect(notice, "画面の中の upcoming.md リンクが実態を伝えていない").toContain("upcoming.title");
  expect(notice).toContain("マークダウン");
  expect(notice).toContain("ダウンロード");

  // 噓の無い説明にしておく根拠を、ビルド成果物自身で確認する（md はマークダウンのまま配られる）。
  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  expect(md.startsWith("# "), "upcoming.md がマークダウン文書でない").toBe(true);
  const tableRows = md.split("\n").filter((l) => l.startsWith("| "));
  expect(tableRows.length, "upcoming.md に行が見つからない").toBeGreaterThan(10);
  const bracketLinks = tableRows.filter((l) => /\[[^\]]+\]\(https?:\/\//.test(l));
  expect(
    bracketLinks.length,
    "upcoming.md の会議名がマークダウンの記号で書かれていない（説明の実態が変わった）",
  ).toBeGreaterThan(0);
});

it("常時受付の行にも公式ページの URL が出る（SPEC §7）", () => {
  /* 種別で「常時受付」を選ぶと、締切を持たないジャーナルをその場で行に組み立てる
   * （`journalRows`）。この経路だけ会議レコードを `normalizeConference` を通して作っていたが、
   * その正規化が `link` を持っていなかった（型にも無い）。画面は `ed.link || conf.link` で
   * リンクを出すので、常時受付の行だけが公式ページへ飛べない形になっていた（2026-08-09 実測:
   * 常時受付 22 行のうちリンクを持つ物 0 件。同じ 22 件は収録データの `conference.link` に
   * 公式 URL を持っていた）。表のリンク・行の詳細の「公式サイトを開く」・CSV の URL 欄の
   * すべてが空で、常に投稿できる掲載先を探している人がそこで手が止まる。 */
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    // `node -e` のソースは require とトップレベル await を同時に持てない（AGENTS.md）。
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const srcLink = new Map();",
    "for (const c of (DATA.conferences || [])) {",
    "  if (typeof c.key === 'string' && typeof c.link === 'string' && c.link) srcLink.set(c.key, c.link);",
    "}",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const linkOf = (r) => String((r.ed && r.ed.link) || (r.conf && r.conf.link) || '');",
    "let missing = 0;",
    "let notWeb = 0;",
    "let invented = 0;",
    "const miss = [];",
    "for (const r of journals) {",
    "  const u = linkOf(r);",
    "  const name = String((r.conf && r.conf.title) || (r.conf && r.conf.key) || '');",
    "  if (!u) { missing += 1; if (miss.length < 3) miss.push(name); continue; }",
    "  if (!/^https?:\\/\\//.test(u)) notWeb += 1;",
    "  const src = srcLink.get(String((r.conf && r.conf.key) || ''));",
    // 収録データに有る URL を引き継ぐだけ。こちらで作り込んでいない（締切と同じで推測しない）。
    "  if (src && u !== src) invented += 1;",
    "}",
    "const CRLF = String.fromCharCode(13) + String.fromCharCode(10);",
    "const lines = Recommender.deadlinesToCsv(journals, now).split(CRLF).filter((l) => l.length);",
    // URL は最後の列（ヘッダの語で位置を決める）。
    "const head = lines[0].split(',');",
    "const urlIdx = head.indexOf('URL');",
    "const blankUrl = lines.slice(1).filter((l) => !String(l.split(',').pop() || '').trim()).length;",
    "console.log(JSON.stringify({",
    "  journalRows: journals.length,",
    "  urlIdx,",
    "  csvRows: lines.length - 1,",
    "  missing, notWeb, invented, blankUrl, miss,",
    "  sample: journals.slice(0, 2).map((r) => linkOf(r)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout.split("\n")[0]) as {
    journalRows: number;
    urlIdx: number;
    csvRows: number;
    missing: number;
    notWeb: number;
    invented: number;
    blankUrl: number;
    miss: string[];
    sample: string[];
  };
  expect(out.journalRows, "常時受付の行が実データに無い（検査が空振り）").toBeGreaterThan(0);
  expect(out.urlIdx, "CSV に URL 欄が無い").toBeGreaterThan(-1);
  expect(out.csvRows).toBe(out.journalRows);
  expect(out.missing, `公式ページの URL が無い常時受付行: ${out.miss.join("、")}`).toBe(0);
  expect(out.notWeb, "http/https でないリンクを載せている").toBe(0);
  expect(out.invented, "収録データに無い URL を行に載せている").toBe(0);
  expect(out.blankUrl, "CSV の URL 欄が空の常時受付行がある").toBe(0);
  for (const u of out.sample)
    expect(u.startsWith("https://") || u.startsWith("http://")).toBe(true);

  // 持たせても画面が読まなければ直らない。実際に使われている式と、href 前の検査を見る。
  const app = siteRuntime();
  expect(app).toContain("r.ed.link || r.conf.link");
  expect(app, "リンクをそのまま href に置いている").toContain(
    "safeExternalUrl(r.ed.link || r.conf.link)",
  );
});

it("画面に出る語と CSV の値に計算の失敗が混ざらない（SPEC §7）", () => {
  /* 第 174 回の点検で、ビルドした成果物を見て確かめた項目は、どれも問題なしだった。画面の噓は
   * 見つからなかったが、問題なしだという事実には検査が無かった（第 167 回・第 169 回・第 170 回・
   * 第 172 回の欠陥は、どれも「別の場所が同じ値を出しているか」の検査が有ればもっと早く落ちた）。
   * そこで点検内容をそのまま検査に落とす。
   *   - CSV の全マス（45,290 マス実測）に undefined・NaN・Invalid Date・null・Infinity が無い
   *   - 狭い画面のカード化で列の名前（`data-label`）が 7 列すべてに出る
   *   - てびきの「並び順」の項に並ぶ列名が、実装の並び替え可能な列と一致する
   * いずれも実装から語を導いて比べる（数字や語を書き写さない）。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const app = siteRuntime();

  // ---- 1. カード化の列名 == 表の見出し ----
  const headerCells = [
    ...html.slice(html.indexOf("<thead"), html.indexOf("</thead>")).matchAll(/<th\b[^>]*>([^<]*)/g),
  ]
    .map((m) => m[1].replace(/[↕↑↓]/g, "").trim())
    .filter((t) => t.length > 0);
  expect(headerCells.length, "表の見出しが見つからない").toBeGreaterThan(3);
  const cardLabels = [...app.matchAll(/td\([A-Za-z]+, "([^"]+)"/g)].map((m) => m[1]);
  expect(cardLabels.length, "カード化の列名が 1 つも付いていない").toBe(headerCells.length);
  for (const label of headerCells) {
    expect(cardLabels, `カード化したとき「${label}」の列名が消える`).toContain(label);
  }

  // ---- 2. てびきの並び順の項 == 並び替え可能な列 ----
  const sortable = [
    ...html
      .slice(html.indexOf("<thead"), html.indexOf("</thead>"))
      .matchAll(/data-sort="([a-z]+)"[^>]*>([^<]*)/g),
  ].map((m) => ({ key: m[1], label: m[2].replace(/[↕↑↓]/g, "").trim() }));
  expect(sortable.length, "並び替え可能な列が無い").toBeGreaterThan(3);
  const gStart = html.indexOf("<dt>並び順</dt>");
  expect(gStart, "てびきの並び順の項が無い").toBeGreaterThan(-1);
  const guideSort = html.slice(gStart, html.indexOf("</dd>", gStart));
  for (const col of sortable) {
    // 見出しは「日時（JST）」の様に但し書きを添えるので、てびき側は語の始めで当たる。
    const head = col.label.replace(/（.*$/, "");
    expect(guideSort, `てびきの並び順の項に「${col.label}」が書かれていない`).toContain(head);
  }
  // てびきに並んだ語が実装に無い列を指しても困るので、両側を同じ数で見ておく。
  const listed = ["残り", "日時", "会期", "会議", "ランク"].filter((w) => guideSort.includes(w));
  expect(listed.length, "てびきに並ぶ列数が実装と違う").toBe(sortable.length);

  // ---- 3. CSV の値に計算の失敗が混ざらない ----
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    // バックスラッシュ入りの正規表現を文字列に書くと不可視の制御文字になる（第 169 回で実発生）。
    // なので語の切れ目を見たい項目は部分一致で見る。
    "const BAD = ['undefined', 'NaN', 'Invalid Date', 'null', 'Infinity'];",
    "const Q = String.fromCharCode(34);",
    "const CRLF = String.fromCharCode(13) + String.fromCharCode(10);",
    "const parseLine = (line) => {",
    "  const out = [];",
    "  let cur = '';",
    "  let q = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (q) {",
    "      if (ch === Q) {",
    "        if (line[i + 1] === Q) { cur += Q; i++; } else { q = false; }",
    "      } else { cur += ch; }",
    "    } else if (ch === Q) { q = true; }",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else { cur += ch; }",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "};",
    "const lines = Recommender.deadlinesToCsv(rows, now).split(CRLF).filter((l) => l.length);",
    "const head = parseLine(lines[0]);",
    "let cells = 0;",
    "let bad = 0;",
    "const where = [];",
    "for (let i = 1; i < lines.length; i++) {",
    "  const cellsRow = parseLine(lines[i]);",
    "  for (let c = 0; c < cellsRow.length; c++) {",
    "    const v = cellsRow[c];",
    "    cells += 1;",
    "    if (BAD.some((w) => v.indexOf(w) >= 0)) {",
    "      bad += 1;",
    "      if (where.length < 3) where.push(head[c] + ' = ' + v.slice(0, 30));",
    "    }",
    "  }",
    "}",
    // 検出器が死んでいると「0 件」が空振りになるので、わざと壊した 1 マスで自查する。
    "const probe = parseLine('a,NaN,c').filter((v) => BAD.some((w) => v.indexOf(w) >= 0)).length;",
    "console.log(JSON.stringify({",
    "  rows: rows.length,",
    "  cols: head.length,",
    "  cells,",
    "  bad,",
    "  where,",
    "  probe,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 180_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rows: number;
    cols: number;
    cells: number;
    bad: number;
    where: string[];
    probe: number;
  };
  expect(out.rows, "候補行が出ていない").toBeGreaterThan(200);
  // CSV は行と 1:1 で並び、列数は全行で同じ（マスの総数はその積になる）。
  expect(out.cells, "CSV のマス数が行数と列数の積にならない").toBe(out.rows * out.cols);
  expect(out.probe, "計算の失敗を検出する検査自体が壊れている").toBe(1);
  expect(out.bad, `CSV に計算の失敗が混ざっている: ${out.where.join(" / ")}`).toBe(0);
});

it("「評価なし」で印刷すると、紙の条件にも同じ語が出る（SPEC §7）", () => {
  /* ランクの選択欄は、値 `N`（データ内部の番兵）を日本語の「評価なし」で出している –
   * 実装のコメントも「読み手には意味が伝わらない」と書いていた。ところが印刷物の条件の
   * 書き下ろしは値をそのまま書いていて、「評価なし」で絞って印刷すると紙に
   * 「ランク: N」と刷れていた（2026-08-09 実測: ビルドした describeFilters に
   * rank='N' を渡すと「検索語「HPC」 ／ ランク: N ／ …」）。紙を配った人にだけ意味が
   * 読めない語なので、選択欄と同じ式（`rankFilterLabelJa`）を使うようにした。 */
  const app = siteRuntime("app.js");
  const rec = join(site, "recommender.js");
  const body = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const RANK_UNRATED = Recommender.rankUnratedLabelJa();",
    "const meta = { textContent: '' };",
    "const cards = { children: [] };",
    "const $ = (id) => (id === 'printMeta' ? meta : id === 'recommendationCards' ? cards : null);",
    "const valueElement = () => ({ options: [{ text: '30 日以内' }], selectedIndex: 0 });",
    "const countJa = (n) => String(n);",
    "const fmtJst = () => '2026-08-09 (日) 09:00 JST';",
    "function generatedAtLabel(v) { return 'データ生成: ' + v; }",
    "const KIND_LABEL = { paper: '論文締切' };",
    "const DATA = { generated_at: '2026-08-09T09:00:00Z' };",
    "let sortKey = 'date', sortAsc = true;",
    "const sortColumnLabel = (k) => ({ date: '日時（JST）', rem: '残り', event: '会期' })[k] || '';",
    "let shown = [null, null];",
    "let state = { mode: 'deadlines', q: 'HPC', win: '30d', kind: '', rank: 'N', est: false, domestic: false, online: false, past: false, cats: [] };",
    // 印刷の但し書きは本物の 3 関数を繋いで走らせる（配線を確かめるため）。
    jsFunction(app, "rankFilterLabelJa"),
    jsFunction(app, "describeFilters"),
    verificationLabelsSource(),
    jsFunction(app, "printLegendJa"),
    jsFunction(app, "fillPrintMeta"),
    "fillPrintMeta();",
    // 選択肢のラベルも同じ式を使う（規則を 2 箇所に書かない）。
    "const labelOf = (g) => Recommender.rankGradeOrderJa().map((x) => (x === g ? (x === 'N' ? RANK_UNRATED : x) : null)).filter(Boolean)[0];",
    "console.log(JSON.stringify({",
    "  out: meta.textContent,",
    "  unrated: RANK_UNRATED,",
    "  optionLabel: labelOf('N'),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(body)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as { out: string; unrated: string; optionLabel: string };
  // 紙に出る語が、選択欄と同じ語であることを正本から確かめる。
  expect(out.optionLabel, "選択肢のラベルが日本語で無い").toBe(out.unrated);
  expect(out.out, `紙の条件に選択肢と同じ語が出ていない: ${out.out}`).toContain(
    `ランク: ${out.unrated}`,
  );
  expect(out.out, `紙の条件に内部の番兵が残っている: ${out.out}`).not.toMatch(/ランク: N(\D|$)/);

  // 同じ式を両方で使っていること（書き写しが再び生まれないように）。
  const uses = app.match(/rankFilterLabelJa/g) || [];
  expect(
    uses.length,
    "条件の書き下ろしか選択肢のどちらかが別の式になっている",
  ).toBeGreaterThanOrEqual(3);
});

it("相対月の展開を、てびきは固定の日付で約束していない（SPEC §7）", () => {
  /* てびきの「今月」「来月」「再来月」「先月」の項は、展開結果の例を「来月 = 2026年10月」と
   * 書いていた。しかし 2026-08-09 のビルドで実装が返すのは 2026年9月 で、10月は
   * 「再来月」の値だった（ビルドした recommender.js で実測: 今月 2026年8月 / 来月 2026年9月 /
   * 再来月 2026年10月 / 先月 2026年7月）。静的な文に固定の日付で例を書くと、その月を離れた
   * 読者には画面と食い違う語になる – 「来月」が 2 ヶ月先だと受け取った人は出張の月を
   * 間違える。項からは日付の例を外し、「打った語 = 解決した西暦月」という形の記述に替えた。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const helpStart = html.indexOf('id="helpPanel"');
  expect(helpStart, "てびきの欄が見つからない（検査が空振り）").toBeGreaterThan(-1);
  const help = html.slice(helpStart, html.indexOf("</details>", helpStart));
  const visible = help.replace(/<[^>]+>/g, "");

  // てびきの項に、画面で無くなっている可能性のある展開例（語 = 具体的な日付）を書かない。
  for (const word of ["今月", "来月", "再来月", "先月", "明日", "今週", "来週", "先週"]) {
    expect(visible, `てびきが「${word}」の展開例を固定の日付で書いている`).not.toMatch(
      new RegExp(`${word} = 20\\d\\d`),
    );
  }
  // 展開結果の形だけは教えてくれないと、件数欄の語が何かわからない。
  expect(visible, "展開結果の形を書いていない").toContain("打った語 = 解決した西暦月");

  // 規則そのものは実測で守られている（期待値は実装から写さず、この検査が固定した
  // 時計から導く。ずらす月数はてびきに書いた意味そのもの）。
  const rec = join(site, "recommender.js");
  const app = siteRuntime("app.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const NOW = Date.parse('2026-08-09T00:00:00Z');",
    "const base = new Date(NOW + 9 * 3600000);",
    // 日本時間の暦月から期待する月を独立に作る（実装の月加算を写さない）。
    "const monthAt = (offset) => {",
    "  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));",
    "  return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月';",
    "};",
    "const offsets = { 今月: 0, 来月: 1, 再来月: 2, 先月: -1 };",
    "const expanded = {};",
    "const expected = {};",
    "for (const [word, offset] of Object.entries(offsets)) {",
    "  expanded[word] = Recommender.expandRelativeMonths(word, NOW);",
    "  expected[word] = monthAt(offset);",
    "}",
    // 件数欄に書く語は本物の `relativeMonthNote` が作る（画面の文と検査が離れないように）。
    jsFunction(app, "relativeMonthNote"),
    "const note = relativeMonthNote('来月', NOW);",
    "const particleNote = relativeMonthNote('来月の締切', NOW);",
    "console.log(JSON.stringify({ expanded, expected, note, particleNote, expectedNote: '来月 = ' + monthAt(1) }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    expanded: Record<string, string>;
    expected: Record<string, string>;
    note: string;
    particleNote: string;
    expectedNote: string;
  };
  /* 助詞で繋がれた入力（`来月の締切`）も、同じ説明が出ることをここで見る
   * （第 251 回 – 以前は展開が通らず、説明も出なかった）。 */
  expect(out.particleNote, "助詞で繋がれた相対月の説明が出ていない").toContain(out.expectedNote);
  for (const word of Object.keys(out.expected)) {
    expect(
      out.expanded[word],
      `「${word}」の展開が ${out.expected[word]} ではない（取り違えると画面とてびきがズレる）`,
    ).toBe(out.expected[word]);
  }
  expect(out.note, "件数欄に展開した語が出ない").toContain(out.expectedNote);
});

it("過去の締切の読み込み状態は、同じ画面上で二つの名前を持たない（SPEC §7）", () => {
  /* 「過去の締切も表示」にチェックした直後、件数欄は「全履歴を読み込み中…」、状態欄は
   * 「過去の締切を読み込んでいます…」と出していた（2026-08-09 実測）。同じ 1 回の読み込みを
   * 指すのに別の語が並び、別々の読み込みが始まったように読める。状態欄の語には
   * 「表示中のカタログ」という、画面のどこにも出ていない語も混ざっていた。名詞を 1 箇所で
   * 決め（`HISTORY_NOUN_JA`）、件数欄の短い形も状態欄の長い形もそこから作るようにした。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  // 定義その物を実行して語を取り出す（画面に出る語を、この検査に写さない）。
  const block = /(const HISTORY_NOUN_JA = [\s\S]{0,700}?const HISTORY_ERROR_JA = [^;]+;)/.exec(app);
  expect(block, "読み込み状態の語の定義が見つからない（検査が空振り）").not.toBeNull();
  const script = [
    block![1],
    "console.log(JSON.stringify({ nounJa: HISTORY_NOUN_JA, shortLoad: HISTORY_LOADING_SHORT_JA, shortErr: HISTORY_ERROR_SHORT_JA, load: HISTORY_LOADING_JA, err: HISTORY_ERROR_JA }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const words = JSON.parse(proc.stdout) as {
    nounJa: string;
    shortLoad: string;
    shortErr: string;
    load: string;
    err: string;
  };
  expect(words.nounJa.length).toBeGreaterThan(0);
  // 四つの形がすべて同じ名詞で始まる（ここで又分岐しない）。
  for (const [name, text] of [
    ["件数欄の読み込み中", words.shortLoad],
    ["件数欄の失敗", words.shortErr],
    ["状態欄の読み込み中", words.load],
    ["状態欄の失敗", words.err],
  ] as const) {
    expect(text, `${name} が同じ名詞で始まっていない（別名で読める語になる）`).toContain(
      words.nounJa,
    );
  }
  // 状態欄は『どうなったか』と『いま使える物』を書く（短い形だけでは追い切れない）。
  expect(words.err, "状態欄の語が使える範囲を伝えていない").toContain("一覧");

  // 件数欄と状態欄の両方が同じ定義を参照していること。
  expect(
    (app.match(/HISTORY_LOADING_SHORT_JA/g) || []).length,
    "件数欄が短い方を使っていない",
  ).toBeGreaterThanOrEqual(3);
  expect(
    (app.match(/HISTORY_ERROR_SHORT_JA/g) || []).length,
    "件数欄が短い方を使っていない",
  ).toBeGreaterThanOrEqual(3);
  expect(
    (app.match(/HISTORY_LOADING_JA(?!_)/g) || []).length,
    "状態欄が長い方を使っていない",
  ).toBeGreaterThanOrEqual(2);
  expect(
    (app.match(/HISTORY_ERROR_JA(?!_)/g) || []).length,
    "状態欄が長い方を使っていない",
  ).toBeGreaterThanOrEqual(2);

  // 二つ目の名前（全履歴）は、画面に出る文字列から無くなっている。
  const literals = app.match(/"[^"\n]*"/g) || [];
  expect(
    literals.filter((text) => text.includes("全履歴")),
    "画面に出る語に別名が残っている",
  ).toEqual([]);

  // てびきが、画面に出る語そのもので状態を説明している。
  const dtAt = html.indexOf("<dt>過去の締切も表示</dt>");
  expect(dtAt, "てびきの項が見つからない").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが読み込み中の語で説明していない").toContain(
    words.shortLoad.replace("…", ""),
  );
  expect(entry, "てびきが読み込みに失敗したときの話をしていない").toContain("失敗");
  const retry = /<button id="historyRetry"[^>]*>([^<]+)</.exec(html);
  expect(retry, "再試行のボタンが見当たらない").not.toBeNull();
  expect(entry, "てびきが再試行のボタンの名前で書いていない").toContain(String(retry![1]).trim());
  // 再試行のボタンも同じ名詞を使う（名前が又分岐しないように）。
  expect(String(retry![1]), "再試行のボタンが別の名詞になっている").toContain(words.nounJa);
});

it("入力の例を押すと、打ち込んだ物を取り消せる（SPEC §7）", () => {
  /* 投稿先を探す画面の「入力の例」（以前の群ラベルは「動作確認用サンプル」）は、
   * 欄をその例で上書きする。空のときの案内は『上のサンプルボタンで入力の形を確かめ
   * られます』と押すことを勧めていたのに、押すと打ち込んだタイトル・概要・キーワード・
   * 掲載先が告げずに消え、元に戻せなかった（2026-08-09 実測: ハンドラが
   * `setPrimaryRecord` と参考論文欄のクリアを無条件に呼んでいた）。長い概要を貼った後に
   * 形を確かめることができなかった。今は差し替え前に入力を保持し、取り消しのボタンを
   * 出す。規則は純粋な関数にしてある（画面を作らずに検査で動かせる）。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");

  const script = [
    jsFunction(app, "paperInputHasText"),
    jsFunction(app, "paperInputWithSample"),
    "const empty = { title: '', abstract: '', keywords: '', references: '', venue: '' };",
    "const typed = { title: '自分の論文', abstract: 'とても長い概要'.repeat(40), keywords: '', references: '', venue: '' };",
    "const blanks = { title: '   ', abstract: '', keywords: '', references: '', venue: '' };",
    "const refsOnly = { title: '', abstract: '', keywords: '', references: '先行研究 A | 先行 | ICSE', venue: '' };",
    "const out = {};",
    "for (const [name, current] of Object.entries({ empty, typed, blanks, refsOnly })) {",
    "  const swap = paperInputWithSample(current, { ...empty, title: '例のタイトル' });",
    "  out[name] = {",
    "    kept: swap.kept ? [swap.kept.title, swap.kept.abstract, swap.kept.references].join('|') : null,",
    "    next: swap.next.title,",
    "  };",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Record<string, { kept: string | null; next: string }>;
  // 空の欄では戻す物がないので取り消しを出さない（押すたびにボタンが出るのも嘘になる）。
  expect(out.empty.kept, "空の欄でも取り消しを出している").toBeNull();
  expect(out.blanks.kept, "空白だけを取り消し可能な入力にしている").toBeNull();
  // 打ち込んでいれば、そのまま残る（タイトルと長い概要が戻る）。
  expect(out.typed.kept, "打ち込んだ概要が保持されない").toContain("とても長い概要");
  expect(out.typed.next, "例の方が入力になっていない").toBe("例のタイトル");
  // 本文欄が空でも、参考論文を挙げていれば戻す物がある。
  expect(out.refsOnly.kept, "参考論文だけの場合に取り消しが無い").toContain("先行研究 A");

  // 画面の配線: 差し替えの規則を使って書き、取り消しのボタンを出す。
  expect(app, "差し替えが規則関数を使っていない").toContain("paperInputWithSample(");
  // 例のボタンと、ファイル選んだときの差し替えが**同じ規則**を通ること（規則が又分岐して
  // 一方だけ黙って消すようにならないように。ファイル欄には「複数可」と書いてあるので、
  // 前に選んだ物が残ると読む人がいる）。
  const swaps = (app.match(/paperInputWithSample\(/g) || []).length;
  // 定義 1 箇所 + 例のボタン + ファイル選択 の 3 箇所が規則を通る（1 つでも欠ければ、
  // その道だけは黙って消す側へ戻る）。
  expect(
    swaps,
    "差し替えの規則を使う場所が足りない（黙って消す道が残っている）",
  ).toBeGreaterThanOrEqual(3);
  expect(app, "取り消しのボタンを操作していない").toContain("setPaperUndoVisible(");
  const undo = /<button id="paperUndo"[^>]*>([^<]+)</.exec(html);
  expect(undo, "取り消しのボタンが画面に無い").not.toBeNull();
  const undoLabel = String(undo![1]).trim();
  expect(undoLabel, "取り消しのボタンが日本語で何を戻すか書いていない").toContain("戻す");

  // てびきが、画面のボタン名で説明している（語を写さず、ビルドから取る）。
  const dtAt = html.indexOf("<dt>論文の入力とサンプル</dt>");
  expect(dtAt, "てびきの項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが取り消しのボタン名で書いていない").toContain(undoLabel);
  expect(entry, "てびきが欄を入れ替えることを隠している").toContain("入れ替えます");
  // ファイルを選んだときの差し替えも同じボタンで戻せる、と書いてあること。
  expect(entry, "てびきがファイル選択でも戻せると書いていない").toContain("PDF・TXT を選んだとき");

  // 開発向けの群ラベルは画面から無くなる。
  expect(html, "開発向けの群ラベルが残っている").not.toContain("動作確認用サンプル");
});
