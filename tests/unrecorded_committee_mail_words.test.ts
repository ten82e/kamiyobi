/**
 * 収録に無い話（運営の委員・メールの配達）を訪ねる語を载せた羣の檢査（SPEC §7・第 613 回）。
 * 實測（2026-08-09 生成の実ビルド 868 行・固定時刻 2026-08-09T00:00:00Z）で、百零一文の表の
 * まことの默り六文が此處に集まつて居た – `出版されますか` `招へい状の発行`
 * `PCメンバーになりたい` `招待される` `リマインドされる` `発表準備しています`。
 * 絕對の件數はビルドの品書で數へん（fixtures で組むので其の方の行が缺ける – 第 611 回の敎へ） –
 * 「收錄に無い」と斷る語は `data/snapshot.json` で 0 行である事を張り、斷りに引いた語は同じ
 * 來源で行が出る事を張る。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/** 収録の行（絕對の件數を數へる正本）。 */
function 収録(): Array<{ hay: string }> {
  const data = JSON.parse(
    readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(data) as unknown as Array<{ hay: string }>;
}
const 全 = 収録();
function 件(文: string): number {
  const 當たる = Recommender.searchMatcher(文, 基準);
  return 全.filter((row) => 當たる(String(row.hay)) === true).length;
}

describe("収録に無い話を訪ねる語（第 613 回）", () => {
  it("默つて居た六文が、打った語を名指して斷る", () => {
    const 文々: Array<[string, string]> = [
      ["出版されますか", "出版"],
      ["招へい状の発行", "招へい状"],
      ["PCメンバーになりたい", "PCメンバー"],
      ["招待される", "招待"],
      ["リマインドされる", "リマインド"],
      ["発表準備しています", "発表準備"],
    ];
    for (const [文, 語] of 文々) {
      const 案内 = Recommender.uiWordNoteJa(文);
      expect(案内, `斷りが無い: ${文}`).not.toBe("");
      expect(案内, `打った語を名指さん: ${文}`).toContain(`「${語}」`); // 第 388 回
      expect(Recommender.uiWordLiveNoteJa(文), `読み上げが缺いて居る: ${文}`).not.toBe("");
    }
  });

  it("載せた語は皆、収録で行を出さん – 噓の斷りを立たん（第 337 回）", () => {
    for (const 語 of [
      "出版",
      "招へい状",
      "発行",
      "PCメンバー",
      "プログラム委員会",
      "組織委員会",
      "運営委員会",
      "実行委員会",
      "セッションチェア",
      "オーガナイザー",
      "一般委員",
      "学生委員",
      "委員",
      "招待",
      "発表準備",
      "リマインド",
      "リマインダー",
      "催促",
      "通知メール",
      "メール配信",
      "再通知",
      "締切の連絡",
    ]) {
      expect(件(語), `この語は行を出すので「持っていません」とは言えん: ${語}`).toBe(0);
    }
  });

  it("メールの羣の斷りが絞り直し方に引く語は、實に行を出す", () => {
    const 案内 = Recommender.uiWordNoteJa("リマインド");
    for (const 語 of ["採択", "査読", "登録"]) {
      expect(件(語), `斷りに引いた語が行を持たん: ${語}`).toBeGreaterThan(0);
      expect(案内, `斷りが語を名指さん: ${語}`).toContain(語);
    }
    /* 畫面に出る品書（868 行）で實測した數を寫して居る – 註を書き換える時だけ觸る（第 535 回）。*/
    for (const 斷片 of [
      "『採択』（實測 129 行）",
      "『査読』（實測 13 行）",
      "『登録』（實測 7 行）",
    ]) {
      expect(案内, `斷りの實測値が崩れた: ${斷片}`).toContain(斷片);
    }
  });

  it("「通知」は實に在る語なので、メールの羣に载せん（第 337 回）", () => {
    expect(件("通知")).toBeGreaterThan(0);
    const 案内 = Recommender.uiWordNoteJa("通知");
    expect(案内, `行が出る語に「持っていません」を言わせた: ${案内}`).not.toContain(
      "はこの表が持っていません",
    );
  });

  it("導きだけの增し物 – 檢索の道は變はらん（第 362 回）", () => {
    /* 語尾に「になりたい」を足したが、之は導きの表なので檢索を廣げん。 */
    expect(件("PCメンバーになりたい")).toBe(0);
    expect(件("委員になりたい")).toBe(0);
    expect(件("リマインドされる")).toBe(0);
    /* 逆に、行が出る打ち方を導きの語で潰しても居らん。 */
    expect(件("採択")).toBeGreaterThan(0);
    expect(件("査読")).toBeGreaterThan(0);
  });

  it("新しい語は一つの家だけ持つ（第 512 回・第 246 回 – 二箇所に書くとズレる）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const j = 源.indexOf("\n  ];\n", i);
    expect(i).toBeGreaterThan(0);
    const 群 = 源.slice(i, j);
    for (const 語 of [
      "PCメンバー",
      "リマインド",
      "招へい状",
      "発表準備",
      "メール配信",
      "出版",
      "発行",
      "委員",
    ]) {
      expect(群.split(`"${語}",`).length - 1, `"${語}" を二つの羣に载せた`).toBe(1);
    }
    /* 「になりたい」は語尾の表に一度だけ（檢索側の敬語の語尾とは別の家 – 第 505 回）。 */
    const k = 源.indexOf("const UI_WORD_TAILS_JA");
    const l = 源.indexOf("\n  ];", k);
    expect(源.slice(k, l).split('"になりたい",').length - 1).toBe(1);
  });
});
