/**
 * 参加形式の言い方（第 383 回）。実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・
 * 固定時刻 2026-08-09T00:00:00Z）: 参加形式の印は `オンライン参加可` 24 行が通るのに、日本で
 * 書かれる別の言い方 `リモート参加` `遠隔参加` `ネット参加` `ネット開催` `ウェブ参加`
 * `ウェビナー` `オンライン形式` `在宅参加` `在宅` `ハイフレックス` は **0 行で案内も無し**
 * だった（其の方の `リモート` `遠隔` `ウェブ開催` `web開催` は 24 行通る – 品書の文本にも
 * "webinar" 0 箇所・"hyflex" 0 箇所）。逆の言い方（`対面のみ` `現地参加` `オフライン`
 * `リアル開催`）は既に 0 件の案内が出て居り、`オンライン参加可` へ寄せると反対の意味に成る
 * ので寄せない（第 337 回）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 其の方 = "オンライン参加可";

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 寄せの案内(語: string): string {
  return Recommender.querySynonymNotes(語).join("・");
}

const 打ち方 = [
  "リモート参加",
  "遠隔参加",
  "ネット参加",
  "ネット開催",
  "ウェブ参加",
  "ウェビナー",
  "オンライン形式",
  "在宅参加",
  "在宅",
  "ハイフレックス",
];

describe("参加形式の言い方", () => {
  it("別の言い方で打っても参加形式の印の行を其侭通す", () => {
    const 正 = 当たり列表(其の方);
    expect(正.length, "品書に参加形式の印の行が無い").toBeGreaterThan(0);
    for (const 語 of 打ち方) {
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
    }
  });

  it("寄せた事は件数欄の案内に出す（黙って条件を変えない）", () => {
    for (const 語 of 打ち方) {
      const 案内 = 寄せの案内(語);
      expect(案内, `寄せの案内が出ない: ${語}`).toContain(其の方);
      expect(案内, `行かない先を書かない案内: ${語}`).toContain("参加形式");
    }
    /* 其の方を打った人には寄せの案内を出さない（せる事がない）。 */
    expect(寄せの案内(其の方)).toBe("");
  });

  it("反対の意味の言い方を オンライン参加可 に寄せない（0 件の案内で受けさせる）", () => {
    const オンライン = 当たり列表(其の方);
    for (const 語 of ["対面のみ", "現地参加", "オフライン", "リアル開催"]) {
      const 当たり = 当たり列表(語);
      expect(当たり, `反対の意味が当たり出した: ${語}`).toEqual([]);
      expect(対称差(当たり, オンライン), `オンライン参加可 に広がった: ${語}`).toBe(
        オンライン.length,
      );
    }
  });

  it("`オンラインのみ` を参加形式の印の行すべてに広げない（『のみ』の区別は収録して居ない）", () => {
    const み = 当たり列表("オンラインのみ");
    const オンライン = 当たり列表(其の方);
    expect(み.length).toBeGreaterThan(0);
    expect(み.length, `『のみ』が印の行全部に広がった`).toBeLessThan(オンライン.length);
    expect(寄せの案内("オンラインのみ")).not.toContain(其の方);
  });

  it("足した条目が成果物に一度だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of 打ち方) {
      const 数 = (成果物.match(new RegExp(`"${語}"`, "g")) || []).length;
      expect(数, `条目の数が違う: ${語}`).toBe(1);
    }
  });
});
