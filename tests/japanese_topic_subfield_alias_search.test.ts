import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 検索の土臺は実際の品書で張る（目録 3,280 行とは少し当りが違ふので、こちらの数を正とする）。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}
const rows = 品書();
function 當る行(文: string): Row[] {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return rows.filter((r) => m(String(r.hay)) === true);
}
function 當(文: string): number {
  return 當る行(文).length;
}
function 注(文: string): string {
  return Recommender.querySynonymNotes(文).join("\n");
}

/** この回に載せて屆いた十七本（載せる前は検索し 0 行 – 実測の当り）。 */
const 寄せ: [string, string, number][] = [
  ["人間コンピュータ相互作用", "human-computer interaction", 52],
  ["情報可視化", "visualization", 36],
  ["視覚化", "visualization", 36],
  ["セマンティックウェブ", "semantic web", 33],
  ["モバイルコンピューティング", "mobile computing", 24],
  ["デジタルフォレンジック", "digital forensics", 8],
  ["要求工学", "requirements", 16],
  ["バーチャルリアリティ", "virtual reality", 16],
  ["ソフトウェア品質", "software quality", 12],
  ["医用画像", "medical image", 12],
  ["インターネット測定", "internet measurement", 10],
  ["3次元", "3d", 8],
  ["並行処理", "concurrency", 6],
  ["地理情報", "geographic information", 6],
  ["量子情報", "quantum", 6],
  ["自然言語生成", "natural language generation", 4],
  ["ハードウェア", "hardware", 48],
];

describe("細目の分野の和名を英字の会議名へ寄せる（第 674 回）", () => {
  it("載せた十七本が検索しで行を受け、案内が英字の綴りを復唱する", () => {
    for (const [和名, , 件] of 寄せ) {
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
  });

  it("当たりは寄せ先の語かその方の和名を持つ – 内訳を外から見る", () => {
    for (const [和名, 英] of 寄せ) {
      const 語 = 英.split(/[\s-]+/);
      const 外 = 當る行(和名).filter((r) => {
        const x = String(r.hay).toLowerCase();
        return !語.some((w) => x.includes(w.toLowerCase())) && !x.includes(和名.toLowerCase());
      });
      expect(外, `${和名} が寄せ先の語も和名も持たん行を當てた`).toEqual([]);
    }
  });

  it("並べ語の寄せ先を載せ直した四本が屆く（第 674 回に拔いた理由の訂正）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");

    const 載せ直し: [string, number][] = [
      ["ワイヤレスネットワーク", 13],
      ["ネットワーク測定", 21],
      ["ネットワーク計測", 21],
      ["ネットワーク管理", 5],
    ];
    for (const [和名, 件] of 載せ直し) {
      expect(表.includes(`["${和名}",`), `${和名} が表から消えた`).toBe(true);
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
    /* その方の短い打ち手も今まで通り行が出る（载せ直しても減つて居らん – 検索の振ひで減 0）。 */
    expect(當("ワイヤレス"), "ワイヤレス の当たりが動いた").toBe(23);
    expect(當("無線")).toBe(23);
    expect(當("モバイル")).toBe(44);
    expect(當("ネットワーク"), "ネットワーク 単体の当たりが動いた").toBeGreaterThan(200);
  });

  it("寄せ先が会場名・説明文に当つ組は載せん（第 673 回の決まりの續き）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    for (const 和名 of ["モンテカルロ法", "位置情報", "メタデータ", "科学計算"]) {
      expect(表.includes(`["${和名}",`), `${和名} を載せてしまつた`).toBe(false);
    }
    /* `monte` 単体の当たりは FPGA 会場名の话で、モンテ・カルロ法の会議は品書に無い。 */
    expect(當("monte carlo"), "モンテ・カルロ法の会議が入つたか？").toBe(0);
    expect(
      當る行("location").some((r) => !/location-based/i.test(String(r.hay))),
      "location が説明文に当つ事実",
    ).toBe(true);
    /* `metadata` は CHI の説明文に当つ（主題の欄ではない – 検索しが数へん欄の内訳を見る）。*/
    expect(當("メタデータ"), "メタデータ の和名を載せ直したか？").toBe(0);
    /* 拡張現実 は既に ISMAR 8 行を受けるので dup に載せん。*/
    expect(當("拡張現実")).toBe(8);
  });

  it("検索の振ひを動かしらん – 第 673 回からの金庫と表の在處", () => {
    const 金庫: Record<string, number> = {
      暗号: 117,
      視覚: 250,
      機械学習: 504,
      multimedia: 69,
      ヒューマンコンピュータインタラクション: 138,
      計算機科学: 0,
      // 性能評価 は第 675 回の検索し側の直しで 2 行屆くやうになつた（PERFORMANCE 2026）。
      性能評価: 2,
      検索技術: 58,
      "30日以内": 689,
      OA: 0,
    };
    for (const [文, 件] of Object.entries(金庫)) expect(當(文), `搜 ${文}`).toBe(件);
    expect(rows.length).toBe(3250);
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    const 本 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    // 分けの時に 119 条 – 載せ增しで增えるので下限だけ張る（確数は各回合が持つ）。
    expect((表.match(/^\s*\["/gm) || []).length, "条目が減つた").toBeGreaterThanOrEqual(119);
    expect(本).toContain('from "./topic-aliases.ts"');
  });
});
