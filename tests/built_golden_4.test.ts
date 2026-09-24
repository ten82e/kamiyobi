import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type Recommender from "../site/recommender.ts";
import {
  data,
  FILTER_RUNTIME_STUBS,
  site,
  siteHtmlRuntime,
  verificationLabelsSource,
} from "./built_golden_shared.ts";
import { NOW, REPO_ROOT, runCli } from "./helpers.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

it("ラウンドの R 表記が、別の周目の行を混ぜない（SPEC §7）", () => {
  /* 検索は英字語を語頭だけ閉じた形で開く（`crypto` が `cryptography` に当たる）。
   * 同じ規則を `R1` にも利かせていたため、右に数字が続いても打ち切れず、1 周目を引い
   * たのに 10・11・12 周目の行が混ざっていた（2026-08-09 実測: 既定画面で `R1` が 426 行
   * に当たり、そのうち 6 行は round が 10・11・12。てびきは「CSV に書く R2 と同じ語で
   * 引ける」と書いていたので、表計算から画面に戻った人が見落とす形だった）。末尾が数字
   * の語だけ右端も閉じるようにした。英字で終わる語の前缀一致はそのまま残す。
   * 規則その物は合成した行に当てて確かめる（テスト用ビルドの収録に左右されない）。 */
  const script = [
    "(async () => {",
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const match = (q) => Recommender.searchMatcher(q, now);",
    "const hit = (r, q) => match(q)(r.hay);",
    "const round = (r) => Number((r.dl && r.dl.round) || 0);",
    // 規則の直接検査: 末尾が数字の語は右も閉じ、英字で終わる語は語頭だけ開く。
    "  const digits = {",
    "    open: match('R1')('venue r1 paper'),",
    "    ten: match('R1')('venue r10 paper'),",
    "    glued: match('R1')('venue r1b paper'),",
    "    tenItself: match('R10')('venue r10 paper'),",
    "    tenFromOne: match('R10')('venue r100 paper'),",
    "  };",
    "  const letters = {",
    "    prefix: match('crypto')('field cryptography systems'),",
    "    plural: match('robot')('field robotics lab'),",
    "    leftGlued: match('crypto')('xcryptographyy'),",
    "  };",
    // 収録全体: 周目の数だけ、それぞれの R 表記がその周目の行にだけ当たることを見る。
    "  const seen = {};",
    "  for (const r of rows) { const n = round(r); if (n > 0) seen[n] = (seen[n] || 0) + 1; }",
    "  const perRound = Object.keys(seen).map(Number).sort((a, b) => a - b).map((n) => ({",
    "    n,",
    "    present: seen[n],",
    "    hits: rows.filter((r) => hit(r, 'R' + n)).length,",
    "    wrong: rows.filter((r) => hit(r, 'R' + n) && round(r) !== n).length,",
    "    ja: rows.filter((r) => hit(r, '第 ' + n + ' ラウンド')).length,",
    "  }));",
    "  console.log(JSON.stringify({ digits, letters, perRound, total: rows.length }));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    digits: Record<string, boolean>;
    letters: Record<string, boolean>;
    perRound: { n: number; present: number; hits: number; wrong: number; ja: number }[];
    total: number;
  };
  expect(out.total, "収録行が読めていない").toBeGreaterThan(0);
  // 右端を閉じたこと。
  expect(out.digits.open, "R1 がその物の周目に当たらない").toBe(true);
  expect(out.digits.ten, "R1 が 10 周目の行をまだ返す").toBe(false);
  expect(out.digits.glued, "R1 が続きの数字以外的な語に当たる").toBe(false);
  expect(out.digits.tenItself, "R10 が自分の周目に当たらない（閉めすぎ）").toBe(true);
  expect(out.digits.tenFromOne, "R10 が 100 周目を返す").toBe(false);
  // 英字で終わる語の語頭開きは捨てていない。
  expect(out.letters.prefix, "英字語の前缀一致まで失われている").toBe(true);
  expect(out.letters.plural, "複数形への語頭開きが失われている").toBe(true);
  expect(out.letters.leftGlued, "語頭が英数字でつながる位置を許している").toBe(false);
  // 実データ: 収録されているすべての周目について、R 表記はその周目にだけ当たる。
  expect(out.perRound.length, "周目を持つ行が収録に無い（検査が空振りしている）").toBeGreaterThan(
    1,
  );
  const wide = out.perRound.filter((e) => e.n >= 10);
  for (const e of out.perRound) {
    expect(e.hits, `R${e.n} が 1 件も返さない`).toBeGreaterThan(0);
    expect(e.hits, `R${e.n} の当たった行数がその周目の行数と違う`).toBe(e.present);
    expect(e.wrong, `R${e.n} が別の周目の行を返す`).toBe(0);
    expect(e.ja, `第 ${e.n} ラウンド と R${e.n} で当たった行数が違う`).toBe(e.present);
  }
  // NOTE: この収録に 10 周目以上の行が無いときは、混入その物は上の `digits`（合成行）でだけ
  // 確かまる。本番の収録では 2026-08-09 に 6 行の混入を実測している。
  void wide;

  // てびき: 表に 1 周目を添えないことと、それでも語が引けることを書いておく。
  const html = readFileSync(join(site, "index.html"), "utf8");
  const dtAt = html.indexOf("<dt>検索</dt>");
  expect(dtAt, "検索の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが 1 周目を表に添えないと書いていない").toContain("1 ラウンド目");
  expect(entry, "てびきが 1 周目の語を挙げていない").toContain("第 1 ラウンド");
  expect(entry, "てびきが CSV の書き方を挙げていない").toContain("R1");
});

it("印刷した紙が、紙に出る語を紙の説明だけで読ませる（SPEC §7）", () => {
  /* 画面のてびきは印刷時に隠れる（`@media print` で `#helpPanel` を消す）。ところが紙には
   * 画面と同じ語が刷られる。2026-08-09 実測: 既定の印刷対象 478 行のうち 280 行が
   * 「ランク未確認」で、会期未確認 114 行・開催地未確認 110 行・延長後 9 行が続く。
   * 変更前の紙にはこれらの意味がどこにも書かれておらず、受け取った人は画面を開かないと
   * 読めなかった（研究室に貼る・回覧する用途では足りない）。印刷帯に但し書きを載せ、
   * 語は正本（`recommender.js` の公開している名前）から組み立てるようにした。
   * ここで見るのは (1) 紙に出る語が漏れなく説明されていること、(2) 説明側に自作の語が
   * 無いこと、(3) 紙にだけ出ること、(4) てびきがその但し書きを画面の語で書いていること。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const script = [
    verificationLabelsSource(),
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    jsFunction(app, "printLegendJa"),
    "const legend = printLegendJa();",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const printPool = rows.filter((r) => (r.kind === 'abstract' || r.kind === 'paper') && !r.est);",
    "const cr = String.fromCharCode(13, 10);",
    "const q = String.fromCharCode(34);",
    "const cells = (line) => {",
    "  const out = []; let cur = ''; let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === q) { if (line[i + 1] === q) { cur += ch; i++; } else quoted = false; } else cur += ch;",
    "    } else if (ch === q) quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur); return out;",
    "};",
    "const tableCsv = Recommender.deadlinesToCsv(printPool, now);",
    "const lines = tableCsv.split(cr).filter((l) => l.length);",
    "const head = cells(lines[0]);",
    "const at = head.indexOf('状態');",
    "const counts = {};",
    "for (let i = 1; i < lines.length; i++) {",
    "  const v = cells(lines[i])[at] || '';",
    "  for (const w of v.split('・')) if (w) counts[w] = (counts[w] || 0) + 1;",
    "}",
    // 説明側が使って良い語の集合: CSV に出る値（状態・ランク・種別・締切）。
    "const all = Recommender.deadlinesToCsv(rows, now).split(cr);",
    "const seen = new Set();",
    "for (let i = 1; i < all.length; i++) {",
    "  const c = cells(all[i]);",
    "  for (const k of ['状態', 'ランク', '種別', '締切']) {",
    "    const j = head.indexOf(k);",
    "    if (j < 0) continue;",
    "    for (const w of String(c[j] || '').split('・')) if (w) seen.add(w);",
    "  }",
    "}",
    "console.log(JSON.stringify({",
    "  legend,",
    "  rows: printPool.length,",
    "  counts,",
    "  vocab: [...seen].join(String.fromCharCode(10)),",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    legend: string;
    rows: number;
    counts: Record<string, number>;
    vocab: string;
  };
  expect(out.rows, "印刷対象の行が読めていない").toBeGreaterThan(0);
  const counts = Object.entries(out.counts).sort((a, b) => b[1] - a[1]);
  expect(counts.length, "紙に出る状態の語が無い（検査が空振りしている）").toBeGreaterThanOrEqual(2);
  // (1) 印刷行の 2 割以上に付く語は、紙の説明に載っていなければならない。
  const frequent = counts.filter(([, n]) => n >= out.rows * 0.2);
  expect(frequent.length, "多く付く語が無く、この検査が空振りしている").toBeGreaterThan(0);
  for (const [word, n] of frequent) {
    expect(out.legend, `紙に ${n} 行刷られる「${word}」を但し書きが説明していない`).toContain(word);
  }
  // (2) 但し書きが自作の語を紙に書かない（画面の語か CSV の値に実在するものだけ）。
  const tokens = [...out.legend.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  const lead = out.legend.slice(out.legend.indexOf(": ") + 2).split("は、")[0];
  for (const w of lead.split("・")) if (w.trim()) tokens.push(w.trim());
  // 照合先は「紙に刷られる値」と「画面に見える文」だけに絞る。実装のソース全体を照合先に
  // すると、説明文に偶々現れる語を拾って検査が実質的に効かなくなる（第 182 回に実際に踏んだ:
  // 無い語を但し書きへ足しても、コメント中の語と当たって通ってしまった）。
  const visible = html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "");
  const hay = [out.vocab, visible].join("\n");
  for (const t of tokens) {
    if (t.length < 2) continue;
    expect(hay, `但し書きの「${t}」が画面にも CSV にも無い自作の語になっている`).toContain(t);
  }
  // (3) 紙にだけ出る（画面では隠れ、印刷で見える）。
  expect(html, "印刷の帯が画面に出る設定になっている").toMatch(
    /\.print-meta\s*\{[^}]*display:\s*none/,
  );
  expect(html, "印刷の帯が紙に出る設定が無い").toMatch(
    /\.print-meta\s*\{[^}]*display:\s*block\s*!important/,
  );
  const printBlock = /@media print\s*\{([\s\S]*?)\n\}/.exec(html);
  expect(printBlock, "印刷の取りまとめが見つからない").not.toBeNull();
  expect(printBlock![1], "印刷でてびきが消えない（紙の説明が二つになる）").toContain("#helpPanel");

  // (4) てびきが、紙の但し書きを画面の語で案内している（語を検査に写さない）。
  const prefix = out.legend.slice(0, out.legend.indexOf(": "));
  const dtAt = html.indexOf("<dt>印刷</dt>");
  expect(dtAt, "印刷の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  expect(entry, "てびきが紙の但し書きを案内していない").toContain("但し書き");
  expect(entry, "てびきが紙に出る見出しの語と違う語で書いている").toContain(prefix);

  // 点検: てびきの項は括弧が釣り合っていること（印刷の項で 1 つ開きっぱなしだった）。
  const helpStart = html.indexOf('id="helpPanel"');
  const dl = html.indexOf("<dl", helpStart);
  const dlEnd = html.indexOf("</details>", dl);
  const items = [...html.slice(dl, dlEnd).matchAll(/<dd>([\s\S]*?)<\/dd>/g)];
  expect(items.length, "てびきの項が読めない").toBeGreaterThan(10);
  for (const m of items) {
    const text = m[1].replace(/<[^>]+>/g, "");
    const open = text.split("（").length - 1;
    const close = text.split("）").length - 1;
    expect(open - close, `てびきの項で括弧が釣り合っていない: ${text.slice(0, 40)}`).toBe(0);
  }
});

it("紙に刷られない語を、紙の但し書きが説明していない（SPEC §7）", () => {
  /* 第 182 回で載せた但し書きが、自分自身で噓を書いていた。説明していた語の 2 つが
   * 紙に現れない。行の詳細の「原表記:」は `@media print` で `#drawer` が消えるので
   * 刷られず、残り欄の横線は現状のデータで一度も出ない（2026-08-09 実測: 候補行
   * 3,235 件と期刊行 22 件の CSV に 0 件）。一方で紙に刷る「公式表記」の列と、
   * ランの三列（CCF・CORE・THCPL）が 478 行中 280 行で空欄であることは
   * 説明していなかった。紙の説明は紙に出る語だけを説明すべきなので、方向を直す。
   * ここでは (1) 但し書きが説明する語が紙に刷られる値・見出しに実在すること、
   * (2) 印刷行の 2 割以上で空欄になる列は名前を挙げて説明していること、
   * (3) 「公式表記」と「種別」の中身が別物なら、両方の列名を説明に載せることを見る。 */
  const app = siteRuntime("app.js");
  const html = readFileSync(join(site, "index.html"), "utf8");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    verificationLabelsSource(),
    jsFunction(app, "printLegendJa"),
    "const legend = printLegendJa();",
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const cr = String.fromCharCode(13, 10);",
    "const q = String.fromCharCode(34);",
    "const cells = (line) => {",
    "  const out = []; let cur = ''; let quoted = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (quoted) {",
    "      if (ch === q) { if (line[i + 1] === q) { cur += ch; i++; } else quoted = false; } else cur += ch;",
    "    } else if (ch === q) quoted = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur); return out;",
    "};",
    // 印刷しうる行の全体（表の行と常時受付の行）。但し書きはどちらの印刷にも出る。
    "const pool = Recommender.candidateRows(DATA, now).concat(Recommender.journalRows(DATA.conferences, now));",
    "const csv = Recommender.deadlinesToCsv(pool, now);",
    "const lines = csv.split(cr).filter((l) => l.length);",
    "const head = cells(lines[0]);",
    "const empties = {};",
    "for (let i = 1; i < lines.length; i++) {",
    "  const c = cells(lines[i]);",
    "  for (let j = 0; j < head.length; j++) if (!String(c[j] || '')) empties[head[j]] = (empties[head[j]] || 0) + 1;",
    "}",
    // 「公式表記」と「種別」の中身が重なっているか（重なっていれば二つの説明は要らない）。
    "const official = new Set();",
    "const kinds = new Set();",
    "const oi = head.indexOf('公式表記');",
    "const ki = head.indexOf('種別');",
    "for (let i = 1; i < lines.length; i++) {",
    "  const c = cells(lines[i]);",
    "  official.add(String(c[oi] || '')); kinds.add(String(c[ki] || ''));",
    "}",
    "let overlap = 0;",
    "for (const v of kinds) if (official.has(v)) overlap += 1;",
    "console.log(JSON.stringify({",
    "  legend,",
    "  rows: lines.length - 1,",
    "  unconf: Recommender.unconfirmedLabelJa(),",
    "  head,",
    "  empties,",
    "  overlap,",
    "  printable: csv,",
    "}));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    legend: string;
    rows: number;
    unconf: string;
    head: string[];
    empties: Record<string, number>;
    overlap: number;
    printable: string;
  };
  expect(out.rows, "印刷しうる行が読めていない").toBeGreaterThan(0);
  // (1) 但し書きが説明する語は、紙に刷られる見出しか値に実在しなければならない。
  const tokens = [...out.legend.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  const lead = out.legend.slice(out.legend.indexOf(": ") + 2).split("は、")[0];
  for (const w of lead.split("・")) if (w.trim()) tokens.push(w.trim());
  expect(tokens.length, "但し書きが語を説明していない（検査が空振り）").toBeGreaterThan(3);
  for (const t of tokens) {
    if (t.length < 2) continue;
    expect(
      out.printable,
      `紙に刷られない語「${t}」を但し書きが説明している（紙だけを読む人には存在しない語の説明）`,
    ).toContain(t);
  }
  // (2) 既定の印刷対象で 2 割以上が空欄になる列は、並べても意味が読めないので説明する。
  // 「状態」欄の語で説明する場合（「会期未確認」など）も説明と数える。
  const sparse = out.head.filter((h) => (out.empties[h] || 0) >= out.rows * 0.2);
  expect(sparse.length, "空欄の列が無く、この検査が空振りしている").toBeGreaterThan(0);
  const explained = sparse.filter(
    (h) => out.legend.includes(h) || out.legend.includes(`${h}${out.unconf}`),
  );
  for (const h of sparse) {
    expect(
      explained.length,
      `印刷行の 2 割以上で「${h}」が空欄なのに、但し書きがその列を説明していない（説明済み: ${explained.join("・")}）`,
    ).toBe(sparse.length);
  }
  // (3) 「公式表記」と「種別」は中身が別物なので、両方の列名を説明に載せる。
  expect(out.overlap, "公式表記と種別が同じ値を共有している（前提が変わった）").toBe(0);
  for (const h of ["公式表記", "種別"]) {
    expect(out.legend, `列「${h}」が但し書きに出ない`).toContain(h);
  }
  // 画面のてびきも、但し書きが名指しで説明する列を同じ名前で案内している（語を書き写さない）。
  const dtAt = html.indexOf("<dt>印刷</dt>");
  expect(dtAt, "印刷の項が無い").toBeGreaterThan(-1);
  const entry = html.slice(dtAt, html.indexOf("</dd>", dtAt)).replace(/<[^>]+>/g, "");
  // 「開催地未確認」のように未確認の語で説明する列は、列名そのものを説明していないので、
  // てびきに列名を書くことは要求しない（部分文字列で拾わない）。
  const named = sparse.filter(
    (h) => out.legend.includes(h) && !out.legend.includes(`${h}${out.unconf}`),
  );
  expect(named.length, "列を名指しで説明する項が無く、この検査が空振りしている").toBeGreaterThan(0);
  for (const h of named) {
    expect(entry, `てびきが列「${h}」の空欄を案内していない`).toContain(h);
  }
});

it("`llms.txt` が、月の相対語を実装と違う月に決めていない（SPEC §7）", () => {
  /* `llms.txt` は AI に読ませる案内なので、ここに間違った月が書いてあると、画面を
   * 見ていない人にそのまま伝わる。2026-08-09 生成のビルドで実測: 実装は `来月` を
   * 2026年9月 に解決する（2026年10月は `再来月`）。ところが `llms.txt` は
   * `来月 = 2026年10月` と書いていた – 画面のてびきでは第 180 回ごろに直した
   * 固定の例が、こちらの文に残っていた。画面と同じ「打った語 = 解決した西暦月」の
   * 形に替え、月の語のずれ分だけを数で書くことにする。
   * ここでは (1) 文が書くずれ分が実装と一致すること、(2) 固定の月を書いている箇所が
   * あれば、その月が実装の答えと一致すること、(3) 画面と同じ形の名前が載っていることを見る。 */
  const rec = join(site, "recommender.js");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    `const llms = readFileSync(${JSON.stringify(join(site, "llms.txt"))}, 'utf8');`,
    "const now = Date.parse(DATA.generated_at);",
    "const words = [['今月', 0], ['来月', 1], ['再来月', 2], ['先月', -1]];",
    "const DAY = 86400000;",
    "const jst = new Date(now + 9 * 3600000);",
    "const base = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1);",
    "const rows = words.map(([w, off]) => {",
    "  const d = new Date(base + off * 31 * DAY);",
    "  const y = d.getUTCFullYear();",
    "  const m = d.getUTCMonth() + 1;",
    "  const want = y + '年' + m + '月';",
    "  return { w, off, want, got: Recommender.expandRelativeMonths(w, now) };",
    "});",
    "console.log(JSON.stringify({ rows, llms }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    rows: { w: string; off: number; want: string; got: string }[];
    llms: string;
  };
  expect(out.rows.length, "月の語が読めない").toBe(4);
  // (1) 文が書くずれ分（+0 / +1 / +2 / -1 ヶ月）が、実装の答えと一致する。
  for (const r of out.rows) {
    expect(r.got, `\`${r.w}\` の解決が実装と違う（展開結果: ${r.got}）`).toBe(r.want);
  }
  // (2) 固定の月を例に書いている箇所があれば、その月は実装の答えでなければならない。
  const claims = [...out.llms.matchAll(/(今月|来月|再来月|先月)`?\s*=\s*(\d{4}年\d{1,2}月)/g)];
  for (const m of claims) {
    const row = out.rows.find((r) => r.w === m[1]);
    expect(row, `案内に \`月\` の語があるが読み取れない: ${m[0]}`).toBeDefined();
    expect(
      row!.want,
      `案内が \`${m[0]}\` と書いているが、実装は ${row!.want} と読む（生成日からずれている）`,
    ).toBe(m[2]);
  }
  expect(claims.length, "固定の月の例が復活している（実装とズレる書き方）").toBe(0);
  // (3) 画面の件数欄と同じ形の名称を使っている（書き写しで別名称にならないように）。
  expect(out.llms, "件数欄の形の説明が無い").toContain("打った語 = 解決した西暦月");
  // 四つの語をまとめて説明していること（1 語だけ説明が落ちると、その語だけが画面と違う）。
  for (const r of out.rows) {
    expect(out.llms, `案内に ${r.w} の説明が無い`).toContain(`\`${r.w}\``);
  }
});

