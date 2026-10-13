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

function 当たり列表(語: string): string[] {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => matches(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

/** 品書の文本にその語が**繋がって**書かれている行（寄せ先の定義）。 */
function 語が書かれた行列表(語: string): string[] {
  const 小 = 語.toLowerCase();
  return 品書()
    .filter((行) => String(行.hay).toLowerCase().includes(小))
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 全案内(語: string): string {
  const 入口 = [
    "columnQueryLiveNoteJa",
    "uiWordLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const;
  const 表 = Recommender as unknown as Record<
    (typeof 入口)[number],
    (q: string) => string | undefined
  >;
  return 入口.map((名) => String(表[名](語) || "")).join(" | ");
}

/** 寄せ先の語 → 打ち方の語（実測で 0 行だった片仮名の言い方）。 */
const 寄せ = new Map<string, string[]>([
  ["short paper", ["ショートペーパー", "ショートペーパー募集", "ショートペーパー投稿"]],
  ["track paper", ["トラックペーパー", "トラックペーパー募集"]],
  ["position paper", ["ポジションペーパー", "ポジションペーパー募集"]],
  ["technical paper", ["テクニカルペーパー", "テクニカルペーパー募集"]],
  ["demo paper", ["デモ論文", "デモ論文募集"]],
  ["special session", ["スペシャルセッション", "スペシャルセッション募集"]],
]);

describe("論文の種類の片仮名の言い方", () => {
  it("片仮名で打ってもその方の語が書かれた行を其侭通す", () => {
    for (const [語, 打ち方] of 寄せ) {
      const 正 = 語が書かれた行列表(語);
      const 語列 = 語.split(/\s+/);
      for (const 打 of 打ち方) {
        const 得 = 当たり列表(打);
        if (語列.length < 2) {
          expect(対称差(得, 正), `当たり列表が違う: ${打}`).toBe(0);
          continue;
        }

        expect(
          正.filter((x) => !得.includes(x)),
          `${打} が "${語}" を連なりで書く行を落とした`,
        ).toEqual([]);
        expect(
          得.filter((x) => !語列.every((w) => x.includes(w))),
          `${打} が語を揃へん行を拾つた`,
        ).toEqual([]);
      }
    }

    for (const 打 of [
      "ショートペーパー",
      "ポジションペーパー",
      "テクニカルペーパー",
      "スペシャルセッション",
    ]) {
      expect(当たり列表(打).length, `当たりが空: ${打}`).toBeGreaterThan(0);
    }
  });

  it("寄せは語の組にその方の語を 1 つ足すだけ（その方を繋げて打つ形と違う）", () => {
    const 語組 = (語: string) =>
      (
        Recommender as unknown as {
          queryTokenGroups: (q: unknown, now?: number) => string[][];
        }
      ).queryTokenGroups(語, 基準);
    const 組 = 語組("トラックペーパー");
    expect(組.length).toBe(1);
    expect(組[0]).toContain("track paper");
    /* 空格で二語に並べて打つと語のかけ算になる（品書に "track" と "paper" を別々に書く行も
     * 当たる – 実測ビルドで `track paper` 二語 9 行 / 繋がって書かれた行 1 行）。
     * 寄せはその方の語その物なので語のかけ算には成らない。 */
    const 二語 = 語組("track paper");
    expect(二語.length, "二語が一つに括られた侭").toBeGreaterThan(1);
  });

  it("審査の段階の語には寄せない（案内が二つ並んで噓になる – 締切の推測はしない）", () => {
    for (const 語 of ["ピアレビュー", "ピアレビュー期間"]) {
      expect(当たり列表(語).length, `当たりが出た: ${語}`).toBe(0);
      expect(全案内(語), `案内が消えた: ${語}`).toContain("審査の方式を書く欄は無いです");
    }
    /* `査読期間` はこの群に入れない – この群の案内は「審査の**方式**（盲検の形・査読者数）の
     * 欄は無い」と言う物で、期間の事を訊く打ち方に返すと的が違う（噓にはならないが読めない）。
     * 収録が行に書くのは『査読結果公開』の一段階の日なので、期間の寄せも作らない –
     * 実測 0 行・案内も無しの侭残す（既知の抜けとして §7 に書く）。 */
    expect(当たり列表("査読期間").length).toBe(0);
    expect(全案内("査読期間")).not.toContain("という語で探しています");

    for (const 語 of ["リバットル", "レブタ", "リブタ", "オーサーレブタ"]) {
      expect(当たり列表(語).length, `当たりが出た: ${語}`).toBe(0);
      expect(全案内(語), `寄せの案内が混んだ: ${語}`).not.toContain("という語で探しています");
    }
  });

  it("レフリーは収録にない事の案内が出る（実測 0 行 – 案内も無しだった）", () => {
    expect(当たり列表("レフリー").length).toBe(0);
    const 案内 = 全案内("レフリー");
    expect(案内).toContain("審査の方式を書く欄は無いです");
    /* 品書の文本に "referee" は 0 箇所（実測）なので「持っていません」は本当。 */
    expect(語が書かれた行列表("referee")).toEqual([]);
  });

  it("寄せの条目が成果物に一度だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 語々 = [...寄せ.values()].flat();
    for (const 打 of 語々) {
      const 数 = (成果物.match(new RegExp(`"${打}"`, "g")) || []).length;
      expect(数, `条目の数が違う: ${打}`).toBe(1);
    }
    /* 審査の語は寄せ表に置いていない（案内の群にあるだけ – 上の条目の決まり）。 */
    expect(成果物).not.toContain('"ピアレビュー", "行に書かれた査読');
    expect(成果物).not.toContain('"リバットル", "原文');
  });
});
