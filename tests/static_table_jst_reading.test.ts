/**
 * 静的な一覧（`upcoming.md` / `upcoming.html`）の日付欄が、日本時間での読みを持っているかの検査
 * （SPEC §7・第 287 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 日付欄は締切の公式表記だけで、
 * 1,126 行のうち **497 行は日本時間に直すと「日」が変わった**（AoE 23:59 は日本では翌日 20:59、
 * UTC 23:59 は日本では翌朝 08:59）。画面（`index.html`）は「投稿作業は日本の時刻で回る」と
 * JST を主表記にしているのに、印刷・貼り込み・JavaScript なしで読むこの表だけ、換算を
 * `index.html` に投げていた（但し書きが「換算はそちらが早い」と書いていた）。
 * ここでは (a) 公式表記の後読みが全行に有ること、(b) その値が**算術として正しい**こと、
 * (c) 但し書きが読み方と行の並び順を同時に語っていることを見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function text(name: string): string {
  return readFileSync(join(site, name), "utf8");
}

/** マークダウン表のデータ行（先頭の `|` を落として列に割る）。 */
function mdRows(): string[][] {
  const md = text("upcoming.md");
  return md
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .slice(1) // 列の名前の行
    .map((l) =>
      l
        .replace(/^\|\s*/, "")
        .replace(/\s*\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
}

/** HTML 版の 1 列目（行ヘッダーの次のマス = 日付欄）。 */
function htmlDateCells(): string[] {
  const html = text("upcoming.html");
  const body = html.slice(html.indexOf("<tbody>"));
  return [...body.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => {
    const cells = [...m[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) =>
      c[1].replace(/<[^>]*>/g, "").trim(),
    );
    return cells[0] ?? "";
  });
}

/** 「…（JST では YYYY-MM-DD(曜) HH:MM）」 の読み。括弧内の其它（公式表記）にも付く。 */
const READING =
  /（(?:公式 [^・]*・)?JST では (\d{4})-(\d{2})-(\d{2})\(([月火水木金土日])\) (\d{2}):(\d{2})）/;
/** 公式表記のままの壁時計（末尾の単位とうしろの括弧を落とす）。 */
const WALL = /^(\d{4})-(\d{2})-(\d{2})\(([月火水木金土日])\) (\d{2}):(\d{2}):(\d{2}) (AoE|UTC|JST)/;

/** 壁時計（表示されたとおりの時刻）から JST の読みを組み直す。秒は切り捨て（上の欄と同じ）。 */
function expectedReading(wall: RegExpMatchArray): string {
  const ms = Date.UTC(
    Number(wall[1]),
    Number(wall[2]) - 1,
    Number(wall[3]),
    Number(wall[5]),
    Number(wall[6]),
    Number(wall[7]),
  );
  const offsetHours = wall[8] === "AoE" ? 12 : 0; // JST 宣言の行はここを通らない（読みを添えない）
  const jst = new Date(ms + offsetHours * 3_600_000 + 9 * 3_600_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
  return `${day}(${WEEKDAY[jst.getUTCDay()]}) ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

describe("静的な一覧の日付欄に日本時間の読み（第 287 回）", () => {
  it("公式表記が AoE / UTC の行は、例外なく日本時間での読みを後ろに持っている", () => {
    const rows = mdRows();
    // 検査用ビルド（`tests/helpers.ts` の `tempCache()`）は収録の一部だけを積む。
    // 実測: 検査用で 591 行、`repo/.cache` 付きの生成で 1,126 行。
    expect(rows.length, "データ行が数え上げられていない").toBeGreaterThan(400);
    const official = rows.map((r) => r[0]).filter((c) => /(AoE|UTC)(（|$)/.test(c));
    // 実測: 検査用ビルドで 224 行、`repo/.cache` 付きで 524 行。
    expect(official.length, "AoE / UTC 表記の行が 1 行も無い（空振り防止）").toBeGreaterThan(150);
    const missing = official.filter((c) => !READING.test(c));
    expect(missing.slice(0, 3), `読みが添えてない行: ${missing.length} 件`).toEqual([]);
    // HTML 版も同じ（`upcoming.md` から組み立てている）。
    const cells = htmlDateCells().filter((c) => /(AoE|UTC)(（|$)/.test(c));
    expect(cells.length, "HTML 版で列の読み取りに失敗している").toBeGreaterThan(150);
    const missingHtml = cells.filter((c) => !READING.test(c));
    expect(
      missingHtml.slice(0, 3),
      `HTML 版で読みが添えてない行: ${missingHtml.length} 件`,
    ).toEqual([]);
  });

  it("添えた読みは算術として合っている（曜日・分も同じ式）", () => {
    let seen = 0;
    const wrong: string[] = [];
    for (const row of mdRows()) {
      const cell = row[0];
      const wall = WALL.exec(cell);
      const reading = READING.exec(cell);
      if (!wall || !reading) continue;
      seen += 1;
      const want = expectedReading(wall);
      const got = `${reading[1]}-${reading[2]}-${reading[3]}(${reading[4]}) ${reading[5]}:${reading[6]}`;
      if (got !== want) wrong.push(`${cell} → 期待 ${want} / 実際 ${got}`);
    }
    expect(seen, "照合できる行が 1 行も無い（正規表現が壊れている）").toBeGreaterThan(150);
    expect(wrong.slice(0, 3), `換算の値が合っていない行: ${wrong.length} 件`).toEqual([]);
  });

  it("表示の暦日と日本時間の日が違う行が実際に有る（読みが飾りでないこと）", () => {
    let shifted = 0;
    for (const row of mdRows()) {
      const cell = row[0];
      const wall = WALL.exec(cell);
      const reading = READING.exec(cell);
      if (!wall || !reading) continue;
      const shown = `${wall[1]}-${wall[2]}-${wall[3]}`;
      const jstDay = `${reading[1]}-${reading[2]}-${reading[3]}`;
      if (shown !== jstDay) shifted += 1;
    }
    // 実測: 検査用ビルドで 215 行、`repo/.cache` 付きの生成で 497 行。
    // これが消えたら、換算が効かなくなったか、行の並びが暦日順に変わった合図。
    expect(shifted, "日が違う行が消えた（換算が効いていない疑い）").toBeGreaterThanOrEqual(150);
  });

  it("JST 宣言の行はそのまま（単位を二度書かない）", () => {
    const cells = mdRows().map((r) => r[0]);
    const jstDeclared = cells.filter((c) => c.endsWith("JST"));
    expect(jstDeclared.length, "JST 宣言の締切が 1 件も無い（空振り防止）").toBeGreaterThan(0);
    const doubled = jstDeclared.filter((c) => c.includes("JST では"));
    expect(doubled.slice(0, 3), "JST を言い直している行").toEqual([]);
    const anywhere = cells.filter((c) => /JST では[^）]*JST/.test(c));
    expect(anywhere.slice(0, 3), "単位が二重になっている読み").toEqual([]);
  });

  it("但し書きが、読み方と行の並び方を一緒に語っている", () => {
    const md = text("upcoming.md");
    const head = md.slice(0, md.indexOf("\n|"));
    expect(head, "但し書きが公式表記の話だけに戻った").toContain("日本時間での読み");
    expect(head, "AoE の例が無く、読み方が確定できない").toContain("AoE（JST では");
    // 表示の暦日は単調でない（実測 150 箇所戻る）ので、並び順を書かないと表の壊れに見える。
    expect(head, "行の並びが瞬間順だと書いていない（日付が戻って見える）").toContain(
      "締切の瞬間の古い順",
    );
    const html = text("upcoming.html");
    expect(html, "HTML 版の表のうえに同じ但し書きが無い").toContain("日本時間での読み");
    expect(html).toContain("締切の瞬間の古い順");
  });

  it("head の説明が呟いた『日本時間』を、本文が本当に出している", () => {
    /* 第 286 回で書いた説明文は「日時は日本時間（JST）と曜日で出します」と言う。
     * その頃の本文は公式表記だけで、説明文が噓を書いていた（第 287 回の実測）。
     * 声明と本文をここで突き合わせる。*/
    const html = text("upcoming.html");
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(description).toContain("日本時間（JST）");
    expect(htmlDateCells().filter((c) => c.includes("JST では")).length).toBeGreaterThan(150);
  });

  it("マークダウン版と HTML 版で、日付欄の値が同じ", () => {
    const fromMd = mdRows().map((r) => r[0]);
    const fromHtml = htmlDateCells();
    expect(fromHtml.length, "HTML 版の行数がマークダウン版と違う").toBe(fromMd.length);
    const diff: number[] = [];
    for (let i = 0; i < fromMd.length; i += 1) {
      if (fromMd[i] !== fromHtml[i]) diff.push(i);
    }
    expect(diff.slice(0, 3), `版で値がズレた行: ${diff.length} 件`).toEqual([]);
  });
});
