/** 出欠・原稿・合否を**和語や道具の名で**打つ人の讓りの檢査（SPEC §7・第 670 回）。
 *
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行）– 「キャンセル」「返金」「録画」「ページ数」
 * 「不採択」「何時」は羣の斷りを受けるのに、同じ事を和語や道具の名で打つ人は搜 0 行・打ち替え
 * 無し・讓り無しで面の三つが皆默つて居た（`欠席` `不参加` `払い戻し` `取り消し` `レシート`
 * `zoom` `ズーム` `見逃し` `何分` `書式` `フォーマット` `最大ページ` `原稿の長さ` `スコア`
 * `却下` `落ちた` `タイムゾーン` `索引` `Invoice`）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（3,250 行）で張る – fixtures の品書だと讓りの当たりが別物になる為。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8")),
  ) as Row[];
}
const rows = 品書();
const hays = rows.map((r) => String(r.hay));
function 當(文: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return rows.filter((r) => m(String(r.hay)) === true).length;
}
/** 畫麵と同じ順で讓りを再現する（site/app.ts – 欄の名前 → 語の斷り → 日の幅 → 寄せ表 → 助詞）。 */
function 讓り(文: string): string {
  return String(
    Recommender.columnQueryNoteJa(文, (語) => 當(語) > 0) ||
      Recommender.uiWordNoteJa(文, false) ||
      Recommender.dayRangeNoteJa(文) ||
      Recommender.wholeTableQueryNoteJa(文) ||
      Recommender.conjunctionQueryNoteJa(文, 當) ||
      "",
  ).trim();
}
/** 斷りを復唱の後で較べる為の後尾（羣は打ち手を先頭に置く – echo）。 */
function 後尾(文: string): string {
  const x = 讓り(文);
  return x.slice(x.indexOf("」") + 1);
}

/** 此の回に羣へ载せた打ち手（搜 0 行で讓りも無かつた語 – 十九語）。 */
const 载せた = [
  "欠席",
  "不参加",
  "払い戻し",
  "取り消し",
  "レシート",
  "Invoice",
  "zoom",
  "ズーム",
  "見逃し",
  "何分",
  "書式",
  "フォーマット",
  "最大ページ",
  "原稿の長さ",
  "スコア",
  "却下",
  "落ちた",
  "タイムゾーン",
  "索引",
];

/** 其の方が既に持つ物の隣（和語 ↔ 英語・略し方）で、同じ羣の斷りを受けたい組。 */
const 對 = [
  ["返金", "払い戻し"],
  ["領収書", "レシート"],
  ["キャンセル", "取り消し"],
  ["録画", "zoom"],
  ["録画", "ズーム"],
  ["オンデマンド", "見逃し"],
  ["ページ数", "書式"],
  ["ページ数", "フォーマット"],
  ["持ち時間", "何分"],
  ["発表番号", "索引"],
  ["不採択", "却下"],
  ["何時", "タイムゾーン"],
] as const;

describe("出欠・原稿・合否を和語で打つ人", () => {
  it("载せた語は搜 0 行の侬で斷りを受ける（噓の案内を立たん – 第 337 回）", () => {
    for (const 語 of 载せた) {
      expect(當(語), `"${語}" が行を持つやうに廣がつた`).toBe(0);
      expect(讓り(語).length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
    }
  });

  it("隣の打ち手と同じ羣の斷りを受ける（言葉の違いで行が割れん – 第 670 回）", () => {
    for (const [先, 新] of 對) {
      expect(讓り(先).length, `先に在つた "${先}" の斷りが消えた`).toBeGreaterThan(0);
      expect(後尾(新), `"${新}" の斷りが "${先}" と別の羣`).toBe(後尾(先));
    }
  });

  it("斷りが噓を言はん – 収録する物の名を每個に書く", () => {
    for (const 語 of 载せた) {
      const 文 = 讓り(語);
      /* 羣の斷りは「収録するのは…」で始まる家（第 332 回 – 默つても噓でもいかん）。
       * 聞く事への答えなので、收錄の欄の名前を一つは必ず持つ。*/
      expect(
        ["締切", "日", "分野", "種別", "開催地", "参加形式", "公式ページ", "会議"].some((欄) =>
          文.includes(欄),
        ),
        `"${語}" の斷りに収録する物の名が無い: ${文.slice(0, 30)}`,
      ).toBe(true);
    }
  });

  it("打ち替えと同じ語に喋らん（默つて二つの話をするな – 第 330 回）", () => {
    for (const 語 of ["欠席", "zoom", "書式", "スコア", "索引", "却下"]) {
      const chip = Recommender.shorterHitWordsJa(語, hays, AT) || [];
      expect(chip.length, `"${語}" は打ち替えと讓りの両方が出て居る`).toBe(0);
    }
  });

  it("搜れる語は羣に混ぜん – `データベース登録` は行が在る（第 670 回）", () => {
    /* 载せ樣としたが事實は 1 行出た（行に其のまま書かれて居る）。搜れる打ち手に「持って
     * 居らん」と書くと噓になるので引いた（第 337 回）。*/
    expect(當("データベース登録")).toBeGreaterThan(0);
    expect(讓り("データベース登録")).toBe("");
    const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 群 = 源.slice(0, 源.indexOf("const UI_WORD_TAILS_JA"));
    expect(群.includes('"データベース登録"'), "搜れる語を羣に載せた").toBe(false);
  });

  it("搜の当たり數は此の回、一つも減つて居らん（第 669 回の実測金庫）", () => {
    const 金庫: Record<string, number> = {
      ハイブリッド: 109,
      オンライン参加: 109,
      遠隔参加: 109,
      EasyChair: 58,
      データベース登録: 1,
      延長: 36,
      カメラレディ: 147,
      来月まで: 330,
      "8月": 600,
      人工知能: 1072,
      座長: 0,
      招待講演: 0,
      締切: 2886,
    };
    for (const [文, 數] of Object.entries(金庫)) {
      expect(當(文), `搜の当たり數が變た: ${文}`).toBe(數);
    }
  });

  it("語尾を連れた打ち方も受ける（`欠席の連絡` `zoomの会議` – 第 670 回）", () => {
    for (const 文 of [
      "欠席の連絡",
      "書式は",
      "フォーマットは",
      "スコアの公開",
      "索引されますか",
      "zoomの会議",
      "タイムゾーンは",
      "払い戻しは",
      "原稿の長さは",
      "何分の発表",
    ]) {
      expect(當(文), `"${文}" が行を持つやうに廣がつた`).toBe(0);
      expect(讓り(文).length, `"${文}" が無言に逆戻りした`).toBeGreaterThan(0);
    }
  });

  it("品書は 3,250 行 – 搜の土臺を壞して居ん", () => {
    expect(rows.length).toBe(3250);
  });
});
