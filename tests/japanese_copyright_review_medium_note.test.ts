/** 著作権・審査の方式・締切の後を**其の方の名前で**打つ人の讓りの檢査（SPEC §7・第 671 回）。
 *
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行）– `オープンアクセス` `ダブルブラインド` `滑り込み`
 * `日本語` `研究倫理` `非会員` `論文集` は羣の斷りを受けるのに、同じ事を別の名で打つ十六語は搜 0 行・
 * 打ち替え無し・讓り無しで面の三つが皆默つて居た。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（3,250 行）で張る – fixtures の品書だと讓りの当たりが別物になる為。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
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
/** 斷りの復唱の後の文（羣は打ち手を先頭に置く – echo – 第 670 回と同じ張り方）。 */
function 後尾(文: string): string {
  const x = 讓り(文);
  return x.slice(x.indexOf("」") + 1);
}

/** 此の回に羣へ载せた打ち手（搜 0 行で讓りも無かつた十六語）。 */
const 载せた = [
  "著作権",
  "著作権移譲",
  "ライセンス",
  "クローズドアクセス",
  "名乗り査読",
  "レビュー形式",
  "reciprocal reviewing",
  "遅れて提出",
  "セカンドチャンス",
  "ラストミニット",
  "英語で書く",
  "IRB",
  "同意書",
  "DVD",
  "USB",
  "入会",
];

/** 先に讓りの出て居た隣（同じ羣の斷りを受けたい組）。 */
const 對 = [
  ["オープンアクセス", "著作権"],
  ["オープンアクセス", "クローズドアクセス"],
  ["ダブルブラインド", "名乗り査読"],
  ["匿名査読", "レビュー形式"],
  ["ブラインド審査", "reciprocal reviewing"],
  ["滑り込み", "遅れて提出"],
  ["間に合わない", "セカンドチャンス"],
  ["間に合わない", "ラストミニット"],
  ["日本語", "英語で書く"],
  ["研究倫理", "IRB"],
  ["研究倫理", "同意書"],
  ["論文集", "入会"],
  ["論文集", "DVD"],
  ["論文集", "USB"],
] as const;

describe("著作権・審査の方式・締切の後を別の名で打つ人", () => {
  it("载せた語は搜 0 行の侬で斷りを受ける（噓の案内を立たん – 第 337 回）", () => {
    for (const 語 of 载せた) {
      expect(當(語), `"${語}" が行を持つやうに廣がつた`).toBe(0);
      expect(讓り(語).length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
    }
  });

  it("隣と同じ羣の斷りを受ける（言葉の違いで案内が割れん – 第 671 回）", () => {
    for (const [先, 新] of 對) {
      expect(讓り(先).length, `先に在つた "${先}" の斷りが消えた`).toBeGreaterThan(0);
      expect(後尾(新), `"${新}" の斷りが "${先}" と別の羣`).toBe(後尾(先));
    }
  });

  it("打ち替えと同じ語に兩方喋らん（第 330 回）", () => {
    for (const 語 of 载せた) {
      const chip = Recommender.shorterHitWordsJa(語, hays, AT) || [];
      expect(chip.length, `"${語}" は打ち替えと讓りの両方が出て居る`).toBe(0);
    }
  });

  it("語尾を連れた形も受ける（`著作権移譲は` `同意書の提出` – 第 671 回）", () => {
    for (const 文 of [
      "著作権移譲は",
      "ライセンスの問題",
      "レビュー形式は",
      "遅れて提出します",
      "ラストミニットの締切",
      "IRBの申請",
      "同意書の提出",
      "DVDで届く",
      "入会しないと",
    ]) {
      expect(當(文), `"${文}" が行を持つやうに廣がつた`).toBe(0);
      expect(讓り(文).length, `"${文}" が無言に逆戻りした`).toBeGreaterThan(0);
    }
  });

  it("註を縮めた規則が其の侬効いて居る（第 315 回と第 517 回 – 搜の侧）", () => {
    /* 此の回は二つの註の數字を SPEC.md へ寫した。搜の規則その物は觸つて居ない證左。*/
    expect(當("7日以内")).toBe(206);
    expect(當("30日以内")).toBe(689);
    expect(當("デモ締切")).toBe(7);
    expect(當("抄録提出")).toBe(3);
    /* 搜れる語を羣に载せ替へた證左 – 讓りが二重に出たり、搜が廣がらん。*/
    expect(當("multimedia")).toBe(69);
    expect(當("データベース登録")).toBe(1);
  });

  it("搜の当たり數は此の回、一つも減つて居らん（第 670 回からの實測金庫）", () => {
    const 金庫: Record<string, number> = {
      オープンアクセス: 0,
      ダブルブラインド: 0,
      匿名査読: 0,
      ブラインド審査: 0,
      滑り込み: 0,
      間に合わない: 0,
      日本語: 0,
      英語のみ: 0,
      研究倫理: 0,
      非会員: 0,
      論文集: 0,
      索引: 0,
      ハイブリッド: 109,
      延長: 36,
      カメラレディ: 147,
      来月まで: 330,
      "8月": 600,
      人工知能: 1072,
      締切: 2886,
    };
    for (const [文, 數] of Object.entries(金庫)) {
      expect(當(文), `搜の当たり數が變た: ${文}`).toBe(數);
    }
  });

  it("品書は 3,250 行 – 搜の土臺を壞して居ん", () => {
    expect(rows.length).toBe(3250);
  });
});
