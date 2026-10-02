/**
 * 「まで」「から」で結ぶ訪ね方を讓りで導く（第 668 回）。
 *
 * 事實 – 打ち方の群 1,798 本を面の三つ（搜・讓り・打ち替え）で洗ふと、分野や手続きの名に `まで` を
 * 續けた形 **38 本**（`HPCまで` `スパコンまで` `ネットワークまで` `年度内までに` の類）が搜 0 行・
 * 打ち替え無し・讓り無しで、皆默つて居た（第 665 回・第 667 回の洗ひ）。`まで` も `から` も其の方で
 * 0 行の語（事實 `まで` 0 行・`から` 0 行 – 日にちと共にと打たれる語）なので、搜の侧で落とすと
 * 「何時までに」の話を靜かに廣げる事になる（第 362 回で禁じた形）。故に讓りで導く。
 *
 * 決まり三つ – ①**搜れる語を劝む**（前に残る語が 0 行なら黙る – 第 337 回）②**行が出る打ち手を
 * 説教せん**（`来月まで` 330 行・`今日まで` 34 行は此の枝に來ん）③**頭に日の語が立つ形は讓る**
 * （`年度内まで` `土曜日から` – 其の方は日にちに付いた形で、幅の語の切れ目を解く規則が別に在る –
 * 第 393 回・第 475 回。其處で「日にちに付く語なので絞り込めません」と書くと噓になる）。
 *
 * 效き – 默り 38 本が 21 本に減り（この家 26 本が立つ・他の讓りと重なる物 0 本）、搜の減りは 0。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

/** 搜 – 品書の行に當たる數（畫面の絞り込みと同じ述語）。 */
function 當(文: string): number {
  const matcher = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return 收錄().filter((行) => matcher(String(行.hay)) === true).length;
}

/** 讓り – 助詞で結ぶ羣の枝だけが何を言うか。 */
function 讓り(文: string): string {
  return String(Recommender.conjunctionQueryNoteJa(文, 當) || "").trim();
}

/** 他の讓り（欄の名前・羣の語・幅・表その物）が既に喋つて居るか。 */
function 他の讓り(文: string): string {
  return [
    String(Recommender.columnQueryNoteJa(文, (語) => 當(語) > 0) || ""),
    String(Recommender.uiWordNoteJa(文, false) || ""),
    String(Recommender.dayRangeNoteJa(文) || ""),
    String(Recommender.wholeTableQueryNoteJa(文) || ""),
  ]
    .join("")
    .trim();
}

describe("「まで」「から」で結ぶ訪ね方（第 668 回）", () => {
  it("搜 0 行に、其の語だけの件數と日にちを添う例を出す", () => {
    for (const 文 of [
      "HPCまで",
      "AIまでに",
      "スパコンまで",
      "ネットワークまで",
      "セキュリティまで",
      "機械学習まで",
      "組み込みまで",
      "データベースまで",
      "分散システムまで",
      "通信まで",
      "OSまで",
      "HPCから",
      "セキュリティから",
    ]) {
      expect(當(文), 文).toBe(0);
      const 前 = 文.replace(/(までに|まで|から)$/, "");
      expect(當(前), 前).toBeGreaterThan(0); // 搜れん語を劝まん（第 337 回）
      const 注 = 讓り(文);
      expect(注, 文).toContain("日にちに付く語");
      expect(注, 文).toContain(`「${前}」を書く行を ${當(前)} 件`); // 實數をそのまま書く
      expect(他の讓り(文), 文).toBe(""); // 二つの話を並べん（第 330 回）
    }
  });

  it("搜れる打ち手と、其の方の規則が受ける形は説教せん（第 337 回）", () => {
    for (const 文 of [
      "来月まで",
      "今月まで",
      "8月まで",
      "9月までに",
      "今日まで",
      "年度内に",
      "来週から",
      "明日から",
    ])
      expect(當(文), 文).toBeGreaterThan(0);
    for (const 文 of ["来月まで", "今日まで", "年度内に", "来週から", "明日から"])
      expect(讓り(文), 文).toBe("");
  });

  it("頭に日の語が立つ形は讓る – 幅の規則が受ける（第 393 回・第 475 回）", () => {
    for (const 文 of [
      "年度内まで",
      "年度内までに",
      "年内から",
      "平日から",
      "土曜日から",
      "日曜日から",
      "今月末まで",
    ])
      expect(讓り(文), 文).toBe("");
  });

  it("搜れん語を續けた形は默る（第 337 回）", () => {
    for (const 文 of [
      "ソナーまで",
      "記憶装置まで",
      "演算まで",
      "フガフガまで",
      "まで",
      "から",
      "それまで",
    ])
      expect(讓り(文), 文).toBe("");
  });

  it("note が勸める日にちの例は總て行が出る（第 337 回）", () => {
    let 數 = 0;
    for (const 文 of ["HPCまで", "AIから", "スパコンまでに", "機械学習まで", "通信まで"]) {
      const m = /期間で絞るなら「(.+?)」（([0-9,]+) 件）/.exec(讓り(文));
      expect(m, 文).not.toBeNull();
      const 例 = String(m?.[1]);
      expect(當(例), 例).toBe(Number(String(m?.[2]).replace(/,/g, "")));
      expect(當(例), 例).toBeGreaterThan(0);
      數 += 1;
    }
    expect(數).toBe(5);
  });

  it("搜れる打ち方には觸れん – 假の件數で門を確かめる（第 337 回）", () => {
    /* 收錄では `まで` を續けた形が全て 0 行なので、この門は実データでは踏めん – 假の件數で張る
     * （面の振ひで讓り 增 26 本・書き換 0 本と確かめた效きと併せ持つ）。*/
    const 假 = (文: string) => (文 === "架空まで" ? 5 : 文 === "架空" ? 7 : 0);
    expect(String(Recommender.conjunctionQueryNoteJa("架空まで", 假) || "").trim()).toBe("");
    /* 門を通つた後の形（搜 0 行）だけが喋る – 同じ假の表で確かめる。*/
    const 假2 = (文: string) => (文 === "架空まで" ? 0 : 文 === "架空" ? 7 : 0);
    expect(String(Recommender.conjunctionQueryNoteJa("架空まで", 假2) || "")).toContain(
      "日にちに付く語",
    );
  });

  it("收錄の品書は 3,250 行 – 搜の土臺を壞して居ん", () => {
    expect(收錄().length).toBe(3250);
  });
});
