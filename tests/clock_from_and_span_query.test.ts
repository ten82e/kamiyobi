/**
 * 「9時から」「17時から19時」「明日午後」だけ黙つて空だつた – 時刻の『から』と一日の中の幅（第 442 回）。
 *
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `9時以降` 586 行・`9時より`（同じ案内）が通るのに `9時から` は 0 行で案内も無し。
 * - `17時台` が通るのに `17時から19時` `17時から19時まで` `17時-19時` は 0 行で案内も無し。
 * - `明日の午後` 4 行が通るのに繋げた `明日午後` は 0 行で案内も無し（`明日 17時` と同じ
 *   二語の話なのに、空格が有る人だけ通つた）。
 *
 * 直し:
 * - 時刻の前後境界の尾に『から』（`9時から` ≡ `9時以降` の一字も違はぬ並び）
 * - 二つの時刻の幅 `17時から19時` は前後とも 1 時の帯で受ける（17:00〜19:59 – 分は帯を
 *   絞らない・其の場で其の方を言う）。前後が逆な打ち方と夜跨ぎは解かない（締切の推測をしない）
 * - 割りの尾に 午前・午後・正午 と『から』（`明日午後` ≡ `明日` ∩ `午後`）
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

function 和集合(...xs: Array<Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const x of xs) for (const a of x) out.add(a);
  return out;
}

describe("『N時から』は『N時以降』と同じ並び（第 442 回）", () => {
  it("『9時から』は『9時以降』と一字も違わない", () => {
    expect(対称差(列("9時から"), 列("9時以降"))).toBe(0);
    expect(列("9時から").size).toBeGreaterThan(0);
    const 案内 = Recommender.relativeDayNotes("9時から", 基準).join(" ");
    expect(案内).toContain("09:00〜23:59");
  });
  it("分付きと午後の前缀も通る", () => {
    expect(対称差(列("17時30分から"), 列("17時30分以降"))).toBe(0);
    expect(対称差(列("午後5時から"), 列("午後5時以降"))).toBe(0);
  });
});

describe("一日の中の時刻の幅が帯で絞れる（第 442 回）", () => {
  it("『17時から19時』は 17・18・19 時台の和集合", () => {
    /* 行の多い少ないに依らない当たり方の直接検査 – ハーネスの品書は行数が小さいので
     * 和集合が空で対称差 0 が空対空になり得る（第 442 回の改ざん検査で実測）。 */
    const 当 = Recommender.searchMatcher("17時から19時", 基準);
    for (const 入る of ["ai 17:30 deadline", "hpc 18:00", "sec 19:59", "17:00"]) {
      expect(当(入る), `『${入る}』が当たら無い`).toBe(true);
    }
    for (const 外 of ["ai 16:59 deadline", "hpc 20:00", "sec 12:00"]) {
      expect(当(外), `『${外}』が当たつてしまう`).toBe(false);
    }
    const 期待 = 和集合(列("17時台"), 列("18時台"), 列("19時台"));
    expect(対称差(列("17時から19時"), 期待)).toBe(0);
    const 案内 = Recommender.relativeDayNotes("17時から19時", 基準).join(" ");
    expect(案内).toContain("17:00〜19:59");
    expect(案内).toContain("1 時の帯");
  });
  for (const 形 of ["17時から19時まで", "17時-19時", "17時〜19時", "17時より19時"]) {
    it(`『${形}』も同じ並び`, () => {
      expect(対称差(列(形), 列("17時から19時")), 形).toBe(0);
    });
  }
  it("前後が逆な打ち方と夜跨ぎは解かない（締切の推測をしない）", () => {
    for (const 語 of ["9時から5時", "午後8時から午前6時"]) {
      expect(列(語).size, 語).toBe(0);
    }
  });
  it("其の日の中の語と合わせても帯が効く", () => {
    const 期待 = new Set([...列("明日")].filter((x) => 列("17時から19時").has(x)));
    expect(対称差(列("明日 17時から19時"), 期待)).toBe(0);
  });
});

describe("日の語に 午前・午後・正午 を繋げた形が二語に割れる（第 442 回）", () => {
  it("『明日午後』は『明日』∩『午後』", () => {
    const 期待 = new Set([...列("明日")].filter((x) => 列("午後").has(x)));
    expect(対称差(列("明日午後"), 期待)).toBe(0);
    expect(列("明日午後").size).toBe(列("明日の午後").size);
    const 案内 = Recommender.relativeDayNotes("明日午後", 基準).join(" ");
    expect(案内).toContain("明日 = 2026年8月10日(月)");
  });
  it("『N時から』の複合も割れて AND になる", () => {
    const 期待 = new Set([...列("明日")].filter((x) => 列("17時以降").has(x)));
    expect(対称差(列("明日17時から"), 期待)).toBe(0);
  });
  it("日の頭の語以外では割らない（第 423 流義は其侭）", () => {
    /* 『締切午後』のやうに頭が日の語で無い物は割らない – 割られたら締切∩午後の行が
     * 出てしまう。割られなければ語其侭の文字列で当たり 0 行の侭。 */
    expect(列("締切").size).toBeGreaterThan(0);
    expect(列("締切午後").size).toBe(0);
  });
});

describe("直した形がビルド成果物に残る（第 442 回）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("尾の表・帯の式・割りの尾が入つて居る", () => {
    expect(
      物.split(
        /^(?:(午前|午後|ごぜん|ごご))?([0-9]{1,2})時(?:([0-9]{1,2})分)?(以降|より|から|前|前に)(?:に|で|は|が|も)?$/
          .source,
      ).length - 1,
    ).toBe(1);
    expect(物.split("前後とも 1 時の帯で受けました").length - 1).toBe(1);
    expect(
      物.split(
        /^(.+?)((?:[0-9]{1,2}|[〇零一二三四五六七八九十]{1,3})時(?:[0-9]{1,2}分|半)?(?:以降|より|から|前|前に)?(?:に)?|[0-9]{1,2}時台|午前|午後|正午|JST|UTC|GMT|jst|utc|gmt|日本時間|世界標準時|協定世界時)$/
          .source,
      ).length - 1,
    ).toBe(1);
  });
});
