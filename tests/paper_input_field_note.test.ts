/**
 * 論文を貼る欄の名前を打つ人に、其の場處を名指す（第 628 回）。
 *
 * 實測 – 2026-08-09 生成の実ビルド（品書 3,280 行）で 0 件になる打ち手 819 本を讀んだ處、
 * 論文の入力の欄名を打つ文が**一つも案内に當たらん**かつた（`参考論文` `論文入力`
 * `投稿予定タイトル` `投稿予定概要` `投稿予定キーワード` `投稿予定論文選ぶ` `件数`）。
 * 之等は搜の語ではなく**欄の名前**なので、黙られると画面の何處へ行けば良いか分らん。
 * 直し – 欄の名前を名指す羣を新たに置き（`site/recommender.ts` の `UI_WORD_GROUPS_JA`）、
 * 押す所（『投稿先を探す』 – 『締切を検索』の隣の切り替え）まで書く。併せて
 * ①「投稿先」を打つ人を公式ページへだけ追は無い（此の画面に投稿先を出す機能が在る）
 * ②「何件」の羣に「件数」を足す（實測で `件数` だけが彈かれた）
 * ③語尾に「を探す」「選ぶ」を置く（`投稿先を探す` `投稿予定論文選ぶ`）。
 * 效き – 舊來（第 627 回品）と竝べて、品書 0 件に出る羣の斷り **285 → 293 本**
 * （開いた 8 本、狹まつた 0 本）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();

describe("論文の入力の欄名を打つ人（第 628 回）", () => {
  const 欄名 = [
    "参考論文",
    "掲載先",
    "論文入力",
    "論文の入力",
    "投稿予定タイトル",
    "投稿予定概要",
    "投稿予定キーワード",
    "投稿予定論文選ぶ",
  ];
  it("打ち先（『投稿先を探す』の切り替え）まで名指す", () => {
    for (const 文 of 欄名) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `切り替えの名前が書かれて居ん: ${文}`).toContain("投稿先を探す");
      expect(out, `着く欄の名前が書かれて居ん: ${文}`).toContain("論文の入力");
      expect(out, `搜の語と區別して居ん: ${文}`).toContain("検索欄の語");
    }
  });
  it("斷りが名指す物は、畫面に實際に在る（成果物の字面照合）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    /* 案内が言う各所が、ビルドした頁に一字違はず出て居る事を張る（第 466 回の流儀 –
       案内の字面は畫面の字面と違へん）。 */
    for (const 字 of ["投稿先を探す", "締切を検索", "論文の入力", "投稿予定タイトル", "参考論文"])
      expect(頁, `畫面に無い名前を案内が言った: ${字}`).toContain(字);
    expect(頁).toContain("タイトル | キーワード | 掲載先");
  });
  it("讀み上げは 60 字以内に納まつて居る（第 247 回 – 畫面の短い形）", () => {
    /* `uiWordNoteJa` の二つ目の引數は打ち替えの有無で、短い形では無い – 短い形は
       `uiWordLiveNoteJa` が返す（app の `zeroResultLive` が之に「 ｜ 」と
       「下に外せる条件も書いてあります」を添えて讀み上げる – 六十字の張りは其の方）。 */
    for (const 文 of 欄名.concat(["投稿先", "件数", "投稿先を探す"])) {
      const 短 = String(Recommender.uiWordLiveNoteJa(文) || "");
      expect(短, `短い形が空: ${文}`).not.toBe("");
      expect([...短].length, `讀み上げが ${[...短].length} 字あつた: ${文}`).toBeLessThanOrEqual(
        60,
      );
    }
  });
});

describe("『投稿先』に此の画面の機能を足す（第 628 回）", () => {
  it("公式ページへ追うだけでなく、此の畫面の切り替えを示す", () => {
    for (const 文 of ["投稿先", "提出先", "投稿システム", "修正稿"]) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `此の畫面の機能が書かれて居ん: ${文}`).toContain("投稿先を探す");
      expect(out, `欄が無い事が消えた: ${文}`).toContain("EasyChair");
    }
    expect(短い("投稿先")).toContain("投稿先を探す");
  });
  it("当たりが行に在る語には羣の斷りを被せん（搜の語は讓る）", () => {
    /* 「論文」は品書に 2,004 行出る語（實測）。單體で羣の語になつて居らん事を見る。 */
    expect(斷り("論文")).toBe("");
    expect(斷り("投稿")).toBe("");
    expect(斷り("掲載")).not.toBe(斷り("掲載先"));
  });
});

describe("件数の語（第 628 回）", () => {
  it("`件数` も『何件』と同じ案内に落ちる", () => {
    for (const 文 of ["件数", "件数が知りたいです", "件数の數え方"]) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out).toContain("件数欄");
    }
    /* 打ち方を名指す頭（echo）を外せば同じ家（第 388 回の決まり – 打たれた語を書き返す）。 */
    const 家 = (文: string) => 斷り(文).replace(/^「[^」]*」/, "");
    expect(家("件数")).toBe(家("何件"));
  });
  it("品書では 0 件の侬にだけ乘る（檢索の側は廣げて居らん – 第 362 回）", () => {
    const 品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    );
    const 基準 = Date.parse("2026-08-09T00:00:00Z");
    for (const 文 of ["参考論文", "投稿予定タイトル", "件数", "掲載先", "論文入力"]) {
      const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
      expect(
        品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length,
        `行が出た: ${文}`,
      ).toBe(0);
    }
  });
});
