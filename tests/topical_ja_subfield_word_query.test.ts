/**
 * 分野の**下位の名前**を日本語で打った人の検査（SPEC §7・第 518 回）。
 * 二つの穴を塞いでいる。
 *  ① 主題の寄せ表（`TOPIC_QUERY_ALIASES_JA`）に、日本語の長表記も翻訳も無い語 –
 *    `計算論言語学` `生体認証` `チャットボット` `ベンチマーク` `音楽情報` `プライバシー保護` は
 *    実ビルドの品書 868 行で **0 行・案内も無し**だった（2026-08-09T00:00:00Z 生成で実測）。
 *    収録は其の方の英語表記（computational linguistics・biometrics・chatbot・benchmark・music・
 *    privacy）だけを書く。
 *  ② 分野その物ではなく其の下位の名前で打たれる語 – `AIセキュリティ` `インシデント対応`
 *    `脆弱性研究` `人間中心設計` `移動体通信` も同じく 0 行・無言だった。之は英語表記に寄せても
 *    届かない（収録に "AI security" の様な語順で書く行は無い）ので、**分野への寄せ**で受ける。
 *    広げた先は件數欄が「分野『セキュリティ』で探しています」と内側に出す（第 331 回の決まり）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { conf?: { name?: string; key?: string }; hay: string };

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

/** 案内の channels（件數欄に出る物）をまとめて一本にする。 */
function 案内(語: string): string {
  return [
    Recommender.columnQueryNoteJa(語),
    Recommender.uiWordNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    Recommender.wholeTableQueryNoteJa(語),
    ...(Recommender.relativeDayNotes(語, AT) || []),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ");
}

/** ① 英語表記に寄せる語（日本語 → 寄せ先）。 */
const 寄せ: Array<[string, string]> = [
  ["計算論言語学", "computational linguistics"],
  ["計算論的言語学", "computational linguistics"],
  ["計算言語学", "computational linguistics"],
  ["生体認証", "biometrics"],
  ["チャットボット", "chatbot"],
  ["ベンチマーク", "benchmark"],
  ["音楽情報", "music"],
  ["プライバシー保護", "privacy"],
];

/** ② 分野へ寄せる語（日本語 → 分野の label と、寄せ先として表に置いて有る二語）。 */
const 分野: Array<[string, string, string, string]> = [
  ["AIセキュリティ", "セキュリティ", "セキュリティ", "security"],
  ["インシデント対応", "セキュリティ", "セキュリティ", "security"],
  ["インシデント", "セキュリティ", "セキュリティ", "security"],
  ["脆弱性研究", "セキュリティ", "セキュリティ", "security"],
  ["人間中心設計", "人間情報処理", "人間情報処理", "hci"],
  ["移動体通信", "ネットワーク", "ネットワーク", "networking"],
  ["モバイル通信", "ネットワーク", "ネットワーク", "networking"],
];

/** 弾いた語（實測で寄せを置いていない – 行が出たら前提が変わつた事）。 */
/* 第 642 回 – `音声処理` と `推薦システム` は此處から**寄せを置く方**に移した（下の
 * 「下位の名前を一語に潰して打つ人」）。彈いた理由は「英語側の語順（speech processing）が
 * 品書に無い」で其のとおりだが、寄せ先を英語の短表記（`speech`・`recommendation`）と
 * 日本語の主題の語に取れば屆く（實測で 19 行・23 行 – icassp・www）。決まりは其侭 –
 * 寄せ先の語が品書に實在る事を檢査が張る。 */
const 弾いた = [
  "手話",
  "環境",
  "映像",
  "分散表現",
  "オントロジー",
  "連合学習",
  "時系列",
  /* `アクセシビリティ` は彈いた – 第 673 回で寄せ表に載つた。彈いた理由の「英語側の語順が品書に
   * 無い」が當てはまらん（`accessibility` の侬が收錄に出て ASSETS 2 行に屆く – 實測）。*/
  "支援技術",
  "対話システム",
  "機械翻訳",
  "光通信",
  "CTF",
  "GPU",
  "Kubernetes",
];

describe("分野の下位の名前を日本語で打つ人", () => {
  it("寄せた語が英語表記と同じ行に会える（画面に出る品書）", () => {
    const rows = 品書();
    寄せ.forEach(([日本語, 英語]) => {
      expect(当たり(rows, 日本語).sort(), `"${日本語}" が "${英語}" と違う行を出している`).toEqual(
        当たり(rows, 英語).sort(),
      );
    });
  });

  it("実データで 0 行で無くなつた事（測つた規模を張る）", () => {
    const rows = 収録();
    const 実測: Array<[string, number]> = [
      ["計算論言語学", 7],
      ["計算論的言語学", 7],
      ["計算言語学", 7],
      ["生体認証", 6],
      ["チャットボット", 1],
      ["ベンチマーク", 1],
      ["音楽情報", 1],
      ["プライバシー保護", 37],
      ["AIセキュリティ", 100],
      ["インシデント対応", 100],
      ["脆弱性研究", 100],
      ["人間中心設計", 20],
      ["移動体通信", 60],
    ];
    実測.forEach(([日本語, 以上]) => {
      expect(
        当たり(rows, 日本語).length,
        `"${日本語}" が 0 行に近い（寄せが消えた）`,
      ).toBeGreaterThanOrEqual(以上);
    });
  });

  it("寄せの実体は日本語の語を行に書いていない事（増加分が寄せの働き）", () => {
    const rows = 品書();
    寄せ
      .concat(分野.map(([日本語, , 先]) => [日本語, 先] as [string, string]))
      .forEach(([日本語]) => {
        const 書く行 = rows.filter((row) => String(row.hay).includes(日本語)).length;
        expect(書く行, `"${日本語}" は行に書かれている（前提が変わった – §7 を直す）`).toBe(0);
      });
  });

  it("分野へ寄せた語は、其の分野の語（日本語の label と英文字）で打った当たりと同じ行を出す", () => {
    /* 寄せ先は二語の OR なので（`分散システム` → ["システム","systems"] と同じ形）、
     * 比べるのも其の二つの和集合にする。1 語ずつより減つて居ない事も之で見る。 */
    const rows = 収録();
    分野.forEach(([日本語, label, 先, 英語]) => {
      const 和 = [...new Set(当たり(rows, 先).concat(当たり(rows, 英語)))].sort();
      expect(当たり(rows, 日本語).sort(), `"${日本語}" が分野「${label}」の行とズレている`).toEqual(
        和,
      );
      expect(
        当たり(rows, 日本語).length >= 当たり(rows, 先).length,
        `"${日本語}" が分野の語より少ない（寄せ先が欠けた）`,
      ).toBe(true);
    });
  });

  it("案内が打ち込まれた語を名乘り、寄せ先を省いていない", () => {
    寄せ.forEach(([日本語, 英語]) => {
      const t = 案内(日本語);
      expect(t.includes(日本語), `"${日本語}": 打った語を言っていない`).toBe(true);
      expect(t.includes(英語), `"${日本語}": 寄せ先 "${英語}" を言っていない`).toBe(true);
      expect(t.includes("英語で書かれた会議名"), `"${日本語}": 寄せの意味を省いた`).toBe(true);
    });
    分野.forEach(([日本語, label]) => {
      const t = 案内(日本語);
      expect(t.includes(日本語), `"${日本語}": 打った語を言っていない`).toBe(true);
      expect(t.includes(`分野「${label}」`), `"${日本語}": 広げた先を隠した`).toBe(true);
    });
  });

  it("弾いた語は 0 行の侭（正直な 0 件 – 寄せを戻さない）", () => {
    const rows = 収録();
    弾いた.forEach((語) => {
      expect(当たり(rows, 語).length, `"${語}" に行が届くやうになつた（§7 を直す）`).toBe(0);
    });
  });

  it("`環境` を寄せない理由は行の内譯 – environment は計算機の環境の事（實測）", () => {
    /* `環境` は日本語で 0 行なので寄せたくなつ所だが、`environment` を書く行は
     * co-designing environments と heterogeneous environments で、分野の環境では無い。
     * 寄せたら 5 行出て了ひ、其の内譯が噓になる（第 337 回の決まり – 中身を見る）。 */
    const 行々 = 収録().filter((row) => /environment/i.test(String(row.hay)));
    expect(行々.length, "`environment` を書く行が居ない（前提が変わった）").toBeGreaterThan(0);
    行々.forEach((row) => {
      const h = String(row.hay).toLowerCase();
      expect(
        /co-?design|heterogeneous|runtime|software|development|virtual|container|computing|parallel/.test(
          h,
        ),
        `environment の行の意味が変わつた（見直す）: ${h.slice(0, 70)}`,
      ).toBe(true);
    });
  });

  it("寄せた語の兄弟は壊れて居ない（其の方の語は其侭当たる）", () => {
    const rows = 収録();
    const 兄弟: Array<[string, number]> = [
      ["プライバシー", 37],
      ["モバイル", 9],
      ["暗号", 31],
      ["音声認識", 3],
      ["音響", 3],
      ["セキュリティ", 100],
    ];
    兄弟.forEach(([語, 以上]) => {
      expect(
        当たり(rows, 語).length,
        `"${語}" が減つた（寄せの差し替えで壊れた）`,
      ).toBeGreaterThanOrEqual(以上);
    });
  });

  it("`モバイル通信` の差し替え – 二語に割れて 0 行だつた形が分野に就いた（實測）", () => {
    /* 舊は `モバイル` と `通信` に割れて其の方の英語表記の両方を書く行を探し、0 行だつた
     * （實測 – 案内は二本立つが件數は 0）。今は分野への寄せが其の語を名乘つて 75 行を出す。
     * 案内が減つた事（二本→一本）は此處に書いて置く – mono の檢査が之を唯一の減として出す。 */
    const rows = 収録();
    expect(当たり(rows, "モバイル通信").length).toBeGreaterThan(0);
    const t = 案内("モバイル通信");
    expect(t.includes("モバイル通信"), "打ち込まれた語を名乘つて居ない").toBe(true);
    expect(案内("モバイル通信")).toBe(案内("移動体通信").replace("移動体通信", "モバイル通信"));
  });

  it("寄せ表の語は品書の文本にも原典にも無い事（第 337 回 – 案内が噓にならんやう）", () => {
    /* 寄せた語自体は照合で受ける語なので品書に現れて良いが、**弾いた語**が品書に現れ出すと
     * 此の頁の「0 件」の前提が崩れる。其の内、画面に出る字面は品書側の語に依るので之で見る。 */
    const rows = 品書();
    ["CTF", "GPU", "Kubernetes"].forEach((語) => {
      expect(
        rows.filter((row) => String(row.hay).includes(語)).length,
        `"${語}" が品書に出るやうになつた（寄せを検討する）`,
      ).toBe(0);
    });
  });
});

describe("下位の名前を一語に潰して打つ人（第 642 回）", () => {
  const 寄せた: Array<[string, string, number]> = [
    ["音声処理", "音声", 19],
    ["スピーチ", "音声", 19],
    ["推薦システム", "推薦", 23],
    ["計算機ビジョン", "コンピュータビジョン", 230],
  ];
  it("寄せた語が行に出て、件數欄が寄せ先を名乘る", () => {
    for (const [語, 先, 見當] of 寄せた) {
      /* 品書() は檢査用の一時ビルド（行が少ない）なので、行の数は收錄の品書で張る
       * – 畫面に出る實物の數とそろへる為（第 642 回）。*/
      const 件 = 当たり(収録(), 語).length;
      expect(件, `"${語}" が 0 行（寄せが死んで居る）`).toBeGreaterThanOrEqual(見當);
      expect(案内(語), `"${語}" の件數欄が寄せ先（${先}）を隱した`).toContain(先);
    }
  });
  it("寄せ方を誤つたら直ぐ落ちる – 同じ字を含む別物の行數を張る", () => {
    /* `性能評価` を `性能` に寄せたくなるが、その 188 行は**全部「高性能計算」の内**で、
     * 寄せると性能評価の打ち手に並列計算を並べる噓になる（第 642 回で細目の羣に讓した）。
     * `ソフトウェア`（6 行）も内譯は情報処理学会の OS 研究会で、ソフトウェア工学の会議は無い。*/
    expect(当たり(収録(), "性能").length, "性能の行數が變はつたら彈いた理由を見直す").toBe(188);
    expect(案内("性能評価"), "性能評価が默つたら細目の羣から落ちた").toContain("細目");
    expect(案内("ソフトウェアインジニアリング"), "打ち直しの敎えが無いつた").toContain("細目");
    expect(
      当たり(品書(), "ソフトウェア").length,
      "ソフトウェア工学の会議が收錄されたなら寄せ直して良くて居る",
    ).toBeLessThan(10);
  });
});
