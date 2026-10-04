/**
 * 幅を分数・漢数字で打った人（『30分以内』『三分以内』『三時間以内』）– 第 421 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 同じ所で算用数字の時間幅は「この表は締切を日単位で持っている（時に持たない）ので、時間単位では
 * 絞れません」（第 365 回）と書くのに、分数で打つと**黙って 0 行**だった – `30分以内` `10分以内`
 * `60分以内` `90分以内` `30分` `三分以内` `半時間以内` `30分未満` が 0 行で案内も無し、漢数字の
 * 時間幅も同じ（`三時間以内` `一時間以内` が 0 行で案内無し / `3時間以内` `1時間以内` は案内が
 * 出る）。壁は打ち方だけで、表の幅の仕組みが「半日」と「算用数字 + 時間」しか見て居なかった。
 *
 * 直し – 幅の表に分数と漢数字の時間・分を受ける形を足し、案内は打った単位の名前を書く
 * （分数なら「分数単位」、時間なら「時間単位」）。**行は作らない** – 締切は日単位で在る
 * （時に持たない）ので、分数幅で絞れると見せない（締切の推測はしない – AGENTS.md）。
 * 『30分』を 30/24 で 2 日に丸めない（其のまま行くと「2 日以内が近い」に化ける）。
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

function 幅の案内(語: string): string {
  return String(Recommender.dayRangeNoteJa(語) ?? "").replace(/\s+/g, " ");
}

describe("分数で打たれた幅", () => {
  it("分数の幅は黙って 0 行にせず、日単位の話を書く（打ち直しは『1 日以内』）", () => {
    for (const 語 of ["30分以内", "10分以内", "15分以内", "60分以内", "90分以内", "30分間以内"]) {
      expect(列(語).size, `「${語}」で行が出てしまった（締切は日単位）`).toBe(0);
      const 文 = 幅の案内(語);
      expect(文, `「${語}」の案内が無い（黙つて 0 件）`).toContain("日単位");
      expect(文, `「${語}」の案内に打ち直しが無い`).toContain("1 日以内");
      expect(文, `「${語}」に分数で無い単位を書いた`).toContain("分数単位");
    }
  });

  it("漢数字で打った分数も同じ案内（『三分以内』）", () => {
    const 文 = 幅の案内("三分以内");
    expect(文, "「三分以内」の案内が無い").toContain("分数単位");
    expect(列("三分以内").size, "「三分以内」で行が出てしまった").toBe(0);
  });

  it("算用数字の時間幅の案内は其侭（『1時間以内』『半日以内』は時間単位と書く）", () => {
    for (const 語 of ["1時間以内", "3時間以内", "24時間以内", "半日以内"]) {
      const 文 = 幅の案内(語);
      expect(文, `「${語}」の案内が消えた`).toContain("時間単位");
      expect(文, `「${語}」に分数と書いた`).not.toContain("分数単位");
    }
  });

  it("漢数字で打った時間幅も同じ案内（『三時間以内』『一時間以内』）", () => {
    for (const 語 of ["三時間以内", "一時間以内", "二時間以内", "半時間以内"]) {
      const 文 = 幅の案内(語);
      expect(文, `「${語}」の案内が無い（黙つて 0 件）`).toContain("日単位");
      expect(文, `「${語}」に打ち直しが無い`).toContain("1 日以内");
      expect(列(語).size, `「${語}」が行を作った`).toBe(0);
      expect(文, `「${語}」に時間の単位を書かなかった`).toContain("時間");
    }
  });

  it("『30分』を 2 日に丸めない – 幅の日数は 1 日（其れ以下には絞れない）", () => {
    const 庫 = Recommender as unknown as Record<string, (語: string) => number | null>;
    for (const 語 of ["30分以内", "90分以内", "9999分以内", "三分以内", "半時間以内", "半日以内"]) {
      const 日数 = 庫.dayRangeDaysJa(語);
      expect(日数, `「${語}」が幅として読めない`).not.toBeNull();
      expect(日数, `「${語}」を ${日数} 日に丸めた（締切は日単位 – 1 日が下限）`).toBe(1);
    }
    for (const 語 of ["30分以内", "90分以内", "三分以内"]) {
      const 文 = 幅の案内(語);
      expect(文, `「${語}」が日数の欄の話に化けた: ${文}`).not.toMatch(/日以内が近い|日以内が確か/);
      expect(文, `「${語}」が日数で絞れると見せた: ${文}`).not.toContain("選ぶと同じ話です");
    }
  });
});

describe("壊して居ない側", () => {
  it("日・週・月の幅は其侭行が出る（『五日以内』25 行・『2週間以内』61 行）", () => {
    for (const [語, 基] of [
      ["五日以内", "5日以内"],
      ["二週間以内", "2週間以内"],
      ["一日以内", "1日以内"],
    ] as const) {
      expect(列(語).size, `「${語}」の行が消えた`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
    expect(対称差("180日以内", "半年以内"), "上限の幅が動いた").toBe(0);
  });

  it("幅の形でも過去に開いた幅は別の話として書く（第 365 回の侭）", () => {
    for (const 語 of ["3日前まで", "1か月前まで"]) {
      const 文 = 幅の案内(語);
      expect(文, `「${語}」の案内が消えた`).toContain("過去の締切も表示");
      expect(文, `「${語}」を分数の幅に化かした`).not.toContain("分数単位");
    }
  });

  it("単位を落としたり其の他の語に繋げたりした形が分数幅に化けない", () => {
    expect(幅の案内("30分"), "『30分』まで幅の案内が出て噓を言う（単位を落とすと幅ではない）").toBe(
      "",
    );
    const 文 = 幅の案内("10以内");
    expect(文, "『10以内』の案内が消えた").toContain("「締切まで」");
    expect(文, "『10以内』を分数の話に化した").not.toContain("分数単位");
  });

  it("成果物の幅の表が分数・漢数字を受ける形で、単位の名前を打った通りにする枝が在る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [形, 度] of [
      ["const HOUR_RANGE_JA =", 1],
      ["(?:時間|分))(?:間)?以内", 1],
      ["const 打った単位 =", 1],
      ["/^(?:[0-9]{1,4}|[一二三四五六七八九十]{1,3})\\s*分/", 1],
    ] as const) {
      const 数 = 物.split(形).length - 1;
      expect(数, `「${形}」が ${数} 回（期待 ${度} 回）`).toBe(度);
    }
    /* 日の単位をこの表に足すと『五日以内』が時間の枝に吸われる – 足して居ない事を見る。 */
    const 表の行 = 物.slice(
      物.indexOf("const HOUR_RANGE_JA ="),
      物.indexOf("const HOUR_RANGE_JA =") + 400,
    );
    expect(表の行, "幅の表が日の単位まで受けてしまった").not.toContain("?\\s*(?:時間|分|日)");
    expect(表の行, "幅の表が日の単位まで受けてしまった").not.toMatch(/時間\|分\|日/);
  });
});