it("一覧の「残り」は、同じ行の締切の日付から数えた日数とずれない（SPEC §7）", async () => {
  /* 「残り」のこれからの分だけ経過 24 時間の floor で数えていて、過ぎた分と過去・現在で
   * 数え方が違っていた（`dataAgeNoteJa` は「残りは JST の暦日が正本」と書いている）。
   * 2026-08-09 生成ビルドで実測: 締切 2026-08-22 03:00 JST の行は JST 09:00 の眺めで
   * 「あと 12 日」（暦日では 13 日後）で、締切の日付が動いていないのにずれは JST 09:00 で
   * 97 行 / 20:00 で 320 行（785 行中）/ 翌朝 06:00 で 7 行出た。表計算で締切日から
   * 逆算する人が 1 日損をする。
   * 画面の関数その物をビルド成果物から抜き出して、全行で暦日差と突き合わせる。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const f = new Function("Date", "DAY", `${jsFunction(app, "remain")}\nreturn remain;`) as (
    dateCtor: unknown,
    day: number,
  ) => (ms: number) => { text: string };
  const DAY = 86400000;
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const jstDay = (t: number) => Math.floor((t + 9 * 3600000) / DAY);
  let 日の表示 = 0;
  let 時刻の表示 = 0;
  let 数え方で変わった行 = 0;

  // 見る人の時計の時刻で数字が動く不具合なので、同じ行を複数の時刻で眺める
  // （JST の朝・夕方・深夜。生成基準時刻の 09:00 JST だけで見ると分からない）。
  // 時刻で出す枝は、いちばん近い締切の 30 分前を足して通す（収録に 24 時間以内の行が
  //無いビルドでも検査が回るよう、日付から作る。第 202 回）。
  const clocks = [0, 11 * 3600000, 21 * 3600000];
  const next = Math.min(
    ...rows
      .map((row) => (Number.isFinite(row.tShown) ? row.tShown : row.t))
      .filter((t) => Number.isFinite(t) && t >= NOW.getTime()),
  );
  if (Number.isFinite(next)) clocks.push(next - NOW.getTime() - 30 * 60000);
  for (const offset of clocks) {
    const now = NOW.getTime() + offset;
    class FakeDate extends Date {
      static now() {
        return now;
      }
    }
    const remain = f(FakeDate, DAY);
    for (const row of rows) {
      const t = Number.isFinite(row.tShown) ? row.tShown : row.t;
      if (!Number.isFinite(t) || t < now) continue;
      const cell = remain(t).text;
      const days = /^あと (\d+) 日$/.exec(cell);
      if (days) {
        日の表示 += 1;
        const cal = jstDay(t) - jstDay(now);
        expect(
          Number(days[1]),
          `${String(row.conf.title).slice(0, 28)} の「${cell}」は JST の暦日 ${cal} 日とずれている`,
        ).toBe(cal);
        // 直す前の数え方（経過 24 時間）と実際に関係が変わった行があることを数える
        if (Math.floor((t - now) / DAY) !== cal) 数え方で変わった行 += 1;
        continue;
      }
      if (cell === "まもなく" || /^あと \d+ 時間$/.test(cell)) {
        時刻の表示 += 1;
        expect(
          t - now < DAY,
          `${String(row.conf.title).slice(0, 28)} の「${cell}」は 24 時間以上先に出ている`,
        ).toBe(true);
      }
    }
  }
  expect(日の表示, "「あと N 日」が出る行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(時刻の表示, "時刻で出る行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(
    数え方で変わった行,
    "どの行でも経過 24 時間と暦日差が同じ（検査が空振り）",
  ).toBeGreaterThan(0);
});

it("書き出した CSV の残り日数が、画面の「残り」の数と全行で一致する（SPEC §7）", () => {
  /* 表計算で並び替える人は、画面の「残り」を確かめてから CSV を開く。両方の数が違えば、
   * どちらを信じるか分からなくなる。2026-08-09 生成のビルドで実測: 過ぎた行 2,317 件のうち
   * 279 件で CSV の数が 1 日大きかった（画面「2019 日前に終了」に CSV「-2020」）。
   * 画面は JST の暦日差で数えるのに、CSV の過去側は経過時間の floor を使っていたため。
   * 先の行は同じ基準だったので 0 件だった。
   * ここでは画面の関数その物（ビルドした app.js から `remain` を抜き出す）と CSV を全行で
   * 突き合わせる。画面の語を組み立てて比べるので、実装の語を検査に書き写さない。 */
  const rec = join(site, "recommender.js");
  const dataFile = join(site, "data.json");
  const appFile = join(site, "app.js");
  const script = [
    "const { readFileSync } = await import('node:fs');",
    `const { default: Recommender } = await import('file://${rec}');`,
    `const APP = readFileSync('${appFile}', 'utf8');`,
    `const DATA = JSON.parse(readFileSync('${dataFile}', 'utf8'));`,
    "const CR = String.fromCharCode(13, 10);",
    "const Q = String.fromCharCode(34);",
    "function jsFunction(name) {",
    "  const i = APP.indexOf('function ' + name);",
    "  if (i < 0) throw new Error('not found: ' + name);",
    "  let depth = 0;",
    "  const start = APP.indexOf('{', i);",
    "  for (let k = start; k < APP.length; k++) {",
    "    if (APP[k] === '{') depth++;",
    "    else if (APP[k] === '}') { depth--; if (!depth) return APP.slice(i, k + 1); }",
    "  }",
    "  throw new Error('unbalanced: ' + name);",
    "}",
    "const DAY = Number(APP.match(/(?:const|var|let) DAY = ([0-9e_]+)/)[1].replace(/_/g, ''));",
    "if (!Number.isFinite(DAY) || DAY <= 0) throw new Error('DAY が読めない');",
    "const now = Date.parse(DATA.generated_at);",
    "if (!Number.isFinite(now)) throw new Error('生成時刻が読めない');",
    "const remain = new Function('Date', 'DAY',",
    "  jsFunction('remain') + '; return remain;')({ now: () => now }, DAY);",
    "function cells(line) {",
    "  const out = [];",
    "  let cur = '', inQ = false;",
    "  for (let i = 0; i < line.length; i++) {",
    "    const ch = line[i];",
    "    if (inQ) {",
    "      if (ch === Q) { if (line[i + 1] === Q) { cur += ch; i++; } else inQ = false; }",
    "      else cur += ch;",
    "    } else if (ch === Q) inQ = true;",
    "    else if (ch === ',') { out.push(cur); cur = ''; }",
    "    else cur += ch;",
    "  }",
    "  out.push(cur);",
    "  return out;",
    "}",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const lines = Recommender.deadlinesToCsv(rows, now).split(CR).filter(Boolean);",
    "const head = cells(lines[0]);",
    "const iLeft = head.indexOf('残り日数');",
    "if (iLeft < 0) throw new Error('残り日数 列が無い');",
    "const bad = [];",
    "let checked = 0, pastLabeled = 0, datedLabeled = 0, skipped = 0;",
    "for (let j = 1; j < lines.length; j++) {",
    "  const row = rows[j - 1];",
    "  if (!row) continue;",
    "  const t = Number.isFinite(row.tShown) ? row.tShown : row.dateOnly ? row.tLast : row.t;",
    "  if (!Number.isFinite(t)) continue;",
    "  const label = remain(t).text;",
    "  const value = cells(lines[j])[iLeft];",
    "  const mDay = label.match(/^あと ([0-9]+) 日$/);",
    "  const mPast = label.match(/^([0-9]+) 日前に終了$/);",
    "  let want = 0;",
    "  if (label === '本日終了' || label === 'まもなく' || /^あと [0-9]+ 時間$/.test(label)) want = 0;",
    "  else if (mDay) want = Number(mDay[1]);",
    "  else if (mPast) { want = -Number(mPast[1]); pastLabeled++; }",
    "  else { skipped++; continue; }",
    "  checked++;",
    "  if (want !== 0) datedLabeled++;",
    "  if (Number(value) !== want && bad.length < 4)",
    "    bad.push('画面「' + label + '」 -> CSV「' + value + '」 ' + String(row.conf.title).slice(0, 22));",
    "}",
    "console.log(JSON.stringify({ bad, checked, pastLabeled, datedLabeled, skipped, rows: rows.length }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    bad: string[];
    checked: number;
    pastLabeled: number;
    datedLabeled: number;
    skipped: number;
    rows: number;
  };
  // 候補行を 1 行も取りこぼさずに比較していること（行数の固定値はハーネスのビルドと
  // 配信ビルドで違うので、常に全行を比べる条件にする）。
  expect(out.rows, "候補行が無い").toBeGreaterThan(100);
  expect(out.checked, "比較から漏れた行がある").toBe(out.rows);
  expect(out.skipped, "画面の語が読み解けず比較できなかった行がある").toBe(0);
  // 過去側の基準を実際に通っていること（無ければこの検査は空振りになる）。
  expect(
    out.pastLabeled,
    "「N 日前に終了」の行が無く、過去側の基準を検査できていない",
  ).toBeGreaterThan(0);
  expect(out.datedLabeled, "日数を出す行が無く、この検査は空振りしている").toBeGreaterThan(0);
  expect(out.bad, `画面と CSV の残り日数が食い違う行がある\n${out.bad.join("\n")}`).toEqual([]);
});

it("upcoming.md の「残り」が、実在しない猶予を約束していない（SPEC §7）", () => {
  /* `upcoming.md` の「残り」欄は、日・時間・分はいずれも切り下げで書く欄である。ところが分の
   * 欄だけ 1 に切り上げていた（`Math.max(1, …)`）。2026-08-09 生成のビルドで実測: 生成時刻
   * ちょうどに締まる行が「1分」と書かれていた（同じ行の画面は「まもなく」を出す）。「まだ
   * 1 分ある」と読んだ人が、締まり切った行を眺めていたことになる。
   * 検査は 2 方向。
   * (1) 通常のビルドの全行で、書いた猶予が実在し、次の単位までは届いていないこと。
   * (2) 分の欄は通常のビルドでは踏まないので、`upcoming.md` に載る最も早い締切の 30 秒前に
   *     生成時刻を置いたビルドを別途作り、その行を通す（切り上げなら「1分」と書いて落ちる）。
   * 語の形は検査側で組み立てて比べ、実装の語を検査に書き写さない。 */
  const rowsOf = (mdPath: string, jsonPath: string) =>
    [
      "const { readFileSync } = await import('node:fs');",
      `const MD = readFileSync('${mdPath}', 'utf8');`,
      `const DATA = JSON.parse(readFileSync('${jsonPath}', 'utf8'));`,
      "const now = Date.parse(DATA.generated_at);",
      "if (!Number.isFinite(now)) throw new Error('生成時刻が読めない');",
      "const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;",
      // 「2026-08-09(日) 00:00:00 UTC」の形だけ読む。末尾の「（公式 PT）」などは落として良い。
      "const INST = /^([0-9]{4})-([0-9]{2})-([0-9]{2})\\(([日月火水木金土])\\) ([0-9]{2}):([0-9]{2}):([0-9]{2}) (UTC|JST|AoE)(?:（[^）]*）)?$/;",
      // AoE は UTC-12、JST は UTC+9。表示されているInstantに戻す。
      "function instantOf(text) {",
      "  const m = text.match(INST);",
      "  if (!m) return NaN;",
      "  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),",
      "    Number(m[5]), Number(m[6]), Number(m[7]));",
      "  if (m[8] === 'JST') return base - 9 * HOUR;",
      "  if (m[8] === 'AoE') return base + 12 * HOUR;",
      "  return base;",
      "}",
      // 「残り」欄の形を (書いた猶予, 単位) に落とす。数えられない形は数えない。
      "function claimOf(text) {",
      "  const t = text.trim();",
      "  if (t === 'まもなく') return { want: 0, unit: MIN };",
      "  let m = t.match(/^([0-9]+)分$/);",
      "  if (m) return { want: Number(m[1]) * MIN, unit: MIN };",
      "  m = t.match(/^([0-9]+)時間$/);",
      "  if (m) return { want: Number(m[1]) * HOUR, unit: HOUR };",
      "  m = t.match(/^([0-9]+)日$/);",
      "  if (m) return { want: Number(m[1]) * DAY, unit: DAY };",
      "  return null;",
      "}",
      "const bad = [], targets = [];",
      "let parsed = 0, claims = 0, soon = 0;",
      "for (const line of MD.split('\\n')) {",
      "  if (!line.startsWith('| ')) continue;",
      "  const cells = line.slice(2).split(' | ');",
      "  if (cells.length < 7 || cells[0] === '日付' || /^-+$/.test(cells[0])) continue;",
      "  const at = instantOf(cells[0].trim());",
      "  if (!Number.isFinite(at)) continue;",
      "  parsed++;",
      "  const left = at - now;",
      "  if (left > 2 * MIN && left < 170 * DAY) targets.push(String(at));",
      "  const claim = claimOf(cells[1]);",
      "  if (!claim) continue;",
      "  claims++;",
      "  if (left >= 0 && left < MIN) soon++;",
      "  // 書き方は切り下げなので、書いた猶予は実在し、次の単位までは届いていないはず。",
      "  if (left < claim.want || left >= claim.want + claim.unit) {",
      "    if (bad.length < 5)",
      "      bad.push('「' + cells[1].trim() + '」の実残り ' + Math.floor(left / MIN) + '分 ' +",
      "        cells[0].trim() + ' ／ ' + String(cells[2]).slice(0, 26));",
      "  }",
      "}",
      "console.log(JSON.stringify({ bad, parsed, claims, soon, targets }));",
    ].join("\n");
  const run = (mdPath: string, jsonPath: string) => {
    const proc = spawnSync("node", ["-e", vmSafeSource(rowsOf(mdPath, jsonPath))], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
    return JSON.parse(proc.stdout) as {
      bad: string[];
      parsed: number;
      claims: number;
      soon: number;
      targets: string[];
    };
  };
  const main = run(join(site, "upcoming.md"), join(site, "data.json"));
  expect(main.parsed, "upcoming.md から時刻を読み取れた行が無い").toBeGreaterThan(100);
  expect(main.claims, "「残り」の猶予欄を読み取れた行が無い").toBeGreaterThan(100);
  // 締切の 30 秒前に生成したビルドで、分の欄を実際に通す。
  expect(main.targets.length, "作り直しの対象にできる締切が無い").toBeGreaterThan(0);
  const target = Math.min(...main.targets.map((t) => Number(t)));
  const stamp = new Date(target - 30_000).toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  const outSub = join(mkdtempSync(join(tmpdir(), "kamiyobi-soon-")), "public");
  const built = runCli(outSub, { now: stamp, extra: ["--no-embeddings"] });
  expect(built.status, built.stderr).toBe(0);
  const sub = run(join(outSub, "upcoming.md"), join(outSub, "data.json"));
  expect(
    sub.soon,
    "締切 30 秒前のビルドで分の欄を通れていない（この検査は空振りになる）",
  ).toBeGreaterThan(0);
  expect(
    [...main.bad, ...sub.bad],
    "実在しない（または次の単位に届かない）猶予を書いた行がある",
  ).toEqual([]);
});

it("health.md の出力ファイル表が、載せないファイルを自分で言い切っている（SPEC §7）", () => {
  /* 「## 出力ファイル」の下に一部のファイルだけを並べると、読者はそれが配付物の全部だと読む。
   * 2026-08-09 生成のビルドで実測: 配付先に置くファイルは 16 件、この表は 13 件で、
   * 除く 3 件（`health.json`・`health.md`・`publish.json`）のことはどこにも書いていなかった。
   * 収録を確かめる人と、ハッシュを突き合わせる機械の両方がそこで止まる。
   * 検査は 3 点。(1) ビルド後の実ファイルと表の対応 (2) 載らないファイルが表の直前の但し書きに
   * 名前で挙がっているか (3) 但し書きが「完全な一覧」として指す `publish.json` の `artifacts` が、
   * 実ファイルを漏れなく載せているか（自分自身の `publish.json` を除く）。 */
  const md = readFileSync(join(site, "health.md"), "utf8");
  const head = md.indexOf("## 出力ファイル");
  expect(head, "health.md に見出し「出力ファイル」が無い").toBeGreaterThan(-1);
  const section = md.slice(head);
  const listed = new Set(
    [...section.matchAll(/^\| (\S+) \| [0-9]+ \| [0-9a-f]{64} \|$/gm)].map((m) => m[1]),
  );
  expect(listed.size, "health.md の出力ファイル表から行が読めない").toBeGreaterThan(5);
  const present = readdirSync(site, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const omitted = present.filter((name) => !listed.has(name)).sort();
  // このビルドでは実際に載らない物が出ている（載らない物が無くなったときは但し書きごと
  // 用がなくなるので、この検査も外す）。
  expect(
    omitted,
    "出力ファイル表が実ファイルを全て載せていて、この検査は空振りになる",
  ).not.toHaveLength(0);
  // 表の直前（但し書き）に、載らない物が名前で挙がっている。
  const tableAt = section.indexOf("\n| ");
  const note = section.slice(0, tableAt < 0 ? section.length : tableAt);
  for (const name of omitted) {
    expect(note, `但し書きが「${name}」にふれていない`).toContain(`\`${name}\``);
  }
  // 但し書きが指す先の publish.json が、本当に漏れなく全ファイルを載せているか。
  const publish = JSON.parse(readFileSync(join(site, "publish.json"), "utf8")) as {
    artifacts: Record<string, { bytes: number; sha256: string }>;
  };
  const covered = Object.keys(publish.artifacts);
  expect(
    present.filter((name) => name !== "publish.json" && !covered.includes(name)),
    "publish.json の artifacts が実ファイルを漏らしている",
  ).toEqual([]);
  // 自分自身のハッシュを持てない物だけを除いている（何でも除外して良いことにしない）。
  expect(omitted.includes("publish.json"), "publish.json が除かれていない").toBe(true);
});

it("upcoming.md の会期行の「残り」が、JST の同じ日なら同じ読みになる（SPEC §7）", () => {
  /* 「本日開催」「開催中(残り N 日)」「N 日後」は暦日で決める表記である。ところが 今日 を UTC の
   * 暦日から取っていた（`dateOnly(safeNow)`）。この表の日付は会期そのもの（時刻を持たない暦日）で、
   * サイトの一覧は JST 固定なので、日本の午前 9 時までのあいだだけ表が一日古くなる。
   * 2026-08-10 08:30 JST 生成で実測: 前日に終わった会期（WISA 2026）が「開催中(残り1日)」として
   * 載り、当日開始の CCCG 2026 と USENIX Security 2026 の 2 件が「1日」＝明日になっていた。
   * 検査は語を書き写さない。JST で同じ日の 2 時刻（生成時刻の 30 分前と 90 分後。UTC の日は
   * 変わる）で 2 通作り、会期行の並びと「残り」が同じであることを比べる。
   * 締切行を比べないのは、締切の残りは経過時間で決まるので 2 通のあいだで正当に変わるため。 */
  const nowMs = Date.parse(data.generated_at);
  const clocks = [new Date(nowMs - 30 * 60_000), new Date(nowMs + 90 * 60_000)];
  // 2 通が JST の同じ日にあること（無ければこの検査は意味を失う）。
  const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
  expect(jstDay(clocks[1].getTime()), "2 通が JST の同じ日に無い").toBe(
    jstDay(clocks[0].getTime()),
  );
  // UTC の日は違っていなければ、直前の実装でも通ってしまう。
  expect(clocks[1].toISOString().slice(0, 10)).not.toBe(clocks[0].toISOString().slice(0, 10));

  const eventRows = (outdir: string) => {
    const md = readFileSync(join(outdir, "upcoming.md"), "utf8");
    const map = new Map<string, string>();
    for (const line of md.split("\n")) {
      if (!line.startsWith("| ")) continue;
      const cells = line.slice(2).split(" | ");
      if (cells.length < 7 || cells[3] !== "開催") continue;
      map.set(cells[2], cells[1]);
    }
    return map;
  };
  const dirs = clocks.map((clock, index) => {
    const outdir = join(mkdtempSync(join(tmpdir(), `kamiyobi-jst-day-${index}-`)), "public");
    const run = runCli(outdir, {
      now: clock.toISOString().replace(/\.[0-9]{3}Z$/, "Z"),
      extra: ["--no-embeddings"],
    });
    expect(run.status, run.stderr).toBe(0);
    return { dir: outdir, rows: eventRows(outdir) };
  });
  const [morningJst, laterJst] = dirs;
  expect(morningJst.rows.size, "会期行が 1 件も読めない（この検査は空振りになる）").toBeGreaterThan(
    0,
  );
  // 同じ日なら、載る会期も「残り」の読みも同じでなければ噓をつく。
  expect(
    [...morningJst.rows.keys()].filter((key) => !laterJst.rows.has(key)),
    "JST の同じ日に、片方にしか載らない会期がある",
  ).toEqual([]);
  const drift = [...morningJst.rows.keys()]
    .filter((key) => laterJst.rows.has(key) && morningJst.rows.get(key) !== laterJst.rows.get(key))
    .slice(0, 4)
    .map((key) => `${key}: 「${morningJst.rows.get(key)}」 -> 「${laterJst.rows.get(key)}」`);
  expect(drift, "JST の同じ日に「残り」の読みが変わる会期がある").toEqual([]);
});

it("llms.txt が data.csv の列をビルドの列定義どおりに載せる（SPEC §7）", () => {
  /* `data.csv` は README でも入口に挙がる成果物なのに、列の辞書がどの公開文書にも無かった。
   * 2026-08-09 生成のビルドで実測: 25 本の列名のうち 7 本（`rank_ccf`・`rank_core`・`edition_id`・
   * `deadline_utc`・`deadline_aoe`・`estimate_window_start`・`estimate_window_end`）は
   * `llms.txt` のどこにも出てこず、Excel で開いた人が空欄と値 'N' の違いを確かめられなかった。
   * 検査は列名を書き写さない。ビルドした `data.csv` のヘッダー行を正として、`llms.txt` の
   * 「## data.csv の列」節が同じ名前を同じ順で、空欄でない説明付きで載せることを見る。
   * 列を足した／削った／順を変えたときに辞書だけが古くなる状態を、この検査が止める。 */
  const csv = readFileSync(join(site, "data.csv"), "utf8");
  const headerLine = csv.split("\n")[0];
  expect(headerLine.includes('"'), "ヘッダー行の読み方が変わる").toBe(false);
  const columns = headerLine.split(",").map((name) => name.trim());
  expect(columns.length, "data.csv のヘッダーが読めない").toBeGreaterThan(10);

  const txt = readFileSync(join(site, "llms.txt"), "utf8");
  const head = txt.indexOf("## data.csv の列");
  expect(head, "llms.txt に「## data.csv の列」の節が無い").toBeGreaterThan(-1);
  const next = txt.indexOf("\n## ", head + 1);
  const section = txt.slice(head, next < 0 ? txt.length : next);

  const entries = section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const at = line.indexOf("：");
      expect(at, `説明の区切り「：」が無い行: ${line.slice(0, 40)}`).toBeGreaterThan(1);
      return { name: line.slice(2, at).trim(), note: line.slice(at + 1).trim() };
    });
  expect(entries.length, "列の項目が読めない").toBeGreaterThan(10);
  expect(
    entries.map((entry) => entry.name),
    "載る列の名前が data.csv と違う",
  ).toEqual(columns);
  for (const entry of entries) {
    expect(entry.note, `列「${entry.name}」の説明が空欄`).not.toBe("");
  }
  // 「この順で N 本」という宣言が実数と合っているか（宣言を書き写すと必ずズレる）。
  const declared = /列はこの順で ([0-9]+) 本。/.exec(section);
  expect(declared, "本数の宣言が無い").not.toBeNull();
  expect(Number(declared?.[1]), "本数の宣言が data.csv の列数と違う").toBe(columns.length);
});

it("JavaScript が動かないとき、index.html が理由と読み替え先を自分で言う（SPEC §7）", () => {
  /* 学内や端末側でスクリプトを止める運用、読み込みの失敗などで JS が動かないと、この画面は
   * 黙って空になる。2026-08-09 生成のビルドで実測: JavaScript を使わないときに出る案内を
   * 一つも置いておらず、表は空・件数は「--」のまま、検索も絞り込みも押せた。
   * 検査は built の index.html から読む。 (1) 案内ブロックが 1 個ある (2) ブロックの中のリンクが
   * すべて相対パスで、しかもビルド先に実在する（配信先はサブパスの下なので、絶対パスは 404 に
   * なる。ビルドしなくなったファイルを指していてもいけない） (3) 空の表より前に出る
   * (4) 静的な HTML に締切の件数を書かない（生成のたびに古くなる語を残さない）。 */
  const html = readFileSync(join(site, "index.html"), "utf8");
  const opens = [...html.matchAll(/<noscript>/g)].length;
  expect(opens, "JavaScript を使わないときの案内が複数あるか、無い").toBe(1);
  const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  expect(block, "案内ブロックの閉じが無い").not.toBeNull();
  const inner = String(block?.[1]);
  const text = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  expect(text.length, "案内が空である").toBeGreaterThan(60);
  expect(text.includes("JavaScript"), "何が効かないのかが書かれていない").toBe(true);
  /* 静的な HTML に収録数の噓を置かない。締切の総数は生成のたびに動くので、ここで 3 桁以上の
   * 「N 件」を書いた瞬間に古くなる（「1 行 1 件」のような形の話は残して良い）。 */
  expect(
    /[0-9][0-9,]{2,} ?件/.test(text),
    `静的な HTML に収録数を書いている: ${text.slice(0, 60)}`,
  ).toBe(false);
  // リンクは相対パスで、実在する物だけ。
  const hrefs = [...inner.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(hrefs.length, "読み替え先の案内が無い").toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href, `絶対パスのリンクはサブパス配信で切れる: ${href}`).not.toMatch(/^(?:\/|https?:)/);
    expect(existsSync(join(site, href)), `案内が指す ${href} がビルド先に無い`).toBe(true);
  }
  // 空の表より前に読む位置にあること。
  const results = html.indexOf('id="results"');
  expect(results, "一覧の目印が無い").toBeGreaterThan(-1);
  expect(html.indexOf("<noscript>"), "案内が表のうしろに回っている").toBeLessThan(results);
});

