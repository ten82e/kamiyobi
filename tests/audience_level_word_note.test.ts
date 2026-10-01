/**
 * 対象とレベルで訪ねる人が 0 件の侭默つて居た壁を（第 661 回）。
 *
 * 實測（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）で、`初心者向け` `初学者向け`
 * `社会人限定` `研究者向け` `技術者向け` `企業向け` `実践向け` `シニア限定` `入門` `上級` 等は
 * 当たり 0 件・導き無しだつた（十八語 × 五の形 = 90 本が默つて居た）。募集対象の羣は既に在つて
 * `学生向け` `教員` `女性` `若手` `学部生` `企業人` `技術職員` は應へて居たが、其の語列に
 * レベル（初級・中級・上級・入門）と広い対象（初心者・社会人・研究者 …）が缺けて居た。
 *
 * 讓りは当たり 0 件の時にしか畫面に出ん（app.ts の `matchedRows === 0` の門）ので、载せた語が
 * 搜れる打ち手の取り分は減らん – 其れを此の檢査が張る。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

function 当たり(訪ね: string): number {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄().filter((行) => 目(String(行.hay)) === true).length;
}

function 讓り(訪ね: string): string {
  return String(
    Recommender.columnQueryNoteJa(訪ね, (語) => 当たり(語) > 0) ||
      Recommender.uiWordNoteJa(訪ね, false) ||
      Recommender.dayRangeNoteJa(訪ね) ||
      Recommender.wholeTableQueryNoteJa(訪ね) ||
      "",
  ).trim();
}

/** 第 661 回で募集対象の羣に载せた語。*/
const 载せた語々 = [
  "初心者",
  "初学者",
  "初級",
  "中級",
  "上級",
  "入門",
  "実践",
  "実践者",
  "シニア",
  "社会人",
  "技術者",
  "研究者",
  "企業",
  "産業界",
  "業界",
  "院生",
  "修士",
  "一般",
];

describe("対象とレベルで訪ねる人", () => {
  it("载せた十八語は 0 件で讓りが應へる（默りは零）", () => {
    const 變 = [];
    for (const 語 of 载せた語々) {
      for (const 形 of ["", "向け", "限定", "対象", "の人", "向けのセッション"]) {
        const 訪ね = 語 + 形;
        const 當 = 当たり(訪ね);
        if (當 !== 0) 變.push(`${訪ね} = ${當} 行`);
        else if (!讓り(訪ね)) 變.push(`${訪ね} = 默り`);
      }
    }
    expect(變, `變な內譯 ${變.length} 本: ${變.slice(0, 10).join(" ")}`).toEqual([]);
    /* 宛先は募集対象の斷り – 「この表が持つ物」を名指す文に屆いて居る筈。*/
    expect(讓り("初心者向け")).toContain("募集対象");
    expect(讓り("社会人限定")).toContain("公式ページ");
  });

  it("課程の名の頭になる語は载せん（彈いた語の張り – 第 661 回）", () => {
    /* `博士` を载せた折、`博士前期`（博士前期課程 – 修士の舊稱）が募集対象の斷りに化けた
     * （tests/zero_result_recovery.test.ts の「別の語で試す」が彈いた）。拔いた譯は表の註にも書く。*/
    expect(讓り("博士前期"), "`博士前期` が募集対象の讓りに乘つた").not.toContain("募集対象");
    expect(当たり("博士前期")).toBe(0);
    /* 其の方の課程の語は羣に在る（第 650 回）。*/
    expect(讓り("博士課程")).toContain("募集対象");
  });

  it("搜れる打ち手と他の羣の讓りは一通も動かん", () => {
    for (const [形, 當] of [
      ["学生", 4],
      ["機械学習", 504],
      ["ccf", 2819],
      ["論文の締切", 2004],
      ["オンラインのみ", 1],
      ["学生だけの会議", 4],
      ["12月31日まで", 1031],
      ["来週までに", 206],
      ["オンライン", 109],
    ] as Array<[string, number]>) {
      expect(当たり(形), `搜の當たりを變へた: ${形}`).toBe(當);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
    /* 別の羣の讓りが其の侪立つて居る事（载せた語が頭を奪つたら此處が落ちる – 第 505 回）。*/
    for (const [訪ね, 宛先] of [
      ["対面のみ", "参加形式"],
      ["学生割引", "この表が持っていません"],
      ["招待講演", "招待講演"],
      ["参加費", "参加費"],
      ["旅費", "旅費"],
      ["機械学習向け", ""],
      ["学生向け", "募集対象"],
      ["技術職員", "募集対象"],
      ["企業人", "募集対象"],
    ] as Array<[string, string]>) {
      const 注 = 讓り(訪ね);
      if (宛先 === "") expect(当たり(訪ね), `${訪ね} は搜れる筈`).toBeGreaterThan(0);
      else expect(注, `${訪ね} の宛先`).toContain(宛先);
    }
  });

  it("载せた語は募集対象の羣に一個所だけ（同じ語を二つの群に载せず – 第 525 回）", () => {
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );
    const 羣々 = 上.split("\n    {\n");
    expect(羣々.length, "羣の切れ目が數へられん").toBeGreaterThan(20);
    const 主語々: string[] = [];
    let 募集の羣 = "";
    for (const 羣 of 羣々) {
      const 語々 = [...羣.matchAll(/^\s+"([^"\n]+)",$/gm)].map((m) => m[1]);
      主語々.push(...語々);
      if (語々.includes("初心者")) {
        expect(募集の羣, "募集対象の羣に二處载つた").toBe("");
        expect(語々).toContain("学生向け");
        募集の羣 = 羣;
      }
    }
    expect(募集の羣.length, "十八語が募集対象の羣に無い").toBeGreaterThan(0);
    for (const 語 of 载せた語々)
      expect(主語々.filter((w) => w === 語).length, `『${語}』が重複して居る`).toBe(1);
  });
});
