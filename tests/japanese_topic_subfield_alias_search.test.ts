/** 細目の分野の和名を搜しで打つ人に、會議名の英字の綴りで行を渡す檢査（SPEC §7・第 674 回）。
 *
 * 事實（2026-08-09 生成の実ビルド・搜しの品書 3,250 行）– `ハードウェア`（0 行 / 英字では 48 行）
 * `情報可視化`・`視覚化`（0 / 36）`モバイルコンピューティング`（0 / 24）`要求工学`（0 / 16）
 * `バーチャルリアリティ`（0 / 16）`ソフトウェア品質`（0 / 12）`医用画像`（0 / 12）`インターネット測定`
 * （0 / 10）`セマンティックウェブ`（0 / 33）`デジタルフォレンジック`（0 / 17）`3次元`（0 / 8）
 * `並行処理`（0 / 6）`地理情報`（0 / 6）`量子情報`（0 / 6）`自然言語生成`（0 / 4）は搜し 0 行で、
 * 收錄の會議名には其の方が英字で書かれて居る（`Design Automation Conference` の類ひ –
 * `IEEE Conference on Virtual Reality and 3D User Interfaces` `International Conference on Medical
 * Image Computing and Computer Assisted Intervention` `USENIX Conference on File and Storage
 * Technologies`）。第 673 回と同じ手で `site/topic-aliases.ts` に十七條を載せた（表示は變へん）。
 * 載せきれん物も實測で確かめて拔いた – 其の内譯を下に張る。
 *
 * 第 675 回 – 搜し側が**並べた語の寄せ先を語ごとに數える**やうになつたので、此處の數字が
 * 三本動いた（`セマンティックウェブ` 10 → 33・`モバイルコンピューティング` 20 → 24・
 * `人間コンピュータ相互作用` 1 → 52 – 收錄が語を離して書く行を受け取つた）。拔いた四本
 * （`ネットワーク測定` 等）も同じ直しで載せ直して屆いた – 拔いた本当の理由（語を連なりで
 * 探す振ひだつた）も下に書き直す。第 674 回に「搜しが先に割れる熟語」と書いたのは誤りだつた。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書で張る（目録 3,280 行とは少し當りが違ふので、此方の數を正とする）。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8")),
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

/** 此の回に載せて屆いた十七本（載せる前は搜し 0 行 – 實測の當り）。 */
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

describe("細目の分野の和名を英字の會議名へ寄せる（第 674 回）", () => {
  it("載せた十七本が搜しで行を受け、案内が英字の綴りを復唱する", () => {
    for (const [和名, , 件] of 寄せ) {
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
  });

  it("当たりは寄せ先の語か其の方の和名を持つ – 內譯を外から見る", () => {
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
    /* 第 674 回は「搜しが先に割れる熟語」と書いたが誤りだつた – 搜しは此方の和名を割らずに
     * 一まとめの語として寄せ表を引いて居り、詰まりは**寄せ先の並べた語を連なりで探して**居た
     * （`network measurement` の語を離して書く收錄に屆かん）。搜し側を直した第 675 回で
     * 載せ直して屆いた – 實測の數を張る。 */
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
    /* 其の方の短い打ち手も今まで通り行が出る（载せ直しても減つて居らん – 搜の振ひで減 0）。 */
    expect(當("ワイヤレス"), "ワイヤレス の当たりが動いた").toBe(23);
    expect(當("無線")).toBe(23);
    expect(當("モバイル")).toBe(44);
    expect(當("ネットワーク"), "ネットワーク 單體の当たりが動いた").toBeGreaterThan(200);
  });

  it("寄せ先が會場名・説明文に當つ組は載せん（第 673 回の決まりの續き）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    for (const 和名 of ["モンテカルロ法", "位置情報", "メタデータ", "科学計算"]) {
      expect(表.includes(`["${和名}",`), `${和名} を載せてしまつた`).toBe(false);
    }
    /* `monte` 單體の当たりは FPGA 會場名の话で、モンテ・カルロ法の會議は品書に無い。 */
    expect(當("monte carlo"), "モンテ・カルロ法の會議が入つたか？").toBe(0);
    expect(
      當る行("location").some((r) => !/location-based/i.test(String(r.hay))),
      "location が説明文に當つ事實",
    ).toBe(true);
    /* `metadata` は CHI の説明文に當つ（主題の欄ではない – 搜しが數へん欄の内譯を見る）。*/
    expect(當("メタデータ"), "メタデータ の和名を載せ直したか？").toBe(0);
    /* 拡張現実 は既に ISMAR 8 行を受けるので dup に載せん。*/
    expect(當("拡張現実")).toBe(8);
  });

  it("搜の振ひを動かしらん – 第 673 回からの金庫と表の在處", () => {
    const 金庫: Record<string, number> = {
      暗号: 117,
      視覚: 250,
      機械学習: 504,
      multimedia: 69,
      ヒューマンコンピュータインタラクション: 138,
      計算機科学: 0,
      // 性能評価 は第 675 回の搜し側の直しで 2 行屆くやうになつた（PERFORMANCE 2026）。
      性能評価: 2,
      検索技術: 58,
      "30日以内": 689,
      OA: 0,
    };
    for (const [文, 件] of Object.entries(金庫)) expect(當(文), `搜 ${文}`).toBe(件);
    expect(rows.length).toBe(3250);
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    const 本 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    // 分けの時に 119 條 – 載せ增しで增えるので下限だけ張る（確數は各回合が持つ）。
    expect((表.match(/^\s*\["/gm) || []).length, "条目が減つた").toBeGreaterThanOrEqual(119);
    expect(本).toContain('from "./topic-aliases.ts"');
  });
});