it("llms.txt の出力一覧が、ビルドが置いたファイルを一つも漏らさない（SPEC §7）", () => {
  /* `llms.txt` は機械が読む索引なのに、2026-08-09 生成のビルドで実測すると「出力一覧」は
   * 16 件中 10 件しか並べておらず、`recommendation-core.js`・`publish.js`・`icon.svg`・
   * `.nojekyll` など公開物の 4 割が何かも分からないままだった（第 189 回に health.md で
   * 見たのと同じ形）。名前はビルドの定数から生成しているので、**ビルド先に実在する物を
   * 全部載せているか**をビルドした出力から確かめる（定数を書き写さない）。
   * 載せたのに無いファイルは、その行が自分で「こういうビルドだけに出る」と説明していること。
   * 黙って載せたまま 404 を教えないようにする。 */
  const llms = readFileSync(join(site, "llms.txt"), "utf8");
  const start = llms.indexOf("## 出力一覧");
  expect(start, "出力一覧の節が無い").toBeGreaterThanOrEqual(0);
  const rest = llms.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const entries = [...section.matchAll(/^- ([^：\r\n]+)：([^\r\n]*)/gm)];
  expect(entries.length, "出力一覧が空である").toBeGreaterThan(0);
  const named = entries.map((m) => m[1].trim());
  expect(new Set(named).size, "同じファイルを二回載せている").toBe(named.length);
  for (const [name, note] of entries.map((m) => [m[1].trim(), m[2].trim()] as const)) {
    expect(note.length, `説明が空欄: ${name}`).toBeGreaterThan(4);
    if (existsSync(join(site, name))) continue;
    expect(
      note.includes("出ない"),
      `ビルド先に無い ${name} を載せているのに、どのビルドに出ないのかを書いていない`,
    ).toBe(true);
  }
  for (const name of readdirSync(site)) {
    expect(named.includes(name), `ビルドが置いた ${name} が出力一覧に無い`).toBe(true);
  }
});

it("画面が「ランク」と呼ぶ語で、等級の行に実際に出会える（SPEC §7）", async () => {
  /* 列の見出し・選択欄・早め絞り込みのボタンは等級を「ランク」と呼ぶ（ボタンは `A*ランク`）。
   * 2026-08-09 生成のビルドで実測: ボタン名どおり `A*ランク` と打つと 0 件、半角スペースを挟んだ
   * `A* ランク` も 0 件、語順を逆にした `ランク A*` も 0 件で、`A*` 単体の 156 件に出会えなかった。
   * 「表に出す語で検索できる」を検索の実装の不変条件にしているので、画面の語の形でも引けるように
   * 直す。検査は built の recommender.js を built の catalog.json に走らせて数える。等級の並び、
   * 画面のボタン名、正解の集合のすべてを実行時と画面から取る（等級を書き写さない）。
   * 正解は「その等級を画面のランク表記で表示している行」とし、同じ関数の出力から組み立てる。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const html = readFileSync(join(site, "index.html"), "utf8");
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const rowId = (r: (typeof rows)[number]) =>
    `${String(r.conf.title ?? "")}|${String(r.ed.year ?? "")}|${String(r.dl?.utc ?? "")}`;
  const hits = (query: string) =>
    new Set(rows.filter((r) => R.searchMatcher(query, clock)(r.hay ?? "")).map(rowId));
  /* 正解の集合は、検索の実装ではなく**行が持つ等級の組**から作る。`N`（一覧に載っているが
   * 評価が付いていない）は画面が「評価なし」と出す語なので、等級としては数えない。 */
  const unrated = R.rankUnratedLabelJa();
  const showingGrade = (grade: string) =>
    new Set(
      rows
        .filter((r) =>
          (r.rankPairs ?? []).some(
            (pair: string) =>
              pair.slice(pair.indexOf(":") + 1).toUpperCase() === grade.toUpperCase() &&
              !R.rankPairLabelJa(pair).includes(unrated),
          ),
        )
        .map(rowId),
    );
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));

  /* (1) 全等級で、画面の書き方「Xランク」はその等級を表示している行だけを出す。 */
  let tested = 0;
  for (const grade of R.rankGradeOrderJa()) {
    const exact = showingGrade(grade);
    expect(
      same(hits(`${grade}ランク`), exact),
      `語「${grade}ランク」が表示している行と食い違う`,
    ).toBe(true);
    if (exact.size > 0) tested += 1;
  }
  // データ側の空振り確認: 等級の表示を持つ行が1行も無いビルドなら、上の照合は全部空になる。
  expect(
    rows.filter((r) => (r.rankPairs ?? []).length > 0).length,
    "ランク表記を持つ行がテストのビルドに無い",
  ).toBeGreaterThan(0);
  expect(tested, "等級の表示を持つ行があるのに、どの等級でも一致しなかった").toBeGreaterThan(0);

  /* (2) 画面に出ている早め絞り込みのボタン名を、そのまま検索に打てる。 */
  const labels = [...html.matchAll(/class="preset-btn"[^>]*>([A-C]\*?)ランク<\/button>/g)].map(
    (m) => m[1],
  );
  expect(labels.length, "ランクの早め絞り込みが画面に見当たらない").toBeGreaterThan(0);
  // テストのビルドは固定の収録データなので、この等級の行が 0 件のことがある。空の集合同士の
  // 一致を許すと空振りするので、行を持つ等級が1つ以上あることを上で確かめておく。
  for (const grade of labels) {
    const base = hits(grade);
    // ボタン名どおり、語順を変えても、語を離して打っても、同じ行に出会う。
    for (const variant of [
      `${grade}ランク`,
      `${grade} ランク`,
      `ランク ${grade}`,
      `${grade}評価`,
    ]) {
      expect(same(hits(variant), base), `語「${variant}」が「${grade}」と同じ行を出さない`).toBe(
        true,
      );
    }
  }
});

it("等級を呼ぶ語だけで打った人に、絞れていないことと別の言い方を与える（SPEC §7）", async () => {
  /* 列の見出しは等級を「ランク」と呼ぶので、その語に「なし」を添えて打つ人と、単独の「ランク」を
   * 打つ人がいた。2026-08-09 生成のビルドで実測: `ランクなし` は 0 件（画面の語 `評価なし` は
   * 139 件）、`ランク` 単体は 798 / 863 行を返して何も説明しておらず、絞れたと読み違えられる。
   * 直す。検査は built の recommender.js を built の catalog.json に走らせる。見出しの語は画面から、
   * 評価の語の語幹と等級の例は実行時の出力から取る（画面の語を書き写さない）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const html = readFileSync(join(site, "index.html"), "utf8");
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const rowId = (r: (typeof rows)[number]) =>
    `${String(r.conf.title ?? "")}|${String(r.ed.year ?? "")}|${String(r.dl?.utc ?? "")}`;
  const hits = (query: string) =>
    new Set(rows.filter((r) => R.searchMatcher(query, clock)(r.hay ?? "")).map(rowId));
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));

  const unrated = R.rankUnratedLabelJa();
  const grade = R.rankGradeOrderJa()[0];

  /* (1) 見出しの語 + 「なし」は、画面の語で引いた人と同じ行に出会う。 */
  expect(hits(unrated).size, "評価の無い行がテストのビルドに無い").toBeGreaterThan(0);
  expect(
    same(hits("ランクなし"), hits(unrated)),
    "語「ランクなし」が画面の語と同集合を出さない",
  ).toBe(true);
  expect(R.querySynonymNotes("ランクなし").join(""), "寄せた先を説明していない").toContain(unrated);

  /* (2) 等級を呼ぶ語だけを打った人には、絞れていないことと等級の語の例を書く。 */
  const heading = /<label for="rank"[^>]*>([^<]+)<\/label>/.exec(html)?.[1] ?? "";
  expect(heading.length, "ランクの見出しが画面に見当たらない").toBeGreaterThan(0);
  // 画面は評価の無い行に「評価なし」と出すので、その語幹も等級を呼ぶ語として同じ扱いになる。
  const stem = unrated.replace(/なし$/, "");
  expect(stem.length, "評価の語の語幹が空").toBeGreaterThan(0);
  for (const word of [heading, stem]) {
    expect(hits(word).size, `語「${word}」が 0 件（おしらせ以前の問題）`).toBeGreaterThan(0);
    const notes = R.querySynonymNotes(word).join("");
    expect(notes.length, `語「${word}」のおしらせが出ていない`).toBeGreaterThan(0);
    expect(notes).toContain(word);
    expect(notes, "等級の語の例を置いていない").toContain(`${grade}ランク`);
  }

  /* (3) 等級の語をいっしょに入れた人には、余計なおしらせを出さない。 */
  for (const word of [heading, stem]) {
    expect(R.querySynonymNotes(`${grade}${word}`), "等級を絞れているのに教えた").toEqual([]);
    expect(R.querySynonymNotes(`${grade} ${word}`), "語を離しても同じ").toEqual([]);
  }
  expect(R.querySynonymNotes(`一致${stem}`), "別の合成語につられた").toEqual([]);
  expect(R.querySynonymNotes(unrated), "画面の語そのものに教える必要は無い").toEqual([]);
});

it("半角カタカナで貼っても、全角で打ったのと同じ行に出会える（SPEC §7）", async () => {
  /* 古いメーリングリストの書き込みや端末の出力には半角カタカナが混ざることがあり、それを検索欄に
   * 貼る人がいる。検索は両側を NFKC に寄せているので、濁点（ｶﾞ）と小文字（ｬ）を分けた形でも
   * 同じ行に出会えるはずがある。2026-08-09 生成のビルドで実測: 収録データに出てくるカタカナ語
   * 7 語（シンガポール・ハンガリー・ポルトガル・ブルガリア・キャンパス・ハイパフォーマンス
   * コンピューティング・パターン）で全角と半角の件数が一致した。この一致を検査で留める。
   * 変換表は検査側に持つので、**半角に直してから組み戻すと元の語になること**を先に確かめる
   * （このラウンドの実測で、表の語の数が1つ足りずに "undefined" が混ざった変換を確かめず
   * 使い、0 件を欠陥だと読み違えかけた。その経路を閉じる）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const hits = (query: string) =>
    rows.filter((r) => R.searchMatcher(query, clock)(r.hay ?? "")).length;

  const FULL =
    "ァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
  const HALF = "ｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ";
  expect(HALF.length, "半角カタカナの変換表の語の数が合っていない").toBe(FULL.length);
  const VOICED: Array<[string, string]> = [
    ["ガ", "ｶﾞ"],
    ["ギ", "ｷﾞ"],
    ["グ", "ｸﾞ"],
    ["ゲ", "ｹﾞ"],
    ["ゴ", "ｺﾞ"],
    ["ザ", "ｻﾞ"],
    ["ジ", "ｼﾞ"],
    ["ズ", "ｽﾞ"],
    ["ゼ", "ｾﾞ"],
    ["ゾ", "ｿﾞ"],
    ["ダ", "ﾀﾞ"],
    ["デ", "ﾃﾞ"],
    ["ド", "ﾄﾞ"],
    ["バ", "ﾊﾞ"],
    ["ビ", "ﾋﾞ"],
    ["ブ", "ﾌﾞ"],
    ["ベ", "ﾍﾞ"],
    ["ボ", "ﾎﾞ"],
    ["パ", "ﾊﾟ"],
    ["ピ", "ﾋﾟ"],
    ["プ", "ﾌﾟ"],
    ["ペ", "ﾍﾟ"],
    ["ポ", "ﾎﾟ"],
  ];
  const toHalf = (word: string): string => {
    let out = "";
    for (const ch of word) {
      const voiced = VOICED.find((pair) => pair[0] === ch);
      if (voiced) {
        out += voiced[1];
        continue;
      }
      const at = FULL.indexOf(ch);
      out += at >= 0 ? HALF[at] : ch;
    }
    return out;
  };

  /* 収録データに実在する、濁点を含むカタカナ語を集める（画面の語を書き写さない）。 */
  const words: string[] = [];
  for (const r of rows) {
    for (const m of String(r.hay ?? "").matchAll(/[\u30a2-\u30f3][\u30a1-\u30f3\u30fc]{3,}/g)) {
      if (/[\u30ac\u30d0\u30d1]/.test(m[0]) && words.indexOf(m[0]) < 0) words.push(m[0]);
    }
    if (words.length >= 5) break;
  }
  expect(
    words.length,
    "濁点を含むカタカナ語が収録データに見当たらない（検査が空振り）",
  ).toBeGreaterThanOrEqual(3);
  for (const word of words) {
    const half = toHalf(word);
    // 変換表の自己検査: ここで壊れていたら、下の一致は意味を持たない。
    expect(half.normalize("NFKC"), `半角への変換が「${word}」を組み戻せない`).toBe(word);
    const base = hits(word);
    expect(base, `語「${word}」が 0 件（空振り）`).toBeGreaterThan(0);
    expect(hits(half), `半角「${half}」が全角「${word}」と違う行数を出した`).toBe(base);
  }
});

it("データに在る概念を、日本語の言い方で引ける（SPEC §7）", async () => {
  /* ポスター発表・デモ発表・チュートリアル企画のように、上流は英語で書き、表は種別を
   * 「その他」としか出さないことがある。日本語で打った人は 0 件になり、収録されているのに
   * 「無い」と読むしかなかった（2026-08-09 生成ビルドで実測: `ポスター` 0 件なのに原文の
   * poster は 6 行、`デモ` 0 件 / demo 7 行、`チュートリアル` 0 件 / tutorial 6 行）。
   * 表の語は built の `recommender.js` から拾い、件数は built の行に対して数える
   * （語も件数も書き写さない）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const source = readFileSync(join(site, "recommender.js"), "utf8");
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const hits = (query: string) =>
    rows.filter((r) => R.searchMatcher(query, clock)(r.hay ?? "")).length;

  const entries: Array<[string, string, string]> = [];
  for (const m of source.matchAll(/\["([^"]+)", "(原文の [^"]+)", \["([^"]+)"\]\]/g)) {
    entries.push([m[1], m[2], m[3]]);
  }
  expect(
    entries.length,
    "原文の語へ寄せる表から語を拾えない（検査が空振り）",
  ).toBeGreaterThanOrEqual(5);

  /* 展開語が検査用の品書に無い語を、収録の側と突き合わせる（第 306 回）。検査用の品書は
     `tests/fixtures` だけから作る 435 行で、実ビルドの品書 872 行より小さい – `recommendation`
     は実ビルドで 7 行に出会えるが、検査用の収録には収録元が来ていない。ここで見るのは
     「実在しない語を寄せない」なので、収録の側（`data/snapshot.json`）に在れば通す
     （検査用の品書だけで見ると、実データに在る語を寄せるたびに検査が落ちる）。 */
  const shipped = readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8").toLowerCase();
  for (const [word, shown, term] of entries) {
    const reached = hits(term);
    if (reached === 0) {
      expect(
        shipped.includes(term.toLowerCase()),
        `展開語「${term}」が収録にも検査用のデータにも無い（寄せた先が空）`,
      ).toBe(true);
    }
    /* 寄せた側は展開語を **括った語** として括る（`ビッグデータ` → "big data"）。展開語その物を
     * 打たれた検索は 2 つの語にばらして括るので、`big data` は `Big Spatial Data` を含む行も
     * つかまえる（2026-08-09 生成の検査用の品書で実測: ばらして 20 行、括った語で 19 行 –
     * 第 306 回）。基準は画面の照合と同じ語の区切りにする – 画面は `demo` を `demons` の中に
     * 当てない（その語を書く 2 行のうち 1 行は部分一致だけで、画面は括らなかった）。
     * なので 1 語の展開語は画面の照合その物（`reached`）を、2 語以上の英文字の展開語は
     * 語として括った行数を基準にする。*/
    const 語として含む = (hay: string): boolean =>
      new RegExp(`(^|[^a-z0-9])${term.toLowerCase()}([^a-z0-9]|$)`).test(hay);
    const 出会うべき行数 =
      /^[a-z0-9]+ [a-z0-9 ]+$/.test(term.toLowerCase()) && term.includes(" ")
        ? rows.filter((r) => 語として含む(String(r.hay ?? "").toLowerCase())).length
        : reached;
    expect(
      hits(word),
      `語「${word}」が展開語「${term}」を書く行に出会えていない（その語を書く行は ${出会うべき行数} 行）`,
    ).toBeGreaterThanOrEqual(出会うべき行数);
    const notes = R.querySynonymNotes(word);
    expect(notes.length, `語「${word}」を寄せたことが件数欄に出ない`).toBeGreaterThan(0);
    const note = notes.join("・");
    expect(note, `おしらせに打ち込んだ語が書かれていない: ${note}`).toContain(word);
    expect(note, `おしらせが原文の語を言っていない: ${note}`).toContain(term);
    expect(note, `おしらせが原文の語だと書いていない: ${note}`).toContain("原文");
    expect(shown, `寄せ先の言い方に原文の語が在らない: ${shown}`).toContain(term);
  }
});

it("上流の言い方で打った人が、画面の種別の語に出会える（SPEC §7）", async () => {
  /* 「論文募集」は上流（Call for Papers）の言い方で、表は種別「論文締切」を出す。打ち込んだ
   * 人に画面の語を知らないと 0 件を返していた（2026-08-09 生成ビルドで実測: `論文募集` 0 件）。
   * 寄せた先の語は検査側で書かず、件数欄のおしらせから取り、行が持つ種別と照らす。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const word = "論文募集";
  const notes = R.querySynonymNotes(word);
  expect(notes.length, `語「${word}」を寄せたことが件数欄に出ない`).toBeGreaterThan(0);
  const label = /種別「([^」]+)」/.exec(notes.join("・"))?.[1];
  expect(label, `おしらせが種別の語を言っていない: ${notes.join("・")}`).toBeTruthy();
  const labels = R.kindLabelTable();
  expect(Object.values(labels), `おしらせが出した「${label}」は画面の種別の語ではない`).toContain(
    label as string,
  );
  const matched = rows.filter((r) => R.searchMatcher(word, clock)(r.hay ?? ""));
  expect(matched.length, `語「${word}」に出会う行が 0 件（空振り）`).toBeGreaterThan(0);
  for (const r of matched) {
    expect(
      R.kindLabelJa((r as { kind?: string }).kind ?? ""),
      `語「${word}」で出た行の種別が「${label}」ではない`,
    ).toBe(label as string);
  }
});

it("掲載先に入れた語が今の行に無いことを、件数欄が誤らずに言う（SPEC §7）", async () => {
  /* 「入力の例」は掲載先まで打ち替えてくれるが、その会議の締切が今は出ていないことがあり、
   * 候補は別に出るため、探している掲載先だけが黙って消えたように見えていた
   * （2026-08-09 生成ビルドで実測: 例の 1 件は掲載先を `IEEE RTSS` と指定し、検索対象
   * 863 行に RTSS は 0 行で、候補は 44 件出ていた）。
   * 言う・言わないの境目を、built の行と built の検索式から求める（語も件数も書き写さない）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const clock = NOW.getTime();
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const html = readFileSync(join(site, "index.html"), "utf8");
  const venues = [...html.matchAll(/data-sample="([^"]+)"/g)]
    .map((m) => String(m[1].split("|")[2] || "").trim())
    .filter(Boolean);
  expect(venues.length, "入力の例から掲載先を拾えない（検査が空振り）").toBeGreaterThanOrEqual(1);

  const bySearch = (venue: string) =>
    rows.filter((r) => R.searchMatcher(venue, clock)(r.hay ?? "")).length;
  const lookup = (venue: string) =>
    R.unmatchedVenues([{ title: "Test title", keywords: "test", venue }], rows);

  for (const venue of venues) {
    const miss = lookup(venue);
    if (bySearch(venue) > 0) {
      expect(miss, `掲載先「${venue}」はその語で行が引けるのに「見当たりません」と出す`).toEqual(
        [],
      );
    } else {
      expect(miss, `掲載先「${venue}」はどの行にも当たらないのに黙っている`).toEqual([venue]);
      const notice = R.venueLookupNoticeJa(miss);
      expect(notice, `おしらせに打ち込んだ掲載先が書かれていない: ${notice}`).toContain(venue);
      expect(notice, `おしらせが掲載先の話だと書いていない: ${notice}`).toContain("掲載先");
    }
  }

  /* 会議名のかたまり（名前の照合が使う文字列）。下の 2 つの検査で使う。 */
  const names = rows
    .map((r) => `${r.conf.key || ""} ${r.conf.title || ""} ${r.conf.full_name || ""}`.toLowerCase())
    .join(" ");

  /* 空欄のときにおしらせを出さないことと、必ず見当たらない語では言うこと。後者は収録に
   * 左右されない語で見るが、当たらないこと（検索でも名前でも）を先に測ってから使う。 */
  expect(R.venueLookupNoticeJa([]), "掲載先が空のときにおしらせを出す").toBe("");
  const absent = "掲載先テスト専門誌";
  expect(bySearch(absent), `「${absent}」が引けてしまう（検査が空振り）`).toBe(0);
  expect(names.includes(absent), `「${absent}」が会議名に入ってしまっている`).toBe(false);
  expect(lookup(absent), "見当たらない掲載先をおしらせしない").toEqual([absent]);

  /* その語で行が引けるときに「見当たりません」と言わないこと（名前の照合だけでは足りない側）。
   * 行の検索文に出てくる和語のうち、どの会議名にも入っていない物から引く。
   * 当たった語が必ずしも掲載先の名前ではなくても、照合の経路は同じなので有効に検査になる。 */
  const candidates = [
    ...new Set(
      rows.flatMap((r) =>
        String(r.hay ?? "")
          .split(/[ 　,;|]+/)
          .filter((t) => /[぀-ヿ]{4,}/.test(t)),
      ),
    ),
  ];
  const hayOnly = candidates.find((word) => !names.includes(word) && bySearch(word) > 0);
  expect(hayOnly, "検索文にだけ入る和語が見つからない（検査が空振り）").toBeTruthy();
  expect(
    lookup(String(hayOnly)),
    `その語で行が引けるのに「${hayOnly}」を「見当たりません」と出した`,
  ).toEqual([]);
});

it("掲載先のおしらせは画面の組み立てに繋がっている（SPEC §7）", () => {
  /* 判定を recommender に移したとき、UI 側から外れて黙って消える経路を塞ぐ。 */
  const app = readFileSync(join(site, "app.js"), "utf8");
  expect(app, "built の app.js が行に見当たらない掲載先を数えていない").toContain(
    "unmatchedVenues(",
  );
  expect(app, "built の app.js おしらせを件数欄に載せていない").toContain("venueLookupNoticeJa(");
});

