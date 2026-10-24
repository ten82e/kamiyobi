import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
const 件 = (文: string): number =>
  全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true).length;
const 問答 = (語: string): boolean => 件(語) > 0;
function 欄の案内(文: string, 渡す = true) {
  return (
    渡す ? Recommender.columnQueryNoteJa(文, 問答) : Recommender.columnQueryNoteJa(文)
  ).trim();
}

describe("欄の名前が接頭辞の連結形を、門を通る時だけ受ける（第 508 回）", () => {
  it("二つの門を通る連結形 – 単体と同じ案内が出る", () => {
    for (const [文, 名前] of [
      ["分野セキュリティ", "「分野」"],
      ["種別論文締切", "「種別」"],
      ["地域関西", "「地域」"],
      ["会場関西", "「会場」"],
      ["分類機械学習", "「分類」"],
      ["ステータス論文締切", "「ステータス」"],
      ["テーマ高性能計算", "「テーマ」"],
      ["参加形式オンライン参加可", "「参加形式」"],
    ] as Array<[string, string]>) {
      const 説 = 欄の案内(文);
      expect(説 !== "", `「${文}」に案内が出なかつた`).toBe(true);
      expect(説, `「${文}」の案内が欄の名前を名乘つて居ない`).toContain(名前);
      expect(説).toContain("値で検索してください");
      expect(件(文), `「${文}」で行が出た`).toBe(0);
    }
  });
  it("門① – 残りが一文字の磁石は彈く（検査用ビルドで「学」は 25 行に当つ）", () => {
    expect(件("学")).toBe(25);
    for (const 文 of ["分類学", "地域学", "分野別", "種類別"]) {
      expect(件(文)).toBe(0);
      expect(欄の案内(文), `「${文}」に案内が乘つた（磁石）`).toBe("");
    }
  });
  it("門② – 残りそれで行が出ない物は彈く", () => {
    expect(件("案内")).toBe(0);
    for (const 文 of ["会場案内", "会場費", "地域性", "分野の会"]) {
      expect(件(文)).toBe(0);
      expect(欄の案内(文), `「${文}」に案内が乘つた（値で無い残り）`).toBe("");
    }
  });
  it("混在形（繋いだ欄の名前 + 空格の値）も受ける", () => {
    /* separator があるので語に分ける道に入るが、其処に欄の名前の語は無い – 後方の連結形の枝が
       受ける（その枝を外す改ざん T3 をこれで捕まへる）。*/
    const 文 = "分野セキュリティ 2026年";
    expect(件(文)).toBe(0);
    expect(欄の案内(文), `「${文}」に案内が出なかつた`).toContain("「分野」はこの表の欄");
    expect(欄の案内(文, false), "問答を渡さないのに混在形が通つた").toBe("");
  });

  it("問答を渡す caller だけがこの道を通る（正典に品書を持たせない – 第 466 回）", () => {
    expect(欄の案内("分野セキュリティ", false)).toBe("");
    /* separator のある形は問答無くても通る。*/
    expect(欄の案内("分野 セキュリティ", false)).toContain("「分野」は");
    expect(欄の案内("分野：セキュリティ", false)).toContain("「分野」は");
  });
  it("画面の道 – filter.columnValueHits を渡すと 0 件案内に出る", () => {
    const 図 = deadlineHintFunction();
    const 土 = {
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      hidden: { past: 1200, est: 134 },
      hiddenKindWords: [],
      queryMatch: { catalog: 0, journal: 0 },
      urlQuery: false,
      catalogConferences: 12,
      shorterHits: [],
    };
    const 乗る = String(
      図({ ...土, query: "分野セキュリティ", termCounts: [], columnValueHits: 問答 } as never),
    );
    expect(乗る).toContain("「分野」はこの表の欄");
    expect(乗る).toContain("値で検索してください");
    const 乗らん = String(図({ ...土, query: "分野セキュリティ", termCounts: [] } as never));
    expect(乗らん, "問答を渡さないのに欄の名前の案内が出た").not.toContain("「分野」はこの表の欄");
    /* 磁石は画面でも立たない。*/
    const 磁石 = String(
      図({ ...土, query: "分類学", termCounts: [], columnValueHits: 問答 } as never),
    );
    expect(磁石).not.toContain("「分類」はこの表の欄");
  });
  it("値だけで打つ人は今まで通り（案内を被せない）", () => {
    expect(件("セキュリティ")).toBe(68);
    expect(件("論文締切")).toBe(264);
    for (const 文 of ["セキュリティ", "論文締切", "機械学習", "関西"]) {
      expect(欄の案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
  });
  it("既知の境界 – `テーマセッション` は通る（案内の主張は噓ではない）", () => {
    expect(件("セッション")).toBe(2);
    expect(欄の案内("テーマセッション")).toContain("「テーマ」はこの表の欄");
  });
  it("第 470 回〜第 507 回の実測はこの回で変へて居ない", () => {
    expect(件("年内")).toBe(425);
    expect(件("今年内")).toBe(427);
    expect(件("再来週内")).toBe(18);
    expect(件("年末中")).toBe(84);
    expect(件("年初1月")).toBe(23);
    expect(件("来月 末日")).toBe(178);
    expect(件("週 末")).toBe(146);
    expect(件("締切時刻")).toBe(181);
    expect(件("ml から")).toBe(0);
    expect(件("オンラインの締切")).toBe(20);
    expect(Recommender.uiWordNoteJa("当面の締切") || "").toContain("曖昧な幅では絞り込めません");
    expect(Recommender.uiWordNoteJa("費用対効果分析") || "").toBe("");
    expect(Recommender.uiWordNoteJa("リアルタイム処理") || "").toBe("");
    expect(Recommender.uiWordNoteJa("印刷 関西") || "").toBe("");
  });
});

describe("ビルド成果物と足場（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("連結形の口が現れ、足場に登録してある（第 504 回の落とし穴の再発防止）", () => {
    expect(物).toContain("function columnGluedEntryJa");
    expect(物).toContain("function columnGluedEntryJa(query, 値が当たるか)");
    expect(物).toContain("if (値.length < 2)");
    const 足場 = readFileSync(join(import.meta.dirname, "runtime_extract.ts"), "utf8");
    expect(足場).toContain('jsFunction(rec, "columnGluedEntryJa")');
    /* 画面の実配線 – filter に問答を詰め（詰め忘れる改ざん T5 で捕まる）、それを二箇所に渡し、
       問答の中身が「それだけで行が出るか」である事（常に真へ緩めると磁石が通る – T3 で捕まる）。*/
    const 画面 = readFileSync(join(builtSite(), "app.js"), "utf8");
    expect(画面).toContain("columnValueHits: columnValueHitsJa,");
    expect(画面.split("filter.columnValueHits").length - 1).toBe(2);
    expect(画面).toContain("counted.catalog + counted.journal > 0");
  });
});

