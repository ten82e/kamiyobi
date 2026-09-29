/* 第 512 回 – 同じ語を二つの案内の群に載せる誤りの棚卸し（`確定` で実演した通り、応答が食い違う）
 *
 * 第 511 回で `確定` は「見方のてびき」の群と「締切の延伸・確定」の群の兩方に載つて居て、完全一致は
 * 群の並び順で先が勝つ為、單體で打つ人に**誤つた行き先**が返つて居た（実測）。同じ事が起きないやうに、
 * ビルド成果物の表を讀んで検查する –
 * ①一つの群に同じ語を二重に載せない（実測で `過去` `履歴` が二度載つて居た – 応答は変はらないが
 *   「其の語を載せて居る群」が數へられなく成る。第 512 回で拔いた）
 * ②二つ以上の群が同じ語を持つ時、其の群達の**応答（note）が同じ**である事。違ふ語は今のところ
 *   `データ源` の一つだけ – 兩方とも「畫面下の『データ源』に出します」で、導く先が同じなので噓に
 *   成らない（実測で「データ源」は前の群の応答、「出典」は後ろの群の応答に屆く – どちらも畫面下）。
 *   新しい食い違いが現れたら落ちるやうに、例外は名指しの一覧で持つ。*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

type 群 = { k: number; words: string[]; note: string };

function 群々(): 群[] {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
  expect(始, "群の一覧が見つからない（組み立て方が変はつた）").toBeGreaterThan(0);
  const 後 = 物.slice(始);
  const 終節 = 後.match(/\n\s*\];/);
  expect(終節, "群の一覧の終りが見つからない").not.toBeNull();
  const 本 = 後.slice(0, 終節 ? 終節.index : 後.length);
  /* ビルド後は字下げが廣い（函數の中なので 8 字） – 空白に依らない讀み方にする（第 512 回の実測で
     4 字前提の讀み方は 0 群になつた）。*/
  return 本
    .split(/\n\s+\{\n/)
    .slice(1)
    .map((塊, k) => {
      /* 語列表の中の説明（コメント）は語で無い – 落としてから文字列拾ひをする
         （第 512 回の実測で、コメント中の `"fee"` を語と取り違えて數へた）。*/
      const 合 = 塊.match(/words:\s*\[([\s\S]*?)\]/);
      const 語塊 = (合 ? 合[1] : "").replace(/\/\*[\s\S]*?\*\//g, "");
      const words = [...語塊.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((語) => 語);
      const 注塊 = 塊.replace(/\/\*[\s\S]*?\*\//g, "");
      const 注 =
        注塊.match(/\n\s*note:\s*(?:\n\s*)?"([^"]*)/) ||
        注塊.match(/\n\s*note:\s*(?:\n\s*)`([^`]*)/);
      return { k, words, note: (注 ? 注[1] : "").slice(0, 40) };
    })
    .filter((g) => g.words.length > 0);
}

describe("案内の群の語列表の棚卸し（第 512 回）", () => {
  const 群 = 群々();
  it("表が讀める（検査が空振りしない）", () => {
    expect(群.length).toBeGreaterThan(30);
    expect(群.reduce((n, g) => n + g.words.length, 0)).toBeGreaterThan(400);
    for (const g of 群) {
      expect(g.note, `群 ${g.k} の案内の文が讀めない（注の書き方が変はつた）`).not.toBe("");
    }
  });
  it("①一つの群に同じ語を二重に載せて居ない", () => {
    const 二重 = 群
      .map((g) => [g.k, g.words.filter((語, i) => g.words.indexOf(語) !== i)] as const)
      .filter(([, 語々]) => 語々.length > 0);
    expect(二重, "同じ語列表に同じ語が二度載つて居る").toEqual([]);
  });
  it("②二つの群が同じ語を持つ時、応答が同じ（違ふ物は名指しで例外に持つ）", () => {
    const 所 = new Map<string, 群[]>();
    for (const g of 群) for (const 語 of g.words) 所.set(語, [...(所.get(語) || []), g]);
    /* 例外: 導く先が同じ（畫面下の『データ源』）で、応答の文面だけ異なる物。*/
    const 例外 = ["データ源"];
    const 重複語: string[] = [];
    const 食い違い: string[] = [];
    for (const [語, gs] of 所) {
      if (new Set(gs.map((g) => g.k)).size < 2) continue;
      重複語.push(語);
      if (new Set(gs.map((g) => g.note)).size > 1) 食い違い.push(語);
    }
    expect(重複語.sort(), "想定外の重複語が現れた（応答を確認して例外に足す）").toEqual(
      [...例外].sort(),
    );
    expect(
      食い違い.filter((語) => !例外.includes(語)),
      "同じ語を載せる群の応答が食い違つて居る（第 511 回の `確定` と同じ誤り）",
    ).toEqual([]);
    /* 例外として持つ語は「導く先が同じ」條件を張る – 応答が他のの所を指せば例外リストが噓に成る
       （第 512 回の改ざん T3）。*/
    const 導く先: Record<string, RegExp> = { データ源: /データ源/ };
    for (const 語 of 例外) {
      const gs = 所.get(語) || [];
      expect(
        gs.length,
        `例外の語「${語}」が二つ以上の群に載つて居ない（例外が死んで居る）`,
      ).toBeGreaterThan(1);
      for (const g of gs)
        expect(g.note, `「${語}」の応答が其の語を名指さなくなつた（導く先が変わつた）`).toMatch(
          導く先[語],
        );
    }
  });
  it("畫面上も、その語の応答が同じ場所へ導く（第 511 回の `確定` の張り直し）", async () => {
    /* 表の読み方だけ見て終わらせない – `データ源` を打つ人に屆く応答が、どちらの群でも導く先が
       同じである事（実測で文面は前群の方が出る）。*/
    const 所 = new Map<string, 群[]>();
    for (const g of 群) for (const 語 of g.words) 所.set(語, [...(所.get(語) || []), g]);
    const デ = 所.get("データ源") || [];
    expect(デ.length, "`データ源` を载せる群の數が變はつた（先に並ぶ群が應じる前提）").toBe(2);
    const Recommender = (await import("../site/recommender.ts")).default;
    const 届く = (Recommender.uiWordNoteJa("データ源") || "").trim();
    expect(届く).toContain("データ源");
    /* 畫面上に屆くのは先に並ぶ群の應答 – 第 511 回の `確定` で誤りが生じた仕組みその物なので、
       同じ語で二つの群を持つ場合の**どちらが應じるか**を張つて置く（變へる時は意圖的に變へる為）。*/
    expect(届く).toContain(デ[0].note.slice(0, 12));
    /* 二つの応答文が同じ場所（ページの下の欄）を指して居る事 – どちらの群が応じても噓に成らない。*/
    expect(/画面の下|ページ下/.test(届く), `導く先が畫面下ではない: ${届く.slice(0, 30)}`).toBe(
      true,
    );
    /* `確定` は一個の群だけの所屬（第 511 回で讓つた）。*/
    expect((所.get("確定") || []).length).toBe(1);
    expect((所.get("過去") || []).length).toBe(1);
  });
});