it("「締切まで N 日」の窓は、同じ画面が「あと N 日」と出す行を落とさない（SPEC §7）", async () => {
  /* 窓は経過 24 時間（`now + N 日`）で切り、行の「残り」と締切欄は JST の暦日を見ていた。
   * 2026-08-09 生成ビルドで実測: 「締切まで 7 日」を選ぶと、同じ画面が「あと 7 日」と
   * 出す行が JST 09:00 の眺めで 10 件、20:00 で 8 件、翌朝 06:00 で 5 件、窓の外に落ちて
   * 消えた（30 日で 5 件、90 日で 2 件）。逆方向もあった: 締切欄が 9/10 なのに `t` が
   * JST 9/9 19:00 の行 10 件が「30 日以内」に並びながら「あと 31 日」と出ていた。
   * 窓の式・行の比較・「残り」をビルド成果物から抜き出して、全行で食い違い 0 件を見る。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const api = new Function(
    "Date",
    "DAY",
    `${[
      jsFunction(app, "windowLimitMs"),
      jsFunction(app, "windowFloorMs"),
      jsFunction(app, "remain"),
    ].join("\n")}
return { limit: windowLimitMs, floor: windowFloorMs, remain };`,
  ) as (
    dateCtor: unknown,
    day: number,
  ) => {
    limit: (win: string, now: number) => number;
    floor: (win: string, now: number) => number;
    remain: (ms: number) => { text: string };
  };
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const DAY = 86400000;
  let 暦日だから並ぶ行 = 0;
  let 見た行 = 0;

  // 見る時刻で窓の端が動いていた不具合なので、複数の時刻で同じ行を眺める
  for (const offset of [0, 5 * 3600000, 11 * 3600000, 21 * 3600000]) {
    const now = NOW.getTime() + offset;
    class FakeDate extends Date {
      static now() {
        return now;
      }
    }
    const { limit, floor, remain } = api(FakeDate, DAY);
    for (const days of [7, 30, 90, 180]) {
      const win = `${days}d`;
      const hi = limit(win, now);
      const lo = floor(win, now);
      for (const row of rows) {
        const shown = Number.isFinite(row.tShown) ? row.tShown : row.t;
        if (!Number.isFinite(shown) || shown < now) continue;
        const hit = /^あと (\d+) 日$/.exec(remain(shown).text);
        const counted = hit ? Number(hit[1]) : shown - now < DAY ? 0 : null;
        if (counted === null) continue;
        見た行 += 1;
        const inWindow = shown <= hi && shown >= lo;
        const title = String(row.conf.title).slice(0, 24);
        expect(
          inWindow || counted > days,
          `「あと ${counted} 日」の ${title} が「${days} 日以内」に並ばない`,
        ).toBe(true);
        expect(
          !inWindow || counted <= days,
          `「${days} 日以内」に「あと ${counted} 日」の ${title} が並ぶ`,
        ).toBe(true);
        // 直す前の式（経過 24 時間）では窓の外だった行があることを数える（空振り防止）
        if (counted <= days && !(row.t <= now + days * DAY)) 暦日だから並ぶ行 += 1;
      }
    }
  }
  expect(見た行, "窓の中で見る行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(
    暦日だから並ぶ行,
    "経過 24 時間と暦日で窓の入り方が変わる行が無い（検査が空振り）",
  ).toBeGreaterThan(0);
});

it("締切の窓は行の「表示している暦日」で比べている（SPEC §7）", () => {
  /* 窓の端を暦日にしても、比較する値が `row.t` のままなら同じ噓が残る
   * （`t` は JST 2026-09-09 19:00 なのに締切欄に 9/10 と出る行が 10 件在った）。
   * `filter` の組み立てをビルド成果物から見て、比較を表示暦日に揃えたことを確かめる。 */
  const app = siteRuntime();
  // 第 228 回で比較は共有関数に寄せた（画面上部の「これからの30日間の締切」と一覧が
  // 違う目盛りを持つようになったので、1 本にまとめる側の検査に組み替える）。
  expect(jsFunction(app, "rowShownDayMs"), "表示暦日が tShown を見ていない").toContain("r.tShown");
  const after = jsFunction(app, "rowAfter");
  expect(after, "窓の上側が行の表示暦日で比較されていない").toContain(
    "rowShownDayMs(r) > dateLimit",
  );
  expect(after, "窓の上側が締切の瞬間で比較している").not.toContain("r.t >");
  const body = jsFunction(app, "filter");
  expect(body, "絞り込みが共有した窓の比較を見ていない").toContain("rowAfter(r, limit)");
  expect(body, "窓の下側が行の表示暦日を使っていない").toContain("rowShownDayMs(r) < floor");
});

it("推薦画面の印刷見出しは、用紙に載る枚数と候補の総数を言い分ける（SPEC §7）", async () => {
  /* 推薦画面は印刷前にカードを足す処理が無く、20 枚しか無い列に「候補 20 件」と
   * 見出しが刷れていた（2026-08-09 生成ビルドで実測: サンプル論文の候補 114 件、
   * 画面は「まず上位 20 件を表示」と言うのに用紙は「候補 20 件」＝ 94 件が紙に無い
   * ことが分からない）。見出しの組み立てをビルド成果物から抜き出して、
   * 載る枚数と総数が違うときに両方を書くことを見る。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const helpers = ["pad", "countJa", "fmtJst", "generatedAtLabel", "printLegendJa", "fillPrintMeta"]
    .map((name) => jsFunction(app, name))
    .join("\n");
  const weekday = /\bconst WEEKDAY_JA = \[[^\]]*\];/.exec(app);
  if (!weekday) throw new Error("WEEKDAY_JA が見つからない（検査の組み立てを直す）");
  const body = `${weekday[0]}\n${verificationLabelsSource()}\n${helpers}\nreturn fillPrintMeta;`;
  const names = [
    "$",
    "DATA",
    "state",
    "valueElement",
    "shown",
    "sortKey",
    "sortAsc",
    "sortColumnLabel",
    "KIND_LABEL",
    "rankFilterLabelJa",
    "Recommender",
    "describeFilters",
    "recommendationList",
  ];
  const used = names.filter((name) =>
    name === "$" ? body.includes("$(") : new RegExp(`\\b${name.replace("$", "\\$")}\\b`).test(body),
  );
  const build = new Function(...used, "Date", body) as (...args: unknown[]) => () => void;

  const header = (drawn: number, total: number): string => {
    const box: { textContent: string } = { textContent: "" };
    const env: Record<string, unknown> = {
      $: (id: string) =>
        id === "printMeta"
          ? box
          : id === "recommendationCards"
            ? { children: { length: drawn } }
            : null,
      DATA: { generated_at: "2026-08-09T00:00:00Z" },
      state: { mode: "recommend", win: "all" },
      valueElement: () => null,
      shown: [],
      sortKey: "deadline",
      sortAsc: true,
      sortColumnLabel: "",
      KIND_LABEL: {},
      rankFilterLabelJa: () => "",
      Recommender: R,
      describeFilters: () => "",
      recommendationList: { length: total },
    };
    class FixedDate extends Date {
      static now() {
        return NOW.getTime();
      }
    }
    build(...used.map((name) => env[name]), FixedDate)();
    return box.textContent;
  };

  const すくない = header(1, 3);
  expect(
    すくない,
    "用紙に載る枚数より候補が多いのに、枚数だけを候補の数として書いている",
  ).toContain("候補 3 件のうちこの用紙に 1 件");
  expect(すくない, "続きが画面にあることが紙で読めない").toContain("さらに表示");

  const ぜんぶ = header(3, 3);
  expect(ぜんぶ).toContain("候補 3 件");
  expect(ぜんぶ, "全部載っている紙に「この用紙に」を足さない").not.toContain("この用紙に");
  expect(すくない === ぜんぶ, "載る枚数が違っても同じ見出しになる（検査が空振り）").toBe(false);
});

it("印刷前に推薦のカードを候補ぶんぜんぶ出している（SPEC §7）", () => {
  /* 表の枝には「用紙に載せるためにもっと見る」処理が有って、推薦の枝は抜けていた。
   * 見出しの文言を直しても、カードが 20 枚のままで候補 114 件の紙は刷れない。
   * `"beforeprint"` を引用符付きで探す（注釈の中の語に当たって空振りしたため –
   * 第 204 回に実際へしこた）。 */
  const app = siteRuntime();
  const at = app.indexOf(`"beforeprint"`);
  expect(at, "印刷前の処理が見当たらない").toBeGreaterThan(-1);
  const open = app.indexOf("{", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    else if (app[i] === "}") {
      depth -= 1;
      if (!depth) {
        close = i;
        break;
      }
    }
  }
  const handler = app.slice(open, close + 1);
  expect(handler, "印刷前に推薦のカードを足す処理が無い").toContain("drawMoreCards(");
  expect(
    handler.indexOf("drawMoreCards("),
    "見出しの件数がカードの枚数を数える前に書かれている",
  ).toBeLessThan(handler.indexOf("fillPrintMeta();"));
});

it("印刷の但し書きは「公式表記」列の実物を説明している（SPEC §7）", async () => {
  /* 但し書きは「「公式表記」は収録元がその締切に付けた呼び方そのもの」と刷っていたが、
   * 列に入っているのはいつ締めるかの宣言だった（2026-08-09 生成ビルドで実測: 値は
   * 「2026-07-21 23:59 AoE」「PDT ／ UTC」「時刻未確認」など 18 種で、収録元の締切名は
   * 候補行 863 行のどこにも入っていない。締切名は「種別」列に出る）。説明を信じて表計算で
   * この列を分類として読む人が、探している行を 1 行も出せない。
   * 但し書きの文を built から抜き、列の実値と突き合わせる（語の書き写しはしない）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const legend = (
    new Function(
      "Recommender",
      `${verificationLabelsSource()}\n${jsFunction(app, "printLegendJa")}\nreturn printLegendJa;`,
    )(R) as () => string
  )();
  const built = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  ) as unknown as Record<string, unknown>[];
  const csv = R.deadlinesToCsv(built, NOW.getTime());
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    const q = '"';
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === q) {
          if (line[i + 1] === q) {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === q) quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  const head = cells(lines[0]);
  const official = new Set<string>();
  const kinds = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const c = cells(lines[i]);
    official.add(String(c[head.indexOf("公式表記")] || ""));
    kinds.add(String(c[head.indexOf("種別")] || ""));
  }
  expect(
    [...official].filter(Boolean).length,
    "公式表記の値が少なすぎる（検査が空振り）",
  ).toBeGreaterThanOrEqual(5);
  expect(
    [...kinds].filter(Boolean).length,
    "種別の値が少なすぎる（検査が空振り）",
  ).toBeGreaterThanOrEqual(3);
  // 前提: 公式表記の列は締切名の分類ではない（種別の値と重ならない）
  const overlap = [...kinds].filter((k) => official.has(k));
  expect(overlap, "公式表記の列に種別の値が入るようになった（前提が変わった）").toEqual([]);

  const sentences = legend.split("。").filter((seg) => seg.includes("公式表記"));
  expect(sentences.length, "但し書きが公式表記の列を説明していない").toBeGreaterThan(0);
  const said = sentences.join("。");
  // 説明が挙げる語は、実際にその列へ入っている物だけでなければならない
  const real = ["AoE", "UTC", R.notApplicableLabelJa() === "" ? "" : "", "時刻未確認"].filter(
    (w) => w !== "" && [...official].some((v) => v.includes(w)),
  );
  expect(
    real.length,
    "公式表記の列に見当たらない語を検査している（検査が空振り）",
  ).toBeGreaterThanOrEqual(2);
  const 列の実物から説明している語 = real.filter((w) => said.includes(w));
  expect(
    列の実物から説明している語.length,
    `但し書きの公式表記の説明が、列の実値（${real.join("・")}）のどれにも触れていない: ${said}`,
  ).toBeGreaterThanOrEqual(2);
  expect(
    said,
    "締切名は別列（種別）に出しているのに、但し書きが公式表記の列の呼び方だと刷っている",
  ).not.toContain("呼び方");
});

it("一覧の会期欄に出る日付をそのまま打つと、その行に出会う（SPEC §7）", async () => {
  /* 会期欄は `2026-12-03(木) 〜 2026-12-04(金)` と ISO 日付を出しているのに、その語を
   * 打つと会期がその日の行が 1 行も出なかった（2026-08-09 生成ビルドで実測: 会期欄の
   * ISO 日付は延べ 1,214 箇所・230 種、うち 1,172 箇所は表示している行自身が引けず、
   * 「12月3日」で残った 4 件は締切がたまたま同じ日の行だった）。画面に出ている語が
   * 引けない状態なので、表示と同じ `eventCellJa` の式から日付を数える。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const rows = R.candidateRows(catalog);
  const だめ: string[] = [];
  let 箇所 = 0;
  let 会期でしか当たらない = 0;
  rows.forEach((r) => {
    const hay = String(r.hay);
    const shown = new Date(r.tShown + 9 * 3_600_000);
    [...R.eventCellJa(r).matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)].forEach((m) => {
      箇所 += 1;
      const iso = m[0];
      const wa = `${Number(m[2])}月${Number(m[3])}日`;
      const 和暦年 = `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
      const hit = (q: string) => R.searchMatcher(q, NOW.getTime())(hay);
      if (!(hit(iso) && hit(wa) && hit(和暦年))) {
        だめ.push(`${iso}（${String(r.conf.title).slice(0, 18)}）`);
      }
      const 締切が同じ日 =
        shown.getUTCFullYear() === Number(m[1]) &&
        shown.getUTCMonth() + 1 === Number(m[2]) &&
        shown.getUTCDate() === Number(m[3]);
      if (!締切が同じ日 && hit(iso)) 会期でしか当たらない += 1;
    });
  });
  expect(箇所, "会期欄の日付が読めていない（検査が空振り）").toBeGreaterThanOrEqual(400);
  expect(だめ.slice(0, 3).join(" / "), `会期欄の日付が引けない箇所が ${だめ.length} 箇所有る`).toBe(
    "",
  );
  expect(
    会期でしか当たらない,
    "会期の日付でしか当たらない行が無い（実装が締切の日付を足し直しているだけ）",
  ).toBeGreaterThanOrEqual(20);
  // 曜日は締切の日の語のままにする（会期終了日の曜日を検索語に足すと「金曜日」が
  // 131 件 → 398 件に膨らみ、締切の日で選ぶ人が使えなくなる – 第 209 回で却下した）。
  const 金曜の締切 = rows.filter(
    (r) => new Date(r.tShown + 9 * 3_600_000).getUTCDay() === 5,
  ).length;
  const 金曜で当たった = rows.filter(
    (r) => R.searchMatcher("金曜日", NOW.getTime())(String(r.hay)) === true,
  ).length;
  expect(金曜の締切, "金曜の締切行が無く、この検査が空振りしている").toBeGreaterThan(0);
  expect(金曜で当たった, "会期の日曜日が「金曜日」の検索に混ざった").toBe(金曜の締切);
});

it("検索語が 1 行も落とさないとき、件数欄が打ち直し方を言う（SPEC §7）", async () => {
  /* 2026-08-09 生成ビルドで実測・第 227 回: `月`・`日`・`年` は各 863 / 863 行に当たり、
   * 件数欄の数字が 1 も動かないまま画面はどこにも理由を書かなかった。数値だけの打ち方も
   * 同じで、`25` は 2025 や 11月25日 に混なって 105 行に当たり、`25日` の 94 行と一致しない。
   * 索引側では直せないので、絞れていないことをその場で言って打ち直させる。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  type Hay = { hay: string };
  const rows = R.candidateRows(catalog) as unknown as Hay[];
  expect(rows.length).toBeGreaterThan(200);
  ["月", "日", "年"].forEach((word) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(word, at), at);
    const 落ちた = rows.filter((r) => matches(r.hay) !== true).length;
    expect(落ちた, `「${word}」で行が落ちるビルドになった（前提の実測が変わった）`).toBe(0);
    const お知らせ = String(R.queryNarrowHintJa(word));
    expect(お知らせ.trim(), `「${word}」の打ち直し方が出ていない`).not.toBe("");
  });
  // 数値だけの入力は暦日の単位を促す（`25` を打った人に `25日` を示す）。
  const 数値向け = String(R.queryNarrowHintJa("25"));
  expect(数値向け, "数値だけの入力に単位のある打ち方を出していない").toContain("`25日`");
  expect(数値向け).toContain("単位");
  // 打ち直しの例は、打たれた語その物を例に書かない。
  expect(String(R.queryNarrowHintJa("セキュリティ")), "打った語を例に書いた").not.toContain(
    "`セキュリティ`",
  );
  expect(String(R.queryNarrowHintJa("オンライン"))).not.toContain("`オンライン`");
  expect(String(R.queryNarrowHintJa("SC"))).not.toContain("`SC`");
  expect(String(R.queryNarrowHintJa(""))).toBe("");
  // 絞り込みの本体が「検索語だけで落ちた行数」を数えている（判断材料を UI に二重化しない）。
  const filterSrc = jsFunction(siteRuntime("app.js"), "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(hay, key) {",
    "  return { kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: hay,",
    "    tags: [], t: now + DAY, tLast: now + DAY, ed: { place: 'Paris, 日本', deadlines: [] },",
    "    conf: { key: key } };",
    "}",
    "const rows = [",
    "  row('2026年10月5日(月) sc 2027', 'sc'),",
    "  row('2026年11月9日(月) icde 2027', 'icde'),",
    "  row('2026年12月1日(火) sc 2027', 'sc2'),",
    "];",
    FILTER_RUNTIME_STUBS,
    "const run = (q) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: q, cats: [], kind: '', rank: '', win: 'all', est: false, domestic: false }, true, 'rem');",
    // どの行にも当たる語は 1 行も落とさない。
    "run('\\u6708')();",
    "const 全部当たる = hiddenCounts.query || 0;",
    "run('icde')();",
    "const 一部落ちる = hiddenCounts.query || 0;",
    "console.log(JSON.stringify({ 全部当たる, 一部落ちる }));",
  ].join("\n");
  // `vmSafeSource` を適用した文字列をそのまま渡す（関数の本体を本文中に注入すると、そこに
  // 現れる語で Node が ESM 判定をし、`new Function` の内側から最上位の const が見えなくなる。
  // 2026-09-23 以降の実測で、この検査でも実際に踏んだ）。
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const 数え = JSON.parse(proc.stdout) as { 全部当たる: number; 一部落ちる: number };
  expect(数え.全部当たる, "どの行にも当たる語で落ちた行数が出ている").toBe(0);
  expect(数え.一部落ちる, "検索語で落ちた行数が数えられていない").toBe(2);
  // 件数欄は「1 行も落ちていない」ときだけ打ち直し方を出す。
  const render = jsFunction(siteRuntime("app.js"), "render");
  expect(render, "打ち直し方をおしらせしていない").toContain("Recommender.queryNarrowHintJa(");
  expect(render, "落ちた行数での絞り込みが無い（常に打ち直し方を出す実装）").toContain(
    "!hidden.query",
  );
});

it("主題の日本語で打つ人が、会議名に書かれた英語の語で行に辿り着ける（SPEC §7）", async () => {
  /* 推薦の照合には日本語→英語の対応表（`JP_EN`）があったが、検索の側に同じ対応が無く、
   * 日本語で打つと 0 件になっていた（2026-08-09 生成ビルドで実測・第 226 回:
   * `アルゴリズム` 0 件 / 会議名に algorithm と書く会 19 行、`異常検知` 0 件 / GeoAnomalies 2026
   * が 3 行、`オーケストレーション` 0 件 / CANOPIE-HPC 2026 が 4 行、`コンテナ` 0 件、
   * `メモリ` 0 件 / HMEM 2026 が 1 行）。穴場ワークショップを探す人の主な打ち方で、
   * 0 件の壁に当たる損が最も大きい箇所だった。 */
  const src = readFileSync(join(site, "recommender.js"), "utf8");
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  type Hay = { hay: string };
  const rows = R.candidateRows(catalog) as unknown as Hay[];
  const hitRows = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return rows.filter((r) => matches(r.hay) === true);
  };
  /* 下限は 1 件だけにしておく（収録は動くので生成時計で行数が変わる。直し前は全部 0 件
   * だったので、1 件を見るだけでこの検査は空振りしない）。 */
  const 救う語: string[] = [
    "アルゴリズム",
    "自動化",
    "ニューラル",
    "ニューラルネットワーク",
    "コンテナ",
    "コンテナオーケストレーション",
    "ミドルウェア",
    "オーケストレーション",
    "マイクロアーキテクチャ",
    "異常検知",
    "メモリ",
    "エッジ",
    "エッジコンピューティング",
    "エッジコンピュティング",
  ];
  expect(救う語.length).toBeGreaterThan(8);
  救う語.forEach((word) => {
    const n = hitRows(word).length;
    expect(
      n,
      `「${word}」が ${n} 件しかない（会議名に書かれた英語の語で行に辿れていない）`,
    ).toBeGreaterThanOrEqual(1);
    const notes = R.querySynonymNotes(word).join(" ");
    expect(
      notes,
      `「${word}」は寄せたことが件数欄に出ない（理由なしで英語名の行が並ぶ）`,
    ).toContain("原文の");
  });
  /* `edge` はそのまま寄せない。`knowledge` の中に含まれるので、CIKM・KR などが「エッジ」で
   * 出てしまう（同じビルドで実測: `edge` を含む行 30 件のうち 26 件が knowledge 由来）。 */
  const グループ = (R.queryTokenGroups("エッジ", at)[0] || []).map((word) => String(word));
  expect(グループ, "「エッジ」が edge computing に寄っていない").toContain("edge computing");
  expect(グループ, "「エッジ」が `edge` 単独に寄った（knowledge で誤爆する）").not.toContain(
    "edge",
  );
  expect(
    hitRows("エッジ").filter((r) => String(r.hay).indexOf("knowledge") >= 0).length,
    "「エッジ」が knowledge を含む行を出している",
  ).toBe(0);
  // 推薦の照合（`JP_EN`）と同じ対応を見ていること。表を 2 本書いたズレはここで止める。
  const 表 = /const JP_EN = (\{[\s\S]*?\n\s*\});/.exec(src);
  expect(表, "JP_EN がビルド成果物から取れない（対応の一致を見られない）").not.toBeNull();
  const JP_EN = new Function(`return ${表![1]}`)() as Record<string, string>;
  /* 対応表の見出しその物ではない語（長音の書き方と複合語）は、基準となる見出し語に寄せて
   * 同じ対応を見せる – 「ゆらぎの語だけ別の語を向く」ことをここで止める。 */
  const 基準語: Record<string, string> = {
    エッジ: "エッジコンピューティング",
    エッジコンピュティング: "エッジコンピューティング",
    コンテナオーケストレーション: "オーケストレーション",
  };
  救う語.forEach((word) => {
    const key = 基準語[word] || word;
    expect(
      JP_EN[key],
      `JP_EN に ${key} が無い（対応表が動いたときは検索の寄せも直す）`,
    ).toBeTruthy();
    const 期待 = String(JP_EN[key]).toLowerCase();
    const 語組 = (R.queryTokenGroups(word, at)[0] || []).map((w) => String(w));
    expect(語組, `「${word}」の寄せが JP_EN（${期待}）と違う語を向いている`).toContain(期待);
  });
});

