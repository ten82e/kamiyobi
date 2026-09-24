/**
 * `upcoming.html` / `upcoming.md` を単体で開いた人が、目印の語の意味を確定できるかの検査
 * （SPEC §7・第 275 回）。
 *
 * 2026-08-09 生成ビルドで実測した形:
 *   - `upcoming.html` の 1,127 行のうち、開催地が「未確認」の行が **182 行**、日付に
 *     「（時刻未確認）」を持つ行が **180 行**、`AoE` の宣言が **410 か所** あった。
 *   - 表のうえの説明は「残り」「開催」「ラウンド」「推定」にしか触れておらず、いちばん多く
 *     出る「未確認」の意味がそのページに無かった。読み手は「収録元が無いと決めたのだ」と
 *     誤読して、探している会議を捨てうる（ kamiyobi が裏取りできていないだけなので事実と違う）。
 *   - 意味の文を 3 か所（画面のてびき・印刷の但し書き・この表）に手コピーすると必ずズレる
 *     ので、`recommender.js` の一文を両方から呼ぶ形にした。
 *
 * 第 276 回で同じページに見つけた別の欠陥もここで見る: この表には `<caption>` が無く、
 * 支援技術では名前の付かない 1,127 行の表になっていた（一覧の側には有った）。説明は
 * ページの見出しと列の名前から組み立てるので、書き写しによるズレが起きない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site, verificationLabelsSource } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function page(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

/** 表より前の説明（マークダウンの引用ブロック）を、行のまま取り出す。 */
function legendLines(src: string): string[] {
  const lines = src.split("\n");
  const tableAt = lines.findIndex((l) => l.startsWith("| 日付 |"));
  expect(tableAt, "表が見つからない（表より前を切り出せない）").toBeGreaterThan(0);
  return lines.slice(0, tableAt).filter((l) => l.startsWith(">"));
}

/** そのページの「表より前の説明」を、生のマークダウンか HTML から取り出す。 */
function legendText(name: string): string {
  const src = page(name);
  if (name.endsWith(".md")) return legendLines(src).join("\n");
  const body = src.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
  return body
    .slice(0, body.indexOf("<table"))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** 説明が「定義している」語（「◯◯」は、と名乗っている部分）。例として挙げているだけの
 * 語（「本日開催」など）は除外する – それらは表の側の値の言い回しで、説明の主題ではない。 */
function quotedTerms(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) for (const m of l.matchAll(/「([^」]+)」は/g)) out.push(m[1]);
  return out;
}

/** 開きの数と閉じの数を数える（タグの入れ子のずれを見る）。 */
function lenTags(body: string, tag: string): [number, number] {
  return [
    (body.match(new RegExp(`<${tag}[ >]`, "g")) || []).length,
    (body.match(new RegExp(`</${tag}>`, "g")) || []).length,
  ];
}

/** `recommender.js` のラベルの語を取り出す（関数本体からでも、定数への転記からでも読む）。
 * 語はいずれも module 直下の定数（`const UNCONFIRMED_LABEL_JA = "未確認";`）が生えていて、
 * 参照の仕方は `function unconfirmedLabelJa() { return …; }` と
 * `extendedLabelJa: () => EXTENDED_LABEL_JA` の 2 通りある（第 275 回の実測）。 */
function labelValue(rec: string, name: string): string {
  const viaAlias = new RegExp(`${name}: \\(\\) => ([A-Z_][A-Z_0-9]*)`).exec(rec);
  const viaFn = new RegExp(`function ${name}[\\s\\S]{0,160}?return ([A-Z_][A-Z_0-9]*);`).exec(rec);
  const constName = viaAlias?.[1] ?? viaFn?.[1];
  if (!constName) throw new Error(`${name} が読む定数が分からない（空振り検査の防止）`);
  const value = new RegExp(`const ${constName} = "([^"]+)"`).exec(rec);
  if (!value) throw new Error(`${constName} の値が読めない（空振り検査の防止）`);
  return value[1];
}

