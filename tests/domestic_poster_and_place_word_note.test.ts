/**
 * 行き止まりの日本語を、収録が実際に使う語へ寄せる（第 686 回）。
 *
 * 實測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、次の語は**0 行で
 * 案内も無し**だつた – `国内学会` `ボスター` `ロングペーパー` `開催期間` `どこ` `どこで`
 * `どこで開催` `大学院生` `博士学生` `学部学生` `奨学金` `参加支援` `参加費補助`
 * `トップカンファレンス` `難関` `有名` `権威`。
 *
 * 直しかた三つ –
 * ① **行が出る語へ寄せる**（`QUERY_SYNONYMS_JA`）– `国内学会` → `国内`・`ボスター` → `poster`
 *    （濁點の違ひだけの同じ語で、`ポスター` 自身も此の表で `poster` へ寄る – `ポスター` を寄せ先に
 *    すると 1 行しか出ない）・`ロングペーパー` → `full paper`（第 381 回の `ショートペーパー` と
 *    同じ筋。`long paper` は Long Beach と `paper` の掛かりで論文の種類では無い – 檢べが彈いた）。`サーベイ論文` `招待論文` `レビュー論文` は**寄せ先が 0 行**なので載せない。
 * ② **畫面の欄の名前に寄せる** – `開催期間` → 欄『会期』（例に擧げる値も行を持つ物だけ）。
 * ③ **其の群の語に載せる** – 場所の聞き方は「知りたい」の群（斷りが既に『会場はどこ』を名指す）、
 *    課程と支援は「対象とレベル」の群、評價の別の言ひ方は「メジャー」の群。
 *
 * 突合（群の語 × 語尾の網羅 18,457 本）– **行 增 3・減 0**（增は寄せた三語だけ）・
 * **案内 新規 14・消失 0・文の變へり 0**・寄せ 新規 3・文の變へり 0。內譯は SPEC.md 第 686 回。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

/** 收錄の全體（速く開く品書は窓で切られて居るので、行の有無は此方で見る）。 */
function 全體(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
  ) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string, 行々: Array<{ hay: string }> = 品書()): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々
    .filter((行) => 照合(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

const 件 = (語: string): number => 行列表(語).length;
const 案内 = (語: string): string => String(Recommender.uiWordNoteJa(語, false) || "");
const 寄せ = (語: string): string => Recommender.querySynonymNotes(語).join(" ");

/** 寄せた語と、其の寄せ先（收錄が行に書く語）。 */
const 寄せた語: Array<[string, string]> = [
  ["国内学会", "国内"],
  ["ボスター", "poster"],
  /* `long paper` は寄せ先にしない – 7 行あるが中身は Long Beach（開催地）と `paper` の掛かりで
   * 論文の種類では無い（檢べが名前を出して彈いた）。收錄が其の意味で書くのは `full paper`。*/
  ["ロングペーパー", "full paper"],
];

/** 群の `words` へ載せた語と、其の群の斷りに必ず出る語。 */
const 群へ載せた語: Array<[string, string]> = [
  ["大学院生", "募集対象や旅費の支援"],
  ["博士学生", "募集対象や旅費の支援"],
  ["学部学生", "募集対象や旅費の支援"],
  ["奨学金", "募集対象や旅費の支援"],
  ["参加支援", "募集対象や旅費の支援"],
  ["参加費補助", "募集対象や旅費の支援"],
  ["トップカンファレンス", "『ランク』"],
  ["難関", "『ランク』"],
  ["有名", "『ランク』"],
  ["権威", "『ランク』"],
];

/** 群の `exactOnly` へ載せた語（打ち方その物の時だけ受ける – 第 682 回）。 */
const 打ち方だけの語: string[] = ["どこ", "どこで", "どこで開催"];

describe("行が出る語へ寄せる（第 686 回）", () => {
  it("寄せた語は、寄せ先と同じ行に屆く（一字も違はない）", () => {
    for (const [語, 先] of 寄せた語) {
      /* 行の有無は收錄の全體で見る（速く開く品書は窓で切られて居る – `full paper` の 72 行の内
       * 30 行だけが既定の窓に入る）。*/
      expect(
        行列表(先, 全體()).length,
        `寄せ先が 0 行（寄せても行は增へん）: ${先}`,
      ).toBeGreaterThan(0);
      expect(行列表(語, 全體()), `收錄の全體で寄せ先と別の行: ${語}`).toEqual(行列表(先, 全體()));
      expect(行列表(語), `品書で寄せ先と別の行: ${語}`).toEqual(行列表(先));
    }
  });

  it("寄せた事を件数欄に言う（黙って別の語で探さない – 第 246 回）", () => {
    for (const [語, 先] of 寄せた語) {
      const 文 = 寄せ(語);
      expect(文, `寄せた事を言って居ん: ${語}`).toContain(`「${語}」`);
      expect(文, `寄せ先を名指して居ん: ${語}`).toContain("で探しています");
      expect(文, `寄せ先の語が文に無い: ${語} → ${先}`).toMatch(/国内|poster|full paper/);
    }
  });

  it("寄せ先の無い語は載せない（行が增へん語を寄せない – 第 246 回）", () => {
    for (const 語 of ["サーベイ論文", "招待論文", "レビュー論文", "survey", "invited"]) {
      expect(件(語), `寄せ先が出來た: ${語}`).toBe(0);
      expect(寄せ(語), `寄せて居る（行が增へん）: ${語}`).toBe("");
    }
  });

  it("同じ意味で通る語の扱ひを變へて居ない", () => {
    for (const 語 of ["ポスター", "ポスター発表", "国内", "研究会", "ショートペーパー"]) {
      expect(件(語), `行が消えた: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
  });
});

describe("畫面の欄の名前へ寄せる（第 686 回）", () => {
  it("`開催期間` は欄『会期』の名前として案内を出す", () => {
    expect(件("開催期間"), "行が出る樣に成つた").toBe(0);
    const 文 = String(Recommender.columnQueryNoteJa("開催期間", (語) => 件(語) > 0) || "");
    expect(文, `默つた`).toContain("欄（会期）");
    expect(文, `値で打つ道を書いて居ん`).toContain("值で打ってください");
  });

  it("案内が例に擧げる値は、其の方で行が出る（空の例を書かない）", () => {
    const 文 = String(Recommender.columnQueryNoteJa("開催期間", (語) => 件(語) > 0) || "");
    for (const 例 of ["2026年12月", "2027年3月"]) {
      expect(文, `例が文に無い: ${例}`).toContain(例);
      expect(件(例), `例が 0 行: ${例}`).toBeGreaterThan(0);
    }
    /* 例の並べが空に成つて居ない（「（例: ）。」で切れる形を防ぐ）。 */
    expect(文, "例が空").not.toContain("（例: ）。");
  });

  it("讀み上げも六十字に納まる（第 651 回）", () => {
    const 聲 = String(Recommender.columnQueryLiveNoteJa("開催期間", (語) => 件(語) > 0) || "");
    expect(聲, `讀み上げが無い`).not.toBe("");
    expect([...聲].length, `讀み上げが六十を越える: ${聲}`).toBeLessThanOrEqual(60);
  });
});

describe("其の群の語に載せる（第 686 回）", () => {
  it("品書で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    for (const [語] of 群へ載せた語) expect(件(語), `品書で行が出た: ${語}`).toBe(0);
    for (const 語 of 打ち方だけの語) expect(件(語), `品書で行が出た: ${語}`).toBe(0);
  });

  it("默らず、其の群の斷りを受ける", () => {
    for (const [語, 印] of [
      ...群へ載せた語,
      ...打ち方だけの語.map((語) => [語, "何を訪ねるか決まりません"] as [string, string]),
    ]) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `其の群の斷りで無い: ${語}`).toContain(印);
      /* 測つて居ない數を書かない（第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語}`).toBe(false);
    }
  });

  it("場所の聞き方は打ち方その物の時だけ受ける（欄の斷りと重ねない – 第 244・653 回）", () => {
    /* `words` に載せると「値 + は + どこ」まで受け、`会場はどこ` に欄の斷りと此の斷りが二つ
     * 並び、第 653 回が事實として張つて居る默り（`オンラインはどこ`）も崩れる（實測）。 */
    for (const 語 of ["どこ？", "どこですか", "どこで"]) {
      expect(案内(語), `打ち方その物で受けて居ん: ${語}`).not.toBe("");
    }
    for (const 語 of ["会場はどこ", "オンラインはどこ", "締切はどこ"]) {
      expect(案内(語), `値の名を訪ねる形まで受けた: ${語}`).toBe("");
    }
    /* 欄の名前の斷りは其の侭（重ねて言はない）。 */
    expect(
      String(Recommender.columnQueryNoteJa("会場はどこ", (語) => 件(語) > 0) || ""),
      "欄の名前の斷りが消えた",
    ).toContain("欄（開催地）");
  });

  it("群の語に載つても、行が出る語の斷りは奪はない（第 337 回）", () => {
    for (const 語 of ["会期", "国内", "ポスター", "full paper", "poster"]) {
      expect(行列表(語, 全體()).length, `前提が崩れた（收錄の全體で 0 行）: ${語}`).toBeGreaterThan(
        0,
      );
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    /* 0 行だが他の群が既に受ける語（斷りが消えたら氣付く）。`会場` は欄の名前の表が受けるので
     * 此方では見ない（`columnQueryNoteJa` の擔當 – 第 244 回）。 */
    for (const 語 of ["修士学生", "大学院生向け", "一流", "上位", "有名な会議"]) {
      expect(行列表(語, 全體()).length, `行が出た: ${語}`).toBe(0);
      expect(案内(語), `斷りが消えた: ${語}`).not.toBe("");
    }
  });

  it("場所の聞き方の斷りは、其の侭の例を持つ", () => {
    const 文 = 案内("どこ");
    for (const 例 of ["会場はどこ", "締切はいつ"]) {
      expect(文, `例が消えた: ${例}`).toContain(例);
    }
  });
});

describe("語列表その物の棚卸し（第 686 回）", () => {
  it("群へ載せた語は、正本の群に一度ずつ載つて居る（一語一羣 – 第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const [語] of 群へ載せた語) {
      const 數 = 本.split(`"${語}",`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    /* 打ち方だけの語は `exactOnly` に一度ずつ（`words` には載せない – 上の見張り）。 */
    const 打法の本 = (本.match(/exactOnly: \[[\s\S]*?\],/g) || []).join("\n");
    const 語列表の本 = (本.match(/words: \[[\s\S]*?\n {6}\],/g) || []).join("\n");
    for (const 語 of 打ち方だけの語) {
      expect(打法の本.split(`"${語}"`).length - 1, `exactOnly に載つて居ん: ${語}`).toBe(1);
      expect(
        語列表の本.includes(`"${語}"`),
        `\`words\` にも載つて居る（二重に受ける）: ${語}`,
      ).toBe(false);
    }
  });

  it("寄せの三條が成果物に入つて居る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [語] of 寄せた語) {
      expect(物, `寄せの條が無い: ${語}`).toContain(`["${語}",`);
    }
    /* 欄の名前の表にも一條（`開催期間` → 会期）。 */
    expect(物, "`開催期間` の欄の名前が無い").toContain('"開催期間"');
  });
});