it("会の催し物の日本語で打つ人が、原文の英文字で打った人と同じ行に出会う（SPEC §7）", async () => {
  /* 第 232 回。2026-08-09 生成ビルドの実測: `ワークショップ` 74 件 / `workshop` 126 件。
   * 74 件は種別ラベルが日本語で出ていた行で、「The 3rd International Workshop on …」のよう
   * に会議名へ書く 52 件が抜けていた。`セッション` 0 件 / `session` 3 件、`学生` 0 件 /
   * `student` 1 件も同じ形で抜けていた（`パネル` は収録 1 件なので入れていない）。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  type Hay = { hay: string };
  const rows = R.candidateRows(catalog) as unknown as Hay[];
  expect(rows.length, "行が無く、この検査が空振りしている").toBeGreaterThan(0);
  // 行固有の id が無いので、並びの中の位置を id にする（比較は同じ `rows` の中だけで行う）。
  const hitIdx = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return rows.map((r, i) => (matches(r.hay) === true ? i : -1)).filter((i) => i >= 0);
  };
  const 対応: Array<[string, string]> = [
    ["ワークショップ", "workshop"],
    ["セッション", "session"],
    ["学生", "student"],
  ];
  let 数えた = 0;
  対応.forEach(([word, latin]) => {
    const 原文の行 = hitIdx(latin);
    if (!原文の行.length) return; // fixture に寄せ先の行が無い語は数えない
    数えた += 1;
    expect(hitIdx(word), `「${word}」で打つと原文の ${latin} と書く行に届かない`).toEqual(
      expect.arrayContaining(原文の行),
    );
    expect(
      R.querySynonymNotes(word).join(" "),
      `「${word}」は寄せたことが件数欄に出ない（理由なしで英語名の行が並ぶ）`,
    ).toContain("原文の");
  });
  expect(数えた, "fixture に寄せ先の行が 1 件も無く、この検査が空振りしている").toBeGreaterThan(0);
  // てびきも同じ寄せ方を書いているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきに催し物の語の寄せを書いていない").toContain(
    "「ワークショップ」は原文の workshop という語で探しています",
  );
});

it("一致評価の内訳の説明は、マウスを乗せなくても読める（SPEC §7）", () => {
  /* 第 233 回。内訳の項目は「当たり方の説明」を持つが、ビルド後の `app.js` で `title="` を
   * 数えると 2 箇所あり、その 1 箇所が内訳チップの説明だった（マウスを乗せたときだけ出る
   * 注記）。タッチ操作の端末では注記が出ず、キーボードと読み上げでも辿れない。
   * 同じ行の詳細の中にも、開催地は「原表記」を本文に出すのに今後の会期は `title` に置く
   * 書き分けがあった。説明を項目の下に出すようにした。 */
  const app = siteRuntime("app.js");
  const escJa = (value: unknown) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const render = new Function("esc", `return (${jsFunction(app, "reasonChipHtml")});`)(escJa) as (
    chips: Array<[string, string, string]>,
  ) => string;
  const html = render([
    ["分野の一致", "", "会議の分野と論文のキーワードが一致（HPC・AI・セキュリティなど）"],
    ["意味検索の候補", "3 位", "意味検索の順位も、順序決めに使う"],
  ]);
  expect(html, "当たり方の説明が画面に出ていない").toContain("会議の分野と論文のキーワードが一致");
  expect(html, "説明を `title` の注記に押し込んでいる（タッチ端末で読めない）").not.toContain(
    "title=",
  );
  expect(html, "順位などの実数を落とした").toContain("3 位");
  // 説明の語は項目と同じ組のデータから来る（組み立ては `reasonChipHtml` 一か所）。
  // 定義 1 回 + 面板の中の呼び出し 1 回で 2 回。組み立てを面板に戻して `chips.map` を
  // 直接書いたら 3 回以上になるので、数で押さえる（文字列の組み立て方は整形で変わる）。
  expect((app.match(/reasonChipHtml/g) || []).length, "内訳の組み立てが一か所に無い").toBe(2);
  expect(
    (app.match(/class="reason-chip"/g) || []).length,
    "内訳の項目を組み立てる箇所が重複している",
  ).toBe(1);
  // 行の詳細の今後の会期も、原表記を `title` に置かない（開催地と同じ書き方にする）。
  expect(app, "今後の会期の原表記が `title` の注記に戻っている").not.toContain('title="原表記');
  // 画面に出る「原表記」の行（開催地・会期・今後の会期）が 3 箇所あることを数で見る。
  const shownRaw = (app.match(/font-size: 0.8rem;">原表記: /g) || []).length;
  expect(shownRaw, "原表記を画面に出す行が減っている（開催地・会期・今後の会期）").toBe(3);
  // てびきも同じ説明を書く（画面の言い方を文書で言い換えない）。
  const htmlGuide = siteHtmlRuntime();
  expect(htmlGuide, "てびきに内訳の説明が常に出ると書いていない").toContain(
    "当たり方の説明を項目の下に書いています",
  );
});

it("言い方を伸ばした語（`今日中` `ワークショップ提案`）が、素の語と同じ行に出会う（SPEC §7）", async () => {
  /* 第 234 回。2026-08-09 生成ビルドで実測した直し前の当たり数:
   * `今日` 2 件 / `今日中` 0 件、`今週` 19 件 / `今週中` 0 件、`今月` 189 件 / `今月中` 0 件、
   * `チュートリアル` 6 件 / `チュートリアル提案` 0 件、`ワークショップ` 126 件 /
   * `ワークショップ提案` 0 件、`学生` 1 件 / `学生発表` 0 件。
   * `中` を足すだけ、`提案` `募集` `発表` を足すだけで 0 件の壁に当たっていた。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = NOW.getTime();
  type Hay = { hay: string };
  const rows = R.candidateRows(catalog) as unknown as Hay[];
  const hitIdx = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return rows.map((r, i) => (matches(r.hay) === true ? i : -1)).filter((i) => i >= 0);
  };
  /* 相対日の語: 同じ展開先に向き、件数欄に展開した暦日が出ることを見る（行の当たり数は
   * 生成時計で 0 件になり得るので、ここでは数が無くても成立する関係を見る）。 */
  const 相対語: Array<[string, string]> = [
    ["今日", "今日中"],
    ["本日", "本日中"],
    ["明日", "明日中"],
    ["今週", "今週中"],
    ["来週", "来週中"],
  ];
  相対語.forEach(([base, word]) => {
    const 基準 = R.relativeDayNotes(base, at).join("");
    expect(基準, `素の語「${base}」の展開が件数欄に出ない`).not.toBe("");
    expect(
      R.relativeDayNotes(word, at).join(""),
      `「${word}」が「${base}」と同じ日に展開されていない`,
    ).toBe(基準.replace(base, word));
    expect(hitIdx(word), `「${word}」が「${base}」と違う行を並べる`).toEqual(hitIdx(base));
  });
  /* 相対月: 暦月へ展開される（件数欄の相対月の説明は無いので、当たり数で見る）。 */
  const 相対月: Array<[string, string]> = [
    ["今月", "今月中"],
    ["来月", "来月中"],
    ["再来月", "再来月中"],
  ];
  相対月.forEach(([base, word]) => {
    expect(
      R.expandRelativeMonths(word, at),
      `「${word}」が「${base}」と同じ暦月に展開されていない`,
    ).toBe(R.expandRelativeMonths(base, at));
    expect(hitIdx(word), `「${word}」が「${base}」と違う行を並べる`).toEqual(hitIdx(base));
  });
  /* 催し物の複合語: 素の語と同じ行に出て、寄せたことが件数欄に出る。 */
  const 催し物: Array<[string, string]> = [
    ["チュートリアル", "チュートリアル提案"],
    ["チュートリアル", "チュートリアル募集"],
    ["ワークショップ", "ワークショップ提案"],
    ["ワークショップ", "ワークショップ募集"],
    ["セッション", "セッション募集"],
    ["特別セッション", "特別セッション募集"],
    ["学生", "学生発表"],
    ["ポスター", "ポスター提案"],
  ];
  let 数えた = 0;
  催し物.forEach(([base, word]) => {
    const 基準 = hitIdx(base);
    if (!基準.length) return; // fixture に素の語の行が無い語は数えない
    数えた += 1;
    expect(hitIdx(word), `「${word}」が素の語「${base}」の行に届かない`).toEqual(基準);
    expect(
      R.querySynonymNotes(word).join(" "),
      `「${word}」は寄せたことが件数欄に出ない`,
    ).toContain("原文の");
  });
  expect(数えた, "fixture に素の語の行が 1 件も無く、この検査が空振りしている").toBeGreaterThan(3);
  // てびきが言い方の幅を書いているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきに言い方の幅を書いていない").toContain("『今日中』は今日の話");
});

it("等級を『A 類』と呼ぶ人が、`Aランク` と打った人と同じ行に出会う（SPEC §7）", async () => {
  /* 第 235 回。2026-08-09 生成ビルドで実測した直し前の当たり数: `Aランク` 286 件 /
   * `A評価` 286 件なのに `A類` は 0 件、`B類` `C類` `A*類` も 0 件だった。
   * 等級の語を作る `rankSearchTerms` が「ランク」「評価」の形しか持っていなかったため。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  // 等級の語は一か所で組み立てる（画面の語と同じ式を見ている）。
  const terms = R.rankSearchTerms(["ccf:A"]);
  expect(terms, "等級の語に `類` の形が無く、この呼び方が引けない").toContain("a類");
  expect(R.rankSearchTerms(["core:A*"]), "A* に `類` の形が無い").toContain("a*類");
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = NOW.getTime();
  type Hay = { hay: string };
  const rows = R.candidateRows(catalog) as unknown as Hay[];
  const hitIdx = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return rows.map((r, i) => (matches(r.hay) === true ? i : -1)).filter((i) => i >= 0);
  };
  const つながり: Array<[string, string]> = [
    ["Aランク", "A類"],
    ["A評価", "A類"],
    ["A*ランク", "A*類"],
  ];
  let 数えた = 0;
  つながり.forEach(([shown, word]) => {
    const 基準 = hitIdx(shown);
    if (!基準.length) return; // fixture に等級の行が無い組み合せは数えない
    数えた += 1;
    expect(hitIdx(word), `「${word}」が「${shown}」と違う行を並べる`).toEqual(基準);
  });
  expect(数えた, "fixture に等級の行が無く、この検査が空振りしている").toBeGreaterThan(1);
  /* `類` だけでは等級を絞れていない（`ランク` と同じ約束）。逆に等級の語がいっしょにあるときは
   * 絞れているので、同じ注意を出さない。 */
  expect(
    R.querySynonymNotes("類").join(" "),
    "`類` だけでは絞れないことを件数欄が言っていない",
  ).toContain("だけでは等級を絞れていません");
  /* 等級の語がいっしょに入れば絞れている、という判定にも `類` が効くこと。
   * `ランク` だけなら注意が出る画面で、`ランク A類` と打った人に同じ注意を出したら
   * 噓になる（実測: 直し前の照合式は `A類` を等級の語と見なさず、この注意が出ていた）。 */
  expect(
    R.querySynonymNotes("ランク").join(" "),
    "`ランク` だけ打った人に『絞れていません』が出ていない",
  ).toContain("だけでは等級を絞れていません");
  expect(
    R.querySynonymNotes("ランク A類").join(" "),
    "「A類」が等級の語として数えられていない",
  ).not.toContain("だけでは等級を絞れていません");
  // てびきが同じ呼び方を書いているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきに『A 類』の言い方を書いていない").toContain(
    "『A 類』のような言い方も同じ行を出します",
  );
});

it("「未確認」と「該当なし」の理由が、行の詳細の本文に表と同じ語で出る（SPEC §7）", async () => {
  /* 第 236 回。理由の語（例「 kamiyobi が公式で会期を確認できていません。」）は表のセルの
   * `title` の注記にしか無く、タッチ操作の端末と読み上げに届かなかった。
   * 2026-08-09 生成ビルドの収録 863 行で実測: 会期 未確認 186 行 / 開催地 未確認 186 行 /
   * 「評価なし」を含む 144 行 / 等級の組が無く表は「未確認」と出す 388 行。
   * 理由の語と条件は `fieldReasonsJa` の一か所に集め、表のセルと行の詳細の両方から見る。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const consts = [
    /const RANK_UNRATED_JA = [^\n]*;/,
    /const RANK_UNRATED_TITLE_JA = [^\n]*;/,
    /const UNCONFIRMED_TITLES_JA = \{[\s\S]*?\};/,
    /const NOT_APPLICABLE_JA = [^\n]*;/,
    /const fieldReasonsJa = \{[\s\S]*?\n {4}\};/,
  ].map((re2) => {
    const found = app.match(re2);
    expect(found, `組み立てに使った断片が見つからない: ${re2}`);
    return (found as RegExpMatchArray)[0];
  });
  const reasons = new Function(
    "Recommender",
    "esc",
    `${consts.join("\n")}\nreturn (fieldReasonsJa);`,
  )(R, (v: unknown) => String(v ?? "")) as unknown as Record<string, (row: unknown) => string>;
  // 説明が要らない行（値が出ている行）は空文字を返す（空の <p> を並べない）。
  expect(reasons.note("")).toBe("");
  // 本文の下に小さく添える行の形（「原表記」の行と同じ出し方。中身は `esc` を通す）。
  expect(reasons.note("abc")).toContain("<p ");
  expect(reasons.note("abc")).toContain("var(--muted)");
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  ) as unknown as Array<{ ed: { place?: string }; rankPairs?: string[]; hay: string }>;
  const 内訳 = { 会期: 0, 開催地: 0, 評価なし: 0, ランク無し: 0 };
  rows.forEach((r) => {
    if (reasons.event(r)) 内訳.会期 += 1;
    if (reasons.place(r)) 内訳.開催地 += 1;
    const 理由 = reasons.rank(r);
    if (!理由) return;
    if ((r.rankPairs || []).length) 内訳.評価なし += 1;
    else 内訳.ランク無し += 1;
  });
  // 検査が空振りしていないこと（このビルドの収録で実際に該当行がある）。
  expect(内訳.会期, "会期の説明が出る行が 1 も無く、この検査は空振り").toBeGreaterThan(0);
  expect(内訳.開催地, "開催地の説明が出る行が 1 も無く、この検査は空振り").toBeGreaterThan(0);
  expect(内訳.評価なし, "「評価なし」の説明が出る行が 1 も無い").toBeGreaterThan(0);
  expect(内訳.ランク無し, "ランクを行その物で出す行が 1 も無い").toBeGreaterThan(0);
  /* 条件と語が一か所であること（表のセルの注記と行の詳細の本文が同じ入口を見る）。
   * どちらかだけ直して言い方が分かれる事故を、ここで落とす。 */
  (["event", "place", "rank"] as const).forEach((field) => {
    const wired = (app.match(new RegExp(`fieldReasonsJa\\.${field}\\(r\\)`, "g")) || []).length;
    expect(wired, `${field} の理由が表と行の詳細のどちらかからしか見えていない`).toBe(2);
  });
  // てびきが同じ出し方を書いているか（画面の語を文書で言い換えない）。
  expect(siteHtmlRuntime(), "てびきに行の詳細の出し方を書いていない").toContain(
    "行の詳細の本文にも同じ語で出します",
  );
});

it("評価なしで絞った人が、件数欄で選択欄と同じ語に出会う（SPEC §7）", async () => {
  /* 第 237 回。件数欄と 0 件案内は絞り込みの**値**をそのまま書いていたため、選択欄が
   * 「評価なし」と出す等級で「評価「N」を持たない行 719 件」という文章になっていた。
   * `N` は一覧にも行の詳細にも出さない語にしている（てびきも「データ内部の表記は N」と
   * 別に書く）ので、件数欄だけ内部トークンを見る面になっていた。
   * 2026-08-09 生成ビルドで実測: 収録 863 行のうち評価なしを含む行は 144 行なので、
   * 評価なしを選んだ人は 719 行がこの数え方で落ちる側に回る。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const app = siteRuntime();
  const words = new Function(
    "Recommender",
    `${jsFunction(app, "rankFilterLabelJa")}\n${jsFunction(app, "rankDropWordsJa")}\nreturn rankDropWordsJa;`,
  )(R) as (grade: string) => string;
  const label = new Function("Recommender", `return (${jsFunction(app, "rankFilterLabelJa")});`)(
    R,
  ) as (grade: string) => string;
  // 選択欄に並ぶ値はすべて、その欄の見出しと同じ語で件数欄に出る。
  const 値 = R.rankGradeOrderJa();
  expect(値.length, "選択欄の等級が 1 も無い組み立てになっている").toBeGreaterThan(1);
  値.forEach((grade) => {
    const 文 = words(grade);
    expect(文.length, `評価「${grade}」でのぞいた行を指す語が空`).toBeGreaterThan(0);
    expect(文, `評価「${grade}」の説明が選択欄の語（${label(grade)}）を含まない`).toContain(
      label(grade),
    );
  });
  /* 値の `N` は画面の語ではないので、どこにも「N」を括弧で囲んで書かない。 */
  値.forEach((grade) => {
    expect(words(grade), `評価「${grade}」の説明に内部トークンがそのまま出た`).not.toContain(
      "「N」",
    );
  });
  // 評価なしは文の形も違う（「評価「評価なし」を持たない」は日本語として読めない）。
  expect(words("N"), "評価なしの文が読める形になっていない").toBe(
    `${R.rankUnratedLabelJa()}の行以外`,
  );
  /* 件数欄と 0 件案内の両方が同じ入口を見る（語の組み立てを 2 箇所に書かない）。 */
  expect(
    (app.match(/rankDropWordsJa\(/g) || []).length,
    "のぞいた行の語が定義以外から 1 か所でしか使われていない",
  ).toBe(3);
  // 評価なしの行が実際に在ること（無ければこの語は空振りになる）。
  const rows = R.candidateRows(
    JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
      typeof R.candidateRows
    >[0],
  );
  const 該当 = rows.filter((row) =>
    ((row as unknown as { rankPairs?: string[] }).rankPairs || [])
      .map((pair) => R.rankPairLabelJa(pair))
      .some((text) => text.indexOf(R.rankUnratedLabelJa()) >= 0),
  ).length;
  expect(該当, "評価なしの行が 1 も無いので、この語は空振りしている").toBeGreaterThan(0);
  // てびきが同じ文の形を書いているか。
  expect(siteHtmlRuntime(), "てびきに評価なしの件数欄の出し方を書いていない").toContain(
    "評価なしの行以外 N 件",
  );
});

it("早め絞り込みのボタンは、押している状態が目以外の手段にも伝わる（SPEC §7）", () => {
  /* 第 238 回。早め絞り込みのボタンは点灯（CSS のクラス）だけで状態を出していた。点灯は
   * 目に見える合図なのでタッチ操作の端末では分かるが、画面読み上げには「押されている」か
   * 「押されていない」が読めない。並び順のボタンと画面切替のボタンは `aria-pressed` を
   * 出しており、この 5 個だけ約束から漏れていた（2026-08-09 生成ビルドで実測:
   * プリセットのボタン 5 個のうち `aria-pressed` を持つ物 0 個 / 他の面のボタン 4 箇所は出ている）。 */
  const app = siteRuntime("app.js");
  const fn = jsFunction(app, "updatePresetActive");
  expect(fn, "早め絞り込みの点灯関数が見当たらない（検査が空振り）").not.toBe("");
  const script = [
    "(async () => {",
    `const { default: Recommender } = await import(${JSON.stringify(`file://${join(site, "recommender.js")}`)});`,
    "const mk = (preset) => {",
    "  const btn = { preset: preset, cls: {}, attrs: {} };",
    "  btn.classList = { toggle: (name, on) => { btn.cls[name] = on === true; } };",
    "  btn.setAttribute = (name, value) => { btn.attrs[name] = String(value); };",
    "  btn.getAttribute = (name) => (name === 'data-preset' ? preset : null);",
    "  return btn;",
    "};",
    "const PRESETS = ['7d', 'a_star', 'hpc_sys', 'domestic', 'online'];",
    "const btns = PRESETS.map(mk);",
    "const document = { querySelectorAll: () => btns };",
    // 点灯関数は画面の状態 `state` を語で読むので、注入側の世界に置いておく。
    "globalThis.state = null;",
    `const updatePresetActive = new Function('document', 'Recommender', ${JSON.stringify(`return (${fn});`)})(document, Recommender);`,
    "const out = [];",
    "PRESETS.forEach((preset) => {",
    // 空の状態からそのボタンを一度押した形（条件の組み立ても正本 `presetNextSelection` に従う）。
    "  globalThis.state = { ...Recommender.presetNextSelection(preset, null) };",
    "  updatePresetActive();",
    "  out.push({",
    "    preset: preset,",
    "    lit: btns.filter((b) => b.cls.active).map((b) => b.preset),",
    "    read: PRESETS.map((key) => btns.find((b) => b.preset === key).attrs['aria-pressed']),",
    "  });",
    "  btns.forEach((b) => { delete b.cls.active; b.attrs = {}; });",
    "});",
    "console.log(JSON.stringify(out));",
    "})().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as Array<{ preset: string; lit: string[]; read: string[] }>;
  const PRESETS = ["7d", "a_star", "hpc_sys", "domestic", "online"];
  expect(out).toHaveLength(5);
  out.forEach((row) => {
    // 前提: 押した本人だけが点く（ハネスが効いていることの確認）。
    expect(row.lit, `${row.preset} を押したときに点くボタンが違っている`).toEqual([row.preset]);
    // 読み上げに伝える状態が、点いているボタンと同じでなければならない。
    expect(row.read, `${row.preset} を押したとき読み上げに伝わる状態`).toEqual(
      PRESETS.map((key) => (key === row.preset ? "true" : "false")),
    );
  });
  /* 押していないボタンも `false` を書く（属性を消すと「押されているか分からない」に戻る）。 */
  out.forEach((row) => {
    expect(
      row.read.filter((v) => v === undefined),
      "状態を書いていないボタンがある",
    ).toHaveLength(0);
  });
  // 組み立てた画面でも、ボタンは初期値の状態を持って並ぶ（JS が走る前も同じ形にする）。
  const html = siteHtmlRuntime();
  const buttons = (html.match(/<button class="preset-btn"[^>]*>/g) || []).filter((tag) =>
    tag.includes('aria-pressed="false"'),
  );
  expect(buttons.length, "初期状態を書いていない早め絞り込みのボタンがある").toBe(5);
  // てびきが同じ状態の出し方を書いているか。
  expect(html, "てびきに読み上げへの出し方を書いていない").toContain(
    "読み上げにも同じ状態として伝わります",
  );
});

it("過ぎた締切の印は、根拠があるときだけ「次回予定」と書く（SPEC §7）", async () => {
  /* 「過去の締切も表示」で並ぶ行には以前、一律に `締切済み（次回予定）` の印を付けていた。
   * 収録データで次回が確認できる行は极少数（2026-08-09 生成ビルドで実測: 過去行 77 件のうち
   * **会期がまだ来ていない行 76 件**、次の回が確認できる行 0 件、会期も過ぎて次の回が無い行
   * 1 件）。76 件が根拠のない語を出していて、「この会議の次回は出る」と誤解させた。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  type TagRow = {
    t: number;
    tLast: number;
    tEvent: number;
    dateOnly: boolean;
    conf: unknown;
    ed: { event_start?: string };
  };
  const rows = R.candidateRows(catalog) as unknown as TagRow[];
  const 過去 = rows.filter((r) => R.deadlineRowIsPast(r, at));
  expect(過去.length, "過去行が無く、この検査が空振りしている").toBeGreaterThanOrEqual(5);
  expect(
    rows.filter((r) => R.pastDeadlineTagJa(r, at) !== "").length,
    "印が出る行と過去行が食い違った",
  ).toBe(過去.length);
  // 画面に並ばない形を作らない（三つのいずれか）。
  const 形 = new Set(過去.map((r) => R.pastDeadlineTagJa(r, at)));
  形.forEach((tag) => {
    expect(
      ["締切済み", "締切済み（会期がこれから）", "締切済み（次回予定）"],
      `想定していない印の形: ${tag}`,
    ).toContain(tag);
  });
  /* 中核の約束: 「次回予定」と書く行は、必ず行の詳細に今後の会期が並ぶ
   * （印だけが別の判断をしない）。収録データに次回の確認できる過去行が無くても
   * 壊れないように、下の合成行の検査と同じ式で見る。 */
  const 根拠なし = 過去.filter(
    (r) =>
      R.pastDeadlineTagJa(r, at).indexOf("次回予定") >= 0 &&
      R.upcomingEditionsOf(r.conf, String(r.ed?.event_start || ""), at).length === 0,
  );
  expect(
    根拠なし.map((r) => String((r.conf as { key?: string }).key)).slice(0, 3),
    "次回が確認できない行に「次回予定」と書いている",
  ).toEqual([]);
  // 会期がまだ先の行を「次回予定」と呼ばない（その会は終わっていない）。
  const 会期がこれから = 過去.filter((r) => Number.isFinite(r.tEvent) && r.tEvent >= at);
  expect(
    会期がこれから.length,
    "会期がこれからの過去行が無く、この検査が空振りしている",
  ).toBeGreaterThanOrEqual(1);
  会期がこれから.forEach((r) => {
    expect(R.pastDeadlineTagJa(r, at), "会期がこれからの行に次回予定と書いた").toBe(
      "締切済み（会期がこれから）",
    );
  });
  /* 合成行で三つの形と「不確か」を確定させる（収録データに少ない形を検査の空振りにしない）。 */
  const now = Date.parse("2026-06-01T00:00:00Z");
  const 会期済み = (eventStart: string, nextEventStart: string | null) => ({
    t: Date.parse("2026-01-10T12:00:00Z"),
    tLast: Date.parse("2026-01-10T12:00:00Z"),
    tEvent: Date.parse(`${eventStart}T12:00:00Z`),
    dateOnly: false,
    conf: {
      editions: [
        { year: 2026, event_start: eventStart, deadlines: [] },
        ...(nextEventStart ? [{ year: 2027, event_start: nextEventStart, deadlines: [] }] : []),
      ],
    },
    ed: { event_start: eventStart },
  });
  expect(
    R.pastDeadlineTagJa(会期済み("2026-02-02", "2027-02-02") as unknown as TagRow, now),
    "次の回が確認できる行が「次回予定」でなくなった",
  ).toBe("締切済み（次回予定）");
  expect(
    R.pastDeadlineTagJa(会期済み("2026-02-02", null) as unknown as TagRow, now),
    "次の回が無い行に根拠のある語を付けた",
  ).toBe("締切済み");
  const 会期がこれから行 = 会期済み("2026-02-02", null) as unknown as TagRow;
  会期がこれから行.tEvent = Date.parse("2027-02-02T12:00:00Z");
  expect(R.pastDeadlineTagJa(会期がこれから行, now), "会期がこれからの行の印が違う").toBe(
    "締切済み（会期がこれから）",
  );
  // 幅を持つ行（時刻未確認）は「表示したより前に終わった可能性がある」の間は過ぎたと呼ばない。
  const 幅 = {
    t: Date.parse("2026-05-20T00:00:00Z"),
    tLast: Date.parse("2026-06-20T00:00:00Z"),
    dateOnly: true,
  };
  expect(R.deadlineRowIsPast(幅, now), "幅の途中でpastと判定した").toBe(false);
  expect(
    R.deadlineRowIsPast(幅, Date.parse("2026-07-01T00:00:00Z")),
    "幅の終わりを過ぎてもpastと言わない",
  ).toBe(true);
  expect(
    R.deadlineRowIsPast(幅, Date.parse("2026-05-01T00:00:00Z")),
    "幅の前からpastと言った",
  ).toBe(false);
  // 画面の配線: 印の語を app.js に写さず、built の正本を呼ぶ。
  const app = siteRuntime("app.js");
  expect(app, "行の印が正本の語を呼んでいない").toContain(
    "Recommender.pastDeadlineTagJa(r, Date.now())",
  );
  expect(app, "印の語が app.js に写しられている（正本とズレる）").not.toContain(
    '"締切済み（次回予定）"',
  );
  expect(jsFunction(app, "rowIsPast"), "行の過ぎた判定が正本に寄っていない").toContain(
    "Recommender.deadlineRowIsPast",
  );
});

it("締切が差し替わった行は、前に出ていた日付が行の詳細に出て、その日付で引ける（SPEC §7）", async () => {
  /* kamiyobi は公式ページの差し替えを検知すると前の値を `superseded_deadlines` に持つ。
   * それなのに画面にも検索にも出ていなかった（2026-08-09 生成ビルドで実測: 収録 863 行の
   * うち 21 行が前の締刻を持つ。前に見た日付 `2026-09-27` を検索欄に貼ってもその行に
   * 出会えず、「延長後」の印は締切名に Extended を持つ行だけだった）。前に見た日付と
   * 違う行を開いた人は、サイトが古いのか会議が動いたのかを判定できない。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  type ShiftRow = { hay: string; dl: unknown; conf?: { key?: string }; ed?: { id?: string } };
  const rows = R.candidateRows(catalog) as unknown as ShiftRow[];
  /* 同じ会議の同じ回に締切が複数ある（抄録と論文）ので、鍵は締切まで入れる
   * – さもないと兄弟の方が「延長後」で当たって、この前の検査が誤って通る。 */
  const key = (r: ShiftRow) => {
    const d = r.dl as { kind?: string; utc?: string; label?: string };
    return `${r.conf?.key}|${r.ed?.id}|${d?.kind}|${d?.utc}|${d?.label}`;
  };
  const hitRows = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return new Set(rows.filter((r) => matches(r.hay) === true).map(key));
  };
  const 差し替え = rows
    .map((r) => ({ row: r, shifts: R.deadlineShiftsOf(r.dl) }))
    .filter((x) => x.shifts.length > 0);
  expect(
    差し替え.length,
    "差し替え前の締切を持つ行が無く、この検査が空振りしている",
  ).toBeGreaterThanOrEqual(10);
  // 1. 前に出ていた日付（ISO と 日付+曜日の形）を貼ると、その行に必ず出会う。
  const 出会えない: string[] = [];
  差し替え.forEach(({ row, shifts }) => {
    shifts.forEach((s) => {
      for (const q of [s.fromIso, s.fromDayJa]) {
        if (!hitRows(q).has(key(row))) 出会えない.push(`${key(row)} ← 「${q}」`);
      }
    });
  });
  expect(
    出会えない,
    `前に出ていた日付を貼ってもその行に出会えない: ${出会えない.slice(0, 2).join(" / ")}`,
  ).toEqual([]);
  // 2. 行の詳細に並ぶ一行その物（日付の語）も、その行に戻ってこられる。
  差し替え.forEach(({ row }) => {
    const line = R.deadlineShiftLineJa(row.dl);
    expect(line, "行の詳細に出す一行が空になっている").toContain("前に出ていた締切:");
    const 日付 = line.match(/\d{4}-\d{2}-\d{2}\(.{1}\)/g) || [];
    expect(日付.length, "一行に日付+曜日の形が並んでいない").toBeGreaterThanOrEqual(2);
    日付.forEach((token) => {
      expect(hitRows(token).has(key(row)), `一行の「${token}」でその行が引けない`).toBe(true);
    });
  });
  // 3. 印は延びた行だけ。「前倒し」（前へ動いた）を「延長後」と呼ばない。
  let 延び = 0;
  let 前へ = 0;
  差し替え.forEach(({ row, shifts }) => {
    const later = shifts.some((s) => s.later);
    if (later) 延び += 1;
    if (shifts.some((s) => !s.later)) 前へ += 1;
    if (later) {
      expect(R.isExtendedDeadline(row.dl), "延びた行に「延長後」の印が出ていない").toBe(true);
      expect(hitRows("延長後").has(key(row)), "「延長後」でその行が引けない").toBe(true);
    } else {
      // 前へ動いた行を「延長後」とは呼ばない（締切名その物に Extended を書く行は
      // もともと印が付くので、それだけを除いて見る）。
      const 締切名 = String((row.dl as { label?: string }).label || "");
      if (!/extend/i.test(締切名) && 締切名.indexOf("延長") < 0) {
        expect(R.isExtendedDeadline(row.dl), "前へ動いた行に「延長後」の印を付けた").toBe(false);
        expect(hitRows("延長後").has(key(row)), "前へ動いた行が「延長後」で引けてしまう").toBe(
          false,
        );
      }
      expect(hitRows("前倒し").has(key(row)), "前へ動いた行が「前倒し」で引けない").toBe(true);
    }
  });
  expect(延び, "延びた行が無く、印の検査が空振りしている").toBeGreaterThanOrEqual(1);
  expect(前へ, "前へ動いた行が無く、前倒しの検査が空振りしている").toBeGreaterThanOrEqual(1);
  // 4. 索引に時刻を入れない。行の詳細には時刻が並ぶが、その語で他の欄の精度を落とさない
  //    （第 224 回の実測: 一行をそのまま索引に入れると「08:59」の当たり行が 57 → 58 になった）。
  const 語 = 差し替え.map(({ row }) => R.deadlineShiftSearchWords(row.dl)).filter(Boolean);
  expect(語.length).toBeGreaterThan(0);
  語.forEach((words) => {
    expect(words, "検索の語に時刻が混んでいる（他の欄の精度を落とす）").not.toMatch(
      /\d{1,2}:\d{2}/,
    );
  });
  // 5. 表示と索引が同じ 1 本を向いている（ドロワーが built の正本を呼んでいる）。
  const app = siteRuntime("app.js");
  expect(app, "行の詳細が前に出ていた日付を出していない").toContain(
    "Recommender.deadlineShiftLineJa(r.dl)",
  );
});

it("残り欄に並ぶ「あと 51 日」をそのまま貼ると、その分だけ先の締切に出会う（SPEC §7）", async () => {
  /* 残り欄は 863 行中 785 行で「あと N 日」に並ぶ（2026-08-09 生成ビルドで実測）。なのに
   * その語をそのまま貼ると 0 件だった – 空格で `あと` `51` `日` の 3 語に割れて AND に
   * なるため（`51日後` `51 日後` `残り51日` もすべて 0 件）。数値の `51` だけ打つと
   * 日付の途中で当たって 0 件または無関係な当たり方になった。表計算の「残り日数」列は
   * 並べ替え用に数値のまま（`deadlinesToCsv` の側）なので、画面の語で引けるようにする。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const at = Date.parse("2026-08-09T00:00:00Z");
  /* 画面と同じ式で残り欄を作る（`remain` はビルド成果物から抜き出し、時計だけ固定する。
   * 渡す値も画面と同じ `tShown` – 幅を持つ行は表示している暦日が正本（第 216 回）。 */
  const app = siteRuntime("app.js");
  const remain = new Function(
    "DAY",
    "FixedDate",
    [jsFunction(app, "remain").replace(/Date\.now\(\)/g, "FixedDate.now()"), "return remain;"].join(
      "\n",
    ),
  )(Number(/const DAY = (\d+);/.exec(app)?.[1] ?? 86400000), { now: () => at });
  type ShownRow = { hay: string; tShown: number };
  const rows = R.candidateRows(catalog) as unknown as ShownRow[];
  const 表示 = (r: ShownRow) => String(remain(r.tShown).text);
  const hitRows = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return new Set(rows.filter((r) => matches(r.hay) === true));
  };
  /* 表示している行は必ず引ける（当たり増分は「その日の暦日を書く行」を含むので、
   * ここは足りない側だけを見る – 暦日で引く以上、会期がその日の行が入るのは `明日` と同じ）。 */
  const 数 = new Set(
    rows.map((r) => 表示(r).match(/^あと (\d+) 日$/)?.[1]).filter(Boolean) as string[],
  );
  expect(
    [...数].length,
    "残り欄が「あと N 日」を出していない（この検査が空振りしている）",
  ).toBeGreaterThanOrEqual(5);
  const 出会えない: string[] = [];
  for (const n of [...数].map(Number)) {
    const 表示している = rows.filter((r) => 表示(r) === `あと ${n} 日`);
    for (const q of [`あと ${n} 日`, `${n}日後`, `${n} 日後`, `残り${n}日`, `残り ${n} 日`]) {
      const 当たり = hitRows(q);
      表示している.forEach((r) => {
        if (!当たり.has(r)) 出会えない.push(`「${q}」← 表示 ${表示している.length} 行のうち`);
      });
    }
  }
  expect(
    出会えない,
    `残り欄の語を貼ってもその日数の行に出会えない: ${[...new Set(出会えない)].slice(0, 2).join(" / ")}`,
  ).toEqual([]);
  // 過ぎた分の語（`N 日前に終了`）と今日の語も同じ経路で引ける。
  for (const 語 of ["本日終了", "まもなく"]) {
    const 表示している = rows.filter((r) => 表示(r) === 語);
    expect(hitRows(語).size >= 表示している.length, `「${語}」が表示より少ない`).toBe(true);
  }
  const 前 = new Set(
    rows.map((r) => 表示(r).match(/^(\d+) 日前に終了$/)?.[1]).filter(Boolean) as string[],
  );
  expect([...前].length, "過ぎた締切の行が無く、この検査が空振りしている").toBeGreaterThanOrEqual(
    1,
  );
  [...前].forEach((n) => {
    const 表示している = rows.filter((r) => 表示(r) === `${n} 日前に終了`);
    表示している.forEach((r) => {
      expect(hitRows(`${n}日前`).has(r), `「${n}日前」が表示している行を引けない`).toBe(true);
    });
  });
  /* 数値だけの語（`5日`）は「今月の 5 日」の意味で使われている（12 か月語への展開がすでに
   * ある）ので、数値だけを day 語へ寄せることはしない。ここを壊すと「5日に締切の会議」が
   * 引けなくなる。 */
  expect(R.queryTokenGroups("5日", at)[0]?.length, "「5日」が 12 か月語でなくなった").toBe(12);
  expect(R.queryTokenGroups("5日", at)[0]).toContain("9月5日");
  // 黙って暦日に変えない。件数欄に解決結果を書く（相対月・相対週と同じ約束）。
  expect(
    R.relativeDayNotes("あと 51 日", at).join("、"),
    "「あと 51 日」の解決結果が件数欄に出ない",
  ).toContain("2026年9月29日");
  expect(
    R.relativeDayNotes("3 日前", at).join("、"),
    "「3 日前」の解決結果が件数欄に出ない",
  ).toContain("2026年8月6日");
  // 他の語とのかけ算（AND）は壊さない。
  const hitCount = (query: string) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return rows.filter((r) => matches(r.hay) === true).length;
  };
  expect(
    hitCount("2日後 福岡") <= hitCount("2日後") && hitCount("2日後 福岡") <= hitCount("福岡"),
    "数値の相対日と他の語を並べたときに絞り込みが効いていない",
  ).toBe(true);
  // 年を跨いでも解決する（12 月に「10日後」は翌年）。
  const dec = Date.parse("2026-12-28T00:30:00Z");
  expect(R.relativeDayNotes("10日後", dec).join("、"), "年跨ぎの解決が間違っている").toContain(
    "2027年1月7日",
  );
});

