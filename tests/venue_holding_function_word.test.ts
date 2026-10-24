import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 全體(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 行列表(語: string, 行々: string[] = 品書()): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々.filter((行) => 照合(行) === true).sort();
}

const 件 = (語: string, 行々?: string[]): number => 行列表(語, 行々).length;

/** 直した形と、同じ意味の繋げた形（行の集合が同じに成る筈）。 */
const 對 = [
  ["海外で開催", "海外開催"],
  ["東京で開催", "東京開催"],
  ["パリで開催", "パリ開催"],
  ["オンラインで開催", "オンライン開催"],
] as const;

describe("開き方を指す機能語を、他の語があるときにのぞく（第 705 回）", () => {
  it("品書と収録の全体の両方で、繋げた形と同じ行に屆く", () => {
    const 全 = 全體();
    for (const [打ち方, 繋げた形] of 對) {
      const 正 = 行列表(繋げた形);
      expect(正.length, `繋げた形に行が無い（此の檢査の前提）: ${繋げた形}`).toBeGreaterThan(0);
      expect(行列表(打ち方), `品書で別の行: ${打ち方}`).toEqual(正);
      const 全正 = 行列表(繋げた形, 全);
      expect(全正.length, `收錄の全體で繋げた形に行が無い: ${繋げた形}`).toBeGreaterThan(0);
      expect(行列表(打ち方, 全), `收錄の全體で別の行: ${打ち方}`).toEqual(全正);
    }
  });

  it("開き方の動詞（開かれる・行われる・催される）も、他の語があるときにのぞく", () => {
    /* 2026-10-18 実測: 「日本で開催される国際会議」は 17 行に屆くのに、
     * 「日本で開かれる国際会議」「日本で行われる国際会議」は 0 件で、「開かれる国際会議」を
     * 1 語として「収録に見当たりません」と案内していた（名詞の前の動詞が割れていなかつた）。 */
    for (const [打ち方, 同じ] of [
      ["日本で開かれる国際会議", "日本 国際会議"],
      ["日本で行われる国際会議", "日本 国際会議"],
      ["東京で開かれる会議", "東京"],
      ["東京で催される会議", "東京"],
      ["大阪で行われる研究会", "大阪 研究会"],
    ] as Array<[string, string]>) {
      const 正 = 行列表(同じ);
      expect(正.length, `同じ意味の形に行が無い（此の檢査の前提）: ${同じ}`).toBeGreaterThan(0);
      expect(行列表(打ち方), `「${打ち方}」が「${同じ}」と違う行を出した`).toEqual(正);
    }
  });

  it("「国内」と「国際会議」を一緒に打つた人に、逆を指す事と探し方を書く", () => {
    /* 2026-10-18 実測: `国内の国際会議` は 0 件で、案内は「国際会議」の片方だけを
     * 説明していた（国内は国内研究会に絞る語で、国際会議はその外側）。 */
    expect(件("国内の国際会議"), "前提が変わつた（0 件でなくなつた）").toBe(0);
    const 案内 = Recommender.querySynonymNotes("国内の国際会議").join(" ");
    expect(案内, "逆を指す事を書いていない").toContain("「国内」は国内研究会");
    expect(案内, "0 件になる理由を書いていない").toContain("両方を打つと 0 件");
    expect(案内, "日本で開かれる国際会議の探し方を書いていない").toContain("「東京」「日本」");
    /* 片方だけの語には付けない（毎回注意されると読めない）。 */
    expect(Recommender.querySynonymNotes("国内研究会").join(" ")).not.toContain("逆を指す");
    expect(Recommender.querySynonymNotes("国際会議").join(" ")).not.toContain("両方を打つと");
    /* 探し方の例は実際に行が出る（案内が空振りしていない）。 */
    expect(件("日本 国際会議"), "案内した探し方に行が無い").toBeGreaterThan(0);
  });

  it("黙つて狹まる語はない（直す前に行が出ていた形は、行が減らない）", () => {
    /* この回の直しは**のぞく**だけなので、行が減る形は一つも無い筈（実測でも減 0）。
     * 減つていたら、のぞいた事が別の語の当たりを壊している。 */
    for (const [打ち方, 前の行數] of [
      ["国内で開催", 22],
      ["研究会で開催", 2],
    ] as Array<[string, number]>) {
      expect(件(打ち方), `行が減つた: ${打ち方}`).toBeGreaterThanOrEqual(前の行數);
      expect(件(打ち方), `繋げた形と同じに成つて居ない: ${打ち方}`).toBe(
        件(打ち方.replace("で開催", "開催")),
      );
    }
  });

  it("機能語に名を續けた塊（`開催される会議`）ものぞく（第 707 回）", () => {
    /* 実測（2026-10-06）– `海外で開催される会議` は 0 行だつた。`で` で割れた後の片方が
     * 「開催される会議」と云ふ**一塊**に成り、それを要求して 0 行に落ちていた（同じ意味の
     * `海外開催` は 3,953 行）。尾に來る名は**催し物の名**に限る – `開催予定` をのぞくと
     * `開催予定はいつ` が雜多の行に成り、その群の斷り（「行の『会期』に出て居ます」）を失ふ。 */
    for (const [打ち方, 正] of [
      ["海外で開催される会議", "海外開催"],
      ["東京で開催される会議", "東京開催"],
      ["研究会で開催される会議", "研究会"],
      ["開催される会議の締切", "締切"],
    ] as Array<[string, string]>) {
      expect(件(打ち方), `行が出て居ん: ${打ち方}`).toBeGreaterThan(0);
      expect(行列表(打ち方), `正と別の行: ${打ち方}`).toEqual(行列表(正));
    }
    /* 熟して一語に成る名（`開催予定`）はのぞかん – その群の斷りを失ふ（実測）。 */
    expect(件("開催予定はいつ"), "`開催予定` をのぞいた").toBe(0);
    expect(
      String(Recommender.uiWordNoteJa("開催予定はいつ", false) || ""),
      "`開催予定` の斷りを失つた",
    ).toContain("行の『会期』に出ています");
  });

  it("機能語だけを打つた人は、今まで通り行が出る（のぞくのは他の語がある時だけ）", () => {
    for (const 語 of ["開催", "実施"]) {
      const 群 = Recommender.queryTokenGroups(語, 基準);
      expect(群.length, `一語なのに組が分かれた: ${語}`).toBe(1);
    }
    expect(件("開催"), "`開催` の行が消えた").toBeGreaterThan(0);
    /* `実施` は収録に行を持たない（この回の直しの前から）– 黙るのは今まで通り。 */
    expect(件("実施"), "`実施` に行が出た（前提が変はつた）").toBe(0);
  });

  it("機能語をのぞいた事で、別の語の組が消えて居ない（のぞくのはその組だけ）", () => {
    /* `セキュリティで開催` は `セキュリティ` と同じ行に屆く（のぞく前は 0 行だつた）。 */
    const 正 = 行列表("セキュリティ");
    expect(正.length, "この検査の前提が崩れた").toBeGreaterThan(0);
    expect(行列表("セキュリティで開催"), "分野の語が消えた").toEqual(正);
  });
});

