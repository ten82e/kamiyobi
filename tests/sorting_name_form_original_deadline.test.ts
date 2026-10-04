import { queryReferenceSnapshotPath } from "./query_reference.ts";
/**
 * 並び方・名前の形・延伸前の日付を普通の日本語で打った人（第 643 回）。
 * 實測（品書 3,250 行・固定時刻 2026-08-09T00:00:00Z – 2026-08-09 生成）で、
 * `年度順` `少ない順` `多い順` `並べる` `並べたい` `並びたい` `並ぶ` `並べて`、
 * `略稱` `略称` `正式名` `正式名称` `英語名` `和名` `アルファベット` `ローマ字`、
 * `元々の締切` `本来の締切` `延長前` はいずれも **0 行で案内も無し**だつた。
 * 同じ羣に在る `日付順`（第 248 回）や `延長した締切`（第 506 回）は通るので、
 * 語の形が少し變はつただけで默る穴だった。此處では
 *  ① 十九語がそれゝ在る羣の案内を受け取る事、
 *  ② 案内が噓を言はない事（名前の形は實際に同じ行が出る・十九語は行を増やさん事）、
 *  ③ 聲の文が新しい羣の長さの決まり（六十字）に納まる事
 * を張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): string[] {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((row) => match(String(row.hay)) === true).map((row) => String(row.hay));
}

/** 案内の通道（件數欄に出る物）を一本に纏める。 */
function 案内(語: string): string {
  return [
    Recommender.uiWordNoteJa(語, false),
    Recommender.wholeTableQueryNoteJa(語),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ")
    .trim();
}

const 並べ = ["年度順", "少ない順", "多い順", "並べる", "並べたい", "並びたい", "並ぶ", "並べて"];
const 名前 = ["略稱", "略称", "正式名", "正式名称", "英語名", "和名", "アルファベット", "ローマ字"];
const 延伸前 = ["元々の締切", "本来の締切", "延長前"];
const 十九語 = [...並べ, ...名前, ...延伸前];

describe("並び方・名前の形・延伸前の日付の打ち手（第 643 回）", () => {
  it("十九語が默らん – それゝ在る羣の答えを受け取る", () => {
    for (const 語 of 十九語) {
      expect(案内(語), `"${語}" が無言に逆戻りした`).not.toBe("");
    }
    for (const 語 of 並べ) {
      expect(案内(語), `"${語}" が並べ方の列の話をして居ん`).toContain("見出し");
    }
    for (const 語 of 名前) {
      const 案 = 案内(語);
      expect(案, `"${語}" が名前のもつ形を敎へて居ん`).toContain("略稱");
      expect(案, `"${語}" が正式名の話をして居ん`).toContain("正式");
    }
    for (const 語 of 延伸前) {
      expect(案内(語), `"${語}" が延伸の印の置き場所を敎へて居ん`).toContain("締切延長");
    }
  });

  it("名前の形の案内は實物と合う – 略稱と正式名が同じ行に出會へる", () => {
    const rows = 收錄();
    const 略 = 当たり(rows, "icassp");
    const 正式 = 当たり(rows, "international conference on acoustics");
    expect(略.length, "前提 – `icassp` の行が減つた（案内の數を直す）").toBe(7);
    expect([...正式].sort(), "略稱と正式名で並ぶ行が違う – 案内が噓になる").toEqual([...略].sort());
  });

  it("十九語は行を増やさん（噓の門を開けん – 第 337 回）", () => {
    const rows = 收錄();
    for (const 語 of 十九語) {
      expect(
        当たり(rows, 語).length,
        `"${語}" に行が届いた（羣の案内では無く搜しの話になつた）`,
      ).toBe(0);
    }
  });

  it("聲に讀む文は新しい羣の長さの決まり（六十字）に納まる", () => {
    for (const 語 of 十九語) {
      const 文 = String(Recommender.uiWordLiveNoteJa(語) || "").trim();
      expect(文, `"${語}" の聲の文が空`).not.toBe("");
      expect(文.length, `"${語}" の聲の文が長い（${文.length}字）`).toBeLessThanOrEqual(60);
    }
  });

  it("羣の歸屬が一つに決まる – 同じ語を二羣に載めん（第 511 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    for (const 語 of 十九語) {
      expect(
        源.split(`"${語}"`).length - 1,
        `"${語}" が源に二度以上並んで居る（別の羣と喧嘩する）`,
      ).toBe(1);
    }
  });

  it("畫面上の説明に中國語の略字を混ぜん", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = 源.indexOf('"略稱", "略称"');
    expect(i, "名前の形の羣が見つからん").toBeGreaterThan(-1);
    const 文 = 源.slice(i, 源.indexOf("},", i));
    for (const 字 of ["它", "语", "实", "级", "弹"]) {
      expect(文, `中國語の略字「${字}」が混んだ`).not.toContain(字);
    }
  });
});
