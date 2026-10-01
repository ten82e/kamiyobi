/**
 * データの出所・持ち出し・寫し方・分野の一覽を、其の物の名で聞く人（第 649 回）。
 * 實測（2026-08-09 生成の品書 3,250 行・固定時刻 2026-08-09T00:00:00Z）– 之れ等は**0 行で案内も無し**
 * だつた（同じ話を答へる羣は既に在つたのに、語表に其の名が無く門を閉れたまま）。
 *  · 出所 – `どこから取った` `誰が管理` `裏取り`（`出典` `出所` `データ源` は通る）
 *  · 持ち出し – `元データ` `生ファイル` `取り込み` `表計算に貼る`（`ダウンロード` `エクスポート` は通る）
 *  · 寫し方 – `表をコピー` `行をコピー` `印刷した版` `紙で出す`（`印刷` `コピー` は通る）
 *  · 分野 – `分野の一覧` `どんな分野` `カテゴリの一覧`（`収録範囲` `対象分野` は別の羣が受ける）
 * 檢査は
 *  ① 新しい語が**一つも收錄に行を持たん**事（噓の門 – 第 337 回）、
 *  ② 各羣の斷りが**實際の物**（ページ下の『データ源』・一覧の下の CSV/JSON・ブラウザの印刷・
 *     画面の上の『分野』のチップ）を名指す事、
 *  ③ 斷りの「九種」がデータの分野表と**同じ數**である事（數字を實物に結ぶ – 第 337 回の実發生）、
 *  ④ 収録範囲の羣を乘取らん事（第 511 回）、
 *  ⑤ 磁石の行數、⑥ 讀み上げの長さ
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

/** 源の語表から讀む（檢査側に寫しを置くとズレる – 第 392 回）。*/
function 羣の語(印: string): string[] {
  const i = 源.indexOf(印);
  expect(i, `語表に「${印}」が在ん（源の書き變へ）`).toBeGreaterThan(-1);
  const 先 = 源.lastIndexOf("words: [", i);
  const 後 = 源.indexOf("]", i);
  return 源
    .slice(先, 後)
    .split("\n")
    .map((行) => (行.match(/^\s*"([^"]+)",$/) || [])[1] || "")
    .filter((語) => 語);
}

const 出所の語 = [
  "どこから取った",
  "どこからとった",
  "何処から取った",
  "誰が管理",
  "誰が管理している",
  "裏取り",
];
const 持出の語 = ["元データ", "生ファイル", "取り込み", "表計算に貼る", "機械向け"];
const 寫しの語 = ["表をコピー", "行をコピー", "印刷した版", "紙で出す"];
const 分野の語 = 羣の語('"分野の一覧"');

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

describe("出所・持ち出し・寫し方・分野の別の名前（第 649 回）", () => {
  it("新しい語が源の語表に在る（手を當てた跡の見張り）", () => {
    for (const 組 of [出所の語, 持出の語, 寫しの語]) {
      for (const 語 of 組) {
        expect(源.includes(`"${語}"`), `"${語}" が語表から消えた`).toBe(true);
      }
    }
    expect(分野の語.length, "分野の羣が讀めない").toBeGreaterThanOrEqual(8);
  });

  it("新しい語は一つも收錄に行を持たん（噓の門 – 第 337 回）", () => {
    const rows = 收錄();
    for (const 語 of [...出所の語, ...持出の語, ...寫しの語, ...分野の語]) {
      expect(当たり(rows, 語), `"${語}" に行が出るやうになつた`).toBe(0);
    }
  });

  it("斷りが實際の物を名指す（畫面上の所在を言ふ – 第 466 回の実發生の流儀）", () => {
    for (const 文 of [...出所の語, "どのサイトの話", "データの出所を確かめたい"]) {
      expect(斷り(文), `出所の「${文}」が默つた`).toContain("データ源");
    }
    for (const 文 of [...持出の語, "元データが欲しい", "カレンダー購読の方法"]) {
      expect(斷り(文), `持ち出しの「${文}」が默つた`).toMatch(/CSV|data\.json|\.ics/);
    }
    for (const 文 of [...寫しの語, "表をコピーできる"]) {
      expect(斷り(文), `寫しの「${文}」が默つた`).toContain("印刷");
    }
    for (const 文 of [...分野の語, "どんな分野を扱ってる", "分野はどこを見れば"]) {
      expect(斷り(文), `分野の「${文}」が默つた`).toContain("チップ");
    }
  });

  it("斷りの「九種」がデータの分野表と同じ數である事（數字を實物に結ぶ）", () => {
    const 實 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"));
    const 種 = Object.keys(實.categories || {}).length;
    expect(種, "snapshot の分野表が讀めない").toBeGreaterThan(4);
    const 數字 = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
    expect(斷り("分野の一覧"), "斷りの分野の數が實物とズレた").toContain(`${數字[種 - 1] || 種}種`);
  });

  it("収録範囲の羣を乘取らん（其の方は件數と『見方のてびき』を答へる – 第 511 回）", () => {
    for (const 文 of ["収録範囲", "対象分野", "何を収録してる"]) {
      const 答 = 斷り(文);
      expect(答, `「${文}」が默つた`).not.toBe("");
      expect(答, `「${文}」が新しい分野の羣に奪られた`).not.toContain("チップ");
    }
    /* 空格で並べた打ち手も同じ斷り（multiword の印 – 第 354 回）。*/
    expect(斷り("分野の一覧 チップ")).toContain("チップ");
  });

  it("磁石は狹まつて居らん – 通つて居る打ち手の行數は舊來の侬", () => {
    const rows = 收錄();
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
      ["ics", 56],
      ["概要締切", 660],
      ["延長", 36],
    ] as Array<[string, number]>) {
      expect(当たり(rows, 語), `"${語}" の行數が變はつた`).toBe(見當);
    }
    /* `ics` は行を出す語 – だから語表に載せない（56 行 – 第 337 回・第 364 回）。*/
    expect(羣の語('"フィード"')).not.toContain("ics");
  });

  it("讀み上げも同じ判斷を出す（六十字に納まる – 第 392 回）", () => {
    const 聲 = String(Recommender.uiWordLiveNoteJa("どんな分野を扱ってる", false) || "").trim();
    expect(聲, "讀み上げが默つた").not.toBe("");
    expect(聲.length, `讀み上げが長すぎる（${聲.length} 字）`).toBeLessThanOrEqual(60);
    expect(斷り("どこから取った")).not.toBe("");
    /* 明かない穴を事實のまま張る – 語の後ろに別の語が續く形は、この羣が語尾を問わん印を
     * 開いて居らんので默る（第 648 回で判つた仕組み。開くのは次の仕事）。*/
    expect(斷り("カレンダーに落とす方法")).toBe("");
  });
});
