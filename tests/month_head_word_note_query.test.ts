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
function 画面案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}
function 何か書く(文: string) {
  return 画面案内(文) !== "" || 日の案内(文) !== "";
}

describe("月の語にその初めの言い方を繋いだ形が 0 件の訳を書く（第 483 回）", () => {
  it("繋いだ形・離した形・『の』を挟む形が同じ説明を出す", () => {
    for (const 文 of [
      "来月初め",
      "来月始め",
      "来月最初",
      "来月 初め",
      "来月の初め",
      "来月 の 初め",
      "今月始め",
      "先月最初",
      "再来月初め",
      "1月初め",
      "12月頭",
      "十月初め",
    ]) {
      const 説 = 画面案内(文);
      expect(説 !== "", `「${文}」が無言だつた（黙つて 0 件）`).toBe(true);
      /* 打ち直しの三つ（その日・その十日間・その月）を并べて書く（その内一つを落とした改ざんが
       * 通つた為、その列まで張つた – 実測 2026-11-08）。*/
      expect(説, `「${文}」の案内が其の日を打てと書いていない`).toContain("其の日");
      expect(説, `「${文}」の案内が上旬を打てと書いていない`).toContain("其の十日間（「上旬」）");
      expect(列(文).size, `「${文}」で行を出した（勝手に寄せた）`).toBe(0);
    }
  });
  it("月と『末』『終わり』を離つたり『の』で挟んだりした形も詰め形と同じ行に出る（第 483 回）", () => {
    for (const [繋, 離] of [
      ["来月末", "来月 末"],
      ["来月末", "来月の末"],
      ["来月終わり", "来月 終わり"],
      ["今月末", "今月 末"],
      ["12月末", "12月 末"],
      ["再来月末", "再来月 末"],
    ] as Array<[string, string]>) {
      expect([離, 列(離).size]).toEqual([離, 列(繋).size]);
      expect([離, 列(離).size > 0]).toEqual([離, true]);
    }
    expect(列("来月末").size).toBe(178);
    expect(列("今月末").size).toBe(118);
    expect(列("12月末").size).toBe(84);
    expect(列("再来月末").size).toBe(97);
    /* 実測（実ビルド 868 行では 夫々 245・192・178・194・262・40・192・82 件）。*/
    expect(列("週 末").size).toBe(146);
    expect(列("来週 末").size).toBe(34);
    expect(列("月末").size).toBe(118);
    expect(列("年度末").size).toBe(29);
  });
  it("その月の幅の語をそのまま打ち直しに書く（第 459 回 – 案内は打たれた語を名乗る）", () => {
    expect(画面案内("来月初め")).toContain("又は其の月（「来月」）");
    expect(画面案内("来月 初め")).toContain("又は其の月（「来月」）");
    expect(画面案内("3月最初")).toContain("又は其の月（「3月」）");
  });
  it("末側の言い方はその方の月の末に解ける – 案内を立てて行を減らさない", () => {
    for (const 文 of ["来月末", "来月末日", "来月終わり", "今月末", "先月末"]) {
      expect(列(文).size > 0, `「${文}」が出ない`).toBe(true);
      expect(画面案内(文), `「${文}」に絞り込めぬ案内が並んだ`).toBe("");
    }
  });

  function 群を数(頭々: string[], 尾部: string[]) {
    const 黙: string[] = [];
    const 絞: string[] = [];
    for (const 甲 of 頭々)
      for (const 乙 of 尾部)
        for (const 文 of [`${甲}${乙}`, `${甲} ${乙}`, `${甲}の${乙}`]) {
          if (列(文).size === 0) {
            if (!何か書く(文)) 黙.push(文);
          } else if (画面案内(文) !== "") {
            絞.push(文); // 行が出るのに「絞り込めません」と書く形（噓）
          }
        }
    return { 黙, 絞 };
  }

  it("群 – 頭の側の言い方は 0 件なら必ず何か書く（第 483 回）", () => {
    const { 黙, 絞 } = 群を数(
      ["来月", "今月", "先月", "再来月", "1月", "3月", "12月"],
      ["頭", "初め", "始め", "最初"],
    );
    expect(黙, "0 件で案内もない打ち方が残つた").toEqual([]);
    expect(絞, "行が出るのに絞り込めぬ案内を並べた").toEqual([]);
  });
  it("群 – 末側の言い方も同じ決まり（第 483 回）", () => {
    const { 黙, 絞 } = 群を数(
      ["来月", "今月", "先月", "再来月", "1月", "3月", "12月"],
      ["末", "終わり"],
    );

    const 残る: string[] = [];
    expect(
      黙.filter((文) => !残る.includes(文)),
      "其它の 0 件で案内もない打ち方が残つた",
    ).toEqual([]);
    for (const 文 of 残る)
      expect([文, 黙.includes(文)], `「${文}」が直つた積り`).toEqual([文, true]);
    expect(絞, "行が出るのに絞り込めぬ案内を並べた").toEqual([]);
  });
  it("群 – 旬側の言い方も同じ決まり（第 483 回）", () => {
    const { 黙, 絞 } = 群を数(
      ["来月", "今月", "先月", "1月", "12月"],
      ["上旬", "初旬", "中旬", "下旬"],
    );
    expect(黙, "0 件で案内もない打ち方が残つた").toEqual([]);
    expect(絞, "行が出るのに絞り込めぬ案内を並べた").toEqual([]);
  });
});