describe("upcoming を単体で読める（第 275 回）", () => {
  it("表に並ぶ目印の語は、表のうえで全部説明している", () => {
    // 実測で多く出る目印: 未確認 182 行 / 時刻未確認 180 行 / 推定 66 行 / AoE 410 か所。
    // 「語が一度出ていれば良い」では足りない – 先頭の案内文は AoE を語として挙げ、
    // 「未確認」は「時刻未確認」の一部として現れるので、挙げだけの変更が通った
    // （第 275 回の改ざんで実発生）。定義の形「◯◯」は、で見る。
    for (const name of ["upcoming.md", "upcoming.html"]) {
      const legend = legendText(name);
      for (const marker of ["未確認", "時刻未確認", "推定", "AoE"]) {
        const defined = new RegExp(`「[（(]?${marker}[）)]?」は`).test(legend);
        expect(defined, `${name} で目印「${marker}」を定義していない（挙げただけ）`).toBe(true);
      }
    }
    // 説明文が自分で名乗った語が、表のどこにも並ばない語なら、読める説明にならない。
    const lines = legendLines(page("upcoming.md"));
    const table = page("upcoming.md").slice(page("upcoming.md").indexOf("| 日付 |"));
    for (const term of quotedTerms(lines)) {
      expect(
        table.includes(term) || term.length <= 1,
        `説明が名乗る「${term}」はこの表に並ばない`,
      ).toBe(true);
    }
  });

  it("「未確認」を“収録元が無いと決めた意味”と読み違えない文が書いてある", () => {
    const rec = siteRuntime("recommender.js");
    const core = jsFunction(rec, "unconfirmedMeaningJa");
    expect(core, "「未確認」の一文の正本が、無いという意味だと書いていない").toContain(
      "収録元が無いと決めた意味ではない",
    );
    for (const name of ["upcoming.md", "upcoming.html"]) {
      expect(legendText(name), `${name} に「未確認」の但し書きが無い`).toContain(
        "収録元が無いと決めた意味ではない",
      );
    }
  });

  it("意味の文は正本 1 個（画面・印刷・この表の 3 か所で組み立てる）", () => {
    const app = siteRuntime("app.js");
    const rec = siteRuntime("recommender.js");
    // recommender に一文があり、
    expect(jsFunction(rec, "unconfirmedMeaningJa")).not.toEqual("");
    expect(jsFunction(rec, "aoeMeaningJa")).not.toEqual("");
    // 呼び側は同じ関数を読む（書き写しを残さない。書き写すと 3 か所がズレる）。
    expect(app).toContain("Recommender.unconfirmedMeaningJa()");
    expect(app).toContain("Recommender.aoeMeaningJa()");
    // 書き写した語が混ざっていないこと（同じ文が 2 か所に有る状態を防ぐ）。
    expect(app.match(/収録元が無いと決めた/g) || []).toHaveLength(0);
    expect((app.match(/「AoE」は UTC-12/g) || []).length).toBeLessThan(1);
  });

  it("印刷の但し書きは、正本の文を繋いでも文が壊れない", () => {
    const app = siteRuntime("app.js");
    const rec = siteRuntime("recommender.js");
    const labelNames = [
      "unconfirmedLabelJa",
      "rankUnratedLabelJa",
      "extendedLabelJa",
      "notApplicableLabelJa",
    ];
    /* ラベルは関数として生えている物と、`extendedLabelJa: () => EXTENDED_LABEL_JA` のように
     * 定数への転記だけの物がある。どちらも語として取り出して注入する（語を書き写すと
     * 正本とズレた検査になる）。 */
    const stub = `const Recommender = {
${labelNames.map((n) => `      ${n}: () => ${JSON.stringify(labelValue(rec, n))},`).join("\n")}
      unconfirmedMeaningJa: (${jsFunction(rec, "unconfirmedMeaningJa")}),
      aoeMeaningJa: (${jsFunction(rec, "aoeMeaningJa")}),
    };`;
    const legend = new Function(
      "VERIFICATION_STATUS_LABELS",
      `${stub}\nreturn (${jsFunction(app, "printLegendJa")});`,
    )(verificationLabelsSource())();
    // 「…行です」の語尾を「…です」に直したので、繋がって読める（第 275 回の組み立て）。
    expect(legend).toContain("収録元が無いと決めた意味ではない）です");
    expect(legend, "文を繋いだところで語尾が破れている").not.toContain("ないです");
    // AoE の一文も同じ正本から印刷に出る。
    expect(legend).toContain("「AoE」は UTC-12 の時刻で締める締切です");
  });

  it("ラベルの語は書き写さず、`recommender.js` の語を使う", () => {
    const rec = siteRuntime("recommender.js");
    const label = labelValue(rec, "unconfirmedLabelJa");
    const md = legendLines(page("upcoming.md")).join("");
    expect(label, "正本の語が空だった（説明文が宙に浮く）").toBeTruthy();
    expect(md, `説明文が正本の語「${label}」で名乗っていない`).toContain(`「${label}」は`);
    // 「時刻未確認」の語も正本から取る（画面の日付欄とスペルがズレると探せない）。
    const timeLabel = labelValue(rec, "timeUnconfirmedLabelJa");
    expect(timeLabel, "時刻未確認の語の正本が見つからない").toBeTruthy();
    expect(md).toContain(`（${timeLabel}）`);
  });

  it("HTML では説明が表の外に有る（表の中に入る組み立てに戻さない）", () => {
    /* 以前は呼び出し側が `out` 全体を <table> で囲んでいて、表のうえの見出し・生成時刻・
     * 列の意味が表の中に落ちていた（2026-08-09 生成ビルドで実測）。ブラウザは表に置け
     * ない要素を外へ押し出すので、マークアップと見えがズレ、支援技術には読まれない。 */
    const html = page("upcoming.html");
    const body = html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
    const open = body.indexOf("<table");
    const close = body.indexOf("</table>");
    expect(open, "表が無い").toBeGreaterThan(0);
    expect(body.indexOf("列の意味"), "説明が表より前に無い").toBeLessThan(open);
    expect(body.indexOf("<h1"), "見出しが表より前に無い").toBeLessThan(open);
    const inside = body.slice(open, close);
    expect(inside, "表の中に h1 や blockquote が落ちている").not.toMatch(
      /<(h[1-6]|blockquote|p)\b/,
    );
    // 表の入れ子が壊れていない（開と閉が同じ数）。
    expect(lenTags(body, "table")[0], "table の開きがずれている").toBe(lenTags(body, "table")[1]);
    expect(lenTags(body, "div")[0], "div の開きがずれている").toBe(lenTags(body, "div")[1]);
  });

  it("表その物に、支援技術が読める名前と列の並びがある", () => {
    /* 一覧の表には `<caption>` が有るのに、この表には無かった（2026-08-09 生成ビルドで実測:
     * `upcoming.html` の `<table>` 1 個に対する `<caption>` 0 個、1,127 行）。支援技術では
     * 名前の無い表に入り、何の表か分からないまま 1,127 行を辿ることになる。 */
    const html = page("upcoming.html");
    const caption = /<caption\b([^>]*)>([\s\S]*?)<\/caption>/.exec(html);
    expect(caption, "表に説明（`<caption>`）が無い").toBeTruthy();
    expect(caption![1], "表の説明が画面に出てしまう（`only-sr` を外した）").toContain("only-sr");
    const cap = caption![2].replace(/<[^>]+>/g, "");
    // 説明が名乗る列の並びが、実際に並ぶ列と一字一句同じ（書き写すと必ずズレる）。
    const cols = [...html.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").trim(),
    );
    expect(cols.length, "列が見当たらない").toBeGreaterThan(3);
    expect(cap, `説明が数える列が、実際の列（${cols.join("・")}）と違う`).toContain(
      cols.join("・"),
    );
    // 表の見出し（h1）から作った説明なので、ページの見出しと食い違わない。
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    expect(h1, "ページの見出しが無い").toBeTruthy();
    expect(cap).toContain(h1![1].replace(/<[^>]+>/g, "").trim());
    // `<caption>` は `<table>` の最初の子（`<thead>` より前）に置く。
    expect(html.indexOf("<caption"), "説明が列見出しより後ろに有る").toBeLessThan(
      html.indexOf("<thead"),
    );
    expect(html.indexOf("<table")).toBeLessThan(html.indexOf("<caption"));
  });

  it("一覧の表と静的な表で、説明の形を揃えている", () => {
    // 両方の表が「支援技術にだけ出る説明」を持ち、言い回しの形が同じ（「〜の一覧」）。
    const capOf = (name: string) => {
      const m = /<caption\b([^>]*)>([\s\S]*?)<\/caption>/.exec(page(name));
      expect(m, `${name} の表に説明が無い`).toBeTruthy();
      expect(m![1], `${name} の表の説明が画面に出てしまう`).toContain("only-sr");
      return m![2].replace(/<[^>]+>/g, "");
    };
    const list = capOf("index.html");
    const upcoming = capOf("upcoming.html");
    expect(list).toContain("の一覧");
    expect(upcoming).toContain("の一覧");
  });
});

