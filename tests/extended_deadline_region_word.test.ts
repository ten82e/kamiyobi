/**
 * 「延長締切」「中近東」「バーチャル」の検査（SPEC §4・§7・第 342 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `延長` 21 行・`締切の延長` 21 行・`中東` 5 行・`virtual` 11 行が通るのに、繋げて打たれた
 * `延長締切` `締切延長` `延長された締切` **0 行**・`中近東` **0 行**・`バーチャル` **0 行**だった。
 * 「対面」「現地」「リアル」「口頭」は収録にその印が無いので 0 行の侭 – 黙って対になる語へ寄せない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true).map((row) => String(row.hay));
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a));
  const y = new Set(行列表(b));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 寄せの案内(語: string): string {
  return Recommender.querySynonymNotes(語).join(" ");
}

/** 件数欄に届く案内の入口をすべて束ねる（第 339 回の教訓 – 一つの入口だけ探ると空振りする）。 */
function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    String(Recommender.uiWordNoteJa(語) || ""),
    String(Recommender.uiWordLiveNoteJa(語) || ""),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ].join(" ");
}

describe("『延長締切』型の繋げた言い方", () => {
  it("語を割けない打ち方も `延長` と同じ行を出す", () => {
    expect(行列表("延長").length, "`延長` が 0 行（品書に延伸の印が無い）").toBeGreaterThan(0);
    ["延長締切", "締切延長", "延長された締切", "期限延長", "締切の延伸", "延長期限"].forEach(
      (語) => {
        expect(行列表(語).length, `"${語}" が 0 行`).toBe(行列表("延長").length);
        expect(対称差(語, "延長"), `"${語}" が "延長" と違う行を出した`).toBe(0);
      },
    );
  });

  it("寄せた事を打たれた語その物で件数欄に書く", () => {
    const 文 = 寄せの案内("延長締切");
    expect(文, "寄せた事を隠した").toContain("延長締切");
    expect(文, "寄せ先の語を書いていない").toContain("『延長』");
    expect(文).toContain("という語で探しています");
    /* 日数で絞る入口も同じ欄に有る事を言う（行に延びた後の日付が有るとは限らない為）。 */
    expect(文, "締切までの欄を案内していない").toContain("『締切まで』");
    /* 画面に実在する欄の名前だけを案内に書く（第 339 回の決まり – built の index.html から読む）。 */
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    /* 欄の名前の正本は `<label for="win">締切まで</label>`（Select の中身は「7 日以内」等で、
     * 案内が名指すのは labels の方 – 第 339 回と同じ読み方）。 */
    const 欄 = /<label for="(\w+)">([^<]*)<\/label>\s*<select id="\1"/g;
    const 名列表: string[] = [];
    for (let 該当 = 欄.exec(html); 該当 !== null; 該当 = 欄.exec(html)) {
      名列表.push(String(該当[2]));
    }
    expect(名列表.length, "欄の名前が一つも読めない").toBeGreaterThan(0);
    expect(名列表, "案内した欄が画面に無い").toContain("締切まで");
  });

  it("`延長` をそのまま打った人には案内を重ねない", () => {
    expect(全案内("延長"), "その物の語に『寄せた』と書いた").not.toContain(
      "という語で探しています",
    );
    expect(全案内("中東"), "無関係の語に案内を付けた").not.toContain("延長");
  });
});

describe("『中近東』の言い方", () => {
  it("中東と同じ行集合で、打ち方を名指した案内を出す", () => {
    expect(行列表("中東").length, "`中東` が 0 行（対照が無い）").toBeGreaterThan(0);
    expect(対称差("中近東", "中東"), "`中近東` が `中東` と違う行を出した").toBe(0);
    const 文 = Recommender.querySynonymNotes("中近東").join(" ");
    expect(文, "打たれた語を名指していない").toContain("「中近東」");
    expect(文, "地域まとめである事を隠した").toContain("地域まとめ");
  });
});

describe("『バーチャル』の言い方", () => {
  it("原文の virtual を打った行だけを出す（案内が実物とズレない）", () => {
    const 行 = 行列表("バーチャル");
    expect(行.length, "`バーチャル` が 0 行").toBeGreaterThan(0);
    expect(
      行.every((hay) => hay.includes("virtual")),
      "案内が virtual と言ったのに其の語を含まない行が出た",
    ).toBe(true);
    expect(Recommender.querySynonymNotes("バーチャル").join(" ")).toContain("原文の virtual");
  });
});

describe("収録に無い言い方は寄せない（締切の推測をしない）", () => {
  it("`口頭` は 0 行の侭で、英字語に寄せた案内も出さない", () => {
    /* 実測で原文の oral は 0 行（品書の "oral" は別の英字語の一部 – 書き方が他にある）なので、
     * 寄せても 0 件の侭。表に載せる意味が無い語を載せていない事を見る。 */
    expect(行列表("口頭").length, "`口頭` に行が出た（実在しない語へ寄せた）").toBe(0);
    expect(全案内("口頭")).not.toContain("oral");
  });

  it("`対面` は 0 行で、参加形式の印が無い事を正直に言う", () => {
    expect(行列表("対面").length).toBe(0);
    const 文 = 全案内("対面");
    expect(文, "対面をオンラインに寄せる等の言い方をしていない").toContain("オンライン参加可");
  });
});

describe("成果物", () => {
  it("組み立てた品が三つの言い方を持つ（第 342 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(rec.includes("中近東"), "中近東が消えた").toBe(true);
    expect(rec.includes("原文の virtual"), "バーチャルの寄せが消えた").toBe(true);
    /* 締切の延伸の寄せは `jsFunction` 抜き出し検査が在るので関数の中に有る事（第 341 回）。
     * 固定長の窓で見るのは取り違える – 中に規則を足すたびに長くなる（第 346 回の実発生）。 */
    expect(
      jsFunction(rec, "collapseRelativeDayPhrase").includes("延長"),
      "延伸の寄せが関数の外に出た",
    ).toBe(true);
  });
});
