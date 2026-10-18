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
function 列(文: string) {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return new Set(全.filter((行) => 照合(行) === true));
}
function 案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}

describe("期の区分の語に語尾を繋げても案内が出る（第 503 回）", () => {
  it("前期・後期が仲間入りし、それ等に何が繋がっても同じ話を書く", () => {
    for (const [語, 文] of [
      ["前期", "前期"],
      ["後期", "後期の締切"],
      ["上半期", "上半期の締切"],
      ["上半期", "上半期の期限"],
      ["上半期", "上半期まで"],
      ["上半期", "上半期に"],
      ["下期", "下期の締切"],
      ["期初", "期初の締切"],
      ["四半期", "四半期の予定"],
      ["第1四半期", "第1四半期の締切"],
    ] as Array<[string, string]>) {
      const 説 = 案内(文);
      expect(説 !== "", `「${文}」が無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内が区分の話をしない`).toContain(
        "という区分はこの表が持っていません",
      );
      /* 案内はその方が解けた語を名乗る（打たれた語の先頭 – 第 248 回・第 366 回）。*/
      expect(説, `「${文}」の案内が語を名乗つて居ない`).toContain(`「${語}」`);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
  });
  it("一通に決まらない語の群も同じ（月初・週明け）", () => {
    for (const 文 of ["月初の締切", "月初まで", "月初の頃", "週明けの締切", "来週明けの締切"]) {
      const 説 = 案内(文);
      expect(説 !== "", `「${文}」が無言だつた`).toBe(true);
      expect(説).toContain("では絞れません");
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
    expect(案内("月初の締切")).toContain("月の初めという言い方は");
    expect(案内("週明けの締切")).toContain("週の明けという言い方は");
  });
  it("案内が導す語は実在する（第 353 回）", () => {
    expect(列("1日").size).toBe(59);
    expect(列("上旬").size).toBe(10);
    expect(列("月曜").size).toBe(59);
    expect(列("来週").size).toBe(43);
    expect(列("年度初め").size).toBe(31);
    expect(列("年度末").size).toBe(29);
    expect(案内("上半期の締切")).toContain("年度初め");
  });
  it("離して打つた形・単体の形は今まで通り", () => {
    expect(案内("上半期 締切")).toContain("「上半期」");
    expect(案内("上半期")).toContain("「上半期」");
    expect(案内("下期")).toContain("「下期」");
    expect(案内("月初")).toContain("「月初」");
  });
  it("群の全打ち方で、0 件の物は必ず何か書く（第 332 回）", () => {
    const 黙: string[] = [];
    for (const 頭 of [
      "上半期",
      "下半期",
      "上期",
      "下期",
      "半期",
      "期初",
      "期末",
      "四半期",
      "第1四半期",
      "前期",
      "後期",
      "月初",
      "月頭",
      "週明け",
      "来週明け",
    ])
      for (const 尾 of ["", "締切", "の締切", "の期限", "まで", "に", " 締切", "の予定"])
        for (const 文 of [`${頭}${尾}`, `${頭} ${尾}`]) {
          const 説 = 案内(文) || (Recommender.relativeDayNotes(文, 基準) || []).join("");
          if (列(文).size === 0 && 説 === "") 黙.push(文);
        }
    expect(黙, "0 件で案内もない打ち方が残つた").toEqual([]);
  });
  it("他の群を吸つて居ない（第 352 回 – 印を付けた三群だけ語尾を問わない）", () => {
    /* 費用の群は印を持たないので、その語に既知でない語尾が付いた形は従来通り黙る。*/
    expect(案内("参加費")).toContain("費用");

    expect(案内("参加費の安い会議")).toContain("参加費");
    expect(案内("祝日")).toContain("祝日");
  });
  it("第 470 回〜第 502 回の実測はこの回で変へて居ない", () => {
    expect(列("年内").size).toBe(425);
    expect(列("今年内").size).toBe(427);
    expect(列("再来週内").size).toBe(18);
    expect(列("年末中").size).toBe(84);
    expect(列("年初1月").size).toBe(23);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("締切時刻").size).toBe(181);
    expect(列("ml から").size).toBe(0);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("月初").size).toBe(0);
  });
});

describe("ビルド成果物に印がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("語尾を問わない印は十四の群だけ、語尾一覧は問いの形の侭（第 503 回・第 504 回）", () => {
    /* 第 648 回で日をまたぐ重なりを数へる羣（祝日級の次に置いた）を增やしたので 14 → 15。*/
    /* 第 649 回で分野の一覽の羣（語尾を問わん印を開いた）を增やしたので 15 → 16。*/
    /* 2026-10-18 に『締切が無い・未確認』の群（カードの「締切未確認」「締切なし」）を増やしたので 16 → 17。*/
    expect(物.split("anyTail: true").length - 1).toBe(17);
    expect(物).toContain("group.anyTail !== true");
    const 尾表 = 物.slice(物.indexOf("UI_WORD_TAILS_JA ="), 物.indexOf("UI_WORD_TAILS_JA =") + 900);
    expect(尾表).not.toContain('"の締切"');
    /* 複合の語を並べ替へる旧の道に戻して居ない事。*/
    expect(物).not.toContain('"上半期の締切"');
    expect(物).toContain('"前期"');
    expect(物).toContain('"後期"');
  });
});
