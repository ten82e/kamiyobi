/**
 * 分野の語を**片仮名の長表記で打った人**の検査（SPEC §4・§7・第 324 回）。
 * `TOPIC_QUERY_ALIASES_JA` に無い日本語の語は、行にその語が書かれていなければ 0 件になる。
 * 2026-09-26 に 2026-08-09 生成の実ビルドで実測した残りを直した（品書 872 行 / 収録 3,250 行）:
 * `エージェント` 0 → 14 行（収録 34 行）・`アクセラレータ` `アクセラレーター` 0 → 3 行（4 行）・
 * `ワイヤレス` 0 → 7 行（23 行）・`知識表現` 0 → 2 行（19 行）・
 * `クラウドコンピューティング` 0 → 25 行（44 行）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { conf?: { name?: string }; hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}

function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): string[] {
  const match = Recommender.searchMatcher(query, AT);
  return rows
    .filter((row) => match(row.hay) === true)
    .map((row) => String(row.conf?.name || row.hay));
}

/** 対になった語（日本語の語 → 寄せ先）。第 324 回に足した物。 */
const 対: Array<[string, string]> = [
  ["エージェント", "agent"],
  ["アクセラレータ", "accelerator"],
  ["アクセラレーター", "accelerator"],
  ["ワイヤレス", "wireless"],
  ["知識表現", "knowledge representation"],
  ["クラウドコンピューティング", "cloud"],
];

describe("分野の語を片仮名の長表記で打つ人", () => {
  it("寄せ先と同じ行に会える", () => {
    const rows = 品書();
    対.forEach(([日本語, 寄せ先]) => {
      expect(
        当たり(rows, 日本語).sort(),
        `"${日本語}" が "${寄せ先}" と違う行を出している`,
      ).toEqual(当たり(rows, 寄せ先).sort());
    });
  });

  it("実データでは 0 件では無くなっている（測った規模）", () => {
    const rows = 収録();
    const 実測: Array<[string, number]> = [
      ["エージェント", 30],
      ["アクセラレータ", 3],
      ["アクセラレーター", 3],
      ["ワイヤレス", 20],
      ["知識表現", 15],
      ["クラウドコンピューティング", 40],
    ];
    実測.forEach(([日本語, 以上]) => {
      expect(
        当たり(rows, 日本語).length,
        `"${日本語}" が 0 件に近い（寄せが消えた）`,
      ).toBeGreaterThanOrEqual(以上);
    });
  });

  it("寄せが働いている（画面に出る品書で、日本語の語が行に書かれていない）", () => {
    const rows = 品書();
    対.forEach(([日本語]) => {
      const 書く行 = rows.filter((row) => String(row.hay).includes(日本語)).length;
      expect(書く行, `"${日本語}" は行に書かれている（前提が変わった – §7 を直す）`).toBe(0);
    });
  });

  it("件数欄は寄せた先を英語の語として言う（画面に出る語を寄せる）", () => {
    /* 件数欄の文は「英語で書かれた会議名（… など）も探しています」なので、寄せ先は画面に
     * 出せる形にしておく – 行を増やせるからと言って件数欄に載せられない語を置いていないこと。 */
    対.forEach(([日本語, 寄せ先]) => {
      const notes = Recommender.querySynonymNotes(日本語).join("");
      expect(notes.includes(日本語), `"${日本語}": 打った語を言っていない`).toBe(true);
      expect(notes.includes(寄せ先), `"${日本語}": 寄せ先 "${寄せ先}" を言っていない`).toBe(true);
      expect(notes.includes("英語で書かれた会議名"), `"${日本語}": 寄せの意味を省いた`).toBe(true);
    });
  });

  it("寄せの利きは表を通して測る – 複数語の寄せ先は語を分ける", () => {
    /* `侵入検知` の旧来的な寄せ先 `intrusion detection` は、**画面に出る品書で追加 0 行**だった
     * – 寄せは語のかたまりのまま照らすので、収録が "Intrusion Detection" と書いた行にしか
     * 当たらない（`intrusion` と `detection` を別々に含む行は 1 行在る – 実測）。語を分けた
     * `intrusion` に替えて品書 0 → 1 行・収録 5 → 15 行になった。同じ失敗を戻さないための検査。 */
    expect(Recommender.queryTokenGroups("侵入検知"), "`侵入検知` の寄せ先が変わった").toEqual([
      ["侵入検知", "intrusion"],
    ]);
    /* 実測: 品書 0 → 1 行・収録 5 → 15 行（試験用の品書にはこの行が無いので収録側で見る）。 */
    const 収録行 = 収録();
    expect(
      当たり(収録行, "侵入検知").length,
      "`侵入検知` が 5 件以下のまま（寄せ先をかたまりに戻した）",
    ).toBeGreaterThanOrEqual(15);
    expect(収録行.length, "収録が読めない").toBeGreaterThan(100);
    /* 寄せ先と同じ行に会えること – 語を分けたので、収録が "Intrusion Detection" と書いた行も
     * `intrusion` を書く行も、どちらも拾える（かたまりだと後者だけが漏れた – 実測）。 */
    expect(
      当たり(収録行, "侵入検知").sort(),
      "`侵入検知` が `intrusion` と違う行を出している",
    ).toEqual(当たり(収録行, "intrusion").sort());
  });

  it("当たりが行に在る語なので、0 件案内は立てない", () => {
    対.forEach(([日本語]) => {
      expect(Recommender.uiWordNoteJa(日本語), `"${日本語}" に 0 件案内を立てた`).toBe("");
    });
  });
});
