/**
 * 「午前」「午後」で打った人と、時間帯の名前で打った人（第 418 回）。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `午前` `午後` `午前中` `午後中` `ごぜん` `ごご` は**すべて 0 行・案内も無し**だった – 同じ画面で
 * `17時` 2 行・`17時台` 2 行・`正午` 1 行・`23:59` 507 行・`9時` 12 行が通るので、時刻の仕組みは
 * 在つて「帯」だけ無かつた。`夕方` `深夜` `未明` `終日` `朝` `夜` も 0 行・案内も無し。
 *
 * 直し – 午前後は正午を境にする公用の決まりが在るので受ける（品書の時刻は時の頭が必ず 0 埋め –
 * 時刻を持つ 688 行で 1 桁の時は 0 行 – なので二桁の `HH:` だけで帯を作る。`9:` は `19:00` を
 * 含んで化ける – 第 315 回）。其の他の時間帯の名前（夕方・深夜・未明・終日 …）は人によって幅が
 * 違うので表側で幅を作らず、其の場で打ち直しを書く（其の週のいつを指すか決めないと断つた旬 –
 * 第 416 回 – と同じ扱い）。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る。
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

/** 件の数欄に出る文を全部集める（案内の通道が幾つもあるので – 第 355 回以来的な測り方）。 */
function 案内(語: string): string {
  const 庫 = Recommender as unknown as Record<string, unknown>;
  const 文 = Object.keys(庫)
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
    .join(" ｜ ");
  return 文.replace(/\s+/g, " ");
}

