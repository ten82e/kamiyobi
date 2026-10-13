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
const 対称差 = (甲: string, 乙: string) => {
  const A = 列(甲);
  const B = 列(乙);
  let 違 = 0;
  for (const 行 of new Set([...A, ...B])) if (A.has(行) !== B.has(行)) 違 += 1;
  return 違;
};

describe("英文字の語を と で繋いだ打ち方が空格で打つのと同じになる（第 425 回）", () => {
  const 対: Array<[string, string]> = [
    ["aiとml", "ai ml"],
    ["AIと機械学習", "ai 機械学習"],
    ["aiとmlとnlp", "ai ml nlp"],
    ["mlとai", "ml ai"],
    ["gpuとクラスタ", "gpu クラスタ"],
  ];
  for (const [繋いだ, 割った] of 対) {
    it(`『${繋いだ}』は『${割った}』と同じ一覧`, () => {
      expect(対称差(繋いだ, 割った)).toBe(0);
    });
  }

  it("『aiとml』は 0 行でない（空格で打つのと同じ当たり）", () => {
    expect(列("aiとml").size).toBe(列("ai ml").size);
    expect(列("aiとml").size).toBeGreaterThan(0);
  });
});

describe("語の内は割らない – 頭が英文字でない語は其侭（第 425 回）", () => {
  it("『機械と学習』は語の内の `と` を割らない（0 行の侭 – 掛け算 1 行に化けない）", () => {
    expect(列("機械と学習").size).toBe(0);
    expect(対称差("機械と学習", "機械 学習")).toBeGreaterThan(0);
  });

  it("『ネットワークとセキュリティ』も割らない", () => {
    expect(列("ネットワークとセキュリティ").size).toBe(0);
  });

  it("片側だけ英文字でも頭が英文字なら割れる（『aiと HPC』は ai と HPC の掛け算）", () => {
    expect(対称差("aiと HPC", "ai HPC")).toBe(0);
  });

  it("敬語で了う打ち方（『mlとです』）と `と` だけで了う打ち方（『aiと』）は其侭通る", () => {
    expect(対称差("mlとです", "ml")).toBe(0);
    expect(対称差("aiと", "ai")).toBe(0);
  });
});

describe("其它の打ち方は一寸も動かない（第 425 回）", () => {
  it("第 424 回の列挙・第 423 回の空格相対日・其它の検索", () => {
    expect(対称差("来週と再来週", "来週と 再来週")).toBe(0);
    expect(対称差("来 週", "来週")).toBe(0);
    expect(対称差("3 日以内", "3日以内")).toBe(0);
    expect(対称差("ai ml", "ai ml")).toBe(0);
    expect(列("").size).toBe(436);
  });
});

describe("割りの形がビルド成果物に残る（第 425 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("先頭が英文字だけの部を表す目印がある", () => {
    expect(
      物.match(/const 英文字の部の列Ja = String\(token \|\| ""\)\.split\("と"\);/g),
    ).toHaveLength(1);
    expect(物.includes("英文字の部の列Ja[0]) &&")).toBe(true);
  });
});
