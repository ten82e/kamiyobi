import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8"));
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

/** 第 662 回で讓りの語尾に载せた物の名。*/
const 载せた語尾々 = ["査読", "視聴", "動画", "開催"];

describe("羣の語に物の名を續ける打ち方", () => {
  it("四つの物の名で結んだ打ち手が宛先に屆く", () => {
    for (const [訪ね, 宛先] of [
      ["ダブルブラインド査読", "審査の方式"],
      ["アーカイブ視聴", "収録するのは"],
      ["録画動画", "収録するのは"],
      ["混合開催", "参加形式"],
      ["学生向け査読", "募集対象"],
      ["初心者向け動画", "募集対象"],
      ["ビザ視聴", "ビザ"],
    ] as Array<[string, string]>) {
      expect(当たり(訪ね), `${訪ね} は搜れる筈ではない`).toBe(0);
      expect(讓り(訪ね), `${訪ね} の宛先`).toContain(宛先);
    }
  });

  it("検索れる打ち手は讓りが無く其侪検索へる（行の取り分を奪はん）", () => {
    /* 載せた語尾其物も検索れる（`査読` 32 行・`開催` 298 行・`動画` は让られん – 第 588 回）。*/
    for (const [訪ね, 當] of [
      ["オンライン開催", 109],
      ["査読", 32],
      ["開催", 298],
      ["オンライン", 109],
      ["機械学習", 504],
      ["ccf", 2819],
      ["論文の締切", 2004],
      ["来週までに", 206],
      ["12月31日まで", 1031],
      ["学生だけの会議", 4],
      ["オンラインのみ", 1],
    ] as Array<[string, number]>) {
      expect(当たり(訪ね), `搜の當たりを變へた: ${訪ね}`).toBe(當);
    }
    expect(收錄().length, "品書の行数").toBe(3250);

    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );

    const 其侬 = new Set<string>();
    const 本體 = 上.replace(/exactOnly: \[[\s\S]*?\]/g, (塊) => {
      for (const m of 塊.matchAll(/"([^"\n]+)"/g)) 其侬.add(m[1]);
      return "";
    });
    expect(其侬.size, "exactOnly の語が読められん（配線が変はつた）").toBeGreaterThan(0);
    for (const 語 of 其侬) {
      expect(讓り(語), `印の語『${語}』は其侬でも讓らん – 載せた甲斐が無い`).toBeTruthy();
    }
    /* 羣の語だけを読む（行の頭が語の列 – 讓り文・空格を残す）。*/
    const 羣 = [
      ...new Set(
        [...本體.matchAll(/^\s+"([^"\n]+)",$/gm)]
          .map((m) => m[1])
          .filter((語) => 語.length >= 2 && !/[。、『』（）\s]/.test(語)),
      ),
    ];
    expect(羣.length, "羣の語が読められん").toBeGreaterThan(1000);
    const 默 = [];
    let 洗 = 0;
    for (const 語 of 羣) {
      if (!讓り(語)) continue;
      for (const 尾 of 载せた語尾々) {
        const 訪ね = 語 + 尾;
        洗 += 1;
        if (当たり(訪ね) === 0 && !讓り(訪ね)) 默.push(訪ね);
      }
    }
    expect(洗, "讓りが立つ頭の語尾續きが多すぎる（表が亂れた）").toBeGreaterThan(4000);
    expect(默, `語尾を續けた形で默つた ${默.length} 本: ${默.slice(0, 8).join(" ")}`).toEqual([]);
  });

  it("乘り変はりは悉く語の長い方が勝つ（第 505 回）", () => {
    for (const [訪ね, 名] of [
      ["対面のみ査読", "対面のみ"],
      ["学生割引視聴", "学生割引"],
      ["キャンセル料動画", "キャンセル料"],
      ["現地のみ開催", "現地のみ"],
    ] as Array<[string, string]>) {
      expect(讓り(訪ね), `${訪ね} は頭の長い方を名指す`).toContain(`「${名}」`);
    }
  });

  it("四語尾は白一覧に一個所だけ・效かなかつた二語は载せん", () => {
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.indexOf("const UI_WORD_TAILS_JA = [");
    expect(上, "白一覧が宣わつていない").toBeGreaterThan(0);
    const 下 = 物.slice(上, 物.indexOf("function uiWordTailOk", 上));
    expect(
      物.slice(0, 物.indexOf("function uiWordTailOk")).match(/const UI_WORD_TAILS_JA = \[/g)
        ?.length,
      "白一覧が二處ある",
    ).toBe(1);
    for (const 尾 of 载せた語尾々) {
      const 數 = [...下.matchAll(new RegExp(`^\\s+"${尾}",$`, "gm"))].length;
      expect(數, `『${尾}』の載せ處が違います`).toBe(1);
    }

    for (const 尾 of ["集録", "規約"])
      expect(new RegExp(`^\\s+"${尾}",$`, "m").test(下), `『${尾}』を载せ直した`).toBe(false);
  });
});
