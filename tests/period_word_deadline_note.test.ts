/* 第 503 回 – 期の区分や「一通に決まらない語」に語尾を繋げた形（`上半期の締切` `前期` `下期まで`）
 *
 * 実測（2026-11-09 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、案内の表は其の語の
 * **完全一致**か、其后が問いの形（`したい` `の仕方` – `UI_WORD_TAILS_JA`）の時にだけ働く（第 352 回）。
 * 其の為、`前期` `後期` は表に語その物が無く **0 件で案内も無し**、其上
 * `上半期の締切` `下期の締切` `期初の締切` `四半期の期限` `上半期まで` `上半期に` `月初の締切`
 * `週明けの締切` のやうに語尾を繋いだ形も **0 件で案内も無し**だつた（同じ語の `上半期` `下期`
 * `月初` `週明け` 単体と、離して打つた `上半期 締切` は案内が出る – 案内が黙るのが打ち方の差だけ
 * なので、第 332 回「黙つても嘘でもいけない」の黙る側）。
 *
 * 直しは群の印（`anyTail`）– 「この表が其の区分を持っていない」「其の言い方は一通に決まらない」と
 * 云ふ話は、其后に何が繋がっても同じ答えなので、**其の語が先頭に在れば**語尾を問わない。
 * `UI_WORD_TAILS_JA` に「の締切」を足す形は取らない（第 352 回 – 費用など他の群まで吸う）。
 * 群ごとに切る為、誤発火の面は「語の先頭に在る事」に限定した（第 326 回 – 語が文中に在るだけの
 * 打ち方で誤発火した実測がある）。
 *
 * 案内は其の方が解けた語を名乗る（`上半期の締切` → 「上半期」という区分は… – 第 248 回・第 366 回
 * の「照合の語が打たれた語の先頭の時は同じ長さの先頭を返す」決まり）。品書の文本に「前期」
 * 「後期」「上半期」「下期」「四半期」「期初」「期末」は一度も出ない（実測 0 行）ので「この表が
 * 持っていません」は噓にならない（第 337 回）。*/
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
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}

describe("期の区分の語に語尾を繋げても案内が出る（第 503 回）", () => {
  it("前期・後期が仲間入りし、其れ等に何が繋がっても同じ話を書く", () => {
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
      /* 案内は其の方が解けた語を名乗る（打たれた語の先頭 – 第 248 回・第 366 回）。*/
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
    expect(列("1日").size).toBe(62);
    expect(列("上旬").size).toBe(10);
    expect(列("月曜").size).toBe(59);
    expect(列("来週").size).toBe(43);
    expect(列("年度初め").size).toBe(29);
    expect(列("年度末").size).toBe(28);
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
    expect(黙, "0 件で案内も無い打ち方が残つた").toEqual([]);
  });
  it("他の群を吸つて居ない（第 352 回 – 印を付けた三群だけ語尾を問わない）", () => {
    /* 費用の群は印を持たないので、其の語に既知でない語尾が付いた形は従来通り黙る。*/
    expect(案内("参加費")).toContain("費用");
    expect(案内("参加費の安い会議")).toBe("");
    expect(案内("祝日")).toContain("祝日");
  });
  it("第 470 回〜第 502 回の実測は此の回で変へて居ない", () => {
    expect(列("年内").size).toBe(424);
    expect(列("今年内").size).toBe(426);
    expect(列("再来週内").size).toBe(18);
    expect(列("年末中").size).toBe(84);
    expect(列("年初1月").size).toBe(23);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("締切時刻").size).toBe(180);
    expect(列("ml から").size).toBe(0);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("月初").size).toBe(0);
  });
});

describe("ビルド成果物に印が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("三つの群だけ anyTail を持ち、語尾一覧は問いの形の侭", () => {
    expect(物.split("anyTail: true").length - 1).toBe(3);
    expect(物).toContain("group.anyTail !== true");
    const 尾表 = 物.slice(物.indexOf("UI_WORD_TAILS_JA ="), 物.indexOf("UI_WORD_TAILS_JA =") + 900);
    expect(尾表).not.toContain('"の締切"');
    /* 複合の語を並べ替へる旧の道に戻して居ない事（第 503 回で外した）。*/
    expect(物).not.toContain('"上半期の締切"');
    expect(物).toContain('"前期"');
    expect(物).toContain('"後期"');
  });
});
