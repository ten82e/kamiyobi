/**
 * 検索の畳み込み（`kanaFold` – 全角・半角・仮名のゆらぎを寄せる）を憶える形の検査（SPEC §7・第 258 回）。
 *
 * 2026-08-09 生成ビルド・候補行 3,253 行 / 210 万字で実測した形：
 *   - 検索 1 走 31 ms（うち行の畳み込み 13.6 ms）+ 語ごとの件数 93 ms
 *   - 1 打鍵で表 1 回ぶんの畳み込みを組み直し、同じ量の文字列（4 MB）を捨て続けていた
 *   - 検索欄 1 打鍵 83 ms の内訳の大半で、語を並べた人ほど重かった
 * 畳んだ結果を憶えると 検索 1 走 0.8 ms・語ごとの件数 4 ms になった（件数は 16 語で完全一致）。
 *
 * **第 264 回に、速さの检测方法を変えた。** 以前は同じビルドの中で「初回 / 2 回目」の時間を
 * 比べて 3 倍以上を見ていたが、同じ機械で検査を並列実行したときに平気で落ちた
 * （2026-09-24 実測: 初回 4.6 ms / 2 回目 6.2 ms – 比 0.73）。主張したいのは
 * 「時間が短かった」ではなく「**同じ行を二度畳まなかった**」なので、畳む関数に差し込んだ
 * `Map` の数え上げで検める（時間の話は上の実測値の記録としてだけ残す）。
 */

import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

type SearchFn = (hay: unknown) => boolean;
type FoldFn = ((value: unknown) => string) & { kanaFoldCache?: Map<string, string> };

/** 畳み込みが憶えた量を見えるようにする `Map`（読み・書き・捨ての各回数を持つ）。 */
class CountingMap extends Map<string, string> {
  gets = 0;
  sets = 0;
  clears = 0;
  get(key: string): string | undefined {
    this.gets += 1;
    return super.get(key);
  }
  set(key: string, value: string): this {
    this.sets += 1;
    return super.set(key, value);
  }
  clear(): void {
    this.clears += 1;
    super.clear();
  }
}

interface Reco {
  searchMatcher: (query: unknown, nowMs?: number) => SearchFn;
  queryTermCounts: (
    query: unknown,
    hays: readonly unknown[],
    nowMs?: number,
  ) => Array<{ term: string; count: number }>;
  /* 畳む関数の窓（`site/recommender.ts` の同じ名前の項参照）。無いとこの検査は
   * 空振りになるので、無ければそこで落ちる。 */
  kanaFoldMemo?: () => FoldFn;
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

describe("検索の畳み込みを憶える（第 258 回）", () => {
  it("同じ行を二度畳まない（第 264 回: 壁時計ではなく働き方で検める）", () => {
    /* 畳む関数に検査側の `Map` を差し込んで、読み・書きの回数を数える。
       「2 回目は速かった」ではなく「2 回目は同じ行を畳み直していない」を見る。 */
    const fold = Rec.kanaFoldMemo?.();
    expect(fold, "畳む関数の窓が無い（検査が空振りになる）").toBeTypeOf("function");
    const counter = new CountingMap();
    fold!.kanaFoldCache = counter;

    const rows = longRows(400, "本題");
    for (const row of rows) {
      fold!(row);
    }
    const firstGets = counter.gets;
    const firstSets = counter.sets;
    /* 初回はまだ憶えていないので、読むたびに作り直して書く。 */
    expect(firstGets, "初回から読み取りに当たっている").toBe(400);
    expect(firstSets, "初回の書き込みが足りない").toBe(400);
    expect(counter.size, "初回に憶えた量が行の数と違う").toBe(400);

    for (const row of rows) {
      fold!(row);
    }
    /* 2 回目は読みだけに当たり、組み直し（書き込み）は起きない。 */
    expect(counter.gets - firstGets, "2 回目で読み取りをしていない（憶える道が消えた）").toBe(400);
    expect(counter.sets - firstSets, "2 回目で同じ行を畳み直している").toBe(0);
    expect(counter.size, "2 回目で憶えた量が増えた").toBe(400);

    /* 憶えた結果は、その場で畳んだ結果と同じ（速さのために意味を変えていない）。 */
    const fresh = Rec.kanaFoldMemo!();
    expect(fold!("ｾｷｭﾘﾃｨ 特集"), "憶えた値がその場の畳み込みと違う").toBe(
      fresh("セキュリティ 特集"),
    );

    /* 画面と同じ経路（`searchMatcher`）でも、同じ表を 2 回掛けて畳み直しは起きない。 */
    const counter2 = new CountingMap();
    fold!.kanaFoldCache = counter2;
    const hit = () => rows.filter(Rec.searchMatcher("性能評価", NOW)).length;
    expect(hit()).toBe(400);
    const setsAfterFirstPass = counter2.sets;
    expect(hit()).toBe(400);
    expect(counter2.sets, "画面の経路で 2 回目に畳み直している").toBe(setsAfterFirstPass);
  });

  it("憶える数に上限を設けている（上限を越えたらまとめて捨てる）", () => {
    const fold = Rec.kanaFoldMemo!();
    const counter = new CountingMap();
    fold.kanaFoldCache = counter;
    for (let i = 0; i < 12_001; i++) fold(`溢れ ${i} の性能評価`);
    expect(counter.clears, "上限で捨てていない（表が育ち続ける）").toBeGreaterThanOrEqual(1);
    /* 捨てた後も畳み込みの結果は同じ。 */
    expect(fold("溢れ 0 の性能評価")).toBe(fold("溢れ 0 の性能評価"));
    expect(counter.size, "捨てた後に憶え直していない").toBeLessThanOrEqual(12_000);
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
