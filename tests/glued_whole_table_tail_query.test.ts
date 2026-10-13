import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();

function 件数(文: string): number {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 全.filter((行) => 照合(行) === true).length;
}

function 行列表(文: string): string[] {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 全.filter((行) => 照合(行) === true);
}

function 畫面の案内(文: string): string {
  return [
    Recommender.columnQueryNoteJa(文) || "",
    Recommender.uiWordNoteJa(文) || "",
    Recommender.dayRangeNoteJa(文) || "",
    Recommender.wholeTableQueryNoteJa(文) || "",
    ...(Recommender.relativeDayNotes(文, 基準) || []),
    ...Recommender.querySynonymNotes(文),
  ]
    .map((文句) => String(文句).trim())
    .filter(Boolean)
    .join(" ∥ ");
}

/* 全行の語の正本を検査側に書き写さない。*/
function 全行の語列(): string[] {
  const 品 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 定義 = 品.match(/const WHOLE_TABLE_QUERY_JA[\s\S]*?\];/)?.[0] ?? "";
  expect(定義, "WHOLE_TABLE_QUERY_JA が見つからない").toBeTruthy();
  return new Function(`${定義}; return WHOLE_TABLE_QUERY_JA;`)() as string[];
}

describe("この表の全行にあてはまる語", () => {
  it("品書に一度も出ない（繋げた語を割つても当たりが減らない事の證）", () => {
    expect(全.length, "品書の行数が 0（検査の前提が変わつた）").toBeGreaterThan(400);
    for (const 語 of 全行の語列()) {
      expect(件数(語), `「${語}」を行うが書いてある`).toBe(0);
    }
  });

  it("その語を後ろに繋げて打たれた形が、空格で並べた時と一字も違わない行を出す", () => {
    const 文例: Array<[string, string, string]> = [
      ["AI会議", "AI", "会議"],
      ["セキュリティ会議", "セキュリティ", "会議"],
      ["分散システム会議", "分散システム", "会議"],
      ["HPC会議", "HPC", "会議"],
      ["データベース会議", "データベース", "会議"],
      ["ワークショップ会議", "ワークショップ", "会議"],
      ["オンライン会議", "オンライン", "会議"],
      ["ポスター発表締切日", "ポスター発表", "締切日"],
    ];
    for (const [繋げた形, 頭, 語尾] of 文例) {
      expect(件数(頭), `頭の語「${頭}」その物が行を持たない（檢査の前提）`).toBeGreaterThan(0);
      /* 直し前は 0 行だつた – 上の「品書に一度も出ない」から従ひ的に決まる（語尾を含む語は
         品書の一行にも出ないので、繋げた形も当たる行が無い）。そこをここで一度見る。 */
      const 空格 = 件数(`${頭} ${語尾}`);
      expect(件数(繋げた形), `「${繋げた形}」が空格で並べた時と違う行数`).toBe(空格);
      expect(行列表(繋げた形).join("\n"), `「${繋げた形}」の行集合が頭の語と違う`).toBe(
        行列表(頭).join("\n"),
      );
    }
  });

  it("一文字の頭も割る（等級で打たれた形 – 助詞の割りの二文字の門は真似ない）", () => {
    expect(件数("A会議"), "一文字の頭が割れない").toBe(件数("A 会議"));
    expect(件数("A会議")).toBe(件数("A"));
    /* 頭が助詞その物の形も同じ – 空格で打った時と揃へば良いのである物を減らさない。*/
    for (const [繋げた形, 空格] of [
      ["が大会", "が 大会"],
      ["の会議", "の 会議"],
      ["し締切日", "し 締切日"],
    ] as Array<[string, string]>) {
      expect(行列表(繋げた形).join("\n"), `「${繋げた形}」が空格で打った時と違う`).toBe(
        行列表(空格).join("\n"),
      );
    }
  });

  it("二つ繋がれた形（`AI会議一覧`）も同じ語列に直す", () => {
    expect(Recommender.queryTokens("AI会議一覧").join("|")).toBe("ai|会議|一覧");
    expect(件数("AI会議一覧")).toBe(件数("AI"));
    expect(件数("AI会議一覧")).toBeGreaterThan(0);
  });

  it("全角の区切り・長い語から順に当てる（`〆` の形と重なる語尾）", () => {
    /* 検索語は `searchNormalize` を通つた後でここへ入るので、表の語も同じ目寄せる –
       `〆` は `締` になる（実測 – 寄せないとおなじ打ち方が 0 行の侭だつた）。*/
    expect(Recommender.queryTokens("A〆切日付").join("|")).toBe("a|締切日付");
    expect(件数("A〆切日付")).toBe(件数("A"));
    expect(件数("A〆切日付")).toBeGreaterThan(0);
    /* 二つの語尾が重なる形（`〆切一覧` は `一覧` でも終る）は長い方から当てる –
       短い方を先に見ると頭の語が壊れて 0 行に落ちる（改ざんで実測）。*/
    expect(Recommender.queryTokens("AI〆切一覧").join("|")).toBe("ai|締切一覧");
    expect(件数("AI〆切一覧")).toBe(件数("AI"));
    expect(件数("AI〆切一覧")).toBeGreaterThan(0);
    /* 語その物が重なる形は割らない – 第 239 回の案内がその方の形で受ける。*/
    expect(Recommender.queryTokens("〆切一覧").join("|")).toBe("締切一覧");
    expect(件数("〆切一覧")).toBe(0);
    expect(畫面の案内("〆切一覧")).toContain("この表の全行にあてはまる語");
  });

  it("第 245 回の案内がそのまま届く（割つた事を黙らない）", () => {
    const 案内 = 畫面の案内("AI会議");
    expect(案内).toContain("「会議」はこの表の全行にあてはまる語");
    expect(案内).toContain("他の語（「AI」）");
    expect(畫面の案内("セキュリティ会議")).toContain("「セキュリティ」");
    /* 頭が行を持たない文も無言では無い（`GPU会議` – 頭が 0 行なので 0 行のまま但し理由は出る）。*/
    expect(件数("GPU会議")).toBe(0);
    expect(畫面の案内("GPU会議"), "無言に戻つた").toContain("この表の全行にあてはまる語");
  });

  it("その方の規則がそのままの語を受ける形は割らない（第 372 回の決まり）", () => {
    const 寄せ: Array<[string, string, string]> = [
      ["穴場な会議", "穴場", "穴場"],
      ["隠れ家的な会議", "穴場", "穴場"],
      ["国内会議", "国内", "国内研究会"],
      ["A*な会議", "A*", "等級"],
    ];
    for (const [繋げた形, 頭, 寄せ先の語] of 寄せ) {
      expect(件数(繋げた形), `「${繋げた形}」が寄せ先の行と違う`).toBe(件数(頭));
      if (件数(頭) > 0) {
        expect(件数(繋げた形), `「${繋げた形}」の寄せ先が行を持たない`).toBeGreaterThan(0);
      }
      expect(
        畫面の案内(繋げた形),
        `「${繋げた形}」の案内が寄せ先「${寄せ先の語}」を名指していない`,
      ).toContain(寄せ先の語);
    }
  });

  it("語その物が全行の語の時は割らない（第 239 回の打ち直しの案内が消えない）", () => {
    for (const 文 of ["締切一覧", "すべて", "全て", "〆切一覧"]) {
      expect(件数(文), `「${文}」が行を出して了う`).toBe(0);
      expect(畫面の案内(文), `「${文}」の打ち直しの案内が消えた`).toContain(
        "この表の全行にあてはまる語",
      );
    }
  });

  it("期間の語に締切の語を繋げた形は期間の規則に任せる（第 344 回の案内が変わらぬ）", () => {
    const 案内 = 畫面の案内("8月締め");
    expect(案内, `「8月締め」の案内が消えた: ${案内}`).toContain("「8月締め」");
    expect(案内).toContain("分けて探しています");
    expect(件数("8月締め"), "期間の語の割方が変わった").toBe(件数("8月 締切"));
    /* 月の語に『締切日』を繋げた形も同じ – 期間の規則が『9月』と『締切』に直す。*/
    const 九月 = 畫面の案内("9月締切日");
    expect(九月, `「9月締切日」の案内が消えた: ${九月}`).toContain("「9月締切日」");
    expect(件数("9月締切日")).toBe(件数("9月"));
  });

  it("助詞で既に割れた打ち方と磁石の決まりを崩さない（第 513 回）", () => {
    /* 助詞で割れた形はその方の語列が主題 – 全行の語で細かく割らない。 */
    expect(Recommender.queryTokens("費用の安い会議").join("|")).toBe("費用|安い会議");
    expect(畫面の案内("費用の安い会議"), "欄の案内が消えた").toContain("「費用」");
    expect(畫面の案内("小規模な会議の会場")).toContain("「小規模な会議」はこの表が持っていません");
    /* 磁石（助詞を挟まない語の頭）は黙つた侭。 */
    for (const 文 of ["費用対効果分析", "リアルタイム処理", "メジャーな学会", "対面について"]) {
      expect(件数(文), `「${文}」が行を出すやうになつた`).toBe(0);
      expect(畫面の案内(文), `「${文}」が案内を出すやうになつた`).toBe("");
    }
    /* 助詞で割つた結果、語の列が跨られてもその方は変はつて居ない。 */
    expect(件数("秋の会議"), "季節の語が壊れた").toBe(件数("秋"));
  });

  it("成果物が配線の形を保つ（第 372 回の抜き出しと同じ入口）", () => {
    const 品 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["function 全行の語尾に割るJa(", 1],
      ["全行の語尾に割るJa(token)", 1],
      ["return 分野の複合に割るJa(token);", 1],
    ] as Array<[string, number]>) {
      expect(品.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 24)}`).toBe(数);
    }
  });
});

describe("助力の動詞で結ばれた打ち方（第 605 回）", () => {
  it("動詞を添えただけの打ち方は、添えん時と同じ行に会ふ", () => {
    for (const [結んだ形, 素の形] of [
      ["オンライン参加できる", "オンライン参加"],
      ["オンライン参加できる会議", "オンライン参加"],
      ["セキュリティできる", "セキュリティ"],
      ["分散システムできる", "分散システム"],
      ["参加したい", "参加"],
    ] as const) {
      expect(行列表(結んだ形).sort(), 結んだ形).toEqual(行列表(素の形).sort());
      expect(件数(結んだ形), `${結んだ形} が 0 行の侭（割りが屆いて居らん）`).toBeGreaterThan(0);
    }
  });

  it("語幹が残る割りをせず、訪ねの語尾の道を生かす（彈かれた作り）", () => {
    /* `したい` の目で割ると `知り` が残つて 0 行に落ちる – 語尾の一覧にある形で落す事。 */
    expect(行列表("会議の締切が知りたい")).toEqual(行列表("会議の締切"));
    expect(Recommender.queryTokenGroups("みたい", 基準), "`みたい` を割つた").toEqual([["みたい"]]);
    expect(Recommender.queryTokenGroups("できる", 基準), "`できる` 単体を行に出した").toEqual([
      ["できる"],
    ]);
  });

  it("打ち方の群は助詞の目で割れる前に直る", () => {
    expect(Recommender.queryTokenGroups("オンライン参加できる会議", 基準)).toEqual([
      ["オンライン参加"],
      ["会議"],
    ]);
  });

  it("語尾の一覧に增やした形は一度ずつ、裸の `たい` は入れて居らん", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = 源.indexOf("const UI_WORD_TAILS_JA = [");
    const 表 = 源.slice(i, 源.indexOf("\n  ];\n", i));
    for (const 語 of ["できますか", "できるか", "できるの", "出来る", "ほしい"]) {
      expect(表.split('"' + 語 + '"').length - 1, `${語} が語尾の一覧に二度並んで居る`).toBe(1);
    }
    /* 裸の `たい` が既あるのは其侭 – 語尾の落しは上の「知りたい」の道が先なので語幹は残らん
     * （其を上の検査が張る）。割りの目に入れない事だけ見る。 */
    expect(表.split('"できる",').length - 1, "`できる` を二度据へた").toBe(1);
    expect(表.split('"したい",').length - 1, "`したい` を二度据へた").toBe(1);
  });
});