describe("必要・できるの係りが入る問ひ（第 707 回）", () => {
  const 係りの語 = [
    ["ビザが必要な会議", "ビザ"],
    ["ビザが不要な会議", "ビザ"],
    ["ビザが無い会議", "ビザ"],
    ["英語で発表できる会議", "英語"],
  ] as const;

  it("群の語に当たる形は、その群の斷りが出る", () => {
    for (const [打ち方, 群の語] of 係りの語) {
      const 文 = String(Recommender.uiWordNoteJa(打ち方, false) || "");
      expect(文, `默つた: ${打ち方}`).not.toBe("");
      expect(文, `打たれた語を書き返して居ん: ${打ち方}`).toContain(`「${群の語}」`);
      /* その群の語その物と同じ斷り（同じ事を敎へる）。 */
      expect(文, `單體と違ふ斷り: ${打ち方}`).toBe(
        String(Recommender.uiWordNoteJa(群の語, false) || ""),
      );
    }
  });

  it("比べる打ち手には斷りを乘せない（第 656・362 回の境界はその侭）", () => {
    for (const 打ち方 of ["費用が安い会議", "参加費が高い", "元データをもらう方法"]) {
      expect(
        String(Recommender.uiWordNoteJa(打ち方, false) || ""),
        `比べる打ち手に斷りが乘つた: ${打ち方}`,
      ).toBe("");
    }
  });
});
