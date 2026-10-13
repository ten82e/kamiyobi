import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(甲: string, 乙: string): number {
  const A = 列(甲);
  const B = 列(乙);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}

describe("週の位を足した言い方", () => {
  it("『来週内』は『来週中』と同じ週を出す", () => {
    for (const [言い方, 正本] of [
      ["来週内", "来週中"],
      ["今週内", "今週中"],
      ["先週内", "先週中"],
    ] as Array<[string, string]>) {
      expect(列(正本).size, `正本「${正本}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(言い方, 正本), `「${言い方}」が別の週に出た`).toBe(0);
    }
  });

  it("件の数欄にはその週の日で書く", () => {
    const 文 = Recommender.relativeDayNotes("来週内", 基準).join(" ");
    expect(文, "広げた週を書いていない").toContain("2026年8月10日");
  });

  it("中国語混じりの週の言い方は寄せない（第 339 回の基準の侭 – 第 416 回で測つた）", () => {
    /* 実測で 0 行（『来週』53 行・『先週』26 行・『先々週』14 行が通る）と測つた形も、
     * 日本語の言い換えが既に通るので寄せない。打ち直しの案内にも出さない。 */
    for (const 語 of ["明週", "去週", "前々週", "前前週"]) {
      expect(列(語).size, `"${語}" まで受けてしまった`).toBe(0);
      expect(String(Recommender.uiWordNoteJa(語) ?? "").trim(), `"${語}" に案内を立てた`).toBe("");
    }
    /* その週の語に旬を繋げた形は第 490 回で二語に割れるやうになつた（離した形と同じ行）。
     * 案内が残るのは公用の決まりの無い前半・後半だけ。 */
    expect(String(Recommender.uiWordNoteJa("来週中旬") ?? "").trim()).toBe("");
    expect(対称差("来週中旬", "来週 中旬")).toBe(0);
  });
});

describe("週の語に旬を繋げた形", () => {
  it("その月の旬に化けない（週と旬のかけ算である – 第 490 回）", () => {
    expect(列("中旬").size, "その月の中旬の行が在らない").toBeGreaterThan(0);
    expect(列("下旬").size).toBeGreaterThan(0);
    for (const 語 of ["来週中旬", "来週中頃", "来週中盤", "来週半ば"]) {
      expect(列(語).size, `「${語}」が其の月の旬の行を並べている`).toBeLessThan(列("中旬").size);
      expect(対称差(語, `${語.slice(0, 2)} ${語.slice(2)}`), `「${語}」が離した形と違ふ`).toBe(0);
    }
    /* その月の旬に、その週の行が混じつて居ない事（今週・先週も同じ決まり）。 */
    expect(対称差("今週上旬", "上旬"), "今月の上旬が其侭混じっている").not.toBe(0);
    expect(列("今週中旬").size).toBe(列("今週 中旬").size);
    expect(列("先週中旬").size).toBe(列("先週 中旬").size);
  });

  it("その場で打ち直しを書く（0 行の侭黙らない – 案内の残る形）", () => {
    /* 旬は第 490 回で行が出る側へ移つたので、案内が残るのは公用の決まりの無い前半・後半と、
     * 頭・終わりのやうな週の中の位置。*/
    for (const 語 of ["来週前半", "来週後半"]) {
      const 文 = String(Recommender.uiWordNoteJa(語) ?? "");
      expect(列(語).size, `「${語}」に行が出た（案内の殘る形）`).toBe(0);
      expect(文, `「${語}」の案内が出て居ない`).toContain(語);
      expect(文, `「${語}」の案内が絞り込めない理由を書いていない`).toContain("絞り込めません");
      expect(文, `「${語}」の案内が打ち直しを書いていない`).toContain("来週水曜");
    }
    /* 旬の方は行が出る（案内は出さない）。*/
    for (const 語 of ["来週中旬", "来週下旬", "来週中頃", "今週中旬", "先週中旬"]) {
      expect(String(Recommender.uiWordNoteJa(語) ?? "").trim(), `「${語}」に案内が並んだ`).toBe("");
      expect(列(語).size, `「${語}」が離した形と違ふ`).toBe(
        列(`${語.slice(0, 2)} ${語.slice(2)}`).size,
      );
    }
  });

  it("離して打たれた週と旬はかけ算の侭（和集合に寄せない）", () => {
    const 来週 = 列("来週");
    const 中旬 = 列("中旬");
    const 積 = new Set([...来週].filter((行) => 中旬.has(行)));
    expect(積.size, "かけ算の側が空（検査が空振り）").toBeGreaterThan(0);
    expect([...列("来週 中旬")].sort().join("\n")).toBe([...積].sort().join("\n"));
    expect(列("来週 下旬").size, "今月の下旬が混んだ（和集合に寄された）").toBe(0);
  });

  it("その週そのを打つ形は変えて居ない", () => {
    expect(列("来週").size).toBeGreaterThan(0);
    expect(列("今週").size).toBeGreaterThan(0);
    expect(列("来週中").size).toBeGreaterThan(0);
  });
});

describe("月の語が頭の旬は其侭解ける", () => {
  it("月の語を継ぐ形と列挙・幅は壊して居ない", () => {
    for (const 語 of ["中旬", "下旬", "上旬", "8月中旬", "今月中旬", "来月上旬", "来月下旬"]) {
      expect(列(語).size, `「${語}」が解けなくなった`).toBeGreaterThan(0);
    }
    expect(列("上旬と下旬").size).toBeGreaterThan(0);
    expect(列("来月上旬から中旬").size).toBeGreaterThan(0);
    expect(列("8月最終週").size).toBeGreaterThan(0);
    /* 案内も出て居ない – それ alone で解ける語に案内を足していない。 */
    expect(String(Recommender.uiWordNoteJa("来月上旬") ?? "")).toBe("");
  });
});

describe("守り", () => {
  it("他の直しを変えて居ない", () => {
    /* 分野の略語。 */
    expect(列("ml").size).toBeGreaterThan(0);
    expect(Recommender.querySynonymNotes("ml").join(" ")).toContain("machine learning");
    /* 漢数字のか月。 */
    expect(対称差("一か月後", "1か月後")).toBe(0);
    /* 曖昧な幅の案内。 */
    expect(String(Recommender.uiWordNoteJa("数日以内") ?? "")).toContain("曖昧な幅");
    /* 暦日を打ってそれより後。 */
    expect(列("8月22日以降").size).toBeGreaterThan(0);
    /* 時刻にゾーンを繋げて打つ形。 */
    expect(対称差("23:59JST", "23:59 JST")).toBe(0);
  });
});

describe("成果物", () => {
  it("割らない決まりと語の表は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/週の語かJa\(頭\) && 旬の位かJa\(尾\)/g) ?? []).toHaveLength(1);
    expect(物.match(/function 旬の位かJa/g) ?? []).toHaveLength(1);
    expect(物.match(/function 週の語かJa/g) ?? []).toHaveLength(1);
    expect(物.match(/今週内: 0,/g) ?? []).toHaveLength(1);
    /* 寄せない語は表にも案内にも出して居ない。 */
    /* 表の条目と案内の語の列挙に入っていない（注釈には測つた語として残る）。 */
    expect(物.match(/明週[:|]/g) ?? []).toHaveLength(0);
    expect(物.match(/(?:前々週|前前週)[:|]/g) ?? []).toHaveLength(0);
    expect(物.match(/来週内: 1,/g) ?? []).toHaveLength(1);
    expect(物.match(/const 週の位のかたちJa =/g) ?? []).toHaveLength(1);
    /* 月の旬の解読で週の語を月の語と取り違えない決まり（その物一会い）。 */
    expect(物.match(/if \(週の語かJa\(冠\)\)/g) ?? []).toHaveLength(1);
  });
});
