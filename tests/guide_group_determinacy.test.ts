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
const 件 = (文: string) =>
  全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true).length;
function 案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}

describe("同じ語を二つの群に持つ誤りを直し、てびきの群にも語尾の印を付けた（第 511 回）", () => {
  it("`確定` の答へは締切確定扱いの群 – てびきではない", () => {
    expect(件("確定")).toBe(0);
    expect(案内("確定")).toContain("延伸や確定の印");
    expect(案内("確定")).not.toContain("見方のてびき");
    /* 後ろの群に語があるので、訪ねた形も同じ答へに変はる。*/
    expect(案内("確定はいくら")).toContain("延伸や確定の印");
    /* その群の他のの語は旧の侭。*/
    for (const 文 of ["未確定の締切", "確定済みの締切", "延長した締切"]) {
      expect(案内(文), `「${文}」の案内が消えた`).toContain("延伸や確定の印");
    }
  });
  it("てびきの群が締切らしい語尾を受ける（旧は完全に無言だった）", () => {
    for (const 文 of [
      "使い方の締切",
      "ヘルプの締切",
      "てびきの締切",
      "みかたの期限",
      "使い方の期限",
      "ヘルプまで",
      "つかいかたの締切",
      "ヘルプの予定",
    ]) {
      const 説 = 案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内がてびきの話をしない`).toContain("見方のてびき");
      expect(件(文), `「${文}」で行が出た`).toBe(0);
    }
    /* 単体の案内も旧の侭（語を拔いたのは `確定` だけ）。*/
    for (const 文 of ["使い方", "ヘルプ", "てびき", "みかた", "つかいかた"]) {
      expect(案内(文), `「${文}」の案内が消えた`).toContain("見方のてびき");
    }
  });
  it("値を並べた打ち方に案内を被せない決まりは其侭（第 250 回・第 354 回）", () => {
    for (const 文 of ["使い方 関西", "ヘルプ HPC", "てびき 2026年", "印刷 関西", "書き出し HPC"]) {
      expect(件(文)).toBe(0);
      expect(案内(文), `「${文}」に案内が乘つた（并べ打ちの決まりを破つた）`).toBe("");
    }
    /* 語の途中に助詞があるだけの打ち方も拾はぬ。*/
    expect(案内("ヘルプデスクの乗り")).toBe("");
    /* 利得の無い群（`以降` を頭に置く打ち方が無い）は開いた侭にしない。*/
    expect(案内("以降の締切")).toBe("");
  });
  it("磁石と行が出る打ち手は旧の侭", () => {
    expect(案内("費用対効果分析")).toBe("");
    expect(案内("リアルタイム処理")).toBe("");
    expect(件("関西")).toBe(6);
    expect(件("セキュリティ")).toBe(68);
    expect(件("ランクA")).toBe(3);
    for (const 文 of ["関西", "セキュリティ", "ランクA"]) {
      expect(案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
  });
  it("第 503 回〜第 510 回の道と、他のの実測は変へて居ない", () => {
    expect(案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(案内("祝日の期限")).toContain("祝日・休日");
    expect(案内("キーノートの締切")).toContain("キーノート");
    expect(案内("前期")).toContain("という区分はこの表が持っていません");
    expect(案内("三連休明け")).toContain("のように祝日・休日の名前で");
    expect(案内("週明け頃")).toContain("「週明け頃」");
    expect((Recommender.columnQueryNoteJa("分野 セキュリティ") || "").trim()).toContain(
      "「分野」は",
    );
    expect(案内("参加費はいくら")).toContain("この表が持っていません");
    expect(件("年内")).toBe(425);
    expect(件("今年内")).toBe(427);
    expect(件("再来週内")).toBe(18);
    expect(件("年末中")).toBe(84);
    expect(件("来月 末日")).toBe(178);
    expect(件("週 末")).toBe(146);
    expect(件("締切時刻")).toBe(181);
    expect(件("ml から")).toBe(0);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("てびきの群から `確定` が消え、語尾の印が 42 群に付いた", () => {
    /* 語の配列を複数行に組んだので、目印は `words:` を
     * 通さない – 羣の語その物を見る（`使い方` はこの羣にしか在らん）。*/
    const 群0 = 物.slice(物.indexOf('"使い方"'), 物.indexOf('"使い方"') + 2400);
    expect(群0).not.toContain('"確定"');
    expect(群0).toContain("deadlineTail: true");
    /* 第 516 回で二つ增える（採否の数の群・当日の様子の群）。*/
    /* 第 516 回で二つ增えて 37、第 517 回で『催し物の名前＋締切の言い方』の群が增えて 38。*/
    /* 第 685 回で募集・応募の群が增えて 42（`応募締切` `募集期限` `募集の締切` を同じ群で受ける）。*/
    expect(物.split("deadlineTail: true").length - 1).toBe(42);
    /* 同じ語を二つの群に持つ形（この回の原因）を `確定` に就て張る – 二つの群が同じ語を持つと
       完全一致は先勝ちで後ろの群の答えが屆かない。他のの群にも重なりはあるが（`データ源` は両方とも
       「画面下の『データ源』」へ導くので噓に成らない）、応答が食い違う重なりは此为一つだけだつた。*/
    const 語列表 = 物.match(/words:\s*\[[^\]]*\]/g) || [];
    expect(語列表.length, "群の語列表が読めない（検査が空振り）").toBeGreaterThan(30);
    const 確定を持つ群 = 語列表.filter((文) => /"確定"[,\]]/.test(文));
    expect(確定を持つ群.length, "`確定` を持つ群が二つある（応答が食い違う）").toBe(1);
  });
});
