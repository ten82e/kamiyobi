import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

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

const 打ち手 = [
  "スマホ",
  "スマートフォン",
  "携帯",
  "ケータイ",
  "レイアウト",
  "見にくい",
  "見づらい",
  "画面が崩れる",
  "表示が崩れる",
  "小さい画面",
  "タブレット",
  "iphone",
  "android",
];

describe("手元の端末で見る人（第 634 回）", () => {
  it("十三本の打ち手が黙らん – 画面の実物だけを名指す", () => {
    for (const 文 of 打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `カード化の話が書かれて居ん: ${文}`).toContain("狭い画面");
      expect(out, `行をカードにする話が書かれて居ん: ${文}`).toContain("カード");
      expect(out, `表の上の並べ替えの列が書かれて居ん: ${文}`).toContain("並べ替え");
      expect(out, `持ち出しの道が書かれて居ん: ${文}`).toContain("カレンダーに追加（.ics）");
      expect(out, `てびきの場所が書かれて居ん: ${文}`).toContain("見方のてびき");
      expect(当たり(文), `当たり行の出る打ち手: ${文}`).toBe(0);
    }
  });
  it("案内が名指す物がビルドした画面に実ある（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["並べ替え", "カレンダーに追加（.ics）", "見方のてびき"])
      expect(頁, `畫面に無い物を書いた: ${字}`).toContain(字);
    /* 幅の規則その物は画面に出らんが、嘘にならんやうに「狭い画面」で言つてる。
       CSS に breakpoint がある事は源码で見る（`site/template.html` – @media (max-width: …）。 */
    const 型 = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
    expect(型.includes("max-width"), "幅の規則が CSS にない").toBe(true);
  });
  it("読み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 打ち手) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("讓した所 – 「見られる」の語尾を積まん（第 622 回との衝突）", () => {
  it("検索に聽こえる打ち方は画面の斷りを立てん", () => {
    for (const 文 of ["スマホでも見られる", "RSSはある", "ポスターでも見られる"])
      expect(
        String(Recommender.uiWordNoteJa(文, false) || ""),
        `斷りが乘つた: ${文}`,
      ).not.toContain("のことなら");
  });
  it("`モバイル` は羣に載せん（検索の語 – 44 行当たる）", () => {
    expect(当たり("モバイル"), "モバイルは行が出る筈").toBeGreaterThan(0);
    expect(斷り("モバイル")).not.toContain("狭い画面");
  });
});
