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
const 全 = 品書();

function 行列表(文: string): string[] {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 全.filter((行) => 照合(行) === true);
}
function 件数(文: string): number {
  return 行列表(文).length;
}
/** 品書の字面で行を探す（寄せ先と**一字も違わない**事を張る為の基準）。 */
function 字面列(語: string): string[] {
  return 全.filter((行) => 行.indexOf(語) >= 0);
}
function 畫面の案内(文: string): string {
  return [
    Recommender.columnQueryNoteJa(文),
    Recommender.uiWordNoteJa(文),
    Recommender.dayRangeNoteJa(文),
    Recommender.wholeTableQueryNoteJa(文),
    ...(Recommender.relativeDayNotes(文, 基準) || []),
    ...Recommender.querySynonymNotes(文),
  ]
    .filter(Boolean)
    .map((案内) => String(案内).trim())
    .join(" ∥ ");
}

/* 国内研究会・国内シンポジウム以外の会議に付く印（`internationalFacetSearchTerms`）。 */
const 国際の印 = "〔国際〕";

describe("『国際』を日本語で打つ人が国内以外の会議に出会える", () => {
  it("「国際会議」は国内研究会・国内シンポジウム以外の会議（名前の International に頼らない）", () => {
    const 行 = 行列表("国際会議");
    expect(行.length, "`国際会議` が 0 行").toBeGreaterThan(0);
    // 印の付いた行と一字も違わない（名前に International の無い会議も入る）。
    expect(行.sort()).toEqual(字面列(国際の印).sort());
    expect(
      行.some((行) => !行.includes("international")),
      "名前に International の無い会議が入っていない（以前の狭い意味のまま）",
    ).toBe(true);
    // 国内研究会・国内シンポジウムは入らない。
    expect(行.some((行) => 行.includes("国内研究会") || 行.includes("国内シンポジウム"))).toBe(
      false,
    );
  });

  it("素の『国際』は国内以外の会議と、原文に international と書く行の和", () => {
    const 和 = [...new Set([...字面列(国際の印), ...行列表("international")])].sort();
    expect(行列表("国際").sort()).toEqual(和);
  });

  it("寄せた語は原文の英文字語を書く行と一字も違わない", () => {
    for (const [打ち方, 原文] of [["年次", "annual"]] as const) {
      expect(件数(打ち方), `\`${打ち方}\` が 0 行`).toBeGreaterThan(0);
      expect(行列表(打ち方).sort(), `\`${打ち方}\` の行集合が "${原文}" の行と違う`).toEqual(
        字面列(原文).sort(),
      );
    }
  });

  it("書き方を変へても同じ行に出会う（和仮名・旧字体・種別語を繋げた形）", () => {
    const 基 = 件数("国際");
    expect(基).toBeGreaterThan(0);
    for (const 打ち方 of [
      "こくさい",
      "國際",
      "国際的",
      "国際的な",
      "国際会議",
      "国際大会",
      "国際学会",
      "国際カンファレンス",
      "国際コンファレンス",
      "国際 会議",
      "国際 大会",
      "国際的な会議",
      "国際会議一覧",
      "国際会議一覧表",
      "こくさい会議",
      "国際会議の締め切り",
    ]) {
      expect(件数(打ち方), `\`${打ち方}\` が \`国際\` と同じ行を出さない`).toBe(基);
    }
  });

  it("助詞で一度割れた打ち方の部も、其侭の見出しで受ける（`国際会議の締切`）", () => {
    expect(件数("国際会議の締切"), "`国際会議の締切` が 0 行").toBeGreaterThan(0);
    expect(件数("国際会議の締切"), "空格で並べた時と行が違う").toBe(件数("国際会議 締切"));
    expect(件数("国際会議の締切"), "絞る前の語より広くなった").toBeLessThanOrEqual(
      件数("国際会議"),
    );
    expect(件数("国際会議への参加"), "`国際会議への参加` が 0 行").toBeGreaterThan(0);
    expect(件数("国際学会の締切"), "`国際学会の締切` が 0 行").toBeGreaterThan(0);
  });

  it("種別を名指す繋げ方は、繋がって書かれた語に寄せる（452 行に広げない）", () => {
    for (const [打ち方, 原文] of [
      ["国際シンポジウム", "international symposium"],
      ["国際ワークショップ", "international workshop"],
    ] as const) {
      const 行 = 字面列(原文);
      expect(行.length, `品書に "${原文}" が無い（検査が空振り）`).toBeGreaterThan(0);
      const 打 = 行列表(打ち方);

      expect(
        行.filter((x) => !打.includes(x)),
        `\`${打ち方}\` が "${原文}" を連なりで書く行を落とした`,
      ).toEqual([]);
      const 語 = 原文.split(/\s+/);
      // 原文の連なりを書く行か、国内以外の会議でその種別の語を持つ行（`国際` と種別語に割れる）。
      const 種別語 = 語[語.length - 1];
      expect(
        打.filter(
          (x) => !語.every((w) => x.includes(w)) && !(x.includes(国際の印) && x.includes(種別語)),
        ),
        `\`${打ち方}\` が語を揃へん行を拾つた`,
      ).toEqual([]);
      /* その方の語を名指さない行まで出さない（`国際` だけの寄せは頼み過ぎ）。 */
      expect(件数(打ち方), `\`${打ち方}\` が \`国際\` より広くなつた`).toBeLessThan(件数("国際"));
    }
    // 空格で並べる人は二語のかけ算（括った語より広い） – その方はその方で通る。
    expect(件数("国際 シンポジウム"), "空格の打ち方が繋がれた形より狭い").toBeGreaterThanOrEqual(
      件数("国際シンポジウム"),
    );
  });

  it("『シンポジウム』は和名の行だけでなく英文字の会議名を持つ行にも届く", () => {
    expect(件数("シンポジウム"), "`シンポジウム` が 0 行").toBeGreaterThan(0);
    // 寄せは和集合なので、以前当たつていた行は残る。
    expect(件数("シンポジウム")).toBeGreaterThanOrEqual(件数("symposium"));
    expect(字面列("symposium").length).toBeGreaterThan(0);
    expect(行列表("symposium").every((行) => 行列表("シンポジウム").indexOf(行) >= 0)).toBe(true);
  });
});