describe("午前後の帯", () => {
  it("『午前』『午後』が絞り込みになり、互いに重ならない", () => {
    expect(列("午前").size, "『午前』の行が在らない").toBeGreaterThan(0);
    expect(列("午後").size, "『午後』の行が在らない").toBeGreaterThan(0);
    const 重 = [...列("午前")].filter((行) => 列("午後").has(行));
    expect(重.length, "午前と午後の帯が同じ行を出した").toBe(0);
  });

  it("言い換え（午前中・ごぜん / 午後中・ごご）は同じ行集合", () => {
    for (const [語, 基] of [
      ["午前中", "午前"],
      ["ごぜん", "午前"],
      ["午後中", "午後"],
      ["ごご", "午後"],
    ] as const) {
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("助詞を付きただけの形も同じ帯（『午後に』が午前の帯に化けない）", () => {
    /* 助詞を含めた全体で帯を分けると『午後に』が午前に化けた（実測で割った – 打ち直し）。 */
    for (const [語, 基] of [
      ["午後に", "午後"],
      ["午後は", "午後"],
      ["午後も", "午後"],
      ["午前で", "午前"],
      ["午前の", "午前"],
    ] as const) {
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("敬語で閉じた形も同じ帯（『午後でした』）", () => {
    for (const [語, 基] of [
      ["午後です", "午後"],
      ["午前 でした", "午前"],
    ] as const) {
      expect(列(基).size, `「${基}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
  });

  it("帯は其の内の時刻を含む（9時は午前、17時台と正午は午後）", () => {
    /* 檢査用ビルド（435 行）に 09 時・17 時の行が無く、其の方で測ると空振りになる
     * （実測 0 行 – 2026-10-08）なので、其の方にある時刻で見る。 */
    for (const [時刻, 帯] of [
      ["08:59", "午前"],
      ["12時", "午後"],
      ["正午", "午後"],
      ["23:59", "午後"],
      ["20時59分", "午後"],
    ] as const) {
      const 行々 = 列(時刻);
      expect(行々.size, `「${時刻}」の行が在らない（検査が空振り）`).toBeGreaterThan(0);
      const 落 = [...行々].filter((行) => !列(帯).has(行));
      expect(落.length, `「${時刻}」の行が「${帯}」の帯から落ちた`).toBe(0);
    }
  });

  it("一字の時の形を作らない（『9:』は『19:00』を含んで化ける – 第 315 回）", () => {
    const 庫 = Recommender as unknown as Record<
      string,
      (語: string) => { terms: string[]; 解: string } | null
    >;
    const 午 = 庫.clockTimeTermsJa("午後");
    const 前 = 庫.clockTimeTermsJa("午前");
    expect(午, "『午後』が帯に解けない").not.toBeNull();
    expect(前, "『午前』が帯に解けない").not.toBeNull();
    expect(午!.terms).toHaveLength(12);
    expect(前!.terms).toHaveLength(12);
    for (const 語 of [...午!.terms, ...前!.terms]) {
      expect(/^([01][0-9]|2[0-3]):$/.test(語), `一字の時の形が混んだ: ${語}`).toBe(true);
    }
    expect(午!.解).toContain("正午");
    expect(前!.解).toContain("正午");
  });

  it("帯で他の語と繋げれば両方の掛かる行だけ（『明日の午後』）", () => {
    const 繋 = 列("明日の午後");
    expect(列("明日").size, "『明日』の行が在らない").toBeGreaterThan(0);
    const 午後の外 = [...繋].filter((行) => !列("午後").has(行));
    expect(午後の外.length, "『明日の午後』が午後の帯の外を出した").toBe(0);
    const 明日の外 = [...繋].filter((行) => !列("明日").has(行));
    expect(明日の外.length, "『明日の午後』が『明日』の外を出した").toBe(0);
  });
});

describe("時間帯の名前は幅を作らない", () => {
  const 名前 = [
    "夕方",
    "夕方頃",
    "朝方",
    "明け方",
    "夜明け",
    "深夜",
    "真夜中",
    "未明",
    "夜間",
    "終日",
    "一日中",
    "お昼",
    "お昼過ぎ",
    "真昼",
    "昼間",
    "夜",
    "朝",
  ];

  it("其れらでは絞り込まないが、打ち直し方を其の場で書く", () => {
    for (const 語 of 名前) {
      expect(列(語).size, `「${語}」で行が出てしまった（幅を作った）`).toBe(0);
      const 文 = 案内(語);
      expect(文, `「${語}」の案内が無い（黙って 0 件）`).toContain("時間帯の名前");
      expect(文, `「${語}」の案内に打ち直しが無い`).toContain("午後5時");
    }
  });

  it("敬語で閉じても同じ案内が出る（『深夜ですね』）", () => {
    for (const 語 of ["夕方です", "深夜ですね", "終日でした", "朝 ですよ"]) {
      expect(列(語).size, `「${語}」で行が出てしまった`).toBe(0);
      expect(案内(語), `「${語}」の案内が無い`).toContain("時間帯の名前");
    }
  });
});

describe("壊して居ない物", () => {
  it("『午前12時』は受けない侭（正午にも 0 時にも読める – 締切の推測はしない）", () => {
    expect(列("午前12時").size).toBe(0);
    expect(対称差("午後12時", "12時"), "『午後12時』が正午から外れた").toBe(0);
  });

  it("『午後まで』は時刻までの頼み方の侭（帯に化けない）", () => {
    expect(列("午後まで").size, "『午後まで』で行が出てしまった").toBe(0);
    expect(案内("午後まで"), "『午後まで』の案内が消えた").toContain("時刻まで");
    expect(案内("午後まで"), "『午後まで』が帯の案内に化けた").not.toContain("12:00〜23:59");
  });

  it("其の他の時刻の打ち方は其侭", () => {
    for (const [語, 基] of [
      ["20時59分", "20:59"],
      ["午後8時59分", "20:59"],
      ["午後12時", "12時"],
    ] as const) {
      expect(対称差(語, 基), `「${語}」が「${基}」と違う行を出した`).toBe(0);
    }
    expect(列("20:59").size, "『20:59』の行が在らない（検査が空振り）").toBeGreaterThan(0);
    expect(列("23:59").size, "『23:59』の行が在らない").toBeGreaterThan(0);
  });

  it("成果物に帯の表と時間帯の名前の表が一つずつ在る", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [形, 度] of [
      ["const 帯 = /^(午前中", 1],
      ['帯[1] === "午後"', 1],
      ["時間帯の名前Ja", 2],
    ] as const) {
      const 数 = 物.split(形).length - 1;
      expect(数, `「${形}」が ${数} 回（期待 ${度} 回）`).toBe(度);
    }
  });
});
