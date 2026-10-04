/**
 * 審る話の日本語の言い換えを収録の語へ寄せる檢査（SPEC §7・第 611 回）。
 * 實測（2026-08-09 生成の実ビルド 868 行・固定時刻 2026-08-09T00:00:00Z）:
 * `査読` 13 行・`査読結果公開` 13 行が通るのに、`審査` **0 行**・`レフェリー` **0 行**・
 * `審査される` **0 行**で、畫 face は「0 件」だけを出した。日本人の研究者は此の方の語を普通
 * に書く（「査読」は案内文で、「審査」は口語で）。同じ事を訪ねて居るので、**畫面に出る種別
 * の語**へ寄せて、寄せた事を案内に書く（默って意味の廣がる行を出さん – 第 246 回・第 337 回）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 収録(): Array<{ hay: string }> {
  const data = JSON.parse(
    readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(data) as unknown as Array<{ hay: string }>;
}

/* 品書（ビルド成果）で數へる – fixtures でも切れないやう比較だけ使う。*/
function 品書行列表(語: string): string[] {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((row) => matches(String(row.hay)) === true)
    .map((r) => r.hay)
    .sort();
}

/* 収録（data/snapshot.json）で數へる – 絕對値を張れるのは此の方（第 522 回と同じ分け）。*/
function 行列表(語: string): string[] {
  const matches = Recommender.searchMatcher(語, 基準);
  return 収録()
    .filter((row) => matches(String(row.hay)) === true)
    .map((r) => r.hay)
    .sort();
}

/* 打ち方 → 案内が名指す語（助詞で割れた形は割れた側の語を名指す – 第 505 回と同じ流儀）。*/
const 寄せた語: Array<[string, string]> = [
  ["審査", "審査"],
  ["レフェリー", "レフェリー"],
  ["審査される", "審査"],
  ["査読料", "査読料"],
];

describe("審る話の別の言い方", () => {
  it("収録の語で行くと同じ行集合になる", () => {
    const 正 = 品書行列表("査読結果公開");
    for (const [文] of 寄せた語.slice(0, 3)) {
      expect(品書行列表(文), `"${文}" が品書で別の行を出している`).toEqual(正);
    }
    /* 絕對値は収録で張る（品書は fixtures なので語が抜ける事がある）。*/
    const 収録の正 = 行列表("査読結果公開");
    expect(収録の正.length, "前提 – 寄せ先が 0 行では檢査が空振りする").toBeGreaterThan(0);
    expect(行列表("審査"), "審査 を寄せた先と行集合が違う").toEqual(収録の正);
    expect(行列表("レフェリー")).toEqual(収録の正);
    expect(行列表("査読料"), "金を訪ねる語まで寄せた").toHaveLength(0);
  });
  it("寄せた事を案内に書く（默って廣げん – 第 246 回）", () => {
    for (const [文, 名] of 寄せた語.slice(0, 3)) {
      const 案内 = (Recommender.querySynonymNotes(文) || []).join("");
      expect(案内, `「${文}」の寄せ案内が消えて居る`).toContain(`「${名}」`);
      expect(案内).toContain("査読結果公開");
    }
  });
  it("人を訪ねる打ち方は寄せん（行の種別と話が違う – 第 337 回）", () => {
    /* `査読者` `審査員` は審査員を募る話。審査の段階の日を出す表に寄せると噓になるので、
     * 案内の群が受ける（0 件の侭 «區別は持っていません» を出す）。*/
    for (const 文 of ["査読者", "審査員", "査読料"]) {
      expect(行列表(文).length, `「${文}」を行に寄せた`).toBe(0);
      const 案内 = String(Recommender.uiWordNoteJa(文) || "");
      expect(案内, `「${文}」が默つて居る`).toContain(文);
      expect(案内, `「${文}」の斷りが噓を言ふ形になった`).toContain("この表");
    }
  });
  it("`ピアレビュー` は案内の群が持つ – 言い換えの表に二重に載せん（第 246 回・第 378 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const QUERY_SYNONYMS_JA");
    const 片 = 源.slice(i, 源.indexOf("\n  ];", i));
    expect(片.includes('["ピアレビュー"'), "言い換えの表に載つた（群と二重になる）").toBe(false);
    /* 群の方で受けるので默らん事だけ確かめる（第 535 回）。*/
    expect(String(Recommender.uiWordNoteJa("ピアレビュー") || "")).toContain("ピアレビュー");
  });
});
