/** 語を繋げて打った人を、分け方に導く案内の檢査（SPEC §7・第 532 回）。 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

type SplitRec = { splitHintJa: (文: string, 件數: (文: string) => number) => string };
let R: SplitRec;
beforeAll(async () => {
  const mod = await import(pathToFileURL(`${site}/recommender.js`).href);
  R = mod.default as unknown as SplitRec;
});

const 偽の件數 = (表: Record<string, number>) => (文: string) => 表[文] ?? 0;

describe("繋げた打ち方を分ける導き", () => {
  it("分け方の中で最も當たる形を、件數を添へて敎うる", () => {
    const 文 = "可視化日程";
    const 案内 = R.splitHintJa(
      文,
      偽の件數({ "可視 化日程": 2, "可視化 日程": 7, "可視化日 程": 1 }),
    );
    expect(案内).toContain("可視化 日程");
    expect(案内).toContain("7 件");
    expect(案内).toContain("繋げた打ち方");
  });

  it("分けても當たらん打ち方には何も言はん（噓の助言を立たん）", () => {
    expect(R.splitHintJa("猫の名前", 偽の件數({}))).toBe("");
    /* 既に分かつて居る打ち方・短すぎる打ち方・_URL_ の様な打たれ方は觸らん。 */
    expect(R.splitHintJa("可視化 日程", 偽の件數({ "可視化 日程": 9 }))).toBe("");
    expect(R.splitHintJa("日程", 偽の件數({ "日 程": 9 }))).toBe("");
    expect(R.splitHintJa("https://example.com/x", 偽の件數({}))).toBe("");
  });

  it("數へる側を渡されん畫面では默る（代りの數へ上げを檢査側に持たん – 第 215 回）", () => {
    /* 畫面側の配線（`filter.splitCount` を渡す所）は下の條でソース側に張る。此處では、抜き出す
     * 檢査が `splitCount` 無しで呼んだ時に**导きが出ん事**だけを張る – 導きが出んのは「數へられん」
     * ので、畫面上は 0 件のままの斷りになる（噓の件數を言はん）。*/
    const hint = deadlineHintFunction();
    const base = {
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      hidden: { past: 0, est: 0 },
      hiddenKindWords: [],
      queryMatch: { catalog: 0, journal: 0 },
      termCounts: [],
      urlQuery: false,
      catalogConferences: 12,
    };
    expect(hint({ ...base, query: "あいう日程" })).not.toContain("語を分けて");

    /* 數へる側を渡すと、畫面の案内に載る（第 533 回 – `specific` の列にを入れて萬通る）。
       これを入れる前は、導きを計算しても「外せる条件」を並べる枝に落ちで、畫面に出んかつた。*/
    expect(
      hint({
        ...base,
        query: "あいう日程",
        splitCount: (文: string) => (文 === "あいう 日程" ? 7 : 0),
      }),
    ).toContain("語を分けて「あいう 日程」と打つと 7 件出ます");
  });

  it("他の原因が分かつて居る時は重ねん（畫面が二つの話をする為）", () => {
    const app = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
    const i = app.indexOf("const splitNote =");
    expect(i).toBeGreaterThan(0);
    const 門 = app.slice(i, app.indexOf("Recommender.splitHintJa", i));
    [
      "columnNote",
      "uiNote",
      "dayRangeNote",
      "wholeNote",
      "nameNote",
      "kindNote",
      "catalogNote",
      "termNote",
      "urlNote",
    ].forEach((語) => {
      expect(門.includes(`!${語}`), `${語} の門が缺けて居る`).toBe(true);
    });
    expect(app).toContain("splitCount: splitCountJa,");
    expect(app).toContain("splitCount?: (文: string) => number;");
  });
});
