/**
 * 「17:00以降」「9時半から」「明日午後10時」だけ黙つて空だつた – コロン打ち・半・午後の前缀（第 445 回）。
 *
 * 実測（2026-10-25 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `17時以降` 538 行が通るのに `17:00以降` `18:30以降` `17:00-19:00` は 0 行。
 *   案内は出る于行だけ空 – 行の側の `middleParts` がコロンで `18` + `30以降` に
 *   割つて居た（裸の `9:30` は timeLike が受けて居たが、語を続けた形は外の表だつた）。
 * - `17時30分以降` が通るのに `9時半以降` `9時半前` `午後5時半以降` は 0 行で案内も無し。
 * - `明日 17時` `明日午後` は通るのに `明日午後10時` `明日午後10時以降` は 0 行 –
 *   割りの尾が午前・午後の前缀を持たなかつた。
 * - `9:00-17:00` はコロンで割れて `9:00` と `17:00` の交わり（11 行）になつて居た –
 *   幅として読むと時の打ち方と同じ 帯になる。
 *
 * 直し:
 * - 時刻の語を解く前に `H:MM` を `H時M分` へ其の場で寄せる（時 23・分 59 を超えたら寄せない）
 * - 時境の尾に `半`（9時半 ≡ 9時30分）
 * - 割りの尾に午前・午前の前缀とコロン打ちの時刻
 * - `middleParts` の割りにコロン打ちの時刻＋語を続ける形を入れ無い守り
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(x: Set<string>, y: Set<string>): number {
  let n = 0;
  for (const a of x) if (!y.has(a)) n += 1;
  for (const b of y) if (!x.has(b)) n += 1;
  return n;
}

function 交差(x: Set<string>, y: Set<string>): Set<string> {
  return new Set([...x].filter((a) => y.has(a)));
}

describe("コロン打ちの時刻も時の打ち方と同じに解ける（第 445 回）", () => {
  for (const [語, 芯] of [
    ["17:00以降", "17時以降"],
    ["18:30以降", "18時30分以降"],
    ["9:30", "9時30分"],
    ["17:00-19:00", "17時から19時"],
  ] as Array<[string, string]>) {
    it(`『${語}』は『${芯}』と一字も違わない`, () => {
      /* ハーネスの品書では行が空対空になり得る – 当たり方を合成行でも見る（第 442 回）。 */
      const 当 = Recommender.searchMatcher(語, 基準);
      const 芯当 = Recommender.searchMatcher(芯, 基準);
      for (const 入る of ["hpc 17:30 deadline", "hpc 09:30", "hpc 18:00", "hpc 20:15"]) {
        expect(当(入る), `${語} が『${入る}』で違う当たり方をした`).toBe(芯当(入る));
      }
      expect(対称差(列(語), 列(芯)), 語).toBe(0);
    });
  }
  it("日の語と繋げたコロン打ちも割れる", () => {
    const 期待 = 交差(列("明日"), 列("17時以降"));
    expect(対称差(列("明日17:00以降"), 期待)).toBe(0);
    expect(列("明日17:00以降").size).toBeGreaterThan(0);
  });
  it("幅の外の時刻（24:00）は寄せない – 其の方の語で探す侭", () => {
    expect(列("24:00以降").size).toBe(0);
  });
  it("『18:30まで』は絞らない – 時刻までの案内の決まりが其侭届く（第 333 回）", () => {
    /* 割らずに通すのは案内を届ける為で、絞り込みを始めない事。 */
    const 当 = Recommender.searchMatcher("18:30まで", 基準);
    expect(当("hpc 18:35 deadline")).toBe(false);
  });
});

describe("『半』の境目も前後で続けられる（第 445 回）", () => {
  for (const [語, 芯] of [
    ["9時半以降", "9時30分以降"],
    ["9時半前", "9時30分前"],
    ["午後5時半以降", "17時30分以降"],
  ] as Array<[string, string]>) {
    it(`『${語}』は『${芯}』と一字も違わない`, () => {
      const 当 = Recommender.searchMatcher(語, 基準);
      const 芯当 = Recommender.searchMatcher(芯, 基準);
      for (const 入る of ["hpc 17:30 deadline", "hpc 18:00", "hpc 09:00"]) {
        expect(当(入る), `${語} が『${入る}』で違う当たり方をした`).toBe(芯当(入る));
      }
      expect(対称差(列(語), 列(芯)), 語).toBe(0);
    });
  }
});

describe("午前・午後の前缀付きの時刻も日の語と繋がる（第 445 回）", () => {
  for (const [語, 日, 芯] of [
    ["明日午後10時", "明日", "午後10時"],
    ["明日午前9時", "明日", "午前9時"],
    ["明日午後10時以降", "明日", "午後10時以降"],
  ] as Array<[string, string, string]>) {
    it(`『${語}』は『${日}∩${芯}』と一字も違わない`, () => {
      const 当 = Recommender.searchMatcher(語, 基準);
      const 芯当 = Recommender.searchMatcher(`${日} ${芯}`, 基準);
      for (const 入る of ["hpc 22:15 deadline", "hpc 09:05 deadline", "hpc 23:00 deadline"]) {
        expect(当(入る), `${語} が『${入る}』で違う当たり方をした`).toBe(芯当(入る));
      }
      expect(対称差(列(語), 交差(列(日), 列(芯))), 語).toBe(0);
      expect(列(語).size, 語).toBe(列(`${日} ${芯}`).size);
    });
  }
});

describe("コロンで割つて交わりにする化け方を戻さない（第 445 回）", () => {
  it("『9:00-17:00』は二つの時点の交わりでなく幅", () => {
    const 幅 = Recommender.searchMatcher("9:00-17:00", 基準);
    const 品 = () =>
      (
        Recommender.candidateRows(
          JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
        ) as unknown as Array<{ hay: string }>
      ).map((行) => String(行.hay));
    /* 交わりに化けて居たら其の両方を書く行だけで 11 行（第 412 回の実測） –
     * 幅なら其の間の時刻を書く行も入る。合成行で確かめる。 */
    expect(幅("hpc 11:30 deadline")).toBe(true);
    expect(幅("hpc 08:59 deadline")).toBe(false);
    /* 帯は両端のhourを含む（第 442 回の時の打ち方と同じ – `9時から17時` も 17:xx を含む） */
    expect(幅("hpc 17:30 deadline")).toBe(true);
    expect(対称差(new Set(品().filter(幅)), 列("9時から17時"))).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 445 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf-8");
  it("コロン寄せ・半・前缀・middleParts の守りが入つて居る", () => {
    expect(物.split("CLOCK_JA.exec(コロン直した語)").length - 1).toBe(1);
    expect(
      物.split(
        /^(.+?)((?:(?:午前|午後|ごぜん|ごご)?(?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?(?:以降|より|から|前|前に)?|正午|[0-9]{1,2}:[0-9]{2}(?:以降|より|から|前|前に)?)(?:に)?|[0-9]{1,2}時台|午前|午後|正午|JST|UTC|GMT|jst|utc|gmt|日本時間|世界標準時|協定世界時)$/
          .source,
      ).length - 1,
    ).toBe(1);
    expect(物.split("コロン時刻を続ける形Ja.test(token)").length - 1).toBe(1);
  });
});
