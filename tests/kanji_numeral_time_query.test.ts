/**
 * 時と分を漢数字で打った人（『二十時』『午後五時』『九時台』）– 第 420 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 漢数字で打つと**全部 0 行・案内も無し**だった – `八時` 0 行（算用数字の `8時` は 88 行）・
 * `二十時` 0（516 行）・`二十三時` 0（507 行）・`九時` 0（12 行）・`十七時` 0（2 行）・
 * `九時台` 0（12 行）・`十七時台` 0（2 行）・`午後五時` 0（2 行）・`午前九時` 0（12 行）・
 * `十七時三十分` 0（`17時30分` は 0 行だが案内は出る）・`十七時まで` は案内すら無かつた
 * （`17時まで` は「時刻まででは絞れない」と書く – 第 333 回）。「締切を午後五時にします」の
 * やり取りから貼る打ち方が黙つて空になつて居た。
 *
 * 直し – 時刻の語を解く所で `時` `分` の直前の漢数字を算用数字に直す（他の単位 – `三日` 80 行・
 * `十五日` 138 行 – は其の側の表が別で受けるので触らない）。『一時』だけは寄せない – „しばらく"
 * の意味にも取れる語を実測 0 行から勝手に 2 行に化かさない為で、其の場に打ち直しを書く
 * （締切の推測はしない – AGENTS.md）。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る – 此の方には 09 時・17 時・13 時の行が無く、
 * 其の方で測ると空振りになるので（実測 0 行 – 第 418 回と同じ注）、行の在る時で見る。
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

function 対称差(甲: string, 乙: string): number {
  const A = 列(甲);
  const B = 列(乙);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}

function 案内(語: string): string {
  const 庫 = Recommender as unknown as Record<string, unknown>;
  return Object.keys(庫)
    .filter((鍵) => /Note|Hint/.test(鍵))
    .map((鍵) => {
      try {
        const 値 = (庫[鍵] as (q: string, n: number) => unknown)(語, 基準);
        const 字 = Array.isArray(値) ? 値.join(" ") : String(値 ?? "");
        return /当たっていて/.test(字) ? "" : 字;
      } catch {
        return "";
      }
    })
    .filter((字) => 字.length > 0)
    .join(" ｜ ")
    .replace(/\s+/g, " ");
}

describe("漢数字の時刻", () => {
  it("時の漢数字は算用数字と同じ行を出す（『二十時』『二十三時』『十二時』『十五時』）", () => {
    for (const [語, 基] of [
      ["二十時", "20時"],
      ["二十三時", "23時"],
      ["十二時", "12時"],
      ["十五時", "15時"],
      ["八時", "8時"],
      ["十時", "10時"],
    ] as const) {
      expect(列(基).size, `「${基}」の行が在らない（検査が空振り）`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("「台」を続けた形も同じ帯（『二十時台』『八時台』）", () => {
    for (const [語, 基] of [
      ["二十時台", "20時台"],
      ["八時台", "8時台"],
    ] as const) {
      expect(列(基).size, `「${基}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("午前後を冠した形も同じ時刻に解ける（『午前八時』『午後二十時』）", () => {
    for (const [語, 基] of [
      ["午前八時", "8時"],
      ["午後二十時", "20時"],
      ["ごご八時", "20時"],
    ] as const) {
      expect(列(基).size, `「${基}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("分の漢数字も同じ形に解ける（案内に書く形が『17:30』のやうになる）", () => {
    const 庫 = Recommender as unknown as Record<
      string,
      (語: string) => { terms: string[]; 解: string } | null
    >;
    for (const [語, 解] of [
      ["十七時三十分", "17:30"],
      ["午後五時三十分", "17:30"],
      ["二十時五十分", "20:50"],
      ["八時十五分", "08:15"],
    ] as const) {
      const 解いた = 庫.clockTimeTermsJa(語);
      expect(解いた, `「${語}」が時刻に解けない`).not.toBeNull();
      expect(解いた!.解, `「${語}」の解が ${解} で無い`).toBe(解);
    }
  });

  it("『零時』『〇時』は 00 時に解ける（算用数字の『0時』と同じ）", () => {
    const 庫 = Recommender as unknown as Record<string, (語: string) => { 解: string } | null>;
    for (const 語 of ["零時", "〇時", "0時"]) {
      const 解いた = 庫.clockTimeTermsJa(語);
      expect(解いた, `「${語}」が時刻に解けない`).not.toBeNull();
      expect(解いた!.解, `「${語}」の解が 00 時で無い`).toContain("00:00");
    }
  });

  it("助詞を付き・敬語で閉じた形も同じ行を出す", () => {
    for (const [語, 基] of [
      ["八時の締切", "8時の締切"],
      ["二十時台 でした", "20時台"],
      ["二十時の締切", "20時の締切"],
    ] as const) {
      expect(列(基).size, `「${基}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("『十七時まで』も時刻までの頼み方として案内が出る（第 333 回の漢数字版）", () => {
    expect(列("二十時まで").size, "『二十時まで』で行が出てしまった").toBe(0);
    expect(案内("二十時まで"), "『二十時まで』の案内が消えた").toContain("時刻まで");
    expect(対称差("二十時まで", "二十時"), "『二十時まで』が幅に化けた").toBeGreaterThan(0);
  });
});

describe("寄せない側に決めた物", () => {
  it("『一時』は 1 時に寄せない – 「しばらく」の意味にも取れる", () => {
    expect(列("1時").size, "『1時』の行が在らない（検査が空振り）").toBeGreaterThan(0);
    for (const 語 of ["一時", "一時に", "一時 でした", "一時ですよ", "一時です"]) {
      expect(列(語).size, `「${語}」が 1 時に化けた`).toBe(0);
      const 文 = 案内(語);
      expect(文, `「${語}」の案内が無い（黙つて 0 件）`).toContain("しばらく");
      expect(文, `「${語}」の案内に打ち直しが無い`).toContain("午前1時");
    }
  });

  it("其の他の漢数字の語（日・月・時間）は其の側の表の侭", () => {
    for (const [語, 基] of [
      ["三日", "三日"],
      ["十五日", "15日"],
      ["三日以内", "三日以内"],
      ["二十日", "20日"],
      ["来月十二日", "来月十二日"],
    ] as const) {
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
    expect(列("十五日").size, "『十五日』の行が在らない").toBeGreaterThan(0);
    expect(対称差("正午", "12:00"), "『正午』が正午から外れた").toBe(0);
    expect(列("午後").size, "『午後』の帯が壊れた").toBeGreaterThan(0);
    expect(対称差("二十時台の締切", "20時台の締切"), "『二十時台の締切』が帯から外れた").toBe(0);
    expect(列("午後").size).toBeGreaterThan(0);
  });

  it("成果物に漢数字の表が一つ在り、其の他の単位を触らない形で在る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [形, 度] of [
      ["const 漢数字の数Ja =", 1],
      ["const 漢数字の語 =", 1],
      ["CLOCK_JA.exec(コロン直した語)", 1],
      ["/^一時(?:に)?", 1],
    ] as const) {
      const 数 = 物.split(形).length - 1;
      expect(数, `「${形}」が ${数} 回（期待 ${度} 回）`).toBe(度);
    }
    /* 直すのは `時` `分` の直前だけ – `日` `月` `秒` に化ける形を作らない事。 */
    const 表の箇所 = 物.slice(
      物.indexOf("const 漢数字の語 ="),
      物.indexOf("CLOCK_JA.exec(コロン直した語)"),
    );
    expect(表の箇所, "時の単位以外で直す形にしてしまった").toContain("(?=時|分)");
    expect(表の箇所, "其の他の単位を触る形が混んだ").not.toContain("?=時|分|日");
    expect(表の箇所, "其の他の単位を触る形が混んだ").not.toContain("?=時|分|秒");
  });
});
