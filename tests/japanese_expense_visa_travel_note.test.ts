/** 出納の手続き・査証・旅と滞在を**其の方の名前で**打つ人（第 672 回）の讓りの檢査（SPEC §7・第 672 回）。
 *
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行）– `精算` `送金` `振込` `ビザ` `査証` `招聘状` `宿`
 * `交通機関` `二重投稿` `プレプリント` は羣の斷りを受けるのに、同じ事を別の名で打つ十五語は搜 0 行・
 * 打ち替え無し・讓り無しで面の三つが皆默つて居た。此の回のもう一半は、その羣を育て続ける為の
 * 壁の直し – 主題の寄せ表を `site/topic-aliases.ts` へ分けた事（第 583 回の `place-aliases.ts` と
 * 同じ手）を、搜の振ひが変わつて居ん證左と纏めて張る。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（3,250 行）で張る – fixtures の品書だと讓りの当たりが別物になる為。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8")),
  ) as Row[];
}
const rows = 品書();
const hays = rows.map((r) => String(r.hay));
function 當(文: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return rows.filter((r) => m(String(r.hay)) === true).length;
}
/** 畫麵と同じ順で讓りを再現する（site/app.ts – 欄の名前 → 語の斷り → 日の幅 → 寄せ表 → 助詞）。 */
function 讓り(文: string): string {
  return String(
    Recommender.columnQueryNoteJa(文, (語) => 當(語) > 0) ||
      Recommender.uiWordNoteJa(文, false) ||
      Recommender.dayRangeNoteJa(文) ||
      Recommender.wholeTableQueryNoteJa(文) ||
      Recommender.conjunctionQueryNoteJa(文, 當) ||
      "",
  ).trim();
}
/** 斷りの復唱の後の文（羣は打ち手を先頭に置く – echo）。 */
function 後尾(文: string): string {
  const x = 讓り(文);
  return x.slice(x.indexOf("」") + 1);
}

/** 此の回に羣へ載せた打ち手（搜 0 行で讓りも無かつた十五語）。 */
const 載せた = [
  "立替",
  "経理",
  "決裁",
  "申請書",
  "伝票",
  "口座振込",
  "領事館",
  "就労ビザ",
  "招請",
  "素泊まり",
  "ゲストハウス",
  "現地集合",
  "移動日",
  "並行投稿",
  "arxiv",
];
/** 同じ羣の隣の語 ⇔ 載せた語（斷りを新製せず、其の方が既に持つ物を共用した證左）。 */
const 對: [string, string][] = [
  ["精算", "立替"],
  ["精算", "経理"],
  ["精算", "決裁"],
  ["精算", "申請書"],
  ["精算", "伝票"],
  ["精算", "口座振込"],
  ["ビザ", "領事館"],
  ["ビザ", "領事館"],
  ["ビザ", "就労ビザ"],
  ["ビザ", "招請"],
  ["宿", "素泊まり"],
  ["宿", "ゲストハウス"],
  ["宿", "現地集合"],
  ["宿", "移動日"],
  ["二重投稿", "並行投稿"],
  ["プレプリント", "arxiv"],
];