it("「来年」「今年」を打つと、その年の締切がぜんぶ出る（SPEC §7）", async () => {
  /* 「来月」「来週」は解決するのに、年の語だけ展開されずに語として検索されていた
   * （2026-08-09 生成ビルドで実測: 「来年」は **0 件**。2027 年の締切は 863 行中 435 行
   * あり、実際には最も広い該当がある）。年の語は 1〜12 か月語の OR なので、文字列展開では
   * 作れず、`queryTokenGroups` の 1 グループとして返す実装にした。 */
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Parameters<
    typeof R.candidateRows
  >[0];
  const rows = R.candidateRows(catalog);
  const hays = rows.map((r) => String(r.hay));
  const at = Date.parse("2026-08-09T00:00:00Z");
  const hit = (query: string, atMs: number) => {
    const matches = R.searchMatcher(query, atMs);
    return hays.filter((hay) => matches(hay) === true).length;
  };
  /* その年の 1〜12 か月語に当たる行数（OR の和集合。足し算だと同じ行を数え直す）。 */
  const yearUnion = (year: number, atMs: number) => {
    const seen = new Set<number>();
    for (let month = 1; month <= 12; month += 1) {
      const matches = R.searchMatcher(`${year}年${month}月`, atMs);
      hays.forEach((hay, index) => {
        if (matches(hay) === true) seen.add(index);
      });
    }
    return seen.size;
  };
  const 来年 = yearUnion(2027, at);
  const 今年 = yearUnion(2026, at);
  expect(来年, "2027 年の締切行が無く、この検査が空振りしている").toBeGreaterThanOrEqual(100);
  expect(hit("来年", at), "「来年」が 2027 年の和集合と違う件数を出した").toBe(来年);
  expect(hit("今年", at), "「今年」が 2026 年の和集合と違う件数を出した").toBe(今年);
  expect(hit("ことし", at), "ひらがなで打つと別の結果になった").toBe(hit("今年", at));
  // 年跨ぎ（12 月に「来年」と打つと翌年、1 月に「去年」と打つと前年）。
  const jan = Date.parse("2027-01-01T00:30:00Z");
  expect(hit("今年", jan), "1 月に「今年」と打つと前年を引いた").toBe(来年);
  expect(hit("去年", jan), "1 月に「去年」と打つと翌年を引いた").toBe(今年);
  // 他の語とのかけ算（AND）は壊さない。
  expect(
    hit("来年 福岡", at) <= hit("来年", at) && hit("来年 福岡", at) <= hit("福岡", at),
    "年の語と他の語を並べたときに絞り込みが効いていない",
  ).toBe(true);
  // 黙って条件が変わったように見せないため、解決結果を件数欄に出す。
  expect(R.relativeDayNotes("来年", at).join("、"), "「来年」の解決結果が件数欄に出ない").toContain(
    "来年 = 2027年",
  );
  expect(
    R.relativeDayNotes("再来年", at).join("、"),
    "「再来年」の解決結果が件数欄に出ない",
  ).toContain("再来年 = 2028年");
});

it("「ポスター募集」のような複合の言い方も、表に出る語へ寄せる（SPEC §7）", async () => {
  // 表に無い複合の言い方だけを打つと 0 件だった（2026-08-09 生成ビルドで実測:
  // `ポスター` 6 件・`ポスター発表` 6 件なのに `ポスター募集` `ポスター投稿` は 0 件、
  // `特集号` 15 件なのに `特集号募集` `特集号投稿` は 0 件、`研究会` 23 件なのに
  // `研究会発表` は 0 件）。寄せ先は必ず表（会議名・種別ラベル）に出る語にする –
  // 画面に出ない語へ寄せると、当たった行になぜ当たったか読める語が残らない。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const catalog = built as Parameters<typeof R.candidateRows>[0];
  const rows = R.candidateRows(catalog);
  const hays = rows.map((r) => String(r.hay));
  const at = Date.parse("2026-08-09T00:00:00Z");
  const hit = (query: string, list: string[]) => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return list.filter((hay) => matches(hay) === true).length;
  };
  const cases: Array<[string, string]> = [
    ["ポスター募集", "poster"],
    ["ポスター投稿", "poster"],
    ["特集号募集", "特集号"],
    ["特集号投稿", "特集号"],
    ["研究会発表", "研究会"],
  ];
  for (const [打ち方, 寄せ先] of cases) {
    const 件数 = hit(打ち方, hays);
    expect(件数, `「${打ち方}」が 0 件のまま（寄せが効いていない）`).toBeGreaterThan(0);
    expect(件数, `「${打ち方}」が寄せ先「${寄せ先}」と違う件数を出した`).toBe(hit(寄せ先, hays));
  }
  // 学会誌・ジャーナルは常時受付の期刊へ寄せる。常時受付の行は既定の一覧プールに
  // 入らないので、種別を選ぶと出る行（built の journalRows）で測る。
  const journals = R.journalRows(built.conferences as Parameters<typeof R.journalRows>[0], at).map(
    (r) => String(r.hay),
  );
  for (const 打ち方 of ["学会誌", "ジャーナル"]) {
    expect(hit(打ち方, journals), `「${打ち方}」が常時受付の行を出さない`).toBe(
      hit("常時受付", journals),
    );
  }
  expect(hit("常時受付", journals), "常時受付の行が無く、この検査が空振りしている").toBeGreaterThan(
    0,
  );
  // 寄せの説明が画面に出る（件数欄の「こう探しました」）。語は表側と同じ正本から来る。
  expect(R.querySynonymNotes("ポスター募集").join("、")).toContain("poster");
  expect(R.querySynonymNotes("特集号募集").join("、")).toContain("特集号");
  // 寄せ先が行に表示される語であることを、built の CSV で確かめる（会议名欄に出る語）。
  /* built の CSV から会議欄だけ取る（列順は 締切, 公式表記, 残り日数, 会議, …。
     開催地に読点が入るので引用符を見たうえで割る – 素朴な分割ではズレる）。 */
  function cells(line: string): string[] {
    const out: string[] = [];
    let cell = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) {
        out.push(cell);
        cell = "";
      } else cell += ch;
    }
    out.push(cell);
    return out;
  }
  const 会議欄 = (row: (typeof rows)[number]): string =>
    cells(
      R.deadlinesToCsv([row as unknown as Record<string, unknown>], at).split("\r\n")[1] || "",
    )[3];
  const 特集号の行 = rows.filter((r) => hit("特集号募集", [String(r.hay)]) === 1);
  expect(特集号の行.length, "『特集号募集』の行が無く、この検査が空振りしている").toBeGreaterThan(
    0,
  );
  expect(
    特集号の行.some((r) => 会議欄(r).includes("特集号")),
    "寄せ先の語が会議名に出ない行に当たっている（画面に出る語への寄せという不変条件に反する）",
  ).toBe(true);
  // 画面に出ない語へは寄せない – `シンポジウム` で当たる行の会議名は `SCIS 2027` なので、
  // 「シンポジウム発表」を寄せると理由の読めない行が増える。表側の語そのものだけが当たる。
  expect(R.querySynonymNotes("シンポジウム発表").length, "画面に出ない語へ寄せた").toBe(0);
  // 既存の言いゆれ吸収は動かさない。
  // 寄せは OR（同義語の和集合）なので、寄せた語の件数を下回ることが壊れ方になる。
  expect(hit("スパコン", hays), "「スパコン」の寄せが壊れた").toBeGreaterThanOrEqual(
    hit("高性能計算", hays),
  );
  expect(hit("論文募集", hays), "「論文募集」の寄せが壊れた").toBe(hit("論文締切", hays));
});