describe("案内（黙つた 0 件を直した事が画面に出る）", () => {
  it("寄せた語は打ち込んだ語と原文の語を名指す", () => {
    for (const 打ち方 of [
      "国際会議",
      "国際学会",
      "国際カンファレンス",
      "国際",
      "こくさい",
      "國際",
    ]) {
      expect(畫面の案内(打ち方), `\`${打ち方}\` が何で探したかを言っていない`).toContain(
        "国内研究会・国内シンポジウム以外の会議",
      );
    }
    for (const [打ち方, 原文] of [
      ["国際", "international"],
      ["こくさい", "international"],
      ["國際", "international"],
      ["国際シンポジウム", "international symposium"],
      ["国際ワークショップ", "international workshop"],
      ["年次", "annual"],
      ["シンポジウム", "symposium"],
    ] as const) {
      const 案内 = 畫面の案内(打ち方);
      expect(案内, `\`${打ち方}\` は無言`).toContain(打ち方);
      expect(案内, `\`${打ち方}\` の案内が原文の語を言っていない`).toContain(原文);
      expect(案内, `\`${打ち方}\` の案内が原文の語だと言っていない`).toContain("原文");
    }
  });

  it("全行の語を繋げた形は二つの案内が並ぶ（第 245 回・第 514 回との対）", () => {
    const 案内 = 畫面の案内("国際 会議");
    expect(案内).toContain("この表の全行にあてはまる語");
    expect(案内).toContain("international");
    expect(件数("国際 会議")).toBe(件数("国際"));
  });
});

describe("寄せない物（黙つて意味を広げない – 四つの門）", () => {
  it("`研究会` を『SIG』に寄せない（第 358 回）", () => {
    const 行 = 行列表("研究会");
    expect(行.length, "`研究会` が 0 行になった").toBeGreaterThan(0);
    expect(
      行.every((hay) => hay.indexOf("研究会") >= 0),
      "`研究会` が『SIG』の行へ広がつた",
    ).toBe(true);
    expect(件数("研究会")).toBe(字面列("研究会").length);
  });

  it("`国際研究会` は寄せない（品書にない行を作らない）", () => {
    expect(件数("国際研究会")).toBe(0);
    // その方の語単体は動く。
    expect(件数("国際")).toBeGreaterThan(0);
  });

  it("`春季` `秋季` `夏季` `冬季` `グローバル` は薄い語へ寄せない（第 232 回の `panel`）", () => {
    for (const 打ち方 of ["春季", "秋季", "夏季", "冬季", "グローバル"]) {
      expect(件数(打ち方), `\`${打ち方}\` に行を作つた`).toBe(0);
    }
  });

  it("`大会` の断りの案内はその侭（第 358 回 – その呼び方の催し物は収録にない）", () => {
    expect(件数("大会")).toBe(0);
    expect(畫面の案内("大会")).toContain("では絞りません");
  });
});

