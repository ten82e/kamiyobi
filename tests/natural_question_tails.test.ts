import { queryReferenceSnapshotPath } from "./query_reference.ts";
/**
 * 助詞が一枚挟まつた問ひ・言ひ換へを受けるやうにした回の檢査（第 620 回）。
 *
 * 實測（2026-08-09 生成の実ビルド・固定時刻 2026-08-09T00:00:00Z・品書 868 行）で、
 * 研究者が打ちさうな自然な文 41 本の内 **24 本が 0 件かつ案内も無し**（まことの默り）だつた。
 * 原因は二つ –
 *   ① 羣の語に其の言ひ方が無い（`A0かA1か` `コレスポンディングオーサー` `お金` `発表費` `代理` …）
 *   ② 語尾を**完全一致でしか**見ず、助詞が一つ增える每に切れる
 *     （`招待状は発行してもらえますか` → 語尾「は発行してもらえますか」が白一覧に無い）
 * 畫面は当たり數 0 の時だけ案内を立てる（`site/app.ts` の `matchedRows === 0` の門）ので、
 * 語尾を緩くしても行が出る打ち方に被らない – 其を下の檢査で張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  );
}
function 収録(): Array<{ hay: string }> {
  return Recommender.candidateRows(JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")));
}
function 件数(列: Array<{ hay: string }>, 語: string): number {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 列.filter((r) => 当(String(r.hay)) === true).length;
}

describe("第 620 回 – 投稿の合否・寸法・役と、助詞が一枚挟まる問ひ", () => {
  it("五つの默りが同じ家族の言葉を名指して開く", () => {
    const 見 = [
      ["A0かA1か", "原稿の書式"],
      ["査読付き論文のみ", "審査の方式"],
      ["コレスポンディングオーサー", "著者や発表者の役"],
      ["採択されたか確認する", "採否の結果が分かる日"],
      ["採否の判定は誰がする", "採否の結果が分かる日"],
    ] as const;
    for (const [文, 含まれる語] of 見) {
      const 注 = String(Recommender.uiWordNoteJa(文) || "");
      expect(注, `"${文}" が默つたまま`).not.toBe("");
      expect(注, `"${文}" の斷りが打ち方を名指して居らん`).toContain("「");
      expect(注, `"${文}" の斷りが「${含まれる語}」を言わない`).toContain(含まれる語);
    }
  });

  it("払い・代理・義務の言ひ換へも同じ門を通る", () => {
    const 文 = [
      "お金はいりますか",
      "費用はいりますか",
      "参加費はいりますか",
      "聴講料はいりますか",
      "発表費はいりますか",
      "掲載料はいりますか",
      "招待状は発行してもらえますか",
      "ISSN は取っていますか",
      "リビューの返事はいつですか",
      "寸法は選べますか",
    ];
    for (const q of 文) {
      const 注 = String(Recommender.uiWordNoteJa(q) || "");
      expect(注, `"${q}" が默つたまま`).not.toBe("");
      expect(注).toContain("この表");
    }
  });

  it("足した語は其のままでは一行も絞らん（行が出る語を斷らん – 第 337 回）", () => {
    const 品 = 品書(),
      収 = 収録();
    for (const 語 of [
      "A0",
      "A1",
      "B0",
      "寸法",
      "判型",
      "サイズ",
      "お金",
      "発表費",
      "投稿費",
      "代理",
      "ISSN",
      "リビュー",
      "コレスポンディング",
      "コレスポンディングオーサー",
      "採択された",
      "採否の判定",
    ]) {
      expect([語, 件数(収, 語)], `"${語}" は収録で行が出る`).toEqual([語, 0]);
      expect([語, 件数(品, 語)], `"${語}" は品書で行が出る`).toEqual([語, 0]);
    }
  });

  it("其の語で絞れる物は斷られん（カメラレディ・プロシーディングス・原稿・査読・採択）", () => {
    const 収 = 収録();
    /* 品書（868 行）で無く収録（3,250 行）を張る – 檢査用のビルドは fixture を使うので
     * 実配場の行数は此こちらで正とする（第 617 回に記錄した二つの書の區別）。*/
    const 實測: Record<string, number> = {
      カメラレディ: 147,
      プロシーディングス: 3,
      原稿: 3,
      査読: 32,
      採択: 240,
      ポスター: 4,
    };
    for (const [語, 行] of Object.entries(實測)) {
      expect([語, 件数(収, 語)], `"${語}" の収録の行数が動いた`).toEqual([語, 行]);
      expect(String(Recommender.uiWordNoteJa(語) || ""), `"${語}" に斷りが被つた`).toBe("");
    }
  });

  it("挟みの門 – 磁石・空格・字數の壁は舊來通り（第 503・250・354 回）", () => {
    /* 助詞を含まん漢字の連なり（`参加費対効果分析ですか`）は語尾と數へん。 */
    expect(
      String(Recommender.uiWordNoteJa("参加費対効果分析ですか") || ""),
      "漢字の連なりを語尾に數へた",
    ).toBe("");
    /* 磁石の點検 – `リアル` は主題の語の頭に成れる（第 503 回で彈いた）。緩めた門でも默る。 */
    expect(
      String(Recommender.uiWordNoteJa("リアルタイム処理は要りますか") || ""),
      "磁石を拾つた",
    ).toBe("");
    /* 値を並べた打ち手（空格を跨ぐ）は舊來の決まりが勝つ（第 513 回が彈いた例）。 */
    expect(
      String(Recommender.uiWordNoteJa("過去の締切 関西") || ""),
      "値の並びに斷りを被せた",
    ).toBe("");
    expect(String(Recommender.uiWordNoteJa("会場 京都") || ""), "値の並びに斷りを被せた").toBe("");
    /* 字數の壁は十六字から廿四字に上げた（第 621 回 – 語尾の門が續き十五字までしか
     * 受けんので、上げても亂れん）。十七字の此れは舊來默つて居たが、今は語の門が受ける。 */
    const 長 = "プレプリントを出しても大丈夫ですか";
    expect([...長].length).toBe(17);
    expect(String(Recommender.uiWordNoteJa(長) || "")).toContain("プレプリント");
    /* 六字の壁 – 廿五字を越えると語の門は默り、打ち直しの形が受ける（第 621 回）。 */
    const 最長 = "査読付きの国際会議で日本で開催される物はありますか";
    expect([...最長].length).toBe(25);
    expect(String(Recommender.uiWordNoteJa(最長) || "")).toContain("長い文のままでは絞れません");
    /* 六字までの挟みは通る（`招待状は発行してもらえますか` の挟みは五字）。 */
    expect(String(Recommender.uiWordNoteJa("招待状は発行してもらえますか") || "")).toContain(
      "招待状",
    );
  });

  it("檢索の側は廣げて居らん（第 362 回 – 案内だけ直した）", () => {
    const 収 = 収録();
    expect(収.length, "収録の行總數が動いた").toBe(3250);
    expect(件数(収, "査読"), "査読の行數が動いた").toBe(32);
    expect(件数(収, "採択"), "採択の行數が動いた").toBe(240);
    expect(件数(収, "オンライン参加可"), "印の行數が動いた").toBe(109);
    expect(件数(収, "camera ready"), "camera ready の行數が動いた").toBe(147);
  });
});