describe("欄の名前が**末尾**に來る連結形（第 608 回）", () => {
  it("前の部が行を持つ形は、単体と同じ斷りが出る", () => {
    for (const [文, 欄] of [
      ["関西の会場", "会場"],
      ["東京の会場", "会場"],
      ["おきなわの場所", "場所"],
    ] as const) {
      expect(件(文), `增やした道が行を出す打ち方になった ${文}`).toBe(0);
      const 案内 = 欄の案内(文);
      expect(案内, `「${文}」が默つて居る`).toContain(`「${欄}」はこの表の欄`);
      expect(案内).toContain("値で検索してください");
    }
    /* 値の方で打けば出る（関西 6 行 – 検査の前提）。 */
    expect(件("関西"), "`関西` の行が潰れた").toBeGreaterThan(0);
  });
  it("前の部が**全行の語**の形も受ける（第 695 回）", () => {
    /* 実測（2026-10-06 – 収録の全体 5,069 行・品書 870 行）で `会議の場所` `会議の会場`
     * `会議の種別` `会議の都市` `会議の地域` `会議の参加形式` は 0 行・案内も無しだつた。
     * 門②（前の部だけで行が出る）を値の語だけに限つていた為 – 全行の語（`会議` `大会`
     * `カンファレンス`）は全行に行を持つので、値と同じく門を通す。*/
    for (const [文, 欄] of [
      ["会議の場所", "場所"],
      ["会議の会場", "会場"],
      ["会議の種別", "種別"],
      ["会議の都市", "都市"],
      ["会議の地域", "地域"],
      ["会議の参加形式", "参加形式"],
      ["大会の場所", "場所"],
      ["カンファレンスの場所", "場所"],
    ] as const) {
      expect(件(文), `增やした道が行を出す打ち方になつた ${文}`).toBe(0);
      const 案内 = 欄の案内(文);
      expect(案内, `「${文}」が默つて居る`).toContain(`「${欄}」はこの表の欄`);
      expect(案内).toContain("値で検索してください");
    }
    /* 一文字の欄の名前（`国`）はこの道の門（二文字以上）で今まで通り黙る。 */
    expect(欄の案内("会議の国"), "一文字の欄の名前を受けた").toBe("");
    /* 値で無い・全行の語でも無い前の部は今まで通り黙る。 */
    expect(件("学生登録"), "この検査の前提が崩れた").toBe(0);
    expect(欄の案内("学生登録の場所"), "値でも全行の語でもない部に欄の名前を説いた").toBe("");
  });
  it("門を通らん物は黙る – 前の部で行が出ん時と、問答を渡さん時（第 508 回）", () => {
    expect(件("学生登録"), "この検査の前提が崩れた").toBe(0);
    expect(欄の案内("学生登録の締切"), "値でない部に欄の名前を説いた").toBe("");
    /* 問答（値が行を持つかの目）を渡さない道は旧の侭黙る – 品書を持つのは `site/app.ts`。*/
    expect(欄の案内("関西の会場", false), "問答無しで欄の名前の案内が出た").not.toContain(
      "「会場」はこの表の欄",
    );
  });
  it("検索の割りは変へて居らん（案内だけ – 第 362 回）", () => {
    /* `会場` を要求する群は其侭残る – 落として行を広げても無い。*/
    const 群 = Recommender.queryTokenGroups("関西の会場", 基準);
    expect(
      群.some((g) => g.every((語) => 語.includes("会場"))),
      "会場の群が消えた",
    ).toBe(true);
    /* 頭の道を奪つて居らん – 両方通る形は頭が勝つ。*/
    expect(欄の案内("分野セキュリティ")).toContain("「分野」はこの表の欄");
  });
});
