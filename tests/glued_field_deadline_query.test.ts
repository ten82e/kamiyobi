/** 分野の語と締切を繋げて打つ打ち方の檢査（SPEC §7・第 528 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
const 品書 = (): Row[] =>
  Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
const 收录 = (): Row[] =>
  Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
function 集(rows: Row[], 文: string): Set<string> {
  const m = Recommender.searchMatcher(文, AT);
  return new Set(rows.filter((r) => m(r.hay) === true).map((r) => String(r.hay)));
}

/** 繋げた打ち方（語）と空格（空格文）の組 – 實測で繋げた方だけ 0 件だつた物（第 528 回）。 */
const 組: Array<[string, string]> = [
  ["機械学習締切", "機械学習 締切"],
  ["HPC締切", "HPC 締切"],
  ["自然言語処理締切", "自然言語処理 締切"],
  ["データベース締切", "データベース 締切"],
  ["ネットワーク締切", "ネットワーク 締切"],
  ["計算論言語学締切", "計算論言語学 締切"],
];

describe("分野の語に締切を繋げて打つ人", () => {
  it("繋げた打ち方が空格と同じ行に出る（品書 – 廣げず狹めず）", () => {
    const rows = 品書();
    組.forEach(([語, 空格]) => {
      const a = 集(rows, 語);
      const b = 集(rows, 空格);
      // 品書の fixtures（435 行）には `自然言語処理` の行が無い – 同じ 0 件なら正しい（實測では
      // 繋がぬ方が 20 件 – 下の收录の條で 0 件でない事を張る）。
      expect([...a].sort(), `"${語}" が空格 "${空格}" と違う行に出た`).toEqual([...b].sort());
    });
  });

  it("収録でも同じ件數になる（data/snapshot.json は品書より多い – 絕對値では張らない）", () => {
    const rows = 收录();
    組.forEach(([語, 空格]) => {
      expect(集(rows, 語).size, `"${語}" が收录で空格と數が違った`).toBe(集(rows, 空格).size);
      expect(集(rows, 語).size).toBeGreaterThan(0);
    });
  });

  it("其の方で行が出ない語を割らない（靜かに廣げない – 第 362 回）", () => {
    const rows = 品書();
    // `分散計算` は單體 0 行（實測）なので、繋げた打ち方も 0 件の侭が正しい。
    expect(集(rows, "分散計算").size).toBe(0);
    expect(集(rows, "分散計算締切").size).toBe(0);
    // 締切の語尾の側の決まり（第 517 回）も其侭 – `論文締切` は寄せ表が先に受ける。
    expect(集(rows, "論文締切").size, "`論文締切` の行が減つた").toBeGreaterThan(200);
    // 実ビルド（品書 868 行）では 機械学習締切 49・HPC締切 84・計算論言語学締切 5 件（第 528 回）。
  });

  it("割りの頭の一覽に彈いた語を足して居ない（ソース側の張り – 第 519 回）", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf("function 締切の語尾に割るJa");
    const 域 = b.slice(i, b.indexOf("\n  }", i));
    // 品書に行を持たん語（`期限` `応募` `募集`）を頭や語尾に混ぜると、割れて 0 件の幅になる。
    ["期限", "応募", "募集", "締め切り"].forEach((語) => {
      expect(域.includes(`"${語}"`), `"${語}" を割りの語尾に混ぜた（品書 0 行）`).toBe(false);
    });
  });
});
