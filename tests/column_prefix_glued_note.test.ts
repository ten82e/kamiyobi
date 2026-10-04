/* 第 508 回 – 欄の名前が**接頭辞**に成つた連結形（`分野セキュリティ` `種別論文締切` `会場関西`）
 *
 * 実測（2026-11-09 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）。第 507 回で欄の名前は
 * 值と並べた形（`分野 セキュリティ` `分野：セキュリティ`）を受けるやうにしたが、**區切りの無い
 * 繋がれた形**は默つた侭だつた（残した差として張つて在る）。之れ等を受けるには接頭照合が要るが、
 * `分類` `地域` `種類` 等は他のの語の頭に成れる磁石なので、第 505 回・第 506 回で避けた道を其の侭
 * 通すわけには行かない – 「打ち方は違うが其れ自身で行が出る語」に限り、欄の名前の案内を出す形にした。
 *
 * 門は二つ（`columnGluedEntryJa`）:
 * - ①残り（欄の名前を拔いた後）が**二文字以上** – `分類学`（残り「学」）・`分野別`・`種類別` を彈く。
 *   検査用ビルドで「学」は 25 行に當つて仕舞ふので、長さの門が無いと磁石が通る。
 * - ②残りが**其れ自身で行を出す** – `会場案内`（残り「案内」 0 行）・`会場費`・`地域性` を彈く。
 *
 * ②の問答は畫面側が持つ（品書を持つのは `site/app.ts` で、正典は行を持たん – 第 466 回）。
 * `emptyDeadlineHint` と `zeroResultLiveNote` は `filter` の受け渡しで動く函數なので、問答も所に
 * 乗せた（`filter.columnValueHits` – 正典を呼ぶ二箇所に渡し、他の caller は舊の侭默る）。
 * 検索の道で時計を讀まない決まり（第 494 回・第 495 回）と同じ筋。
 *
 *  既知の境界 – `テーマセッション` は通る（残り「セッション」が検査用ビルドで 2 行に當つ為）。
 * 案内の主張（「テーマ」は欄の名前で值ではない）は此の打ち方でも噓では無いので、境界として張つた。
 *
 * 行は一個も動かして居ない（此の道は案内の函數だけ。values-only の打ち手は今まで通り案内が立たない
 * – `セキュリティ` 68 件・`論文締切` 264 件・`機械学習` 1 件）。*/
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
  it("二つの門を通る連結形 – 單體と同じ案内が出る", () => {
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
      expect(説).toContain("値で打ってください");
      expect(件(文), `「${文}」で行が出た`).toBe(0);
    }
  });
  it("門① – 残りが一文字の磁石は彈く（検査用ビルドで「学」は 25 行に當つ）", () => {
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
  it("混在形（繋いだ欄の名前 + 空格の值）も受ける", () => {
    /* separator が在るので語に分ける道に入るが、其処に欄の名前の語は無い – 後方の連結形の枝が
       受ける（其の枝を外す改ざん T3 を此れで捕まへる）。*/
    const 文 = "分野セキュリティ 2026年";
    expect(件(文)).toBe(0);
    expect(欄の案内(文), `「${文}」に案内が出なかつた`).toContain("「分野」はこの表の欄");
    expect(欄の案内(文, false), "問答を渡さないのに混在形が通つた").toBe("");
  });

  it("問答を渡す caller だけがこの道を通る（正典に品書を持たせない – 第 466 回）", () => {
    expect(欄の案内("分野セキュリティ", false)).toBe("");
    /* separator の在る形は問答無くても通る（第 507 回）。*/
    expect(欄の案内("分野 セキュリティ", false)).toContain("「分野」は");
    expect(欄の案内("分野：セキュリティ", false)).toContain("「分野」は");
  });
  it("畫面の道 – filter.columnValueHits を渡すと 0 件案内に出る", () => {
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
    expect(乗る).toContain("値で打ってください");
    const 乗らん = String(図({ ...土, query: "分野セキュリティ", termCounts: [] } as never));
    expect(乗らん, "問答を渡さないのに欄の名前の案内が出た").not.toContain("「分野」はこの表の欄");
    /* 磁石は畫面でも立たない。*/
    const 磁石 = String(
      図({ ...土, query: "分類学", termCounts: [], columnValueHits: 問答 } as never),
    );
    expect(磁石).not.toContain("「分類」はこの表の欄");
  });
  it("值だけで打つ人は今まで通り（案内を被せない）", () => {
    expect(件("セキュリティ")).toBe(68);
    expect(件("論文締切")).toBe(264);
    for (const 文 of ["セキュリティ", "論文締切", "機械学習", "関西"]) {
      expect(欄の案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
  });
  it("既知の境界 – `テーマセッション` は通る（案内の主張は噓ではない）", () => {
    /* 残り「セッション」は検査用ビルドで 2 行に當つので門②を通る。案内は「テーマは欄の名前で
       值ではない」で、この打ち方でも噓ではない – 廣げ方を決めた邊境として張る（第 508 回）。*/
    expect(件("セッション")).toBe(2);
    expect(欄の案内("テーマセッション")).toContain("「テーマ」はこの表の欄");
  });
  it("第 470 回〜第 507 回の実測は此の回で変へて居ない", () => {
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
  it("連結形の口が現れ、足場に登錄して在る（第 504 回の落とし穴の再発防止）", () => {
    expect(物).toContain("function columnGluedEntryJa");
    expect(物).toContain("function columnGluedEntryJa(query, 値が当たるか)");
    expect(物).toContain("if (値.length < 2)");
    const 足場 = readFileSync(join(import.meta.dirname, "runtime_extract.ts"), "utf8");
    expect(足場).toContain('jsFunction(rec, "columnGluedEntryJa")');
    /* 畫面の實配線 – filter に問答を詰め（詰め忘れる改ざん T5 で捕まる）、其れを二箇所に渡し、
       問答の中身が「其れだけで行が出るか」である事（常に真へ緩めると磁石が通る – T3 で捕まる）。*/
    const 画面 = readFileSync(join(builtSite(), "app.js"), "utf8");
    expect(画面).toContain("columnValueHits: columnValueHitsJa,");
    expect(画面.split("filter.columnValueHits").length - 1).toBe(2);
    expect(画面).toContain("counted.catalog + counted.journal > 0");
  });
});

describe("欄の名前が**末尾**に來る連結形（第 608 回）", () => {
  /* 日本語は「値 + の + 欄の名前」と言い返す（`関西の会場` `東京の会場`）。頭の道（第 508 回）の
   * 裏側で、實測（2026-08-09 生成の実ビルド 868 行）では此の形が 0 件で默つて居た – 其の名前
   * 單體では第 507 回の斷りが出るのに。此の道は**案内だけ**で、検索の割りは變へん。*/
  it("前の部が行を持つ形は、單體と同じ斷りが出る", () => {
    for (const [文, 欄] of [
      ["関西の会場", "会場"],
      ["東京の会場", "会場"],
      ["おきなわの場所", "場所"],
    ] as const) {
      expect(件(文), `增やした道が行を出す打ち方になった ${文}`).toBe(0);
      const 案内 = 欄の案内(文);
      expect(案内, `「${文}」が默つて居る`).toContain(`「${欄}」はこの表の欄`);
      expect(案内).toContain("値で打ってください");
    }
    /* 值の方で打てば出る（關西 6 行 – 検査の前提）。 */
    expect(件("関西"), "`関西` の行が潰れた").toBeGreaterThan(0);
  });
  it("門を通らん物は默る – 前の部で行が出ん時と、問答を渡さん時（第 508 回）", () => {
    expect(件("学生登録"), "この檢査の前提が崩れた").toBe(0);
    expect(欄の案内("学生登録の締切"), "值で無い部に欄の名前を説いた").toBe("");
    /* 問答（值が行を持つかの目）を渡さない道は舊の侭默る – 品書を持つのは `site/app.ts`。*/
    expect(欄の案内("関西の会場", false), "問答無しで欄の名前の案内が出た").not.toContain(
      "「会場」はこの表の欄",
    );
  });
  it("檢索の割りは變へて居らん（案内だけ – 第 362 回）", () => {
    /* `会場` を要求する群は其侭殘る – 落として行を廣げても無い（第 245 回の全行の語にして
     * 居らん事の実證。欄の名前として第 507 回の斷りを受ける道が正）。*/
    const 群 = Recommender.queryTokenGroups("関西の会場", 基準);
    expect(
      群.some((g) => g.every((語) => 語.includes("会場"))),
      "會場の群が消えた",
    ).toBe(true);
    /* 頭の道（第 508 回）を奪つて居らん – 両方通る形は頭が勝つ。*/
    expect(欄の案内("分野セキュリティ")).toContain("「分野」はこの表の欄");
  });
});
