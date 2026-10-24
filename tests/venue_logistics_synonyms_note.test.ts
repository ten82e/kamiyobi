import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string =>
  String(Recommender.uiWordNoteJa(文, false) || Recommender.wholeTableQueryNoteJa(文) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};

/* [打ち手, その家が言う斷片, 他の家では無い證左] */
const 家族: Array<[string, string, string[]]> = [
  ["バスツアーの予約", "会場の中と外", ["費用の欄", "日付の欄の名前", "当日の様子"]],
  ["見学会はある", "会場の中と外", ["費用の欄", "日付の欄の名前"]],
  ["エクスカーション", "会場の中と外", ["費用の欄", "当日の様子"]],
  ["夕食会の日程", "当日の様子を書く欄", ["費用の欄", "バリアフリー"]],
  ["宴会の予定", "当日の様子を書く欄", ["バリアフリー"]],
  ["ケータリング", "当日の様子を書く欄", ["費用の欄"]],
  ["会員割引がある", "費用の欄はありません", ["バリアフリー", "当日の様子"]],
  ["参加費が割引される", "費用の欄はありません", ["会場の中と外"]],
  ["逐次通訳がある", "バリアフリー", ["費用の欄", "日付の欄の名前"]],
  ["保険は付いてる", "欄の名前ではありません", ["日付の欄の名前"]],
];

describe("会場と当日の用事を訪ねる言い方（第 633 回）", () => {
  it("それぞれの家に着く – 斷りは一つだけ（之家違ひを張る）", () => {
    for (const [文, 家, 他] of 家族) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `${家} とは別の案内になつた: ${文} → ${out.slice(0, 44)}`).toContain(家);
      for (const 別 of 他) expect(out, `他の家の文が混じつた（${別}）: ${文}`).not.toContain(別);
    }
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const [文] of 家族) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
  it("読み上げは 60 字以内（第 247 回 – 新しい語を持つ羣だけ）", () => {
    for (const [文] of 家族) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("门 – 開の字に実ある語を羣に載せん（第 516 回・第 507 回）", () => {
  it("`ホテル` は会場まわりの羣に混ぜん（開催地に実ある – 『ない』が噓になる）", () => {
    const out = 斷り("ホテルの手配");
    expect(out.includes("会場の中と外"), `會場まわりの羣に載つた: ${out.slice(0, 40)}`).toBe(false);
    expect(out.includes("費用の欄"), `費用の羣に載つた: ${out.slice(0, 40)}`).toBe(false);
  });
  it("`会場` は欄の名前を値と並べた形に道を讓る（第 508 回）", () => {
    for (const 文 of ["会場関西", "会場を知りたいです"])
      expect(String(Recommender.uiWordNoteJa(文, false) || ""), `斷りが乘つた: ${文}`).toBe("");
  });
});
