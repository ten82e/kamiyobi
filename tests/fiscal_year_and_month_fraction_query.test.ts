/**
 * 月の幅を柔らかな日本語で打つ形（`8月半ば` `来月初旬` `8月中頃` `上旬頃`）・年度の別の書き方
 * （`本年度` `当年度`）・月の幅に締切の語を繋げた形（`8月上旬締め`）の検査（SPEC §4・§7・第 348 回）。
 * 実測（2026-10-06 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `上旬` 35 行・`中旬` 74 行・`下旬` 91 行・`来月上旬` 88 行・`8月上旬 締切` 30 行・
 * `来月上旬 締切` 73 行・`今月中旬 締切` 70 行・`今年度` 872 行が通るのに、`初旬` **0 行**・
 * `半ば` **0 行**・`中頃` **0 行**・`今月半ば` **0 行**・`来月初旬` **0 行**・`8月中頃` **0 行**・
 * `上旬頃` **0 行**・`本年度` **0 行**・`当年度` **0 行**・`8月上旬締め` **0 行**・
 * `来月上旬締め` **0 行**・`来月下旬締め` **0 行**だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行列表(語: string): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 全案内(語: string): string {
  return [
    Recommender.querySynonymNotes(語).join(" "),
    Recommender.uiWordNoteJa(語),
    Recommender.uiWordLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((文) => 文)
    .join(" / ");
}

/** 成果物に組み立てられた書き換え関数を実際に走らせる（其の関数が参照する表の宣言も置く – 第 347 回）。 */
function 書き換え(語: string): string {
  const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 本体 = jsFunction(rec, "collapseRelativeDayPhrase");
  const 表 = rec.slice(rec.indexOf("const RELATIVE_DAY_PHRASES_JA"));
  const 表の宣言 = 表.slice(0, 表.indexOf("];") + 2);
  expect(表の宣言.includes("["), "`RELATIVE_DAY_PHRASES_JA` の宣言が見つからない").toBe(true);
  /* 語の助詞の表（第 458 回・第 459 回）– 此の書き換えが語を落とす時に読むので、
   * 其の方の宣言も置く（第 347 回 – 参照する表を渡さないと同じ穴に落ちる）。*/
  const 助詞の表 = rec.match(/const QUERY_PARTICLE_SPLIT_CHARS = [^\n]*;/)?.[0] ?? "";
  expect(助詞の表, "`QUERY_PARTICLE_SPLIT_CHARS` の宣言が見つからない").not.toBe("");
  /* 漢数字を算用数字に直す正本（第 392 回）– 上の語の寄せが呼ぶので、関数だけ渡すと
   * `漢の数字に直すJa is not defined` に化ける（第 257 回と同じ穴 – 実際に落ちた）。 */
  const 下請け = jsFunction(rec, "漢の数字に直すJa");
  const 関数 = new Function(
    "Recommender",
    `${表の宣言}\n${助詞の表}\nconst 漢の数字に直すJa = ${下請け};\nreturn (${本体});`,
  )(Recommender) as (語: string) => string;
  return 関数(語);
}

