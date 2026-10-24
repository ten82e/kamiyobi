import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/* 等級の組み合わせが分かっている小さな収録（実データの等級の載り方に左右されない様に）。
 * 2026-10-17 の実測で取り違えた組（DSN: CCF B・CORE A、AsiaCCS: CCF C・CORE A）を含む。 */
function 会議(key: string, rank: Record<string, string>) {
  return {
    key,
    title: key.toUpperCase(),
    full_name: `${key.toUpperCase()} Security Conference`,
    categories: ["security"],
    rank,
    editions: [
      {
        year: 2027,
        id: `${key}27`,
        place: "Berlin, Germany",
        deadlines: [
          {
            kind: "paper",
            label: "Paper submission",
            round: 1,
            precision: "exact",
            utc: "2026-11-01T11:59:00Z",
            aoe: "2026-10-31 23:59:00 AoE",
            tz_raw: "AoE",
          },
        ],
      },
    ],
  };
}
const 収録 = {
  conferences: [
    会議("sp", { ccf: "A", core: "A*", thcpl: "A" }),
    会議("dsn", { ccf: "B", core: "A", thcpl: "B" }),
    会議("asiaccs", { ccf: "C", core: "A", thcpl: "B" }),
    会議("ches", { ccf: "B", core: "A", thcpl: "A" }),
    会議("ccs", { ccf: "A", core: "A*", thcpl: "A" }),
    会議("unranked", {}),
  ],
};

type 行 = { hay: string; conf: { key: string } };
const 全 = Recommender.candidateRows(収録 as unknown as never) as unknown as 行[];

function 当たり(文: string): string[] {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 全.filter((r) => 照合(r.hay) === true).map((r) => r.conf.key);
}

describe("尺度と等級（CCF A・CORE A* など）は 1 つの条件として引く", () => {
  it("組み立てた収録が検索の行になっている（検査が空振りしない）", () => {
    expect(全.length).toBe(6);
  });

  it.each([
    ["CCF A", ["sp", "ccs"]],
    ["CCF B", ["dsn", "ches"]],
    ["CCF C", ["asiaccs"]],
    ["CORE A*", ["sp", "ccs"]],
    ["CORE A", ["dsn", "asiaccs", "ches"]],
    ["THCPL B", ["dsn", "asiaccs"]],
  ] as const)("「%s」はその等級の会議だけを出す", (文, 期待) => {
    // 以前は「ccf」と「a」を別々に当て、`ccf b` と `core a` を持つ DSN まで拾っていた。
    expect(当たり(文).sort()).toEqual([...期待].sort());
  });

  it("書き方（区切り・大小・助詞・語順）を変えても同じ行に出会う", () => {
    const 基 = 当たり("CCF A セキュリティ").sort();
    expect(基).toEqual(["ccs", "sp"]);
    for (const 文 of [
      "CCF:A セキュリティ",
      "CCF-A セキュリティ",
      "ccf a セキュリティ",
      "CCF：A セキュリティ",
      "CCF Aのセキュリティ",
      "セキュリティ CCF A",
    ]) {
      expect(当たり(文).sort(), `「${文}」の行が違う`).toEqual(基);
    }
  });

  it("等級の付かない尺度名だけ・等級だけの語は今まで通り", () => {
    expect(当たり("CCF").sort()).toEqual(["asiaccs", "ccs", "ches", "dsn", "sp"]);
    expect(当たり("A*").sort()).toEqual(["ccs", "sp"]);
  });
});
