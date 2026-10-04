/**
 * 幅の語を「うちに」「開かれる」「時点」で閉じる人が 0 件の侭默つて居た壁を（第 664 回）。
 *
 * 訪ねる人は幅の語を其侪置かず、後ろを種々たる語で閉じる – 然し讓りの家（`collapseRelativeDayPhrase`
 * の指し名の條・判定の條）は「やつ」「もの」と「に間に合う」「過ぎた」の形しか見て居なかった。
 * 實測（2026-08-09 生成の実ビルド・品書 3,250 行・同刻）で、幅の語 × 閉じ方の 154 本の內 **75 本が
 * 当たり 0 件で導きも無し**（`今週のうちに` `来週を過ぎた` `今週時点` `来週中に開かれる`
 * `年度内のうちに` `日曜日に含まれる`）。同じ幅の語を單體で打つと通る（`今週` 37 行・`年度内` 1,658 行・
 * `平日` 2,212 行）ので、惡いのは後ろの方だ – と云ふ事で、通る打ち方を其の場に書く家を通した。
 *
 * 搜れる打ち手に曖昧な斷りを乘せん事（第 337 回）が此の家の命脈なので、語尾を選ぶ時は
 * **全ての幅の頭で 0 行の物だけ**载せる – `中に`（`今日中に` 34 行）・`から`（`明日から` 1,028 行）・
 * `以降`（`今日以降` 1,031 行）は拔いた（拔いた途端、この檢査が彈いた – 第 664 回）。
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

/** 第 664 回に指し名の條へ通した閉じ方（單體で打つ勸めで答へられる類）。*/
const 閉じ方 = [
  "のうちに",
  "うちに",
  "時点",
  "中に開かれる",
  "開かれる",
  "に含まれる",
  "含まれる",
  "行われる",
  "催される",
];
/** 第 664 回に判定の條へ通した助詞の繋ぎ方。*/
const 助詞の判定 = ["を過ぎた", "が過ぎた", "を切れた", "が過ぎたやつ"];
/** 讓りの家に载せん事と決めた語尾（搜れる頭が有る – 第 337 回）。*/
const 拔いた語尾 = ["中に", "までに", "まで", "から", "以降"];

/** 源から幅の頭の語を読む（讓りの家が單體で打つ事を勸める為の語々）。*/
function 幅の頭々(): string[] {
  const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
  const m = /const 幅の頭Ja =\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(源);
  expect(m, "幅の頭Ja が讀められん").not.toBeNull();
  return (m as RegExpMatchArray)[1]
    .replace(/^\(\?:|\)$/g, "")
    .split("|")
    .filter((語) => !/[()[\]?*+{}$^]/.test(語))
    .filter((語) => 語.length >= 2);
}

describe("幅の語を閉じる打ち方", () => {
  it("默つて居た閉じ方が應へるやうになつた", () => {
    const 變 = [];
    for (const 頭 of [
      "今週",
      "来週",
      "明日",
      "年内",
      "年度内",
      "土曜日",
      "日曜日",
      "平日",
      "月末",
    ]) {
      for (const 尾 of [...閉じ方, ...助詞の判定]) {
        const 訪ね = 頭 + 尾;
        if (当たり(訪ね) !== 0) 變.push(`${訪ね} = ${当たり(訪ね)} 行`);
        else if (!讓り(訪ね)) 變.push(`${訪ね} = 默り`);
      }
    }
    expect(變, `變な內譯 ${變.length} 本: ${變.slice(0, 10).join(" ")}`).toEqual([]);
    /* 二つの家が各々別の返事をする – 判定の條は「前か後か」、指し名の條は「幅の語を單體で」。*/
    expect(讓り("来週を過ぎた")).toContain("其れより前か後か");
    expect(讓り("今週のうちに")).toContain("を單體で");
    expect(讓り("今週時点で")).toBe("");
    expect(讓り("来週中に開かれる")).toContain("催し物の日の事か");
  });

  it("勸めが噓にならん – 頭の語は單體で行が出る（過ぎた日は別斷り）", () => {
    const 噓 = [];
    for (const 頭 of 幅の頭々()) {
      for (const 尾 of [...閉じ方, ...助詞の判定]) {
        const 訪ね = 頭 + 尾;
        if (当たり(訪ね) > 0) {
          噓.push(`${訪ね} = ${当たり(訪ね)} 行`);
          continue;
        }
        const 文 = 讓り(訪ね);
        if (!文) continue;
        /* 「幅の語を單體で打て」と勸めるなら、その頭は單體で搜れんといかん。
         * 過ぎた日（`昨日` `先週` 等・「過去の締切も表示」を添へる條）は其處で exempt。*/
        const 勸む = 文.includes("單體で");
        const 過去の断り = 文.includes("過去の締切も表示");
        if (勸む && 当たり(頭) === 0 && !過去の断り)
          噓.push(`${訪ね} の勸めが噓（${頭} 單體 0 行）`);
      }
    }
    expect(噓, `噓の勸め ${噓.length} 本: ${噓.slice(0, 8).join(" / ")}`).toEqual([]);
  });

  it("搜れる打ち手には曖昧な斷りを乘せん（拔いた語尾の張り）", () => {
    for (const [訪ね, 當] of [
      ["今週", 37],
      ["来週", 90],
      ["今週中に", 37],
      ["今日中に", 34],
      ["今週から", 1037],
      ["明日から", 1028],
      ["年度内", 1658],
      ["年度末", 101],
      ["土曜日", 808],
      ["日曜日", 230],
      ["平日", 2212],
      ["年内", 1042],
      ["来週のやつ", 0],
      ["今週", 37],
    ] as Array<[string, number]>) {
      expect(当たり(訪ね), `搜の當たりを變へた: ${訪ね}`).toBe(當);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
    /* 拔いた語尾は曖昧な家に通らん事（讓りが立つのは別の家 – 「以前」等 – に限る）。*/
    for (const 頭 of ["今週", "明日", "年内", "年度内", "平日"]) {
      for (const 尾 of 拔いた語尾) {
        const 文 = 讓り(頭 + 尾);
        expect(
          文.includes("を單體で") || 文.includes("其れより前か後か"),
          `${頭}${尾} が曖昧な家に通つた`,
        ).toBe(false);
      }
    }
  });

  it("表の形 – 载せた語尾と载せぬ語尾が源で區別れる", () => {
    const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 指し名 = /const 指し名のかたちJa = new RegExp\(\s*\n([\s\S]{0,600}?)\n\s*\);/.exec(源);
    expect(指し名, "指し名の條が讀められん").not.toBeNull();
    const 判定 = /const 判定のかたちJa = new RegExp\(\s*\n([\s\S]{0,900}?)\n\s*\);/.exec(源);
    expect(判定, "判定の條が讀められん").not.toBeNull();
    for (const 尾 of ["うちに", "時点", "開か", "含ま", "行わ", "催さ"])
      expect(指し名![1], `指し名の條に『${尾}』が無い（拔き直した）`).toContain(尾);
    for (const 助 of ["を|が"]) expect(判定![1], `判定の條の助詞『${助}』が無い`).toContain(助);
    for (const 尾 of 拔いた語尾)
      expect(
        指し名![1].includes("|" + 尾 + "|") || 指し名![1].includes("|" + 尾 + ")"),
        `拔いた語尾『${尾}』が指し名に還つた`,
      ).toBe(false);
    for (const 頭 of ["年度内", "年度末", "土曜日", "日曜日", "平日"]) {
      expect(new RegExp("\\|" + 頭 + "\\|").test(源), `『${頭}』が幅の頭に讀めん`).toBe(true);
    }
  });
});