describe("月の幅を柔らかな日本語で打つ形", () => {
  it("`初旬` と其の接頭辞付きは上旬と同じ行を出す", () => {
    expect(行列表("上旬").length, "対照の `上旬` が 0 行").toBeGreaterThan(0);
    expect(対称差("初旬", "上旬"), "`初旬` が `上旬` と違う行を出した").toBe(0);
    expect(対称差("来月初旬", "来月上旬"), "`来月初旬` が `来月上旬` と違う行を出した").toBe(0);
    expect(対称差("8月初旬", "8月上旬"), "`8月初旬` が `8月上旬` と違う行を出した").toBe(0);
    /* 幅の表が其の日付を書く – 寄せた語の名前での案内になる（探していない幅を画面に書かない）。 */
    expect(全案内("来月初旬"), "其の幅の日付を書いていない").toContain("2026年9月1日(火)");
  });

  it("`半ば` `中頃` は中旬と同じ行を出す", () => {
    expect(対称差("8月半ば", "8月中旬"), "`8月半ば` が `8月中旬` と違う行を出した").toBe(0);
    expect(対称差("8月中頃", "8月中旬"), "`8月中頃` が `8月中旬` と違う行を出した").toBe(0);
    expect(対称差("今月半ば", "今月中旬"), "`今月半ば` が違う行を出した").toBe(0);
    expect(対称差("来月半ば", "来月中旬"), "`来月半ば` が違う行を出した").toBe(0);
    expect(全案内("8月半ば"), "其の幅の日付を書いていない").toContain("2026年8月11日(火)");
    /* 其の月の全体を言う `8月中`（第 341 回の規則 – `8月` に寄せる）を、中旬の寄せが食わない事。 */
    expect(書き換え("8月中旬"), "`8月中旬` を壊した").toBe("8月中旬");
    expect(対称差("8月中", "8月"), "`8月中` の既の寄せが壊れた").toBe(0);
  });

  it("`上旬頃` `下旬頃` の `頃` は幅を変えない", () => {
    expect(対称差("上旬頃", "上旬"), "`上旬頃` が `上旬` と違う行を出した").toBe(0);
    expect(対称差("下旬頃", "下旬"), "`下旬頃` が `下旬` と違う行を出した").toBe(0);
    expect(対称差("中旬頃", "中旬"), "`中旬頃` が `中旬` と違う行を出した").toBe(0);
    /* 其の幅の語に『頃』を付けた形（其の方の表に其の形が在るかを見る – 初めは中旬が抜けていた）。 */
    expect(書き換え("中旬頃"), "`中旬頃` が寄せられない").toBe("中旬");
    expect(対称差("8月末頃", "8月末"), "`8月末頃` が `8月末` と違う行を出した").toBe(0);
  });

  it("`本年度` `当年度` は今年度と同じ行を出す（他の年度語は寄せない）", () => {
    expect(行列表("今年度").length, "対照の `今年度` が 0 行").toBeGreaterThan(0);
    expect(対称差("本年度", "今年度"), "`本年度` が `今年度` と違う行を出した").toBe(0);
    expect(対称差("当年度", "今年度"), "`当年度` が `今年度` と違う行を出した").toBe(0);
    expect(全案内("本年度"), "年度の幅を書いていない").toContain("2026年4月1日(水)");
    /* 来年度・翌年度・前年度は別の幅 – 其の方に其の語が在るのだから触らない。 */
    for (const 語 of ["来年度", "翌年度", "前年度"]) {
      expect(書き換え(語), `${語} を今年度に寄せてしまった`).toBe(語);
    }
    expect(
      対称差("来年度", "今年度") > 0,
      "`来年度` と `今年度` が同じ行になった（年度語が壊れた）",
    ).toBe(true);
  });
});

describe("月の幅に締切の語を繋げて打つ形", () => {
  it("`8月上旬締め` `来月上旬〆` `今月中旬しめきり` は空格で打つのと同じ行を出す", () => {
    expect(行列表("8月上旬 締切").length, "対照の `8月上旬 締切` が 0 行").toBeGreaterThan(0);
    expect(対称差("8月上旬締め", "8月上旬 締切"), "`8月上旬締め` が違う行を出した").toBe(0);
    expect(対称差("来月上旬締め", "来月上旬 締切"), "`来月上旬締め` が違う行を出した").toBe(0);
    expect(対称差("来月上旬〆", "来月上旬 締切"), "`来月上旬〆` が違う行を出した").toBe(0);
    expect(対称差("来月下旬締め", "来月下旬 締切"), "`来月下旬締め` が違う行を出した").toBe(0);
    expect(対称差("今月中旬しめきり", "今月中旬 締切"), "`今月中旬しめきり` が違う行を出した").toBe(
      0,
    );
    expect(全案内("8月上旬締め"), "寄せた語を名指していない").toContain("「8月上旬」と「締切」");
  });

  it("`8月半ば締め` は其の幅を中旬に直してから分ける（探していない幅を画面に書かない）", () => {
    expect(対称差("8月半ば締め", "8月中旬 締切"), "`8月半ば締め` が違う行を出した").toBe(0);
    expect(対称差("来月初旬締め", "来月上旬 締切"), "`来月初旬締め` が違う行を出した").toBe(0);
    const 案内 = 全案内("8月半ば締め");
    expect(案内, "実際に照った幅を書いていない").toContain("「8月中旬」と「締切」");
    expect(案内, "探していない幅を名指した").not.toContain("「8月半ば」と「締切」");
  });

  it("其の日だけの幅に繋がれた形も空格と同じ（其の幅に行が無くても 0 件の侭 – 対称差で見る）", () => {
    expect(対称差("上旬締切", "上旬 締切"), "`上旬締切` が `上旬 締切` と違う行を出した").toBe(0);
    expect(書き換え("上旬締切")).toBe("上旬 締切");
    expect(書き換え("来月上旬締め")).toBe("来月上旬 締切");
    expect(書き換え("8月半ば締め")).toBe("8月中旬 締切");
    /* 対照 – 第 344・346・347 回の形はこの回合の変更でも其侭通る。 */
    expect(書き換え("3月末締め")).toBe("3月 締切");
    expect(書き換え("週末締切")).toBe("週末 締切");
    expect(書き換え("来週末まで")).toBe("来週末まで");
  });
});

