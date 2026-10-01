/**
 * 手元の端末（スマートフォン・タブレット）で見る人の案内（第 634 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行）で `スマホ` `スマートフォン`
 * `レイアウト` `見にくい` `タブレット` `iphone` は**品書 0 行で、畫面の導きも無かつた** –
 * 一方で `site/template.html` には「狭い画面（スマートフォンの幅）では列の見出しを消して行を
 * カードにする」「表の上に並べ替えの列を出す」が書いて在り、CSS にも `@media (max-width: 640px)`
 * が在る（答へられる質問に答へて居なかつた）。
 *
 * この檢査が主に張るのは**讓した所** – 「見られる」系の語尾を積むと `スマホでも見られる` に
 * 畫面の斷りが乘つて、第 622 回が張つた「搜の文を食はせん」（その物は見られるかと訪ねる打ち方）
 * と衝突した（讀み上げ六十字の檢査も落ちた – 舊來の羣の斷りが乘つて長くなつた）。積まん事
 * を此處に張る。
 */

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
  it("十三本の打ち手が默らん – 畫面の實物だけを名指す", () => {
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
  it("案内が名指す物がビルドした畫面に實在る（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of ["並べ替え", "カレンダーに追加（.ics）", "見方のてびき"])
      expect(頁, `畫面に無い物を書いた: ${字}`).toContain(字);
    /* 幅の規則その物は畫面に出らんが、嘘にならんやうに「狭い画面」で言つてる。
       CSS に breakpoint が在る事は源码で見る（`site/template.html` – @media (max-width: …）。 */
    const 型 = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
    expect(型.includes("max-width"), "幅の規則が CSS に無い").toBe(true);
  });
  it("讀み上げは 60 字以内（第 247 回）", () => {
    for (const 文 of 打ち手) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("讓した所 – 「見られる」の語尾を積まん（第 622 回との衝突）", () => {
  it("搜に聽こえる打ち方は畫面の斷りを立てん", () => {
    /* `Xでも見られる` は「其れは見られるのか（収録に在るのか）」と讀める – 第 622 回が
       搜の文として讓す事に決めた形。語尾を積めば通るが、積む每に搜らしい打ち手を奪ふ。 */
    for (const 文 of ["スマホでも見られる", "RSSはある", "ポスターでも見られる"])
      expect(
        String(Recommender.uiWordNoteJa(文, false) || ""),
        `斷りが乘つた: ${文}`,
      ).not.toContain("のことなら");
  });
  it("`モバイル` は羣に載せん（搜の語 – 44 行當たる）", () => {
    expect(当たり("モバイル"), "モバイルは行が出る筈").toBeGreaterThan(0);
    expect(斷り("モバイル")).not.toContain("狭い画面");
  });
});
