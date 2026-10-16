import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 検索の土臺は実際の品書（3,250 行）で張る – fixtures の品書だと寄せの当たりが別物になる為。*/
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
/** 画麵と同じ順で讓りを再現する（案内の復唱は `querySynonymNotes` が出る）。 */
function 注(文: string): string {
  return Recommender.querySynonymNotes(文).join("\n");
}

/** この回に寄せ表へ載せた打ち手（検索し 0 行だった十七本 – 実測の件数）。 */
const 寄せ: [string, string, number][] = [
  ["検索技術", "retrieval", 58],
  // 設計自動化 – 第 675 回に検索しが並べ語を語ごとに数えるやうになつたので、`design` と
  // `automation` を離して書く行（ICCAD のやうな設計自動化の会議）も受けて 19 → 29 行。
  ["設計自動化", "design automation", 29],
  ["計画立案", "planning", 6],
  ["自動計画", "planning", 6],
  ["プランニング", "planning", 6],
  // ソフトウェアテスト – 第 675 回の検索し側の直しで 19 行（增分の 1 行は HPCTESTS 2026
  // 「testing and evaluation of systems, tools, and software」 – 語を離して書く収録 ✓）。
  /* `ハイパフォーマンスコンピューティング` は表に在るが此の一覧には入れない –
   * 當たる行の多く（153 行）は寄せ先の語を持たず、**收録の分類（`hpc`）で當たつて居る**。
   * 下の「寄せ先の語を持たん行を交へん」はその道を知らないので、入れると誤爆に見える。
   * 畫面での實測は 0 件 → 10 件（default の一覧）。 */
  ["オペレーティングシステム", "operating systems", 53],
  ["オペレーティング・システム", "operating systems", 53],
  ["コンピュータグラフィックス", "graphics", 299],
  ["コンピューターグラフィックス", "graphics", 299],
  ["コンピュータ・グラフィックス", "graphics", 299],
  ["ソフトウェア工学", "software engineering", 87],
  ["ソフトウェア・エンジニアリング", "software engineering", 87],
  ["システムソフトウェア", "systems software", 156],
  ["サイバーセキュリティ", "cyber", 31],
  ["暗号技術", "cryptography", 43],
  ["アーキテクチャ", "architecture", 75],
  ["ソフトウェアテスト", "software testing", 19],
  ["テスト", "testing", 23],
  ["プログラマブル", "programmable", 26],
  ["フィールドプログラマブル", "field-programmable", 20],
  ["再構成可能", "reconfigurable", 2],
  // 計算機支援協調 – 第 675 回に検索しが並べ語を語ごとに数えるやうになつたので 16 行
  // （增分の 2 行は IROS 2026 の協調知能のワークショップ – `cooperative` と `work` を離して
  // 書く – で、英字で `cooperative work` と打つ人も同じ 16 行を見る – 実測で齊しい）。
  ["計算機支援協調", "cooperative work", 16],
  // 協調作業 – `cooperative work` を語ごとに数えるやうになつたので 16 行（增分の 2 行は
  // IROS 2026 の協調知能のワークショップ – 英字で同じ語組を打つ人も同じ 16 行を見る – 実測）。
  ["協調作業", "cooperative work", 16],
  ["ソーシャルコンピューティング", "social computing", 6],
  ["人間工学", "human factors", 17],
  ["アクセシビリティ", "accessibility", 2],
  ["自律エージェント", "autonomous agents", 18],
  ["自律移動", "autonomous", 22],
];

describe("分野の和名を英字の会議名へ寄せる（第 673 回）", () => {
  it("載せた打ち手が検索しで行を受け、英字の綴りを復唱する", () => {
    for (const [和名, , 件] of 寄せ) {
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
  });

  it("寄せ先の語（又はその方の和名）を持たん行を交へん – 誤爆を外から見る", () => {
    for (const [和名, 英] of 寄せ) {
      const 語 = 英.split(/[\s-]+/);
      const 外 = 當る行(和名).filter((r) => {
        const x = String(r.hay).toLowerCase();
        return !語.some((w) => x.includes(w.toLowerCase())) && !x.includes(和名);
      });
      expect(外, `${和名} が寄せ先の語も和名も持たん行を當てた`).toEqual([]);
    }
  });

  it("彈いた組は寄せ表にない – その理由を実測で残す（第 337 回・第 672 回）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");

    expect(當("計算機科学")).toBe(0);
    expect(當("コンピュータサイエンス")).toBe(0);
    expect(當("情報工学")).toBe(0);
    for (const 和名 of [
      "計算機科学",
      "コンピュータサイエンス",
      "運用自動化",
      "ゲーム研究",
      "改ざん耐性",
      "データセンター",
      "ワークフロー",
      "材料科学",
      "情報教育",
      "教育技術",
    ]) {
      expect(表.includes(`["${和名}",`), `${和名} を載せてしまつた`).toBe(false);
    }
    /* ① 会場名の英訳に当つ – `education` は「札幌市教育文化会館」の行を引くので、教育の和名は
     *    載せん（当たりの内 1 行は主題ではなく場所の話）。 */
    expect(
      當る行("education").some((r) => String(r.hay).includes("札幌市教育文化会館")),
      "education が会場名に当つ事実が消えたら、この彈きを外せる",
    ).toBe(true);

    expect(當("評価")).toBeGreaterThan(2000);
    expect(當("性能評価"), "`性能評価` が 0 行に戻つた").toBe(2);

    expect(當("IoT"), "IoT は略語の表が受ける").toBe(9);
    expect(當("モノのインターネット"), "`モノのインターネット` は第 676 回から同じ 9 行").toBe(9);
    /* ④ 寄せ先が広すぎて内訳が違う – `automation` の当たりは ICRA・DAC・DATE。 */
    expect(當("automation"), "automation の当たりが変はつたら彈き直せる").toBeGreaterThan(30);
  });

  it("検索の振ひを動かしらん – 寄せ表の裏側の金庫（第 672 回の分けも含む）", () => {
    const 金庫: Record<string, number> = {
      暗号: 117,
      暗号理論: 117,
      視覚: 250,
      量子コンピュータ: 6,
      延長: 35,
      自然言語処理: 167,
      "7日以内": 206,
      "30日以内": 689,
      デモ締切: 7,
      抄録提出: 3,
      multimedia: 69,
      データベース登録: 1,
      機械学習: 504,
      AI: 1090,
      automation: 44,
      education: 13,
    };
    for (const [文, 件] of Object.entries(金庫)) {
      expect(當(文), `搜 ${文}`).toBe(件);
    }
    expect(rows.length).toBe(3250);
  });

  it("寄せ表は別の產出物に在り、検索しはそれを引く（第 672 回の分けを續ける）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    const 本 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(表).toContain("export const TOPIC_QUERY_ALIASES_JA");
    // 分けの時に 85 条・第 673 回に 102 条 – 载せ增しで增えるので下限だけ張る（確数は各回合が持つ）。
    expect(
      (表.match(/^\s*\["/gm) || []).length,
      "条目が減つた（表の切り出しが崩れた）",
    ).toBeGreaterThanOrEqual(102);
    expect(本).toContain('from "./topic-aliases.ts"');
    // 検索し 0 行の打ち手を広げる表なので、載せた鍵は一つ残らず 0 行**から**始まつている筈だ –
    // 鍵の行が增えたら（収録がその方の和名を書いた）彈いて別扱いにする。
    for (const [和名] of 寄せ) expect(當(和名), `${和名} が搜れる語になつた`).toBeGreaterThan(0);
  });
});
