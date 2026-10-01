/**
 * 案内が名指す道は本物か（第 652 回 – 橫断檢査）。
 *
 * 斷まりの文は「畫面のこの物を見てください」「こんな風に打ってください」と**道の名を挙げる**
 * （『開催地』『データ源』『過去の締切も表示』『1月から7月』…）。其の名が**切れて居れば**、
 * 訪ねて来た人は言ひ通りに打っても何も出ず、畫面を探しても其の物は無い – 案内が噓に成る。
 * 第 338 回に一度同じ形の缺陷を直した（檢査が「案内が名指した幅が行を持たない」を張つた）が、
 * また張つて居るのは個々の家だけだつた。第 652 回に全羣を通すと、**七十三羣が名指す 106 種の內
 * 二種が切れて居た** –
 *  ・『会場はどこ』 – 案内の例として挙げられて居るのに、打ち手は 0 行・案内も立たなんだ
 *    （語の門 `会場` → 『開催地』は通るが、後ろが「はどこ」一語分合わんの為 – 語尾の表に
 *    「どこ」は在つて「はどこ」が無くた）。`tests/…venue…` の斷りも同じ例を聲で讀んで居た。
 *    → 語尾に「はどこ」「はどちら」を足して直した（実測 – `会場はどこ` `会場はどちら`
 *      `参加形式はどこ` `地域はどこ` `分野はどこ` が立つた – 五つの打ち手が一度に開いた）。
 *  ・『年末年始』 – 祝日の斷りが「夫々引けます」と例に挙げる語で、其の方では絞れん話が本文に
 *    書いて在るので生きて居る（0 行だが案内が立つ – ここに事實として張る）。
 *
 * 檢査は
 *  ① 全羣の斷り・讀み上げから『…』を數へて 100 種以上を読む（目が細つたら落ちる – 第 651 回）、
 *  ② 名指した物が生きて居る事を張る（**畫面の實物**か、**打つと行が出る**か、**打つと案内が立つ**か）、
 *  ③ 第 652 回に開いた五つの打ち手が列訪ねの家に屆く事、
 *  ④ 磁石が崩れて居らん事（第 337 回）
 * を張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
const 畫面 = [join(builtSite(), "app.js"), join(builtSite(), "index.html")].map((f) =>
  readFileSync(f, "utf8"),
);

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}

function 当たり(打ち方: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(打ち方, AT), AT);
  return 收錄().filter((r) => m(String(r.hay)) === true).length;
}

/** 畫面が立てる讓り（app.ts と同じ順 – 列訪ね → 羣 → 日数 → 全行）。 */
function 讓り(打ち方: string): string {
  /* app.ts と同じ入力 – 「その値が行に当たるか」を渡す（渡さんはぐつかの讓りが立たない – 實測）。*/
  const 列 = String(Recommender.columnQueryNoteJa(打ち方, (語: string) => 当たり(語) > 0) || "");
  if (列) return 列;
  const 羣 = String(Recommender.uiWordNoteJa(打ち方, false) || "");
  if (羣) return 羣;
  return (
    String(Recommender.dayRangeNoteJa(打ち方) || "") +
    String(Recommender.wholeTableQueryNoteJa(打ち方) || "")
  );
}

/** 羣の斷り・讀み上げが名指す『…』を數へる（第 651 回と同じ眼 – 源の文字每に讀む）。 */
function 名指し(): Map<string, string> {
  const 始 = 源.indexOf("const UI_WORD_GROUPS_JA");
  const 本 = 源.slice(始, 源.indexOf("\n  ];", 始));
  const 出 = new Map<string, string>();
  for (const m of 本.matchAll(/(note|live):\s*"((?:[^"\\]|\\.)*)"/g)) {
    for (const q of m[2].matchAll(/『([^』]{2,26})』/g)) if (!出.has(q[1])) 出.set(q[1], m[1]);
  }
  return 出;
}

describe("案内が名指す道は本物か（第 652 回）", () => {
  it("全羣が名指す物を 100 種以上數へる（目が細つたら落ちる）", () => {
    const 名 = 名指し();
    expect(名.size, "讀める名が少なすぎる").toBeGreaterThanOrEqual(100);
  });

  it("名指した物は畫面の實物か、打てば行が出るか、打てば讓りが立つ（切れて居たら噓）", () => {
    const 切 = [...名指し().keys()].filter((名) => {
      const 素 = 名.replace(/（[^）]*）/g, "").trim();
      if (!素 || 素.length < 2) return false;
      if (畫面.some((本) => 本.includes(素))) return false; /* 畫面に其の物が在る */
      if (当たり(素) > 0) return false; /* 打つと行が出る */
      return 讓り(素).trim() === ""; /* 打つと讓りが立つ */
    });
    expect(
      切.map((名) => `『${名}』`).join("・"),
      "案内が名指す道が切れて居る（其の通りに打つも何も出ん – 第 338 回と同じ形）",
    ).toBe("");
  });

  it("『会場はどこ』『年末年始』は 0 行だが讓りが立つ（第 652 回に開いた・事實として張る）", () => {
    for (const 打ち方 of ["会場はどこ", "年末年始"]) {
      expect(当たり(打ち方), `"${打ち方}" に行が出るやうになつた`).toBe(0);
      expect(讓り(打ち方).trim(), `「${打ち方}」の讓りが消えた`).not.toBe("");
    }
  });

  it("『欄はどこ？』の聽き方を通した（語尾に「はどこ」「はどちら」 – 第 652 回）", () => {
    const 始 = 源.indexOf("const 剥ぐ語尾 = [");
    const 尾 = 源.slice(始, 源.indexOf("\n      ];", 始));
    const 受入 = new Set([...尾.matchAll(/^\s{6}"([^"]+)",$/gm)].map((m) => m[1]));
    for (const 語尾 of ["はどこ", "はどちら"]) {
      expect(受入.has(語尾), `語尾「${語尾}」が消えた（五つの打ち手が默る）`).toBe(true);
    }
    const 家 = new Map<string, string>();
    for (const 打ち方 of [
      "会場はどこ",
      "会場はどちら",
      "参加形式はどこ",
      "地域はどこ",
      "分野はどこ",
      "開催場所は",
      /* 第 652 回に欄の語へ別名として足した物（其の方を置かんと默る – 語の表は完全一致の為）。*/
      "会場名はどこ",
      "開催都市はどこ",
    ]) {
      const 讓 = 讓り(打ち方);
      expect(讓, `「${打ち方}」が默つた`).not.toBe("");
      家.set(打ち方, 讓.includes("欄") ? "欄" : 讓.includes("チップ") ? "チップ" : "未分類");
    }
    expect(
      [...家.values()].filter((v) => v === "欄").length,
      "列訪ねの家に屆いた打ち手が少ない",
    ).toBe(8);
  });

  it("磁石は崩れん（語尾增しが行の數を作つたり奪つたりして居らん – 第 337 回）", () => {
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
      ["ics", 56],
      ["延長", 36],
      ["開催地", 298],
    ] as Array<[string, number]>) {
      expect(当たり(語), `"${語}" の行數が變はつた`).toBe(見當);
    }
  });
});