describe("成果物", () => {
  it("四つの寄せが関数の中に在り、幅その物を作っていない", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(本文.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    expect(本文.includes("初旬の言い方"), "`初旬` の寄せが関数の外に出た").toBe(true);
    expect(本文.includes("中旬の別の言い方"), "`半ば` `中頃` の寄せが消えた").toBe(true);
    expect(本文.includes("頃の言い方"), "`頃` の寄せが消えた").toBe(true);
    /* 『頃』の規則は `月末` を月の語に寄せる規則より前に適用する（後だと `8月末頃` が
     * `8月頃` に割れて 0 行になる – 其の順序を崩す改ざんを検査で検出した）。 */
    expect(
      本文.indexOf("out = out.replace(頃の言い方") < 本文.indexOf("out = out.replace(月の末尾"),
      "`頃` の規則が `N月末` の規則より後ろに並んだ",
    ).toBe(true);
    expect(本文.includes("年度の別の言い方"), "年度語の寄せが消えた").toBe(true);
    /* 寄せ先は既の幅の語だけ – 新しい幅を作らない（日付の表は其の方で持つ）。 */
    expect(書き換え("初旬")).toBe("上旬");
    expect(書き換え("半ば")).toBe("中旬");
    expect(書き換え("中頃")).toBe("中旬");
    expect(書き換え("下中旬")).toBe("下中旬");
    /* 年度の表は今年度に揃えるだけで、他の年度語に手を入れない。 */
    const 年度宣言 = 本文.slice(本文.indexOf("年度の別の言い方"));
    const 年度規則 = 年度宣言.slice(0, 年度宣言.indexOf(";"));
    expect(年度規則.includes("本年度"), "年度語の寄せが見つからない").toBe(true);
    for (const 語 of ["来年度", "翌年度", "前年度"]) {
      expect(年度規則.includes(語), `年度語の寄せに ${語} を入れた`).toBe(false);
    }
    /* 月の幅に繋がれた締切の語を受ける形 – 其の枝其の物が効く（枝を落とすと 0 行に戻る – 改ざんで確認）。 */
    const 締切宣言 = 本文.slice(本文.indexOf("締切を繋げた言い方"));
    const 締切規則 = 締切宣言.slice(0, 締切宣言.indexOf(";"));
    expect(締切規則.includes("(?:上|中|下)旬"), "月の幅に繋がれた締切の語を受ける形が消えた").toBe(
      true,
    );
    /* 並び順は張らない – 月の語を先に並べ替えて測った所、同じ行数だった（正規表現は前の枝が
     * 失敗すれば次の枝を試す – 其の順でないと壊れると書く前に其の順を崩して測る、第 346 回の
     * 教訓を此の回合でもう一度確認した – 検査の側も同じ過ちを起こす）。 */
    expect(rec.includes("に分けて探しています"), "繋げた形の案内が消えた").toBe(true);
  });
});
