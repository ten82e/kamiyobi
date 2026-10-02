/** 分野の和名を搜しで打つ人を、會議名に並ぶ英字の綴りへ寄せる檢査（SPEC §7・第 673 回）。
 *
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行）– `計算機科学` `検索技術` `設計自動化` `テスト`
 * `プログラマブル` `再構成可能` `協調作業` `人間工学` `アクセシビリティ` `自律移動` など十九の打ち手は
 * 搜し 0 行で、畫面は「その欄はありません」の導きだけを出す。收錄の會議名には其の方が英字で書かれて居る
 * （`Foundations of Computer Science` `Design Automation Conference` `Human Factors in Computing
 * Systems`）ので、寄せ表 `site/topic-aliases.ts` に載せて搜しで行を渡す（第 313 回・第 322 回と同じ手 –
 * **表示は變へん**）。彈いた組の理由も一緒に張る（噓の寄せを載せん為 – 第 337 回・第 672 回）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（3,250 行）で張る – fixtures の品書だと寄せの当たりが別物になる為。*/
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
/** 畫麵と同じ順で讓りを再現する（案内の復唱は `querySynonymNotes` が出る）。 */
function 注(文: string): string {
  return Recommender.querySynonymNotes(文).join("\n");
}

/** 此の回に寄せ表へ載せた打ち手（搜し 0 行だった十七本 – 實測の件數）。 */
const 寄せ: [string, string, number][] = [
  ["検索技術", "retrieval", 58],
  ["設計自動化", "design automation", 19],
  ["計画立案", "planning", 6],
  ["自動計画", "planning", 6],
  ["プランニング", "planning", 6],
  ["ソフトウェアテスト", "software testing", 18],
  ["テスト", "testing", 23],
  ["プログラマブル", "programmable", 26],
  ["フィールドプログラマブル", "field-programmable", 20],
  ["再構成可能", "reconfigurable", 2],
  ["計算機支援協調", "cooperative work", 14],
  ["協調作業", "cooperative work", 14],
  ["ソーシャルコンピューティング", "social computing", 6],
  ["人間工学", "human factors", 17],
  ["アクセシビリティ", "accessibility", 2],
  ["自律エージェント", "autonomous agents", 18],
  ["自律移動", "autonomous", 22],
];

describe("分野の和名を英字の會議名へ寄せる（第 673 回）", () => {
  it("載せた打ち手が搜しで行を受け、英字の綴りを復唱する", () => {
    for (const [和名, , 件] of 寄せ) {
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
  });

  it("寄せ先の語（又は其の方の和名）を持たん行を交へん – 誤爆を外から見る", () => {
    for (const [和名, 英] of 寄せ) {
      const 語 = 英.split(/[\s-]+/);
      const 外 = 當る行(和名).filter((r) => {
        const x = String(r.hay).toLowerCase();
        return !語.some((w) => x.includes(w.toLowerCase())) && !x.includes(和名);
      });
      expect(外, `${和名} が寄せ先の語も和名も持たん行を當てた`).toEqual([]);
    }
  });

  it("彈いた組は寄せ表に無い – 其の理由を實測で殘す（第 337 回・第 672 回）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    /* 表全体を名乗る語は寄せ表に載せん – `計算機科学` を寄せると 19 行出て了ひ、其の語の筈の
     * 「この表は七〇〇本の計算機科学の會議を載せて居る」の導き（`WHOLE_TABLE_QUERY_JA` – 第 239 回）と
     * 噓になる。實測で彈く前の件數を張る（搜し 0 行の侬が正しい – 第 673 回で載せ直して拔いた）。*/
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
      "性能評価",
      "モノのインターネット",
    ]) {
      expect(表.includes(`["${和名}",`), `${和名} を載せてしまつた`).toBe(false);
    }
    /* ① 會場名の英訳に當つ – `education` は「札幌市教育文化会館」の行を引くので、教育の和名は
     *    載せん（当たりの内 1 行は主題ではなく場所の話）。 */
    expect(
      當る行("education").some((r) => String(r.hay).includes("札幌市教育文化会館")),
      "education が會場名に當つ事實が消えたら、この彈きを外せる",
    ).toBe(true);
    /* ② 搜しが先に割る熟語 – `評価` 單體で 2,000 行を越えるので `性能評価` の鍵は屆かん。 */
    expect(當("評価")).toBeGreaterThan(2000);
    expect(當("性能評価")).toBe(0);
    /* ③ 略語の表が既に受ける – `IoT` は 9 行に屆いて居るので和名をdupに載せん。 */
    expect(當("IoT"), "IoT は略語の表が受ける").toBe(9);
    expect(當("モノのインターネット")).toBe(0);
    /* ④ 寄せ先が廣すぎて內譯が違う – `automation` の当たりは ICRA・DAC・DATE。 */
    expect(當("automation"), "automation の当たりが變はつたら彈き直せる").toBeGreaterThan(30);
  });

  it("搜の振ひを動かしらん – 寄せ表の裏側の金庫（第 672 回の分けも含む）", () => {
    const 金庫: Record<string, number> = {
      暗号: 117,
      暗号理論: 117,
      視覚: 250,
      量子コンピュータ: 6,
      延長: 36,
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

  it("寄せ表は別の產出物に在り、搜しは其れを引く（第 672 回の分けを續ける）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    const 本 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(表).toContain("export const TOPIC_QUERY_ALIASES_JA");
    // 分けの時に 85 條・第 673 回に 102 條 – 载せ增しで增えるので下限だけ張る（確數は各回合が持つ）。
    expect(
      (表.match(/^\s*\["/gm) || []).length,
      "条目が減つた（表の切り出しが崩れた）",
    ).toBeGreaterThanOrEqual(102);
    expect(本).toContain('from "./topic-aliases.ts"');
    // 搜し 0 行の打ち手を廣げる表なので、載せた鍵は一つ殘らず 0 行**から**始まつて居る筈だ –
    // 鍵の行が增えたら（收錄が其の方の和名を書いた）彈いて別扱いにする（第 337 回）。
    for (const [和名] of 寄せ) expect(當(和名), `${和名} が搜れる語になつた`).toBeGreaterThan(0);
  });
});