describe("週の語の同じ群に抜けていた言い方（第 416 回・第 431 回の続き）", () => {
  it("『始め』『最初』『末日』はその場で説明し、旬は二語に割れて行が出る（第 483 回・第 490 回）", () => {
    for (const 文 of ["来週始め", "来週最初", "来週末日", "今週始め"]) {
      expect(何か書く(文), `「${文}」が無言だつた`).toBe(true);
      expect(列(文).size, `「${文}」で行を出した`).toBe(0);
    }

    for (const 文 of ["来週初旬", "今週初旬", "先週初旬", "再来週初旬"]) {
      expect([文, 列(文).size], `「${文}」`).toEqual([
        文,
        列(`${文.slice(0, 2)} ${文.slice(2)}`).size,
      ]);
      /* 案内（絞り込めません）は出さない – その週の幅を名乗る案内は出る（行が出る為の範囲）。*/
      expect(画面案内(文), `「${文}」に絞り込めぬ案内が並んだ`).not.toContain("絞り込めません");
    }
    expect(列("来週 初旬").size).toBe(2); /* 実ビルド 868 行では 4 件 */
  });
});

describe("その他の機械と前の回の実測は動かして居ない", () => {
  it("行の出る形の行数は其侭", () => {
    expect(列("来月上旬").size).toBe(68);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月末").size).toBe(178);
    expect(列("来月 終わり").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("明日以降").size).toBe(423);
    expect(列("締切時刻").size).toBe(181);
    expect(列("一 月 五 日").size).toBe(5);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(列("来月 下旬 まで").size).toBe(276);
    expect(列("明日 から 明後日").size).toBe(4);
    expect(列("ml から").size).toBe(0);
  });
  it("年度のかたまりの語はその方の表が受ける（この目は触らぬ）", () => {
    expect(列("年度末").size).toBeGreaterThan(0);
    expect(画面案内("年度末")).toBe("");

    expect(列("来年度末").size).toBe(3);
    expect(列("来年度 末").size).toBe(列("来年度末").size);
    expect(列("来年度の末").size).toBe(列("来年度末").size);
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("月の頭尾の目と、週二目の列に足した語が現れる", () => {
    expect(物.match(/月の頭尾のかたちJa/g)?.length).toBe(2);
    expect(物).toContain("(?:頭|初め|始め|最初)");
    /* 週の位の案内は前半・後半だけに残つた（旬は第 490 回で二語に割る側へ移つた）。*/
    expect(物).toContain("(?:前半|後半)");
    expect(物).toContain("|初旬|中頃|中盤|半ば)/g,");
    expect(物).toContain("(?:頭|初め|始め|最初|末日|終わり)");
  });
});