/* --- 第 305 回: この表だけで出張の段取りを決められるか -------------------------
 *
 * 2026-08-09 生成ビルドで実測した形:
 *   - 1,126 データ行のうち **795 行**が締切・採否通知などで、日付列に会議が開かれている日が
 *     入らなかった。品書では 1,434 の版が会期を持ち、画面には「会期」列が、`deadlines.ics` の
 *     本文にも「会期: 」（第 304 回）が有った – この表だけで読む人（印刷・JavaScript なし）だけ
 *     が会期を知らされず、出張の段取りを決めるためにサイトを再び開く形。
 *   - 直し方: 見出しの末尾に「会期」列を足し、`sessionSpanJa`（カレンダーの本文と同じ正本）を
 *     呼んだ。既存の列の位置は変えない（第 302 回と同じ約束）。
 *   - 実測（同じビルド）: 日付の入った会期 942 行・未確認 184 行（合計 1,126 – 全行に 1 個）。
 *     `upcoming.md` +34,486 B・`upcoming.html` +63,829 B で、他の出口は 0 B。
 */
describe("表だけで出張の段取りを決められるよう、会期列を足す（第 305 回）", () => {
  /* ページ本体は検査の中で読む（`site` は共有部品が beforeAll で決めるので、describe の
   * 本体で読むと未確定のパスを渡してしまう）。 */
  const md = () => page("upcoming.md");
  const html = () => page("upcoming.html");

  function mdRows(src: string): { head: string[]; rows: string[][] } {
    const lines = src.split("\n").filter((l) => l.startsWith("|"));
    const head = lines[0]
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const rows = lines
      .slice(1)
      .filter((l) => !/^\|[-| ]+\|$/.test(l))
      .map((l) =>
        l
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    return { head, rows };
  }

  /* 会期の値の形（第 304 回でカレンダーに書いた形と同一の正本）。 */
  const SPAN =
    /^\d{4}-\d{2}-\d{2}\([日月火水木金土]\)( 〜 \d{4}-\d{2}-\d{2}\([日月火水木金土]\))?(?:（推定）)?$/;

  it("見出しは末尾に会期が増え、既存の列の位置は変わっていない", () => {
    const { head } = mdRows(md());
    expect(head.slice(0, 7), "既存の列の並びが変わった").toEqual([
      "日付",
      "残り",
      "会議",
      "種別",
      "ラウンド",
      "推定",
      "開催地",
    ]);
    expect(head[7], "会期列が末尾に無い").toBe("会期");
  });

  it("全行に会期が 1 個並び、列の数も揃う", () => {
    const { head, rows } = mdRows(md());
    expect(rows.length, "データ行が読めない").toBeGreaterThan(100);
    let dated = 0;
    let unknown = 0;
    for (const cells of rows) {
      expect(cells.length, `列数が揃っていない行: ${cells.join(" | ").slice(0, 60)}`).toBe(
        head.length,
      );
      const value = cells[7];
      if (value === "未確認") unknown += 1;
      else if (SPAN.test(value)) dated += 1;
      else expect.fail(`想定外の会期の値: ${JSON.stringify(value)}`);
    }
    expect(dated, "会期の日付が入った行が 1 行も無い（空振りの検査になる）").toBeGreaterThan(0);
    expect(unknown, "分からない会期が 1 件も無い（空振りの検査になる）").toBeGreaterThan(0);
    expect(dated + unknown, "会期の行の数がデータ行と合わない").toBe(rows.length);
  });

  it("種別が「開催」の行は、日付列と同じ会期を書く（二重の意味を持たせない）", () => {
    const { rows } = mdRows(md());
    const eventRows = rows.filter((cells) => cells[3] === "開催");
    expect(eventRows.length, "会期行が 1 行も読めない").toBeGreaterThan(0);
    for (const cells of eventRows) {
      expect(cells[7], `日付列と会期列がずれている: ${cells[2]}`).toBe(cells[0]);
    }
  });

  it("カレンダーの本文に書いた会期と、この表の会期が同じ文字列（正本は 1 本）", () => {
    const ics = readFileSync(join(site, "deadlines.ics"), "utf8")
      .replace(/\r\n(?=[ \t])/g, "")
      .replace(/\r/g, "");
    const byConf = new Map<string, string>();
    for (const block of ics.split("BEGIN:VEVENT").slice(1)) {
      const body = block.split("END:VEVENT")[0];
      const conf = /^DESCRIPTION:(.*)$/m
        .exec(body)?.[1]
        .split("\\n")[0]
        ?.replace(/^会議: /u, "");
      const span = String(
        /^DESCRIPTION:(.*)$/m
          .exec(body)?.[1]
          .split("\\n")
          .find((l) => l.startsWith("会期: ")) ?? "",
      ).slice("会期: ".length);
      if (conf && SPAN.test(span)) byConf.set(conf, span);
    }
    expect(byConf.size, "カレンダー側で会期の日付が読める予定が 1 件も無い").toBeGreaterThan(0);
    const { rows } = mdRows(md());
    let checked = 0;
    for (const cells of rows) {
      const title = /^\[(.*)\]\(.*\)$/.exec(cells[2])?.[1];
      const fromIcs = title ? byConf.get(title) : undefined;
      if (!fromIcs) continue;
      expect(cells[7], `表とカレンダーで会期がずれている: ${title}`).toBe(fromIcs);
      checked += 1;
      if (checked >= 8) break;
    }
    expect(checked, "表とカレンダーを突き合わせられた行が 1 件も無い").toBeGreaterThanOrEqual(8);
  });

  it("HTML の側にも会期列が並び、値はマークダウンと同じ形", () => {
    expect(html().includes('<th scope="col">会期</th>'), "HTML に見出しの会期列が無い").toBe(true);
    const cells = [...html().matchAll(/data-label="会期"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    expect(cells.length, "HTML の会期欄が 1 個も読めない").toBeGreaterThan(100);
    const dated = cells.filter((v) => SPAN.test(v));
    expect(dated.length, "HTML の会期欄に日付が 1 個も無い").toBeGreaterThan(0);
    expect(cells.filter((v) => v === "未確認").length, "HTML に未確認の会期が無い").toBeGreaterThan(
      0,
    );
  });

  it("列の意味の説明に、会期列の読み方が書いてある", () => {
    for (const line of legendLines(md())) {
      if (line.includes("「会期」")) return;
    }
    expect.fail("マークダウンの説明に「会期」列の意味が無い");
  });

  it("HTML の側にも同じ説明が並ぶ（説明を 2 か所に手書きしない）", () => {
    expect(html().includes("出張の段取りはこの列を見る"), "HTML に会期列の説明が無い").toBe(true);
  });
});