describe("出納・査証・旅と滞在を別の名で打つ人（第 672 回）", () => {
  it("搜 0 行の侬で斷りを受ける – 默つても噓でもいかん（第 337 回）", () => {
    const 默 = 載せた.filter((語) => 當(語) !== 0 || !讓り(語));
    expect(默, "搜 0 行で讓りも受けん語がある、又は搜れる語を載せた").toEqual([]);
  });

  it("同じ羣の隣の語と斷りの後尾が一字も違はない（斷りを新製して居ん證左）", () => {
    for (const [隣, 新語] of 對) {
      expect(當(新語), `載せた語 ${新語} は搜れる`).toBe(0);
      expect(後尾(新語), `${隣} ⇔ ${新語} は別の羣の斷りを受けて居る`).toBe(後尾(隣));
      expect(後尾(新語).length, `${新語} の斷りが空`).toBeGreaterThan(4);
    }
  });

  it("打ち替えの語の一覽には混ぜん（讓りと兩方喋らん – 第 330 回）", () => {
    for (const 語 of 載せた) {
      expect(Recommender.shorterHitWordsJa(語, hays, AT), `${語} が打ち替えにも出た`).toEqual([]);
    }
  });

  it("語尾を連れた形も受ける（幅の語尾を待つ羣と、締切の語尾だけ待つ羣を區別して載せた）", () => {
    // 出納・旅・投稿の三羣は anyTail – 幅の語尾まで屆く。
    for (const 文 of [
      "立替の申請書の書き方",
      "決裁が必要",
      "伝票の流れ",
      "口座振込しないと",
      "素泊まりはどこ",
      "ゲストハウスでもいい",
      "移動日の扱い",
      "現地集合って？",
      "並行投稿の問題",
      "arxiv に置いて良いか",
    ]) {
      expect(讓り(文), `${文} が默つて居る`).not.toBe("");
    }
    // 査証の羣は deadlineTail – 締切の語尾は届き、幅の一部は屆かん（屆かん語尾を載せ先と
    // 取り違へると、次の回合が「屆いた」積りになつて穴が殘る – 第 671 回の實測）。
    expect(讓り("就労ビザの締切")).not.toBe("");
    expect(讓り("就労ビザはいつ")).not.toBe("");
  });

  it("搜 0 行でも收錄の原檔に現れる語は載せん（第 672 回で增えた決まり）", () => {
    /* `ホテル` は開催地の實在（第 539 回 – 「花びしホテル」）で、搜しの品書 3,250 行では 0 行。
     * `visa` も同じで、行の『備考』に "First (visa-friendly) round" と出て居る – 搜しは其の欄を
     * 數へんので 0 行に見える。讓りが「その欄はありません」と言うたら噓になる（第 337 回）。
     * だから載せる語は搜 0 行**と原檔に現れん事**の兩方で確かめる。 */
    const 原檔 = readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8");
    expect(
      原檔.toLowerCase().split("visa").length - 1,
      "visa が原檔に出る内譯は變はつた",
    ).toBeGreaterThan(0);
    expect(原檔).toContain("ホテル");
    const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 羣 = 源.slice(0, 源.indexOf("const UI_WORD_TAILS_JA"));
    // `聴講` は費用の羣に在つて彈いた羣に無い（第 543 回）ので、此處では載せ先を問ふ語だけ見る。
    for (const 語 of ["visa", "ホテル", "駅"]) {
      expect(當(語), `搜 ${語}`).toBe(0);
      expect(羣.includes(`"${語}"`), `"${語}" を羣に混ぜて居る`).toBe(false);
    }
    // 載せ替へた語は原檔にも搜しにも出ん。
    for (const 語 of ["素泊まり", "ゲストハウス"]) {
      expect(原檔, `${語} が原檔に出る`).not.toContain(語);
      expect(當(語), `搜 ${語}`).toBe(0);
    }
    // 第 617 回から同じ羣に在つた語（二重に載せ替へると羣の棚卸しが彈く – 實測で彈いた）。
    const 源2 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    for (const 語 of ["宿泊先", "民宿", "旅館"]) {
      expect(源2.includes(`"${語}",`), `${語} が羣から無くなつた（第 617 回の載せ物を殘す）`).toBe(
        true,
      );
    }
  });

  it("搜れる語は羣に混ぜん – 既に屆く打ち手を退けた證左", () => {
    for (const [語, 當り] of [
      ["共著者", 0],
      ["宿代", 0],
      ["送金", 0],
      ["振込", 0],
    ] as [string, number][]) {
      expect(當(語), `${語} の搜`).toBe(當り);
      expect(讓り(語), `${語} は讓りも受けん – 載せ直すべき`).not.toBe("");
    }
    // （羣に既に載つて居る打ち手 – `共著者` `宿代` `送金` `振込` – は上の四つで調べて居る。）
    // データベース登録 は搜しに行が在るので羣に載せられん（第 670 回と同じ決まり）。
    expect(當("データベース登録")).toBe(1);
    const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 羣 = 源.slice(0, 源.indexOf("const UI_WORD_TAILS_JA"));
    for (const 語 of ["データベース登録"]) {
      expect(羣.includes(`"${語}"`), `${語} を羣に混ぜて居る`).toBe(false);
    }
  });

  it("主題の寄せ表を別の產出物へ移しても搜の振ひは變はらん（第 672 回の分け）", () => {
    /* 對照（2026-10-02 實測・2026-08-09 生成の実ビルドの品書 3,250 行）– 分けの前と後で
     * 同じ數。寄せ表の条目は搜しの寄せ先だけなので、移す前の振ひをそのまま張る。 */
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
      OA: 0,
      英語で書く: 0,
    };
    for (const [文, 當り] of Object.entries(金庫)) {
      expect(當(文), `搜 ${文}`).toBe(當り);
    }
    expect(rows.length).toBe(3250);
  });

  it("分けの繋がりが殘つて居る（表の本体は新しい檔に、recommender は import だけ）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    const 本 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(表).toContain("export const TOPIC_QUERY_ALIASES_JA");
    const 條目 = 表.match(/^\s*\["/gm) || [];
    expect(條目.length, "条目の数が動いた（表の切り出しが崩れた可能性がある）").toBe(85);
    expect(本).toContain('from "./topic-aliases.ts"');
    expect(
      本.includes('const TOPIC_QUERY_ALIASES_JA: string[][] = [\n    ["'),
      "表の本体がまだ本檔に殘る",
    ).toBe(false);
    // build と tsconfig の配線（繋がらん所を殘すと `npm run build` が產出物を書かん）。
    expect(readFileSync(`${REPO_ROOT}/site/tsconfig.build.json`, "utf8")).toContain(
      '"topic-aliases.ts"',
    );
    const 組 = readFileSync(`${REPO_ROOT}/src/build.ts`, "utf8");
    expect(組).toContain('"topic-aliases.js"');
    expect(組.match(/"topic-aliases\.js"/g), "產出物の一覽と導出物の註の兩方に要る").toHaveLength(
      2,
    );
    const 檢 = readFileSync(`${REPO_ROOT}/tests/built_golden_shared.ts`, "utf8");
    expect(檢).toContain('siteRuntime(\n    "topic-aliases.js",\n  )');
  });
});
