/**
 * 検索の畳み込み（`kanaFold` – 全角・半角・仮名のゆらぎを寄せる）を憶える形の検査（SPEC §7・第 258 回）。
 *
 * 2026-08-09 生成ビルド・候補行 3,253 行 / 210 万字で実測した形：
 *   - 検索 1 走 31 ms（うち行の畳み込み 13.6 ms）+ 語ごとの件数 93 ms
 *   - 1 打鍵で表 1 回ぶんの畳み込みを組み直し、同じ量の文字列（4 MB）を捨て続けていた
 *   - 検索欄 1 打鍵 83 ms の内訳の大半で、語を並べた人ほど重かった
 * 畳んだ結果を憶えると 検索 1 走 0.8 ms・語ごとの件数 4 ms になった（件数は 16 語で完全一致）。
 * 絶対時間は機械の負荷で化けるので、**同じビルドの中で初回と 2 回目を比べる**形で見た。
 */

import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

type SearchFn = (hay: unknown) => boolean;

interface Reco {
  searchMatcher: (query: unknown, nowMs?: number) => SearchFn;
  queryTermCounts: (
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
  ) => Array<{ term: string; count: number }>;
}

let Rec: Reco;
const NOW = Date.parse("2026-08-09T00:00:00Z");

beforeAll(async () => {
  const mod = await import(pathToFileURL(`${site}/recommender.js`).href);
  Rec = mod.default as Reco;
});

/* 畳み込みの作業が見える長さの行（実データの平均 644 字と同じくらい）。 */
function longRows(count: number, marker: string): string[] {
  const filler = `${marker}の性能評価と最適化の手引き `;
  const rows: string[] = [];
  for (let i = 0; i < count; i++) rows.push(`行 ${i} ${filler.repeat(24)} 提案募集`);
  return rows;
}

function measure(run: () => number): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("検索の畳み込みを憶える（第 258 回）", () => {
  it("同じ行を二度畳まない（初回と 2 回目を同じビルドで比べる）", () => {
    /* 暖機（JIT）は別の文字列で済ませてから測る – さもないと初回が遅い理由が
     * 畳み込みの組み直しではなくなってしまう。 */
    const warm = longRows(300, "暖機");
    Rec.searchMatcher("性能評価", NOW);
    warm.forEach(Rec.searchMatcher("性能評価", NOW));

    const rows = longRows(400, "本題");
    const first = measure(() => rows.filter(Rec.searchMatcher("性能評価", NOW)).length);
    const second = measure(() => rows.filter(Rec.searchMatcher("性能評価", NOW)).length);
    /* 憶えていなければ 2 回目は 1 回目と同じ作業をするので比は 1 に近い。
     * 憶えていれば 2 回目は配列を舴めるだけで、実測比は 20 倍を超えた。 */
    expect(
      first / Math.max(second, 0.01),
      `2 回目が初回と同じ作業をしている（初回 ${first.toFixed(1)} ms / 2 回目 ${second.toFixed(1)} ms）`,
    ).toBeGreaterThan(3);
    /* 早さだけを見て中身を変えていないことも同時に検める。 */
    expect(rows.filter(Rec.searchMatcher("性能評価", NOW)).length).toBe(400);
    expect(rows.filter(Rec.searchMatcher("存在しない語", NOW)).length).toBe(0);
  });

  it("文字列以外を `null` と同じ鍵で憶えない", () => {
    /* 畳み込みは文字列だけを憶える。鍵を生文字列にすると `null`（畳むと空）と
     * `"null"`（畳むと "null"）が衝突して、`null` の行が `null` という語に当たり始める。 */
    const rows: unknown[] = ["null 提案募集", null, undefined, 42, "本 提案募集"];
    expect(rows.filter(Rec.searchMatcher("null", NOW)).length).toBe(1);
    expect(Rec.queryTermCounts("null", rows, NOW)).toEqual([{ term: "null", count: 1 }]);
    /* 語が空のときは全行に通す（従来の意味のまま）。 */
    expect(rows.filter(Rec.searchMatcher(null, NOW)).length).toBe(rows.length);
    /* 数値の行も畳める（憶えないだけで結果は同じ）。 */
    expect(Rec.queryTermCounts("42", ["42 提案募集", 42, "本"], NOW)).toEqual([
      { term: "42", count: 2 },
    ]);
  });

  it("上限を越えても正しい数を言う（憶えすぎて古くならない）", () => {
    /* 上限（12,000 件）を越えたらまとめて捨てて組み直す – 表が育ったときにメモリを食い続け
     * ないためで、捨てた後も数は変わってはならない。 */
    const rows = longRows(13_000, "溢れ");
    const counts = Rec.queryTermCounts("性能評価", rows, NOW);
    expect(counts[0].count).toBe(13_000);
    /* 捨てたあとに同じ語を引いても同じ数が出る。 */
    expect(Rec.queryTermCounts("性能評価", rows, NOW)[0].count).toBe(13_000);
    expect(Rec.queryTermCounts("溢れ", rows, NOW)[0].count).toBe(13_000);
    /* 語を並べたときは語ごとの件数を 1 本ずつ出す（`行` は全行、`12999` は 1 行）。 */
    expect(Rec.queryTermCounts("行 12999", rows, NOW)).toEqual([
      { term: "行", count: 13_000 },
      { term: "12999", count: 1 },
    ]);
    expect(rows.filter(Rec.searchMatcher("行 12999", NOW)).length).toBe(1);
  });

  it("畳み込みは今、全角と仮名のゆらぎをこう寄せている（憶えても変わらない）", () => {
    /* 畳み込みを憶える形にしたので、**何を同じ語と見なすか**をここに書き留める
     * （憶えた結果が今の畳み込みとズレていると、同じ画面の検索と数が食い違う）。
     * 2026-08-09 生成ビルドで実測した形どおり。 */
    const at = (hay: string, word: string): boolean => Rec.searchMatcher(word, NOW)(hay);
    expect(at("ＡＩ 国際会議", "AI"), "全角の英字が寄れない").toBe(true);
    expect(at("ｾｷｭﾘﾃｨ 特集", "セキュリティ"), "半角仮名が寄れない").toBe(true);
    expect(at("きょうの締切", "キョウ"), "大きい仮名と小さい仮名が寄れない").toBe(true);
    expect(at("セッションの案内", "セツショ"), "促音の折り方が変わっている").toBe(true);
    expect(at("セッションの案内", "セショ"), "促音を消しすぎている").toBe(false);
    expect(at("ハードウェアの会", "ハドウェア"), "長音の扱いが変わっている").toBe(true);
  });

  it("畳み込みに依存する語は、憶えた後も同じ行に当たる", () => {
    /* 全角・半角のゆらぎ（畳み込みを通してだけ当たる形）が、2 回目以降も壊れないこと。 */
    const rows = ["ＡＩ 国際会議 提案募集", "ｾｷｭﾘﾃｨ 特集 提案募集", "ほかの行 提案募集"];
    const ai = Rec.searchMatcher("AI", NOW);
    expect(rows.filter(ai).length).toBe(1);
    expect(rows.filter(ai).length).toBe(1);
    const sec = Rec.searchMatcher("セキュリティ", NOW);
    expect(rows.filter(sec).length).toBe(1);
  });
});
