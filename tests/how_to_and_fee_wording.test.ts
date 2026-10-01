/**
 * 「〜する方法」で訪ねる人（第 650 回）。
 * 實測（2026-08-09 生成の品書 3,250 行・固定時刻 2026-08-09T00:00:00Z）– 二十文打つて**默り七つ**だつた
 * （內譯は SPEC.md 第 650 回）。原因は二つ – ①羣の語の後ろに續く**動詞の頭**が語尾の一覽に無く、
 * 「物の名を續ける」表の `方法` と組んだ形が彈かれる（第 602 回の仕組みの側）②料の掛かかり方の語が
 * 語表に無い。第 649 回で殘した穴の續き。
 * 檢査は
 *  ① 開いた形が**その物の在處**を答へる事、
 *  ② 廣すぎて羣を乘取る語尾（`もらう` – 第 505 回の磁石）を再び载せん事と、その為に默つた儘の文を
 *     事實として張る事（第 466 回の実發生の流儀）、
 *  ③ 一語搜の磁石と、既に答えの在つた羣（第 516 回の「當日の様子」）を乘取らん事、
 *  ④ 搜の文（打ち替へが在る打ち方）を食はせん事（第 622 回）、
 *  ⑤ 讀み上げ六十字
 * を張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((r) => match(String(r.hay)) === true).length;
}

function 斷り(文: string): string {
  return String(Recommender.uiWordNoteJa(文, false) || "").trim();
}

describe("「〜する方法」で訪ねる人と、料の掛かかり方（第 650 回）", () => {
  it("語の後ろに動詞の頭が續く形が開く（實測で默つて居た七文の續き）", () => {
    for (const [文, 語] of [
      ["カレンダーに落とす方法", /CSV|data\.json|\.ics/],
      ["表をコピーする方法", /印刷/],
      ["フィードの設定方法", /CSV|\.ics|data\.json/],
      ["元データの取得方法", /CSV|\.ics|data\.json/],
      ["アーカイブはどこで見る", /録画/],
      ["聴講料金はいくら", /費用/],
      ["発表費用はいくら", /費用/],
      ["投稿費用はいくら", /費用/],
      ["誰が応募できる", /資格|応募/],
    ] as Array<[string, RegExp]>) {
      const 答 = 斷り(文);
      expect(答, `「${文}」が默つた`).toMatch(語);
    }
  });

  it("廣すぎる語尾を载せん – `もらう` は羣を乘取る（第 505 回の磁石）", () => {
    const i = 源.indexOf("const UI_WORD_TAILS_JA = [");
    const 語尾 = new Set(
      源
        .slice(i, 源.indexOf("];", i))
        .split("\n")
        .map((行) => (行.match(/^\s{4}"([^"]+)",$/) || [])[1] || "")
        .filter((語) => 語),
    );
    for (const 增し頭 of ["落とす", "設定", "取り込む", "開く", "見る", "どこで見る"]) {
      expect(語尾.has(增し頭), "動詞の頭「" + 增し頭 + "」が消えた").toBe(true);
    }
    /* 廣い助動詞を單體で载せると羣を乘取る（第 505 回の磁石 – 打ち方に現れる句だけは可、
     * `をもらう` のやうに前置が添つた形は舊來から在る）。*/
    for (const 廣 of ["もらう", "している", "られる", "なる"]) {
      expect(語尾.has(廣), "廣すぎる語尾を足さん: " + 廣).toBe(false);
    }
    /* 元データをもらう方法・ICS を読み込む方法 は默つた儘 – 噓の案内を立てん為の事實張り（第 466 回）。*/
    expect(斷り("元データをもらう方法"), "`もらう` で導きが廣がつた").toBe("");
    expect(斷り("ICS を読み込む方法"), "拉丁の頭を羣で受け始めた").toBe("");
  });

  it("既に答えの在つた羣を乘取らん（`アーカイブ` は第 516 回の當日の様子）", () => {
    for (const 文 of ["アーカイブ", "アーカイブはどこで見る", "録画視聴"]) {
      const 答 = 斷り(文);
      expect(答, `「${文}」が默つた`).toContain("録画");
      expect(答, `「${文}」が持ち出しの羣に奪られた`).not.toContain("CSV");
    }
    expect(源.match(/^\s{8}"アーカイブ",$/gm)?.length ?? 0, "`アーカイブ` が二つの羣に並んだ").toBe(
      1,
    );
    /* 語尾增しが檢索の道を作つて居らん事（第 362 回）。*/
    const rows = 收錄();
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["CCF", 2819],
      ["ics", 56],
    ] as Array<[string, number]>) {
      expect(当たり(rows, 語), `"${語}" の行數が變はつた`).toBe(見當);
    }
  });

  it("搜の文を食はせん – 打ち替へが在る打ち方には斷りを出さん（第 622 回）", () => {
    for (const 文 of [
      "オンライン参加できる会議",
      "機械学習の締切",
      "査読",
      "8月の締切",
      "9月22日",
    ]) {
      expect(当たり(收錄(), 文), `搜の文「${文}」が行を出さなくなつた`).toBeGreaterThan(0);
      expect(斷り(文), `「${文}」に斷りが乘つた`).toBe("");
    }
  });

  it("增やした料の語は收錄に行を持たん（噓の門 – 第 337 回）", () => {
    const rows = 收錄();
    for (const 語 of ["発表費用", "掲載費用", "投稿費用", "聴講料金", "誰が応募", "誰が参加"]) {
      expect(源.includes(`"${語}"`), `"${語}" が語表から消えた`).toBe(true);
      expect(当たり(rows, 語), `"${語}" に行が出るやうになつた`).toBe(0);
    }
  });

  it("讀み上げも同じ判斷を出す（六十字に納まる – 第 392 回）", () => {
    for (const 文 of ["カレンダーに落とす方法", "聴講料金はいくら", "誰が応募できる"]) {
      const 聲 = String(Recommender.uiWordLiveNoteJa(文, false) || "").trim();
      if (斷り(文) === "") continue;
      expect(聲, `「${文}」の讀み上げが默つた`).not.toBe("");
      expect(聲.length, `「${文}」の讀み上げが長い（${聲.length} 字）`).toBeLessThanOrEqual(60);
    }
  });
});