describe("第 514 回以前の決まりを壊して居ない", () => {
  it("全行の語尾の割りはその侭効く", () => {
    expect(件数("AI会議"), "`AI会議` が語尾の割りで落ちた").toBe(件数("AI"));
    expect(件数("セキュリティ会議")).toBe(件数("セキュリティ"));
    // `査読締切日` は fixtures に査読の行が無いので繋げた形と並べた形が同じ事を張る
    // （実ビルドでは 13 行 – 第 514 回の検査がその方を張る）。
    expect(件数("査読締切日"), "`査読締切日` が『査読 締切日』と違う").toBe(件数("査読 締切日"));
    expect(件数("AI締切日"), "`AI締切日` が『AI』と違う").toBe(件数("AI"));
    // 語その物が全行の語は割らない。
    expect(件数("締切一覧")).toBe(0);
    expect(畫面の案内("締切一覧")).toContain("では絞り込めません");
  });

  it("`国内会議` の『国内』への寄せはその侭", () => {
    expect(件数("国内会議"), "`国内会議` が『国内』の行を出さない").toBeGreaterThan(0);
    expect(件数("国内会議")).toBe(件数("国内"));
    expect(畫面の案内("国内会議")).toContain("国内");
    // 国内と国際は別の頼み方 – 一方が他方に化けない。
    expect(行列表("国内会議").some((行) => 行列表("国際").indexOf(行) >= 0)).toBe(false);
  });

  it("磁石の決まりはその侭黙つている（第 505 回）", () => {
    for (const 打ち方 of ["費用対効果分析", "リアルタイム処理", "メジャーな学会", "対面について"]) {
      expect(件数(打ち方), `\`${打ち方}\` に行を作つた`).toBe(0);
      expect(畫面の案内(打ち方), `\`${打ち方}\` に案内を出した`).toBe("");
    }
  });

  it("寄せ表の語を繋いだ形（第 381 回）はその侭", () => {
    expect(件数("ショートペーパー"), "`ショートペーパー` が 0 行に戻つた").toBeGreaterThan(0);
    expect(件数("ショートペーパー")).toBeLessThanOrEqual(件数("short"));
  });
});

describe("ビルドの組み込み", () => {
  it("寄せ語の条目は二重に置いて居ない（正本は一つ）", () => {
    // 長い条目は整形で折り返される（末尾にカンマも付く）ので、空白と閉じ括弧前のカンマを除いて数える。
    const 空白なし = (文: string) => 文.replace(/\s+/g, "").replace(/,\]/g, "]");
    const 品 = 空白なし(readFileSync(join(builtSite(), "recommender.js"), "utf8"));
    for (const [見出し, 回] of [
      [
        '["国際", "国内研究会・国内シンポジウム以外の会議と、原文の international という語", ["〔国際〕", "international"]]',
        1,
      ],
      ['["国際会議", "国内研究会・国内シンポジウム以外の会議", ["〔国際〕"]]', 1],
      ['["年次", "原文の annual という語", ["annual"]]', 1],
      ['["シンポジウム", "原文の symposium という語", ["symposium"]]', 1],
      [
        '["国際シンポジウム", "原文の international symposium という語", ["international symposium"]]',
        1,
      ],
    ] as const) {
      let 数 = 0;
      const 探す = 空白なし(見出し);
      let 所 = 品.indexOf(探す);
      while (所 >= 0) {
        数 += 1;
        所 = 品.indexOf(探す, 所 + 1);
      }
      expect(数, `組み込みに \`${見出し}\` が ${数} 本並んだ`).toBe(回);
    }
  });

  it("打ち方の語を品書の字面に足して居ない（足すのは人が打たない印だけ）", () => {
    // 「国際会議」その物を足すと「会議」単体が其の部分に当たり、全行の語ではなくなる。
    expect(字面列("国際会議").length, "品書に『国際会議』の字面を足した").toBe(0);
    expect(件数("会議"), "「会議」単体が行を持つようになった").toBe(0);
    expect(字面列("年次").length, "品書に『年次』の字面を足した").toBe(0);
    expect(字面列("〔国際〕").length, "国内以外の会議の印が無い（検査が空振り）").toBeGreaterThan(
      0,
    );
  });
});
