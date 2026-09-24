/**
 * 分野の語を**長い表記で打った人**の検査（SPEC §4・§7・第 322 回）。
 * `TOPIC_QUERY_ALIASES_JA` は短い日本語の語だけを置いていて、自然に長い表記が 0 行に
 * なっていた（2026-08-09 生成の実ビルドの品書 872 行で実測: `量子コンピュータ` `量子計算`
 * `暗号論` は 0 行、一方 `quantum` 6 行・`crypto` 31 行・`information theory` は 1 行に
 * 当たる）。短いほうが当たり、長いほうが当たらないのは打ち方の損得が逆なので、長い表記も
 * 同じ行に連れていく。置くのは**追加で行が増える物だけ**（表の方針）。
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

function 当たり(rows: Row[], query: string): string[] {
  const match = Recommender.searchMatcher(query, AT);
  return rows
    .filter((row) => match(row.hay) === true)
    .map((row) => String(row.conf?.name || row.hay));
}

/** 日本語の語が行に書かれていないことを見てから、当たった行を返す（増加分が寄せの実体）。 */
function 寄せで当たった行(rows: Row[], 日本語: string): string[] {
  const 書く行 = rows.filter((row) => String(row.hay).toLowerCase().includes(日本語)).length;
  expect(書く行, `"${日本語}" は行に書かれている（前提が変わった）`).toBe(0);
  return 当たり(rows, 日本語);
}

describe("分野の語を長い表記で打つ人", () => {
  it("長い表記が、短い表記と同じ行に会える", () => {
    /* 試験用のビルド成果物では行セットが同じことだけ見る（規模の数は次の検査で実データを見る）。 */
    const rows = 品書();
    const 対: Array<[string, string]> = [
      ["量子コンピュータ", "quantum"],
      ["量子コンピューター", "quantum"],
      ["量子コンピューティング", "quantum"],
      ["量子計算", "quantum"],
      ["暗号論", "crypto"],
      ["情報理論", "情報理論"],
    ];
    対.forEach(([日本語, 英語]) => {
      const 寄せ = 寄せで当たった行(rows, 日本語);
      if (日本語 !== 英語) {
        expect(寄せ.slice().sort(), `"${日本語}" が "${英語}" と違う行を出している`).toEqual(
          当たり(rows, 英語).sort(),
        );
      }
    });
  });

  it("実データでは、寄せで行が届く（品書より収録のほうが多い）", () => {
    /* 2026-08-09 生成の実ビルドで実測した規模（品書 872 行 / 収録 3,250 行）:
     * `量子コンピュータ` 品書 6 行・収録 6 行 / `暗号論` 品書 31 行・収録 117 行 /
     * `情報理論` 品書 1 行・収録 2 行 – いずれも 0 行だった打ち方だった。 */
    const rows = Recommender.candidateRows(
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
    ) as Row[];
    const 実測: Array<[string, number]> = [
      ["量子コンピュータ", 5],
      ["量子計算", 5],
      ["暗号論", 100],
      ["情報理論", 1],
    ];
    実測.forEach(([日本語, 以上]) => {
      expect(
        当たり(rows, 日本語).length,
        `"${日本語}" が 0 行に近い（寄せが消えた）`,
      ).toBeGreaterThanOrEqual(以上);
    });
  });

  it("寄せが働いている（日本語の語で行を拾っていない）", () => {
    const rows = 品書();
    ["量子コンピュータ", "量子計算", "暗号論"].forEach((語) => {
      expect(寄せで当たった行(rows, 語).length, `"${語}": 寄せの行が無い`).toBeGreaterThan(0);
    });
  });

  it("英語側より狭い日本語は寄せない", () => {
    /* `autonomous` は自律システムまで含む – `自動運転` に寄せると「自動運転の会議」では
     * 無い行を約束することになる（`自律`→`autonomous` を置く既存の検査と同じ判断）。
     * `記憶装置`→`storage` `性能評価`→`performance` も同じ形で置かない。 */
    expect(Recommender.queryTokenGroups("自動運転"), "`自動運転` を寄せた").toEqual([["自動運転"]]);
    expect(Recommender.queryTokenGroups("記憶装置")[0], "`記憶装置` を storage に寄せた").toEqual([
      "記憶装置",
    ]);
    expect(
      Recommender.queryTokenGroups("性能評価")[0],
      "`性能評価` を performance に寄せた",
    ).toEqual(["性能評価"]);
    /* 広い側の語は置いたまま – 落としていないことを見る。 */
    expect(Recommender.queryTokenGroups("自律")[0]).toContain("autonomous");
  });

  it("英語側も 0 行の語は、条目を置かずに 0 行のまま（正直な 0 件）", () => {
    const rows = 品書();
    const 候補: Array<[string, string]> = [
      ["機械翻訳", "machine translation"],
      ["数値計算", "numerical"],
      ["半導体", "semiconductor"],
      ["仮想化", "virtualization"],
      ["データセンター", "data center"],
      ["ファイルシステム", "file system"],
    ];
    候補.forEach(([日本語, 英語]) => {
      expect(Recommender.queryTokenGroups(日本語), `"${日本語}" に寄せを足した`).toEqual([
        [日本語],
      ]);
      /* 収録の書き方に連続した形が無く、寄せても行が増えないことを実測で確認する。 */
      const 増 = rows.filter((row) => String(row.hay).toLowerCase().includes(英語)).length;
      expect(増, `"${日本語}": "${英語}" は行を増やさない（寄せる必要があれば §7 を直す）`).toBe(0);
    });
  });
});
