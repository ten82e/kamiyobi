/* 第 475 回 – 其れより後の語を日の語に続けた形（`明日以降` `来週 以降` `下旬以降` `来月上旬以降`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、此れ等は **0 行**
 * なのに件数欄だけ「初期画面は締切の近い順に並んでいて、その以降の締切も並びます」と、画面が果たさ
 * ぬ事を書いて居た（第 332 回 – 黙つても嘘でもいけない）。暦日を打つ形（`8月22日以降` 751 行）は
 * 既に其の日から暦年の終わりまでで絞れて居たので、相対の語も同じ幅に解いた（第 453 回）。初日を
 * 決める連鎖は件数欄が其の場に持つて居た為、`其の日以降の初日Ja` に抜いて両側が同じ日を読むやうに
 * した（第 464 回 – 案内と検索で目が分かれると案内が黙るか嘘を書く）。
 * 直し後（0 行 →）: 明日以降 769 行・来週以降 769 行・今週以降 774 行・先週以降 783 行・下旬以降
 * 752 行・来月上旬以降 710 行・週末以降 770 行・来週末以降 765 行・来年度以降 302 行・来年以降
 * 465 行・22日以降 718 行・年度末以降 303 行・来月末以降 564 行。
 * 3 117 語の群（頭 42 種 × 尾 6 種 × 詰め ⇔ 離し × 後ろの語 + 対照）で**行の差 1 362 語
 * （全部 0 行から）・減つた物 0 語**。`から` `より` は幅の区切りでも在るので載せない（実測 –
 * 寄せると `明日 から 明後日` 0 行 → 9 行・`9月上旬から 中旬` 0 行 → 57 行に化けて幅の終りが消える）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("其れより後の語を日の語に続けた形が其の初日から絞れる（第 475 回）", () => {
  it("離つて打つ形が繋いだ形と同じ行に出る（実測 – 前は両側 0 行だつた）", () => {
    for (const [離, 繋] of [
      ["来週 以降", "来週以降"],
      ["明日 以降", "明日以降"],
      ["下旬 以後", "下旬以後"],
      ["来月上旬 以降", "来月上旬以降"],
      ["明日 この先", "明日この先"],
      ["来週 以来", "来週以来"],
    ]) {
      expect([離, 列(離).size, 列(繋).size]).toEqual([離, 列(繋).size, 列(繋).size]);
      expect(列(離).size).toBeGreaterThan(100);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行 – 前はこの内すべて 0 行だつた）", () => {
    expect(列("明日以降").size).toBe(422);
    expect(列("来週以降").size).toBe(422);
    expect(列("今週以降").size).toBe(422);
    expect(列("先週以降").size).toBe(424);
    expect(列("下旬以降").size).toBe(413);
    expect(列("中旬以降").size).toBe(422);
    expect(列("来月上旬以降").size).toBe(388);
    expect(列("週末以降").size).toBe(422);
    expect(列("来週末以降").size).toBe(420);
    expect(列("来年度以降").size).toBe(48);
    expect(列("来年以降").size).toBe(113);
    expect(列("22日以降").size).toBe(394);
    expect(列("年度末以降").size).toBe(49);
    expect(列("来月末以降").size).toBe(294);
  });
  it("幅で絞れる形は件の数欄が「並びます」と嘘を書かない（暦日を打つ形と同じ決まり – 第 413 回）", () => {
    for (const 文 of [
      "明日以降",
      "来週以降",
      "下旬以降",
      "来月上旬以降",
      "来年以降",
      "来週 以降",
    ]) {
      expect(案内(文)).toBe("");
      expect([文, 列(文).size > 0]).toEqual([文, true]);
    }
  });
  it("後ろに其它の語を続けても効く", () => {
    expect(列("ml 明日以降 締切").size).toBe(14);
    expect(列("明日以降 論文").size).toBe(259);
    expect(列("来週 以降 の 締切").size).toBe(365);
    expect(列("下旬以降 締切").size).toBe(356);
  });
});

describe("載せない形と其它の機械の守り（第 328 回・第 373 回・第 453 回）", () => {
  it("`から` `より` は寄せない – 幅の区切りなので終りが消える（実測で残した差）", () => {
    /* 実測 2026-11-08 – 此れ等を其の初日からの幅に解くと、`明日 から 明後日` 0 行 → 9 行
     * （明後日だけの幅に化ける）・`9月上旬から 中旬` 0 行 → 57 行（幅の終りが消える）になつた。
     * 其の方の幅の機械（第 373 回）が終りまで解く形で直すのが別の群の話。*/
    for (const 文 of ["今日から", "明日から", "来週から", "来月上旬から", "3日後から"]) {
      expect([文, 列(文).size]).toEqual([文, 0]);
      expect(案内(文)).toContain("以降のこと");
    }
    expect(列("明日 から 明後日").size).toBe(0);
    expect(案内("明日 から 明後日")).toContain("明日 = 2026年8月10日(月)");
    expect(列("9月上旬から 中旬").size).toBe(0);
  });
  it("月の語・年・時刻の語は其の方の機械が既に絞る – 此の回は触つて居ない", () => {
    expect(列("8月以降").size).toBe(424);
    expect(列("9月以降").size).toBe(388);
    expect(列("8月から").size).toBe(424);
    expect(列("17時 以降").size).toBe(181);
    expect(案内("17時 以降")).toContain("17時 以降 = 17:00〜23:59");
    expect(案内("17時以降")).toContain("17時以降 = 17:00〜23:59");
  });
  it("日付の語で無いものには尾を寄せない（第 447 回の案内が其侭出る）", () => {
    expect(列("論文以降").size).toBe(0);
    expect(列("JST 以降").size).toBe(0);
    expect(案内("論文以降")).not.toContain("初期画面は締切の近い順に");
  });
  it("残した差 – 其の月の語と塊を離つて其れより後を続ける形は、まだ詰めた方より狭い", () => {
    /* 実測 2026-11-08 – `来月 上旬 以降` 178 件 ⇔ `来月上旬以降` 388 件。第 474 回の塊の目は
     * `まで` の語尾だけを寄せて居て、`以降` 等は寄せなかつた為、其の方の語の塊の目が受けない
     * 形が残る（其の目を語尾の一覧に開くと幅の機械との順序が絡むので、別の群で測つて直す）。*/
    expect(列("来月 上旬 以降").size).toBe(178);
    expect(列("来月上旬以降").size).toBe(388);
  });
  it("在り得ない日は 0 行の侭で、案内が其の事を立つて書く（締切の推測はしない）", () => {
    expect(列("2月30日以降").size).toBe(0);
    expect(案内("2月30日以降")).toContain("其れより後の締切の事だと思いますが");
  });
  it("第 470 回〜第 474 回の実測は此の回で変へて居ない", () => {
    expect(列("週 末").size).toBe(145);
    expect(列("来月 上旬 まで").size).toBe(180);
    expect(列("来 上旬").size).toBe(68);
    expect(列("来 週末").size).toBe(34);
    expect(案内("来 週末")).toContain("来週末 = 2026年8月15日(土)");
    expect(列("8 月の 締切").size).toBe(114);
    expect(列("来 年中").size).toBe(113);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("初日の函数と尾の寄せが現れる", () => {
    expect(物.match(/其の日以降の初日Ja/g)?.length).toBe(4);
    expect(物.match(/其れより後の尾Ja/g)?.length).toBe(2);
    expect(物).toContain("日付らしき語Ja(頭)");
  });
  it("前の四回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物).toContain('"$1$2月$3$4"');
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