it("行に出る検証状態の印が、そのまま打つと 1 件も引けなかった（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 一覧は 863 行中 375 行に「複数候補のため要確認」の印を
  // 出しているのに、その語を打つと 0 件だった（`確認済み` 25 行、`再確認待ち` 2 行も 0 件）。
  // 検索用の語を作る側が `verification === "unverified"` という文字列比較を見ていて、
  // 実データは `{status: "manual-required"}` のオブジェクトだったため、語が 1 つも
  // hay に入っていなかった。画面の印・行の詳細・検索用の語を同じ表に直したので、
  // ここでは**画面が実際にその語を出している行だけが当たる**ことを両側から測る。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const at = Date.parse("2026-08-09T00:00:00Z");
  const hit = (query: string): number => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.filter((hay) => matches(hay) === true).length;
  };
  // built の app.js から画面が印を作る関数をそのまま抜き出して動かす（語を書き写さない）。
  const appSrc = siteRuntime("app.js");
  // 画面は語彙表を recommender の正本から module 直下の定数に落としているので、
  // 抜き出す関数と一緒にその語彙も built から入れる（書き写さない）。
  const alert = new Function(
    `${verificationLabelsSource()}\n${jsFunction(appSrc, "verificationAlert")}\nreturn verificationAlert;`,
  )() as (status?: string) => string | null;
  // 行が持つ検証状態の語（上流の欄名なので画面には出ない。画面に出る語へ写すための足場）。
  const statusOf = (row: (typeof rows)[number]): string => {
    const dl = (row as unknown as Record<string, unknown>).dl as
      | Record<string, unknown>
      | undefined;
    const verification = dl?.verification as { status?: unknown } | undefined;
    return String(verification?.status ?? "");
  };

  // 印を出さない状態（未設定・確認済み）は null のまま。ここを壊すと全行に印が出る。
  expect(alert(undefined), "状態の無い行に印を出すようになった").toBeNull();
  expect(alert("verified"), "確認済みの行に印を出すようになった").toBeNull();
  // 状態ごとの語。未知の状態は機械の語をそのまま出さず「再確認待ち」にする（画面の従来動作）。
  expect(alert("manual-required")).toBe("複数候補のため要確認");
  expect(alert("parser-failed")).toBe("複数候補のため要確認");
  expect(alert("pending")).toBe("再確認待ち");
  expect(alert("source-unreachable")).toBe("公式ページ取得不能");
  expect(alert("思いもよらない状態名"), "機械の語をそのまま画面に出した").toBe("再確認待ち");
  // 画面と検索が同じ正本を見る（語彙表を書き写していないこと）。
  const table = R.verificationStatusLabelTable();
  expect(table["manual-required"], "検索側の語彙表と画面の語がズレた").toBe(
    alert("manual-required"),
  );
  expect(table.verified, "行の詳細に出す語が検索側の語彙表に無い").toBe("確認済み");

  // その印を出している行だけが当たること（件数と、当たった行の状態の一致の両方を見る）。
  const cases: Array<[string, string[]]> = [
    ["複数候補のため要確認", ["manual-required", "parser-failed"]],
    ["再確認待ち", ["pending"]],
    ["確認済み", ["verified"]],
  ];
  for (const [印, statuses] of cases) {
    const 期待 = rows.filter((r) => statuses.includes(statusOf(r))).length;
    expect(期待, `「${印}」の印を出す行が無く、この検査が空振りしている`).toBeGreaterThan(0);
    expect(hit(印), `「${印}」を打った行数が印を出している行数と違う`).toBe(期待);
    const matches = R.searchMatcher(印, at);
    const 当たった行 = rows.filter((r) => matches(String(r.hay)) === true);
    expect(
      当たった行.every((r) => statuses.includes(statusOf(r))),
      `「${印}」がその印を出していない行をよせた`,
    ).toBe(true);
    // 画面が印を作る関数も、同じ行について同じ語を返す（確認済みは一覧の印に出さない語）。
    const 状態 = statusOf(当たった行[0]);
    expect(印 === "確認済み" ? table[状態] : alert(状態), `「${印}」の語が画面と違う`).toBe(印);
  }
  // 「要確認」だけでも同じ行に出会う（語の一部を打つ人は多い）。
  expect(hit("要確認"), "「要確認」が「複数候補のため要確認」の行をよせない").toBe(
    hit("複数候補のため要確認"),
  );
  // 既存の状態の語は動かさない（同じ関数で組み立てている語の回帰を見る）。
  expect(hit("推定"), "「推定」の語が壊れた").toBeGreaterThan(0);
  expect(hit("時刻未確認"), "「時刻未確認」の語が壊れた").toBeGreaterThan(0);
});

it("締切欄・公式表記欄に出る時刻をそのまま打つと、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 収録 863 行中 679 行が締切欄か公式表記欄に時刻を
  // 出している（21 種・最多は `20:59` の 508 行）のに、その語を打つとぜんぶ 0 件だった。
  // 二つの原因が重なっていた。①検索用の語を作る側が時刻を hay に置いていない、
  // ②打った語を割る側がコロンで `23:59` を二つに割り、`59` を含む行が 1 件もないので
  // 全体が 0 件になる（`queryTokenGroups("23:59")` が `[["23"],["59"]]` だった）。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const hit = (query: string): number => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.filter((hay) => matches(hay) === true).length;
  };
  // CSV は一覧と同じ式で列を組み立てる（`fmtJst` との一致は別の検査が既にみている）。
  // 引用符を持つ欄があるので、取り出す側も CSV の書き方で読む。
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cr = "\r\n";
  const header = cells(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const iDeadline = header.indexOf("締切");
  const iOfficial = header.indexOf("公式表記");
  const iName = header.indexOf("会議");
  expect(iDeadline, "CSV に「締切」列が無い").toBeGreaterThan(-1);
  expect(iOfficial, "CSV に「公式表記」列が無い").toBeGreaterThan(-1);
  const rowCells = rows.map((r) =>
    cells(R.deadlinesToCsv([r as unknown as Record<string, unknown>], at).split(cr)[1] || ""),
  );
  const shownTime = (row: string[]): string[] => [
    ...new Set(`${row[iDeadline]} ${row[iOfficial]}`.match(/\d{1,2}:\d{2}/g) || []),
  ];

  // 画面に出る時刻の語ごとに、**その語を出している行数と検索の件数が一致**すること。
  const words = new Map<string, number>();
  rowCells.forEach((row) => {
    shownTime(row).forEach((w) => {
      words.set(w, (words.get(w) || 0) + 1);
    });
  });
  const 時刻を出す行 = rowCells.filter((row) => shownTime(row).length > 0).length;
  expect(時刻を出す行, "時刻を出す行が無く、この検査が空振りしている").toBeGreaterThan(0);
  expect(words.size, "画面に出る時刻の語が 1 種しか無く、この検査が空振りしている").toBeGreaterThan(
    1,
  );
  for (const [word, 表示行数] of [...words.entries()].sort((a, b) => b[1] - a[1])) {
    expect(hit(word), `「${word}」を出している ${表示行数} 行と違う件数になった`).toBe(表示行数);
  }
  // 当たった行は、その語を実際に出している（逆方向の誤爆も見ると両側から締まる）。
  for (const word of [...words.keys()].slice(0, 3)) {
    const matches = R.searchMatcher(word, at);
    const 当たった行 = rowCells.filter((_, i) => matches(hays[i]) === true);
    expect(
      当たった行.every((row) => shownTime(row).includes(word)),
      `「${word}」が誤爆した`,
    ).toBe(true);
  }
  // 零詰めしていない入力は、画面の形に寄せる。元の形を同じ組に残すと `8:59` に
  // 締切欄が `18:59` の行が混む（2026-08-09 生成ビルドで 1 件実測）ので、寄せるだけ。
  const padded = [...words.keys()].find((w) => /^[01]\d:/.test(w));
  expect(padded, "零詰めされた時刻の語が無く、この検査が空振りしている").toBeTruthy();
  expect(hit(String(padded).replace(/^0(\d)/u, "$1")), "零詰めを外して打つと別の行になった").toBe(
    hit(String(padded)),
  );
  // 全角コロンでも同じ行に出会う（全角入力は同じ結果になる、というてびきの約束）。
  expect(R.queryTokenGroups("20：59", at), "全角コロンで打つと別の語になった").toEqual(
    R.queryTokenGroups("20:59", at),
  );
  // 時刻は他の語と組み合わせられる（AND）。
  expect(hit("20:59"), "時刻の語が単独で引けない").toBeGreaterThanOrEqual(hit("20:59 機械学習"));
  // 語の割れ方そのもの（②の原因が戻っていないこと）。
  expect(R.queryTokenGroups("23:59", at), "時刻の語がまだ割れている").toEqual([["23:59"]]);
  expect(R.queryTokenGroups("8:59", at), "零詰めの寄せ方が変わった").toEqual([["08:59"]]);
  // 日付の入力は従来どおり割らない（`dateLike` と同じ判断を時刻にも広げたので、隣を見る）。
  expect(
    R.queryTokenGroups("2026-08-22", at).some((g) => g.includes("2026年8月22日")),
    "日付入力の暦日展開が壊れた",
  ).toBe(true);
  // 時刻未確認（日付しか確認できていない）の行は時刻を出さないので、時刻では出ない。
  const 未確認 = rowCells.filter((row) => row[iOfficial] === "時刻未確認");
  expect(未確認.length, "時刻未確認の行が無く、この検査が空振りしている").toBeGreaterThan(0);
  const anyTime = (hay: string): boolean =>
    [...words.keys()].some((w) => R.searchMatcher(w, at)(hay) === true);
  expect(
    未確認.filter((row) => anyTime(hays[rowCells.indexOf(row)])).length,
    `時刻未確認の行が時刻の語で出てしまった（例: ${未確認[0][iName]}）`,
  ).toBe(0);
  // 同じ行で壊れやすい語の回帰を見る。
  expect(hit("時刻未確認"), "「時刻未確認」の語が壊れた").toBeGreaterThan(0);
  expect(hit("複数候補のため要確認"), "印の語が壊れた").toBeGreaterThan(0);
  expect(hit("来年"), "「来年」が壊れた").toBeGreaterThan(0);
});

