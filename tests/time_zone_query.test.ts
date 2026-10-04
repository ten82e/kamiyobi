/**
 * タイムゾーンと「土日」の言い方の検査（SPEC §4・§7・第 336 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `土日` **0 行**（同じ意味の `週末` 268 行・`平日` 604 行）、`日本時間` `日本標準時`
 * `世界標準時` `協定世界時` `グリニッジ標準時` **いずれも 0 行**（行の表記 `JST` 688 行・
 * `AoE` 492 行・`UTC` 176 行・`GMT` 6 行は当たっていた）。
 * 収録の含みも実測で留める: 「日本時間」の行（=JST）は**時刻を持つ行 688 行と一致**し、
 * `AoE`（492 行）・`UTC`（176 行）の行はすべて JST の表記も持つ – だから「AoE の行は出ません」
 * とは書けない。検査ハーネスの品書（435 行）でも同じ不変条件が成り立つ（土日 145 行・
 * 日本時間 251 行・世界標準時 68 行）ので、実ビルドの件数は検査に書かない（第 331 回の教訓）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 行集合(語: string): Set<string> {
  return new Set(行列表(語).map((row) => String(row.hay)));
}

function 対称差(a: Set<string>, b: Set<string>): number {
  return [...a].filter((行) => !b.has(行)).length + [...b].filter((行) => !a.has(行)).length;
}

describe("タイムゾーンと曜日の言い方", () => {
  it("「土日」は「週末」と同じ行に出て、平日の行を混ぜない", () => {
    const 土日 = 行集合("土日");
    expect(土日.size, "『土日』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    expect(対称差(土日, 行集合("週末")), "「土日」と「週末」が割れた").toBe(0);
    expect(
      [...土日].filter((行) => 行集合("平日").has(行)).length,
      "「土日」に平日が混ざった",
    ).toBe(0);
  });

  it("「日本時間」は行に JST と書かれた行を受け、他の言い方も同じ", () => {
    const 日本時間 = 行集合("日本時間");
    expect(日本時間.size, "『日本時間』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    ["日本標準時", "日本標準時間", "JST"].forEach((語) => {
      expect(対称差(行集合(語), 日本時間), `"${語}" が「日本時間」と違う行を出した`).toBe(0);
    });
    /* JST の表記は時刻の書いてある行に付く – だから「日本時間」= 時刻が書かれた行。
     * この等しさが案内の正しい書き方の根拠（第 336 回）。 */
    const catalog = JSON.parse(
      readFileSync(join(builtSite(), "catalog.json"), "utf8"),
    ) as unknown as never;
    const 全行 = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
    const 時刻付き = new Set(
      全行
        .filter((row) => /[0-9]{1,2}:[0-9][0-9]/.test(String(row.hay)))
        .map((row) => String(row.hay)),
    );
    expect(対称差(日本時間, 時刻付き), "「日本時間」が時刻の書いてある行と一致しなくなった").toBe(
      0,
    );
  });

  it("「世界標準時」は UTC と GMT の両方に出会う", () => {
    const 世界 = 行集合("世界標準時");
    expect(世界.size, "『世界標準時』が 0 行のまま（前提が崩れた）").toBeGreaterThan(0);
    const 和集合 = new Set([...行集合("UTC"), ...行集合("GMT")]);
    expect(対称差(世界, 和集合), "「世界標準時」が UTC・GMT の和集合と割れた").toBe(0);
    ["協定世界時", "グリニッジ標準時", "グリニッジ平均時"].forEach((語) => {
      expect(対称差(行集合(語), 世界), `"${語}" が「世界標準時」と違う行を出した`).toBe(0);
    });
  });

  it("含みを案内に書く – AoE の行は「日本時間」に含まれるので、出ませんとは書かない", () => {
    /* AoE と書かれた行はすべて JST の表記も持つ（実測で越え 0 行）。 */
    const 日本時間 = 行集合("日本時間");
    expect([...行集合("AoE")].filter((行) => !日本時間.has(行)).length).toBe(0);
    const 案内 = Recommender.querySynonymNotes("日本時間");
    expect(案内.length, "案内の行数が違う").toBe(2);
    expect(案内[1]).toContain("行に書かれた時刻を変換はしません");
    expect(案内[1], "AoE・UTC の行を含むと書いていない").toContain("AoE・UTC の行も含みます");
    expect(案内[1]).not.toContain("出ません");
    const utc = Recommender.querySynonymNotes("世界標準時");
    expect(utc[1]).toContain("AoE と書かれた行もこの含みです");
    /* 曜日とタイムゾーンの案内は打ち手に合わせた語で出る（寄せた事を隠さない）。 */
    expect(Recommender.querySynonymNotes("土日")[0]).toContain("土曜日の行と日曜日の行");
    /* 関係のない語に付けない。 */
    expect(Recommender.querySynonymNotes("アジア").join("")).not.toContain("変換はしません");
  });

  it("収録が持たない頼み方は 0 件のまま – 祝日・現地時間・タイムゾーン", () => {
    /* 祝日は休日の情報の収録が無く、推測しない（AGENTS.md）。「現地時間」は行に書かれた
     * 表記が無いので、寄せた事にして件数欄を噓にしない。 */
    ["祝日", "現地時間", "タイムゾーン", "夏時間", "年末年始"].forEach((語) => {
      expect(行集合(語).size, `"${語}" を受けてしまった`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join(""), `"${語}" の案内を立てた`).toBe("");
    });
  });

  it("他の語を足せば絞り込みになる", () => {
    const 時間 = 行集合("日本時間");
    const 絞った = 行集合("日本時間 ワークショップ");
    expect(絞った.size).toBeGreaterThan(0);
    expect(時間.size).toBeGreaterThan(絞った.size);
    expect([...絞った].filter((行) => !時間.has(行)).length, "足した語で行が増えた").toBe(0);
  });

  it("成果物が言い方の表と案内の文を持つ（第 336 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 断片列表: Array<[RegExp, string]> = [
      [/"土日",\s*"土曜日の行と日曜日の行"/, "「土日」の条目"],
      [/"日本時間",\s*"行の時刻に書かれた JST という語"/, "「日本時間」の条目"],
      [/"協定世界時",\s*"行の時刻に書かれた UTC・GMT の語"/, "「協定世界時」の条目"],
      [/ZONE_QUERY_WORDS_JA/, "タイムゾーンの案内の表"],
      [/行に書かれた時刻を変換はしません/, "変換しない事の案内"],
    ];
    断片列表.forEach(([形, 名前]) => {
      expect(形.test(rec), `組み立てた画面から ${名前} が消えた`).toBe(true);
    });
  });
});
