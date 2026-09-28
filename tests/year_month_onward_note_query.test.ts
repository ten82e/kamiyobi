/* 第 485 回 – 年の語に暦月を繋いで其れより後を続けた形が、絞れて居るのに「絞り込みません」と書いて居た
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、其れ等は行が出て居た
 * – `今年1月から` 796 件（= 2026年1月以降、其の年の中まで）・`今年12月から` 178 件（= 2026年12月）・
 * `来年1月から` 465 件・`来年3月から` 371 件 – のに、件の数欄は
 * 「其れより後の締切の事だと思いますが、前の語を此の表の日として探せないので検索欄では絞り込まずにいます」
 * と書いて居た（十六語 – 年五種 × 月二種 × 語尾二種の内、其の方が其の年と暦月に割れた物）。其の方の読みは
 * 其の年 ∧ 其の月以降で合つて居るので（其れを対称差で確かめた – 行は一個も動かして居ない）、嘘なのは
 * 案内の側だつた（黙つても嘘でもいけない – 第 332 回）。案内を行と同じ幅を名乗る形に直した（第 413 回）。
 * 其の年と暦月の両方が決まら無い形（`来年度3月から` – 年度に継いだ月が其の方で割れぬ – 第 484 回の
 * 残した差）は、今まで通り導きを出す（其れは本当に絞れて居ない為 – 第 369 回）。*/
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
function 日の案内(文: string) {
  return (Recommender.relativeDayNotes(文, 基準) || []).join("|");
}

describe("其の年 ∧ 其の月以降で絞れて居る形は、其の幅を名乗る（第 485 回）", () => {
  it("其の方の十六語から「絞り込まずにいます」が消えた", () => {
    const 噓: string[] = [];
    for (const 年 of ["今年", "来年", "去年", "2026年", "2027年"])
      for (const 月 of ["1月", "3月", "12月", "一月", "十二月"])
        for (const 尾 of ["から", "以降"]) {
          const 文 = `${年}${月}${尾}`;
          if (日の案内(文).includes("絞り込まずにいます")) 噓.push(文);
        }
    expect(噓, "其の方の案内が其れでも行が出るのに絞り込まぬと書いて居る").toEqual([]);
  });
  it("案内が其の月一日からの幅を書く（其の方が絞れる範囲と合ふ – 第 413 回）", () => {
    expect(日の案内("今年1月から")).toContain("2026年1月1日以降のこと（其の年の中まで）");
    expect(日の案内("今年12月から")).toContain("2026年12月1日以降のこと（其の年の中まで）");
    expect(日の案内("来年1月以降")).toContain("2027年1月1日以降のこと（其の年の中まで）");
    expect(日の案内("2027年3月から")).toContain("2027年3月1日以降のこと（其の年の中まで）");
    /* 漢数字の月も同じ幅（其の方は算用数字に寄せてから解れる – 第 392 回）。*/
    expect(日の案内("今年一月から")).toContain("2026年1月1日以降のこと");
    expect(列("今年一月から").size).toBe(列("今年1月から").size);
  });
  it("其の方の語が本当に絞れて居る（実測の件数で張る – 案内の幅と行が合ふ）", () => {
    expect(列("今年1月から").size).toBe(426);
    expect(列("今年1月 から").size).toBe(426);
    expect(列("今年一月から").size).toBe(426);
    expect(列("今年12月から").size).toBe(84);
    expect(列("今年 12月").size).toBe(84);
    expect(列("来年1月から").size).toBe(113);
    /* 品書の果てより後の月は行が在らん – 其れを推して行を足して居ない事の実測。*/
    expect(列("来年12月から").size).toBe(0);
    expect(列("2027年3月から").size).toBe(75);
    /* 其の月以降は其の年より広い幅にならぬ（今年1月以降 ⊇ 今年12月以降 – 行の包含関係）。*/
    expect([...列("今年12月から")].every((行) => 列("今年1月から").has(行))).toBe(true);
  });
});

describe("その他の形は動かして居ない（第 352 回・第 369 回・第 413 回）", () => {
  it("其の方で既に解れる形は無言の侭", () => {
    for (const 文 of [
      "12月から",
      "9月から",
      "3月から",
      "今年から",
      "来年度から",
      "明日から",
      "来週から",
    ]) {
      expect(日の案内(文), `「${文}」に案内が並んだ`).toBe("");
      expect(列(文).size > 0, `「${文}」が行を出さない`).toBe(true);
    }
  });
  it("其の年と暦月が決まら無い形は、今まで通りの導きが出る", () => {
    /* 残した差（実測 2026-11-08）– 年度の語に暦月を継いだ形は其の方が割れぬ為 0 件の侭で、
     *其上導きもその他の形より古い文が並ぶ（年度＋月の割りは別の群 – 第 484 回に残した差として載せた）。*/
    expect(列("来年度3月から").size).toBe(0);
    expect(日の案内("来年度3月から")).toContain("其れより後");
    /* 其れを名乗る幅が決まら無い形は、其の侭「検索欄では絞り込まずにいます」を出す（其れを通す目を
     * 落とした改ざんが落ちるやうに、其の文を張る – 其它の頁でも同じ文を張つて居る）。*/
    expect(日の案内("来年度3月から")).toContain("検索欄では絞り込まずにいます");
    /* 同じ文を行が出る形に並べない事も張る（第 462 回・第 463 回と同じ決まり）。*/
    for (const 文 of ["今年1月から", "来年1月から", "今年12月から", "2027年3月から"]) {
      expect(日の案内(文), `「${文}」に行と食い違う案内が並んだ`).not.toContain(
        "絞り込まずにいます",
      );
    }
  });
  it("第 470 回〜第 484 回の実測は此の回で変へて居ない", () => {
    expect(列("来年度末").size).toBe(1);
    expect(列("来年末").size).toBe(21);
    expect(列("今年末").size).toBe(84);
    expect(列("来月 末").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("明日以降").size).toBe(422);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来月終わり").size).toBe(178);
    expect(列("ml から").size).toBe(0);
    expect(列("一 週間後").size).toBe(13);
    expect(列("半 年後").size).toBe(2);
    expect(列("締切時刻").size).toBe(180);
    expect(列("来月初め").size).toBe(0);
    expect(列("今年1月 から").size).toBe(426);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("其の年と暦月の幅を名乗る案内が現れる", () => {
    expect(物.match(/年と暦月/g)?.length).toBeGreaterThan(1);
    expect(物).toContain("以降のこと（其の年の中まで）");
    /* 其の方の導き（本当に絞れぬ形）は其侭残つて居る事。*/
    expect(物).toContain("検索欄では絞り込まずにいます");
  });
});