it("公式表記欄に書く AoE の日付をそのまま打つと、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 863 行中 486 行は、締切欄の JST の日付と公式表記欄の
  // AoE の日付が違う（AoE 23:59 は JST では翌日の 20:59）。画面に書いた日付をそのまま
  // 打つと、その行に出会わなかった（点検した (行, 日付語) の組 5,124 件のうち
  // 486 行・330 語が漏れ。例: AAAI 2027 は 公式表記 `2026-07-21 23:59 AoE` /
  // 締切欄 `2026-07-22 20:59 JST(水)` で、検索用の語は JST の日付だけを持っていた）。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cr = "\r\n";
  const header = cells(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const column = (name: string): number => {
    const i = header.indexOf(name);
    expect(i, `CSV に「${name}」列が無い`).toBeGreaterThan(-1);
    return i;
  };
  const iDeadline = column("締切");
  const iOfficial = column("公式表記");
  const iEvent = column("会期");
  const rowCells = rows.map((r) =>
    cells(R.deadlinesToCsv([r as unknown as Record<string, unknown>], at).split(cr)[1] || ""),
  );
  const 和暦 = (iso: string): string => `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
  const shownDates = (row: string[]): string[] => [
    ...new Set(
      `${row[iDeadline]} ${row[iOfficial]} ${row[iEvent]}`.match(/\d{4}-\d{2}-\d{2}/g) || [],
    ),
  ];
  const hitRows = (query: string): number[] => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.map((hay, i) => (matches(hay) === true ? i : -1)).filter((i) => i >= 0);
  };

  // 総点検: **その日を書く行は、その日で必ず出会う**（ISO と和暦の両方）。
  // 行ごとに数える – 上の欄で同じ日を二度書く行（会期の開始日と終了日が同じ日など）を
  // 二度数えると、直ったあとも 1 件残ったように化ける（本作成中に実際に踏んだ）。
  let 点検した組 = 0;
  const 漏れ行 = new Set<number>();
  rows.forEach((_, i) => {
    shownDates(rowCells[i]).forEach((iso) => {
      [iso, 和暦(iso)].forEach((query) => {
        点検した組 += 1;
        if (!hitRows(query).includes(i)) 漏れ行.add(i);
      });
    });
  });
  expect(点検した組, "日付の点検が空振りしている").toBeGreaterThan(100);
  expect(漏れ行.size, `日付を書く行のうち ${漏れ行.size} 行がその日で出ていない`).toBe(0);

  // 公式表記欄に別の日を書く行（AoE 宣言行）が点検に実際に含まれていること。
  const aoeRows = rowCells.filter((row) => {
    const off = (row[iOfficial].match(/\d{4}-\d{2}-\d{2}/u) || [])[0];
    const dl = (row[iDeadline].match(/\d{4}-\d{2}-\d{2}/u) || [])[0];
    return Boolean(off) && off !== dl;
  });
  expect(
    aoeRows.length,
    "公式表記欄に別の日を書く行が無く、この検査が空振りしている",
  ).toBeGreaterThan(0);
  //AoE の日付で打った行が、その日を実際に出していることも見る（多よせの検査）。
  const 例 = aoeRows[0];
  const 例の日 = String((例[iOfficial].match(/\d{4}-\d{2}-\d{2}/u) || [])[0]);
  const 当たった = hitRows(例の日);
  expect(当たった.length, "公式表記欄の日付でその行が出ていない").toBeGreaterThan(0);
  expect(
    rowCells[rows.indexOf(rows[0])].length >= 0 &&
      当たった.every((i) => shownDates(rowCells[i]).includes(例の日)),
    `「${例の日}」がその日を書いていない行をよせた`,
  ).toBe(true);
  //AoE の日付は前日なので、和暦で打っても同じ行に出会う。
  expect(hitRows(和暦(例の日)).length, "AoE の日付を和暦で打つと出会えない").toBeGreaterThan(0);
  expect(
    hitRows(和暦(例の日)).every((i) => shownDates(rowCells[i]).includes(例の日)),
    "和暦で打つとその日を書いていない行をよせた",
  ).toBe(true);

  // 既存の語の回帰を見る（日付まわりは壊れやすい）。
  /* 日付の入力形も同じ行で見る（固定の日付を書くと、収録にその日が無いビルドで
     空振りする – 本作成中に `2026-12-25` が 0 件で落ちた）。 */
  expect(hitRows(例の日).length, "暦日そのままの入力が壊れた").toBeGreaterThan(0);
  const slash = `${Number(例の日.slice(5, 7))}/${Number(例の日.slice(8, 10))}`;
  expect(hitRows(slash).length, `「${slash}」の入力が壊れた`).toBeGreaterThan(0);
  expect(hitRows("時刻未確認").length, "「時刻未確認」が壊れた").toBeGreaterThan(0);
  expect(hitRows("複数候補のため要確認").length, "印の語が壊れた").toBeGreaterThan(0);
  expect(hitRows("来年").length, "「来年」が壊れた").toBeGreaterThan(0);
});

it("一覧に出る会議名（年を後付けした形）をそのまま打つと、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 一覧に出る会議名 429 種のうち **26 種（影響 35 行）**は、
  // 画面に並ぶそのままの形で打つと 0 件だった（`ACISP 2027`・`CAiSE 2027`・`EuroS&P 2027` …）。
  // 年を後付けした行で、検索用の語が素の `conf.title`（年なし）しか持っていなかった。
  // `ACISP` は 1 件引けるので、画面の語が索引に無い語だった（これらの回は会期が未定で、
  // hay の中に 2027 という数字が無かった）。第 205 回で CSV を `titleWithYearJa` に寄せた
  // と同じ正本を、索引側にも入れる。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cr = "\r\n";
  const header = cells(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const iName = header.indexOf("会議");
  expect(iName, "CSV に「会議」列が無い").toBeGreaterThan(-1);
  const rowCells = rows.map((r) =>
    cells(R.deadlinesToCsv([r as unknown as Record<string, unknown>], at).split(cr)[1] || ""),
  );
  const hitRows = (query: string): number[] => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.map((hay, i) => (matches(hay) === true ? i : -1)).filter((i) => i >= 0);
  };
  const nameOf = (row: (typeof rows)[number]): string => {
    const conf = row.conf as { title?: string; key?: string };
    const ed = row.ed as { year?: number };
    return R.titleWithYearJa(conf.title || conf.key || "", ed.year);
  };

  // 会議名は CSV も画面と同じ式で書かれている（ここで読む「画面に出る名前」の前提）。
  rows.forEach((row, i) => {
    expect(rowCells[i][iName], "CSV の会議名が画面と同じ式になっていない").toBe(nameOf(row));
  });

  const names = new Map<string, number[]>();
  rowCells.forEach((row, i) => {
    const list = names.get(row[iName]) || [];
    list.push(i);
    names.set(row[iName], list);
  });
  expect(names.size, "会議名が数えられず、この検査が空振りしている").toBeGreaterThan(10);
  // 表示名をそのまま打つと、その名前を書く行がぜんぶ出る。
  for (const [name, 書く行] of names) {
    const 当たった = new Set(hitRows(name));
    const 出会えない = 書く行.filter((i) => !当たった.has(i));
    expect(
      出会えない.length,
      `「${name}」を書く ${書く行.length} 行のうち ${出会えない.length} 行が出ていない`,
    ).toBe(0);
  }
  // **この検査が空振りしていないこと**: 後付けした年が、その行の他の欄（締切欄・公式表記欄・
  // 会期欄）にも書いていない名前が 1 件以上あること。そういう名前は年を索引に入れて
  // いなければ 0 件になる（2026-08-09 生成ビルドでは 26 種が該当し、ぜんぶ 0 件だった）。
  const otherColumns = (row: string[]): string => row.filter((_, i) => i !== iName).join(" ");
  const 年を後付けした名前 = [...names.keys()].filter((name) => /(?:20\d{2})$/u.test(name.trim()));
  expect(
    年を後付けした名前.length,
    "年を含む表示名が無く、この検査が空振りしている",
  ).toBeGreaterThan(0);
  const 年が他の欄に無い名前 = 年を後付けした名前.filter((name) => {
    const y = String(/(?:20\d{2})$/u.exec(name.trim())?.[0]);
    return (names.get(name) || []).some((i) => !otherColumns(rowCells[i]).includes(y));
  });
  expect(
    年が他の欄に無い名前.length,
    "後付けした年が他の欄にも無い名前が無く、この検査は空振りしている",
  ).toBeGreaterThan(0);

  // 他の語とのかけ算は壊れない（名前で絞った件数は単独より減る）。
  const 例 = 年を後付けした名前[0];
  expect(hitRows(例).length, "名前で単独で引けない").toBeGreaterThan(0);
  expect(hitRows(`${例} 存在しない会議名`).length, "存在しない語を足しても残った").toBe(0);
  // 既存の語の回帰を見る。
  expect(hitRows("来年").length, "「来年」が壊れた").toBeGreaterThan(0);
  expect(hitRows("時刻未確認").length, "「時刻未確認」が壊れた").toBeGreaterThan(0);
  expect(hitRows("複数候補のため要確認").length, "印の語が壊れた").toBeGreaterThan(0);
});

it("締切欄のセルをコピーして貼ると、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 締切欄は公式の zone 宣言が有る無しにかかわらず
  // `2026-08-22 03:00 JST(土)` の形で書かれる。ところが検索の語は `zoneSearchWords` が
  // **公式の zone 宣言**から作っていたので、宣言が無い行と AoE 宣言の行（合わせて 659 行）に
  // `JST` が無く、**締切欄のセルをコピーして検索欄に貼ると 0 件**だった。一覧で最も頻繁に
  // コピーされる欄なので、表示式に語を聴く形へ直した。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cr = "\r\n";
  const header = cells(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const column = (name: string): number => {
    const i = header.indexOf(name);
    expect(i, `CSV に「${name}」列が無い`).toBeGreaterThan(-1);
    return i;
  };
  const iDeadline = column("締切");
  const iOfficial = column("公式表記");
  const iName = column("会議");
  const rowCells = rows.map((r) =>
    cells(R.deadlinesToCsv([r as unknown as Record<string, unknown>], at).split(cr)[1] || ""),
  );
  const hitRows = (query: string): number[] => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.map((hay, i) => (matches(hay) === true ? i : -1)).filter((i) => i >= 0);
  };

  // 1. **締切欄のセルをそのまま打つと、その行に出会う**（時刻未確認の行は除く – あの欄は
  //    `2026-09-30(水)` の形所以外に書き、それも第 209 回で引けるようになっている）。
  const 時刻を出す行 = rowCells.filter((row) => /\d{1,2}:\d{2}/u.test(row[iDeadline]));
  expect(時刻を出す行.length, "時刻を出す行が無く、この検査が空振りしている").toBeGreaterThan(0);
  const コピーで会えない = rowCells.filter(
    (row, i) => /\d{1,2}:\d{2}/u.test(row[iDeadline]) && !hitRows(row[iDeadline]).includes(i),
  );
  expect(
    コピーで会えない.length,
    `締切欄をコピーして貼ると出会えない行が ${コピーで会えない.length} 件（例: ${
      コピーで会えない[0]
        ? `${コピーで会えない[0][iName]} の「${コピーで会えない[0][iDeadline]}」`
        : ""
    }）`,
  ).toBe(0);

  // 2. `JST` の語は、締切欄にその語を書く行とちょうど一致する（多よせも漏れも無い）。
  const JSTを出す行 = rowCells.filter((row) => row[iDeadline].includes("JST("));
  expect(
    JSTを出す行.length,
    "締切欄に JST を出す行が無く、この検査が空振りしている",
  ).toBeGreaterThan(0);
  expect(hitRows("JST").length, "「JST」の件数が表示行数と違う").toBe(JSTを出す行.length);

  // 3. **直したpopulationを実際に踏んでいること**: 公式表記欄に JST と書かない行
  //    （zone 宣言が無い行・AoE 宣言の行）でも締切欄は JST と書く。第 216 回の欠陥は
  //    まさにこの行で起きていた（`zoneSearchWords` は公式の zone 宣言を読むから）。
  const 公式にJSTなし = JSTを出す行.filter((row) => !row[iOfficial].includes("JST"));
  expect(
    公式にJSTなし.length,
    "公式表記欄に JST を書かない行が無く、この検査が空振りしている",
  ).toBeGreaterThan(0);

  // 4. 時刻の語は第 213 回のとおり、表示行数と件数が一致し続ける（同じ関数を作り直したので見る）。
  const words = new Map<string, number>();
  rowCells.forEach((row) => {
    const shown = new Set(`${row[iDeadline]} ${row[iOfficial]}`.match(/\d{1,2}:\d{2}/gu) || []);
    shown.forEach((w) => {
      words.set(w, (words.get(w) || 0) + 1);
    });
  });
  for (const [word, 表示行数] of words) {
    expect(hitRows(word).length, `「${word}」の件数表示行数が食い違った`).toBe(表示行数);
  }

  // 5. 日付しか確認できていない行は `JST` を出さないので、その語でも出ない。
  const 未確認 = rowCells.filter((row) => row[iOfficial] === "時刻未確認");
  expect(未確認.length, "時刻未確認の行が無く、この検査が空振りしている").toBeGreaterThan(0);
  const JSTで当たる未確認 = rowCells.filter(
    (row, i) => row[iOfficial] === "時刻未確認" && hitRows("JST").includes(i),
  );
  expect(JSTで当たる未確認.length, "時刻未確認の行が JST で出てしまった").toBe(0);

  // 6. 既存の語の回帰を見る。
  expect(hitRows("来年").length, "「来年」が壊れた").toBeGreaterThan(0);
  expect(hitRows("複数候補のため要確認").length, "印の語が壊れた").toBeGreaterThan(0);
  expect(hitRows("推定").length, "「推定」が壊れた").toBeGreaterThan(0);
});

it("会期欄のセルをコピーして貼ると、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 会期欄は `2026-12-03(木) 〜 2026-12-04(金)` の形に並ぶ
  // （一覧・CSV 同じ式）が、括弧で割れて `木` のような1文字の語が立った組になり、組は AND
  // なので、**セルをコピーして貼ると 677 行中 559 行が 0 件**だった。打つ側は日付と曜日を
  // 割らず、表示側は `eventCellJa` の出力からその形そのままを語に入れる形で直した。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const cellsOf = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const cr = "\r\n";
  const header = cellsOf(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const column = (name: string): number => {
    const i = header.indexOf(name);
    expect(i, `CSV に「${name}」列が無い`).toBeGreaterThan(-1);
    return i;
  };
  const iEvent = column("会期");
  const iDeadline = column("締切");
  const iName = column("会議");
  const rowCells = rows.map((r) =>
    cellsOf(R.deadlinesToCsv([r as unknown as Record<string, unknown>], at).split(cr)[1] || ""),
  );
  const hitRows = (query: string): number[] => {
    const matches = R.searchMatcher(R.expandRelativeMonths(query, at), at);
    return hays.map((hay, i) => (matches(hay) === true ? i : -1)).filter((i) => i >= 0);
  };
  const cellValue = (row: string[], col: number): string => {
    const v = String(row[col] || "");
    return v === "未確認" || v === "常時受付" || v === "時刻未確認" ? "" : v;
  };

  // 1. **会期欄のセルをそのまま打つと、その行に出会う**。
  const 会期を持つ行 = rowCells.filter((row) => cellValue(row, iEvent));
  expect(会期を持つ行.length, "会期欄を持つ行が無く、この検査が空振りしている").toBeGreaterThan(0);
  const 会期で会えない = rowCells.filter(
    (row, i) => cellValue(row, iEvent) && !hitRows(cellValue(row, iEvent)).includes(i),
  );
  expect(
    会期で会えない.length,
    `会期欄をコピーして貼ると出会えない行が ${会期で会えない.length} 件（例: ${
      会期で会えない[0] ? `${会期で会えない[0][iName]} の「${会期で会えない[0][iEvent]}」` : ""
    }）`,
  ).toBe(0);

  // 2. 締切欄も同じ（曜日が括弧で続く形に変わったので、第 216 回の検査と同じ要求をここでも見る）。
  const 締切で会えない = rowCells.filter(
    (row, i) => cellValue(row, iDeadline) && !hitRows(cellValue(row, iDeadline)).includes(i),
  );
  expect(
    締切で会えない.length,
    `締切欄をコピーして貼ると出会えない行が ${締切で会えない.length} 件（例: ${
      締切で会えない[0] ? `${締切で会えない[0][iName]} の「${締切で会えない[0][iDeadline]}」` : ""
    }）`,
  ).toBe(0);

  // 3. 会期欄に並ぶ `2026-12-03(木)` の形は、**その形を書く行とちょうど一致**する
  //    （多よせも漏れも無い）。表示している欄は会期欄とは限らない（日付だけの行は締切欄に書く）。
  //    行の詳細に「今後の会期」として同じ形を載せる行もあるので、表示側にはそれも数える
  //    （第 220 回 – その日程をコピーして貼れるように索引へ入れたため、当たり増分は
  //    「画面に出している行」に限定したまま保つ）。
  const tokens = new Set<string>();
  rowCells.forEach((row) => {
    String(row[iEvent] || "")
      .split(" ")
      .forEach((part) => {
        if (/\(.\)$/u.test(part)) tokens.add(part);
      });
  });
  expect(tokens.size, "会期欄に日付+曜日の形が無く、この検査が空振りしている").toBeGreaterThan(0);
  const 今後の会期の語 = rows.map((r) => {
    const later = R.upcomingEditionsOf(
      (r as { conf?: unknown }).conf,
      String((r as { ed?: { event_start?: string } }).ed?.event_start || ""),
      at,
    );
    const set = new Set<string>();
    later.forEach((next) => {
      String(R.laterEditionLineJa(next))
        .toLowerCase()
        .split(/[\s〜/＠]+/u)
        .forEach((part) => {
          set.add(part);
        });
    });
    return set;
  });
  /* 第 224 回: 行の詳細は「前に出ていた締切: 2026-09-27(日) → 2027-01-08(金)」も載せる。
   * その日付を索引に入れたので、表示側にも同じ形を数えて入れる（当たり増分は
   * 「画面に出している行」に限定したまま保つ）。 */
  const 差し替えの語 = rows.map((r) => {
    const set = new Set<string>();
    R.deadlineShiftsOf((r as { dl?: unknown }).dl).forEach((s) => {
      `${s.fromJa} ${s.toJa}`
        .toLowerCase()
        .split(/[\s（）:：/／→]+/u)
        .forEach((part) => {
          if (part) set.add(part);
        });
    });
    return set;
  });
  const 食い違い: string[] = [];
  for (const token of tokens) {
    const 表示 = rowCells.filter(
      (row, i) =>
        [iEvent, iDeadline].some((col) =>
          String(row[col] || "")
            .toLowerCase()
            .split(" ")
            .includes(token.toLowerCase()),
        ) ||
        今後の会期の語[i].has(token.toLowerCase()) ||
        差し替えの語[i].has(token.toLowerCase()),
    ).length;
    const hits = hitRows(token).length;
    if (hits !== 表示) 食い違い.push(`「${token}」 hit ${hits} 件 / 表示 ${表示} 行`);
  }
  expect(食い違い, "日付+曜日の語が表示と食い違った行がある").toEqual([]);

  // 4. 曜日を**単独の語として索引に入れていない**こと（誤爆の防止）。2文字以上の `X曜` は
  //    今も「締切の曜日」だけを指す – 会期欄の `2027-04-09(金)` は `金曜` を含まない。
  for (const day of ["月", "火", "水", "木", "金", "土", "日"]) {
    const 締切がその曜日 = rowCells.filter((row) =>
      String(row[iDeadline] || "").includes(`(${day})`),
    ).length;
    expect(hitRows(`${day}曜`).length, `「${day}曜」の件数が締切の曜日行数と食い違った`).toBe(
      締切がその曜日,
    );
  }

  // 5. 打つ側が曜日を割っていないこと（実在の語で見る – 割れると上の 3. が通らないが、
  //    原因が分かる形でここにも置いておく）。
  const 実在の語 = [...tokens][0];
  expect(実在の語, "検査の語が無い").toBeTruthy();
  const groups = R.queryTokenGroups(実在の語, at);
  expect(groups.length, `語「${実在の語}」が ${groups.length} 組に割れている`).toBe(1);
  expect(groups[0][0], `語「${実在の語}」の先頭の語が形を変えている`).toContain("(");

  // 6. 既存の語の回帰。
  const 名前例を引ける行数 = (
    all: string[][],
    hits: (query: string) => number[],
    col: number,
    name: string,
  ): number => hits(name).filter((i) => String(all[i][col] || "") === name).length;
  expect(hitRows("JST").length, "「JST」が壊れた").toBe(
    rowCells.filter((row) => String(row[iDeadline] || "").includes("JST(")).length,
  );
  expect(hitRows("20:59").length, "「20:59」が壊れた").toBeGreaterThan(0);
  expect(hitRows("来年").length, "「来年」が壊れた").toBeGreaterThan(0);
  // 会議名（第 215 回）も生きたまま。語はビルドから取る（fixtures に特定の名前があると限らない）。
  const 名前の例 = rowCells.map((row) => String(row[iName] || "")).find((v) => v.length > 0) || "";
  expect(
    名前例を引ける行数(rowCells, hitRows, iName, 名前の例),
    `会議名「${名前の例}」が壊れた`,
  ).toBe(rowCells.filter((row) => String(row[iName] || "") === 名前の例).length);
});

it("行の詳細に並ぶ今後の会期の日付をコピーして貼ると、その行に出会う（SPEC §7）", async () => {
  // 2026-08-09 生成ビルドで実測: 研究会などの行の詳細は「今後の会期: 2026-10-11(日)〜10-15(木) ＠…」
  // を 56 行に出すのに、その日程は索引に入っていなかった。**そのまま貼ると 56 行すべてが 0 件**、
  // 先頭の日程だけに絞っても自分の行に当たるのは 8 件だけで、当たった 8 件も別の会だった。
  // 会期の暦日表示 `meetingRangeJa` を app.js から recommender.js へ移して表示と索引の 1 本にし、
  // その形そのままをこの行の語へ入れた（第 220 回）。
  const R = (await import(pathToFileURL(join(site, "recommender.js")).href))
    .default as typeof Recommender;
  const built = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as unknown as Record<
    string,
    unknown
  >;
  const at = Date.parse("2026-08-09T00:00:00Z");
  const rows = R.candidateRows(built as Parameters<typeof R.candidateRows>[0]);
  const hays = rows.map((r) => String(r.hay));
  const hitsThat = (query: string, index: number): boolean =>
    R.searchMatcher(R.expandRelativeMonths(query, at), at)(hays[index]) === true;
  const laterOf = (r: (typeof rows)[number]) =>
    R.upcomingEditionsOf(
      (r as { conf?: unknown }).conf,
      String((r as { ed?: { event_start?: string } }).ed?.event_start || ""),
      at,
    );

  let 出す行 = 0;
  const 会わない: string[] = [];
  rows.forEach((r, i) => {
    const later = laterOf(r);
    if (!later.length) return;
    出す行 += 1;
    for (const next of later) {
      const shown = String(R.meetingRangeJa(next.start, next.end));
      if (!hitsThat(shown, i)) 会わない.push(`「${shown}」（日程だけの形）`);
      if (!hitsThat(next.start, i)) 会わない.push(`「${next.start}」（日付だけ）`);
    }
  });
  expect(出す行, "行の詳細に今後の会期を出す行が無く、この検査は空振りしている").toBeGreaterThan(0);
  expect(会わない, `今後の会期を貼ってもその行に出会えない例: ${会わない.join(" / ")}`).toEqual([]);

  /* 併記する**開催地**は索引へ入れない。入れたうえで測ったところ、この行の開催地欄が
   * ヨーロッパの行が「南米」で 118 件当たり、「ハイブリッド」がオンライン参加の記載のない行を
   * 出し、「別表記の寄せ」の誤爆が 11 件増えた（第 220 回。第 219 回の `プライバシー` と同じ型で、
   * 既存の開催地・参加形式の検査がまとめて検出した）。行の詳細にだけ出る語で行が当たって
   * いないことを、その語を実際に引いて確かめる。 */
  const cr = "\r\n";
  const cellsOf = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += ch;
            i += 1;
          } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = cellsOf(
    R.deadlinesToCsv([rows[0] as unknown as Record<string, unknown>], at).split(cr)[0],
  );
  const iPlace = header.indexOf("開催地");
  expect(iPlace, "CSV に開催地の列が無い").toBeGreaterThan(-1);
  const placeCell = (r: (typeof rows)[number]): string =>
    cellsOf(
      R.deadlinesToCsv([r as unknown as Record<string, unknown>], at)
        .split(cr)
        .slice(1)
        .join(cr),
    )[iPlace] ?? "";
  let 調べた語 = 0;
  const 誤爆: string[] = [];
  rows.forEach((r, i) => {
    if (誤爆.length >= 4) return;
    const own = placeCell(r);
    for (const next of laterOf(r)) {
      const word = String(R.placeJa(next.place) || "").trim();
      if (word.length < 2 || own.includes(word)) continue;
      調べた語 += 1;
      if (hitsThat(word, i)) 誤爆.push(`${word}（この行の開催地欄は「${own}」）`);
    }
  });
  expect(調べた語, "行の詳細にだけ出る開催地が無く、この検査は空振りしている").toBeGreaterThan(0);
  expect(誤爆, `行の詳細にだけ並ぶ開催地でその行が当たっている: ${誤爆.join(" / ")}`).toEqual([]);
});

it("常時受付の行にだけ出る語を、0 件の案内が「収録に無い」と言わない（SPEC §7）", () => {
  /* 2026-08-09 生成ビルドで実測: 「常時受付」は候補行 0 件なのに常時受付の行 22 件がその語を
   * 書いていて、読み上げは「語「常時受付」は収録データにありません」と言い、画面は
   * 「検索語を短くする」としか言わなかった。語の当たり数を数える場所が 2 か所あり
   * （`queryMatchCounts` は候補行 + ジャーナル行、`queryTermNotes` は候補行だけ）、
   * 片方だけが古い集合を見ていた。同じ集合に直し、0 件の案内にジャーナルの行の話をさせる。 */
  const app = siteRuntime();
  const rec = join(site, "recommender.js");
  const fn = (name: string) => jsFunction(app, name);
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "Date.now = () => now;",
    "const DAY = 86400000;",
    `const KIND_ALL_LABEL_JA = ${JSON.stringify("すべて")};`,
    fn("countJa"),
    fn("queryMatchCounts"),
    fn("queryTermNotes"),
    fn("emptyDeadlineHint"),
    fn("hiddenKindDeliveryJa"),
    fn("zeroResultLiveNote"),
    // ---- A. 実データ: 語の当たり数は「候補行 + 常時受付の行」として数える（同じ集合） ----
    "let activeData = DATA;",
    "let rows = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const candHays = rows.map((r) => String(r.hay));",
    "const journalHays = journals.map((r) => String(r.hay));",
    "const journalLabel = String(Recommender.kindLabelTable().journal || '');",
    /* 候補行側にだけ出る語も拾う（ジャーナル側で 0 件の語で、数え上げが過剰になっていないか見る）。 */
    "const onlyCandidate = candHays[0].split(' ').filter((w) => w.length >= 4).find((w) => !journalHays.some((h) => h.includes(w)));",
    "const words = [journalLabel, onlyCandidate].filter(Boolean);",
    "const invariant = words.map((w) => {",
    "  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(w, now), now);",
    "  const seen = new Set();",
    "  candHays.concat(journalHays).forEach((h) => { if (m(h)) seen.add(h); });",
    "  const notes = queryTermNotes(w);",
    "  return { w, 期待: seen.size, 案内: notes.length === 1 ? notes[0].count : -1, 候補: candHays.filter((h) => m(h)).length, ジャーナル: journalHays.filter((h) => m(h)).length };",
    "});",
    // ---- B. 行の話に切り替わる（候補行 0 件・ジャーナル 1 件の小さなデータで決定的に） ----
    "activeData = { conferences: [",
    "  { key: 'jj-journal', title: 'JJ Journal', full_name: 'Journal of JJ', categories: ['networking'], tags: ['journal'], rank: {}, link: 'https://example.invalid/jj-journal', editions: [{ id: 'jj-journal-1', date_text: '', deadlines: [] }] },",
    "  { key: 'jj-conf', title: 'JJ Conf', full_name: 'JJ Conference', categories: ['networking'], rank: {}, link: 'https://example.invalid/jj-conf', editions: [{ id: 'jj-conf-2026', date_text: '2026-10-05', event_start: '2026-10-05', place: 'Tokyo', deadlines: [{ kind: 'paper', precision: 'date-only', local_date: '2026-09-01' }] }] },",
    "]};",
    "rows = Recommender.candidateRows(activeData, now);",
    "const mk = (q) => {",
    "  const queryMatch = queryMatchCounts(q);",
    "  const termCounts = queryTermNotes(q);",
    "  const hidden = { past: 4, window: 6, cats: 2, domestic: 1, online: 1, rank: 1, kind: 0 };",
    "  const filter = { window: '90', past: false, cats: 0, domestic: false, online: false, rank: '', kind: '', est: false, hidden, query: q, hiddenKindWords: [], queryMatch, termCounts, urlQuery: false, catalogConferences: activeData.conferences.length };",
    "  return { queryMatch, termCounts, hint: emptyDeadlineHint(filter), live: zeroResultLiveNote({ ...filter, clearable: true, pastShown: false }) };",
    "};",
    "const journal = mk(journalLabel);",
    /* 候補行と常時受付の行の両方に当たる語では、画面と読み上げが同じ内訳の数を言う
     * （読み上げだけ合計を数えると、同じ 0 件画面で別の数を言う）。 */
    "const 候補だけ = rows.map((r) => String(r.hay));",
    "const ジャーナルだけ = Recommender.journalRows(activeData.conferences, now).map((r) => String(r.hay));",
    "const 両方 = ジャーナルだけ[0].split(' ').filter((w) => w.length >= 4).find((w) => 候補だけ.some((h) => h.includes(w)));",
    "const both = 両方 ? mk(両方) : null;",
    // ---- C. 制御群: 本当に無い語は今までどおり「収録データに無い」と言う（直しすぎの防止） ----
    "const absent = mk(journalLabel + ' ZZZ存在しない語');",
    "console.log(JSON.stringify({ journalLabel, journalRowCount: journals.length, invariant, journal, both, 両方, absent }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    journalLabel: string;
    journalRowCount: number;
    invariant: Array<{
      w: string;
      期待: number;
      案内: number;
      候補: number;
      ジャーナル: number;
    }>;
    journal: {
      queryMatch: { catalog: number; journal: number };
      termCounts: Array<{ term: string; count: number }>;
      hint: string;
      live: string;
    };
    both: {
      queryMatch: { catalog: number; journal: number };
      hint: string;
      live: string;
    } | null;
    両方: string | undefined;
    absent: { hint: string; live: string };
  };
  expect(out.journalLabel, "種別ラベルの表に常時受付の語が無い").toBeTruthy();
  expect(out.journalRowCount, "常時受付の行が実データに無い").toBeGreaterThan(0);

  // A. 語の当たり数が、候補行 + 常時受付の行（重複を除く）と一致する。
  expect(out.invariant.length, "検査の語が無く、この検査が空振りしている").toBeGreaterThanOrEqual(
    2,
  );
  for (const item of out.invariant) {
    expect(item.案内, `語「${item.w}」の当たり数が候補行+ジャーナル行と違う`).toBe(item.期待);
  }
  expect(
    out.invariant.some((i) => i.ジャーナル > 0 && i.候補 === 0),
    "ジャーナル側にだけ出る語が無く、直した箇所を踏めていない",
  ).toBe(true);
  expect(
    out.invariant.some((i) => i.候補 > 0 && i.ジャーナル === 0),
    "候補行側にだけ出る語が無く、直しすぎ（ジャーナルを足して水増し）を検出できない",
  ).toBe(true);

  // B. 候補行に無く常時受付の行にだけある語: 案内はその行の数と選び方を出す。
  expect(out.journal.queryMatch.catalog, "このデータで候補行に語が出てしまった").toBe(0);
  expect(out.journal.queryMatch.journal, "常時受付の行が 1 件になっていない").toBe(1);
  expect(out.journal.termCounts[0].count, "語の当たり数が 0 のまま（収録に無い語扱い）").toBe(1);
  expect(out.journal.hint).not.toContain("収録データにも見当たりません");
  expect(out.journal.hint).toContain(out.journalLabel);
  expect(out.journal.hint, "ジャーナルの行の数を言っていない").toContain("1 件");
  expect(out.journal.hint, "ジャーナルの行だと言っていない").toContain("ジャーナル");
  expect(out.journal.hint, "「種別」での選び方を導いていない").toContain("種別");
  // 原因が特定できているので、的外れな「検索語を短くする」は出さない（画面の既存の約束）。
  expect(out.journal.hint).not.toContain("検索語を短くする");
  expect(out.journal.live).not.toContain("収録データにありません");
  expect(out.journal.live, "読み上げがジャーナルの行を数えていない").toContain("ジャーナル 1 件");

  // B2. 両方の行に当たる語は、画面と読み上げが同じ内訳の数を言う。
  expect(out.両方, "両方の行に当たる語が無く、この検査が空振りしている").toBeTruthy();
  expect(out.both, "両方の行に当たる語で案内を組み立てていない").not.toBeNull();
  const 両 = out.both as {
    queryMatch: { catalog: number; journal: number };
    hint: string;
    live: string;
  };
  expect(両.queryMatch.catalog, "候補行が 1 件になっていない").toBe(1);
  expect(両.queryMatch.journal, "常時受付の行が 1 件になっていない").toBe(1);
  expect(両.hint).toContain("収録済みで 1 件");
  expect(両.hint, "ジャーナルの内訳を分けていない").toContain("ジャーナル 1 件");
  expect(両.live, "読み上げが候補行の数を言っていない").toContain(
    "収録で 1 件と常時受付ジャーナル 1 件",
  );

  // C. 本当に無い語は、今までどおり其のまま言う。
  expect(out.absent.hint).toContain("収録データにも見当たりません");
  expect(out.absent.live).toContain("収録データにありません");
});

it("分野チップに並ぶ語（英表記を併記した形）をそのまま打つと、その分野の行に出会う（SPEC §7）", () => {
  /* 分野チップは日本語名を主、英表記を併記して並ぶ（`システム（Systems, Architecture and
   * Storage）`）。2026-08-09 生成ビルドで実測: チップの語をそのままコピーして貼ると
   * `システム（…）` は 0 件、`人工知能（AI and Machine Learning）` は 309 行中 55 件、
   * `高性能計算（High Performance Computing）` は 102 行中 13 件。日本語だけ打てば
   * それぞれ 163 / 309 / 102 件に出会うのに、画面に並ぶ語をそのまま貼った人だけが
   * 行に出会えなかった。括弧は並べ語なので英語の語に割れ、AND で全部を含む行が消える。
   * 索引側へ英表記を載せる手もあるが、`プライバシー` が 16 件 → 78 件に膨らむなど別の語の
   * 精度を壊すので、打ち手側で「分野名に続く英文字の括弧書き」を落とす寄せを入れた。 */
  const app = siteRuntime();
  const rec = join(site, "recommender.js");
  const script = [
    `const { default: Recommender } = await import(${JSON.stringify(`file://${rec}`)});`,
    "const { readFileSync } = await import('node:fs');",
    `const DATA = JSON.parse(readFileSync(${JSON.stringify(join(site, "data.json"))}, 'utf8'));`,
    "const now = Date.parse('2026-08-09T00:00:00Z');",
    "const rows = Recommender.candidateRows(DATA, now);",
    "const journals = Recommender.journalRows(DATA.conferences, now);",
    "const hays = rows.map((r) => String(r.hay));",
    "const journalHays = journals.map((r) => String(r.hay));",
    "const hitIn = (q, list) => {",
    "  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(q, now), now);",
    "  return list.filter((h) => m(h) === true).length;",
    "};",
    "const en = DATA.categories || {};",
    "const 結果 = Object.keys(en).map((k) => {",
    "  const chip = Recommender.categoryChipLabelJa(k, en[k]);",
    "  const ja = Recommender.categoryLabelJa(k);",
    "  const 行 = rows.filter((r) => ((r.cats || []).concat(((r.conf || {}).categories) || [])).includes(k)).length;",
    "  return {",
    "    key: k,",
    "    chip,",
    "    ja,",
    "    行,",
    "    チップ: hitIn(chip, hays),",
    "    日本語: hitIn(ja, hays),",
    "    // 日本語を含む括弧は意図した絞り込みなので落とさない（狭まったままか）。",
    "    狭まり: hitIn(ja + '（第1回）', hays),",
    "    ジャーナル: hitIn(chip, journalHays),",
    "    ジャーナルの行: journals.filter((r) => (((r.conf || {}).categories) || []).includes(k)).length,",
    "  };",
    "});",
    "console.log(JSON.stringify({ 結果, 併記: 結果.filter((i) => i.chip !== i.ja).length }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  const out = JSON.parse(proc.stdout) as {
    結果: Array<{
      key: string;
      chip: string;
      ja: string;
      行: number;
      チップ: number;
      日本語: number;
      狭まり: number;
      ジャーナル: number;
      ジャーナルの行: number;
    }>;
    併記: number;
  };
  expect(out.結果.length, "分野が無く、この検査が空振りしている").toBeGreaterThan(0);
  // 英表記の併記が無いと検査が空振りする（日本語だけのチップは昔から引けた）。
  expect(out.併記, "英表記を併記する分野が無く、この検査が空振りしている").toBeGreaterThan(0);
  for (const item of out.結果) {
    // 1. チップの語をそのまま打つと、その分野の行すべてに出会う。
    if (item.行 > 0) {
      expect(
        item.チップ,
        `チップ「${item.chip}」で ${item.行} 行のうち ${item.チップ} 行にしか出会えない`,
      ).toBeGreaterThanOrEqual(item.行);
    }
    // 2. コピーした損をしない（チップの語の当たり数 = 日本語名だけの当たり数）。
    expect(item.チップ, `チップ「${item.chip}」の当たり数が日本語名「${item.ja}」と違う`).toBe(
      item.日本語,
    );
    // 3. 日本語を含む括弧は落とさない（`人工知能（第1回）` は意図した絞り込み）。
    if (item.chip !== item.ja) {
      expect(
        item.狭まり,
        `「${item.ja}（第1回）」が「${item.ja}」と同じ ${item.日本語} 件に広くなった（括弧の中身を消しすぎ）`,
      ).toBeLessThan(item.日本語);
    }
    // 4. 常時受付の行でも分野のチップが引ける（分野で絞る操作はジャーナルでも同じ）。
    if (item.ジャーナルの行 > 0) {
      expect(
        item.ジャーナル,
        `常時受付の行で分野「${item.key}」のチップが引けない`,
      ).toBeGreaterThanOrEqual(item.ジャーナルの行);
    }
  }
  // 描画側も同じ 1 本を使う（式を書き写した場所が残っていると片方が古くなる）。
  expect(app).toContain("Recommender.categoryChipLabelJa");
  // 分野ラベルの正本は日本語名だけ（併記した形はチップの組み立てで決まる）。
  for (const item of out.結果) {
    expect(item.ja, `分野ラベルその物に括弧が入っている: ${item.ja}`).not.toContain("（");
  }
});
