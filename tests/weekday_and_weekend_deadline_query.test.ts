/**
 * その日・その曜日に締切の語を**繋げて**打つ形（`週末締切` `金曜締切` `明日締切`）と、
 * 其れらの語に `まで` `いっぱい` を繋げる形の検査（SPEC §4・§7・第 347 回）。
 * 実測（2026-10-05 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `週末 締切` 210 行・`金曜 締切` 112 行・`平日 締切` 499 行・`明日 締切` 3 行・`明後日 締切` 11 行・
 * `来週月曜 締切` 3 行・`週末` 268 行が通るのに、`週末締切` **0 行**・`金曜締切` **0 行**・
 * `月曜〆` **0 行**・`平日しめきり` **0 行**・`明日締切` **0 行**・`週末まで` **0 行**・
 * `週末いっぱい` **0 行**だった。
 * 取り違えやすい所: `来週末まで` 51 行・`来週金曜まで` 37 行・`今週金曜まで` 4 行は期間の語側の
 * 規則が日付の範囲に解いていて、其の日だけの行集合とは違う（`来週末` 単体は 40 行）。
 * 其の方を壊さない事が此処の契約の半分なので、対照として検査に置く。
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

/**
 * 成果物に組み立てられた書き換え関数を実際に走らせる（行集合に頼まない – 第 341 回の流儀）。
 * 其の関数は上の表 `RELATIVE_DAY_PHRASES_JA` を参照するので、其の宣言も一緒に与える
 * （関数本体だけ切り出して走らせると `ReferenceError` になる – 第 347 回の実発生）。
 */
function 書き換え(語: string): string {
  const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 本体 = jsFunction(rec, "collapseRelativeDayPhrase");
  const 表 = rec.slice(rec.indexOf("const RELATIVE_DAY_PHRASES_JA"));
  const 表の宣言 = 表.slice(0, 表.indexOf("];") + 2);
  expect(表の宣言.includes("["), "`RELATIVE_DAY_PHRASES_JA` の宣言が見つからない").toBe(true);
  /* 漢数字を算用数字に直す正本（第 392 回）– 上の語の寄せが呼ぶので、関数だけ渡すと
   * `漢の数字に直すJa is not defined` に化ける（第 257 回と同じ穴 – 実際に落ちた）。 */
  const 下請け = jsFunction(rec, "漢の数字に直すJa");
  const 関数 = new Function(
    "Recommender",
    `${表の宣言}\nconst 漢の数字に直すJa = ${下請け};\nreturn (${本体});`,
  )(Recommender) as (語: string) => string;
  return 関数(語);
}

describe("その日・その曜日に締切の語を繋げて打つ形", () => {
  it("`週末締切` `金曜締切` `月曜〆` `平日しめきり` は空格で打つのと同じ行を出す", () => {
    expect(行列表("週末 締切").length, "対照の `週末 締切` が 0 行").toBeGreaterThan(0);
    expect(対称差("週末締切", "週末 締切"), "`週末締切` が `週末 締切` と違う行を出した").toBe(0);
    expect(対称差("金曜締切", "金曜 締切"), "`金曜締切` が `金曜 締切` と違う行を出した").toBe(0);
    expect(対称差("月曜〆", "月曜 締切"), "`月曜〆` が `月曜 締切` と違う行を出した").toBe(0);
    expect(対称差("日曜締め", "日曜 締切"), "`日曜締め` が `日曜 締切` と違う行を出した").toBe(0);
    expect(
      対称差("平日しめきり", "平日 締切"),
      "`平日しめきり` が `平日 締切` と違う行を出した",
    ).toBe(0);
    const 週末 = new Set(行列表("週末").map((r) => r.hay));
    行列表("週末締切").forEach((行) => {
      expect(週末.has(String(行.hay)), "週末で無い行を出した").toBe(true);
    });
  });

  it("週を付けた曜日の形も其の日と『締切』に分けて探す", () => {
    expect(対称差("来週月曜締切", "来週月曜 締切"), "`来週月曜締切` が違う行を出した").toBe(0);
    expect(対称差("今週金曜締切", "今週金曜 締切"), "`今週金曜締切` が違う行を出した").toBe(0);
    expect(対称差("来週末締切", "来週末 締切"), "`来週末締切` が違う行を出した").toBe(0);
    expect(全案内("来週末締切"), "寄せた語を名指していない").toContain("「来週末」と「締切」");
    expect(全案内("週末締切")).toContain("に分けて探しています");
  });

  it("`明日締切` `明後日締切` も其の日と『締切』に分ける（日付の案内は其侭立つ）", () => {
    expect(対称差("明日締切", "明日 締切"), "`明日締切` が `明日 締切` と違う行を出した").toBe(0);
    expect(対称差("明後日締切", "明後日 締切"), "`明後日締切` が違う行を出した").toBe(0);
    /* 其の日が何の日かを書く案内は期間の語側の物なので、其れも一緒に立っている。 */
    expect(全案内("明日締切"), "其の日付を書いていない").toContain("2026年8月10日(月)");
  });

  it("`週末まで` `金曜まで` `平日まで` は其の語の締切として探し、其の事を件数欄に書く", () => {
    expect(対称差("週末まで", "週末"), "`週末まで` が `週末` と違う行を出した").toBe(0);
    expect(対称差("金曜まで", "金曜"), "`金曜まで` が `金曜` と違う行を出した").toBe(0);
    expect(対称差("平日まで", "平日"), "`平日まで` が `平日` と違う行を出した").toBe(0);
    expect(全案内("週末まで"), "何として探したかを書いていない").toContain(
      "「週末まで」は「週末」",
    );
    expect(全案内("金曜まで"), "何として探したかを書いていない").toContain("「金曜」の締切として");
  });

  it("日付の範囲に解く形は其の方の規則の侭（取り違えると件数と案内が壊れる）", () => {
    for (const 語 of ["来週末まで", "来週金曜まで", "今週金曜まで", "明日まで", "今日まで"]) {
      /* 其の方の案内は日付を書く（範囲なら「〜」、其の日だけなら「=」）– 寄せた場合は
       * 「〜の締切として探しています」に化けるので、日付が書かれている事を見る。 */
      expect(全案内(語), `${語} の日付の案内が消えた`).toContain("2026年8月");
      expect(全案内(語), `${語} を寄せた`).not.toContain("の締切として探しています");
      expect(書き換え(語), `${語} を寄せた（範囲の規則に割り込む形を寄せた）`).toBe(語);
    }
    /* `来週末まで`（51 行）と `来週末`（40 行）は別の頼み方 – 寄せたら其の方を壊す（実測）。 */
    expect(
      対称差("来週末まで", "来週末") > 0,
      "`来週末まで` と `来週末` が同じ行になった（範囲の規則が死んだ）",
    ).toBe(true);
  });

  it("`週末いっぱい` `金曜いっぱい` も其の語に寄せる（其単体で其の案内は出さない）", () => {
    expect(対称差("週末いっぱい", "週末"), "`週末いっぱい` が違う行を出した").toBe(0);
    expect(対称差("金曜いっぱい", "金曜"), "`金曜いっぱい` が違う行を出した").toBe(0);
    expect(対称差("来週末いっぱい", "来週末"), "`来週末いっぱい` が違う行を出した").toBe(0);
    expect(全案内("週末"), "其単体の打ち方に寄せの案内を出した").not.toContain(
      "の締切として探しています",
    );
  });
});

describe("成果物", () => {
  it("書き換えは語を分けるだけで、範囲の規則に譲る形は触らない", () => {
    expect(書き換え("週末締切")).toBe("週末 締切");
    expect(書き換え("金曜〆")).toBe("金曜 締切");
    expect(書き換え("平日しめきり")).toBe("平日 締切");
    expect(書き換え("来週月曜締切")).toBe("来週月曜 締切");
    expect(書き換え("明日締切")).toBe("明日 締切");
    expect(書き換え("週末まで")).toBe("週末");
    expect(書き換え("来週末まで"), "範囲に解く形を寄せた").toBe("来週末まで");
    expect(書き換え("来週金曜まで"), "範囲に解く形を寄せた").toBe("来週金曜まで");
    expect(書き換え("明日まで"), "範囲に解く形を寄せた").toBe("明日まで");
  });

  it("規則は関数の中に在り、曜日・週末・平日の語を受ける形が残っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 本文 = jsFunction(rec, "collapseRelativeDayPhrase");
    expect(本文.length, "`collapseRelativeDayPhrase` が見つからない").toBeGreaterThan(0);
    expect(本文.includes("[月火水木金土日]曜"), "曜日の語を受ける形が成果物から消えた").toBe(true);
    expect(本文.includes("週末|平日"), "週末・平日の語を受ける形が消えた").toBe(true);
    /* 範囲の規則に譲る為の見張り – 其れを消すと `来週末まで` を寄せてしまう（検査で実測）。 */
    expect(本文.includes("(?<!週)"), "`週` 付きの語を見張る形が消えた").toBe(true);
    const まで宣言 = 本文.slice(本文.indexOf("期日までの言い方"));
    const まで規則 = まで宣言.slice(0, まで宣言.indexOf(";"));
    expect(まで規則.includes("(?<![今来先再])"), "今週・来週の週末を見張る形が消えた").toBe(true);
    for (const 語 of ["明日", "今日", "来週", "今週", "来月"]) {
      expect(まで規則.includes(語), `範囲の規則が受ける ${語} を \`まで\` の頭に入れた`).toBe(
        false,
      );
    }
    expect(rec.includes("の締切として探しています"), "『まで』『いっぱい』の案内が消えた").toBe(
      true,
    );
    /* 締切の語に繋げる側は週を付けた形の枝を持たない – `来週月曜締切` の中にも `月曜締切` の形が
     * 在るので其のまま受かる（実測で同じ 3 行 – 第 346 回と同じ判断で二重の規則を置かない）。 */
    const 締切宣言 = 本文.slice(本文.indexOf("締切を繋げた言い方"));
    const 締切規則 = 締切宣言.slice(0, 締切宣言.indexOf(";"));
    expect(
      締切規則.includes("(?:今週|来週|再来週|先週)?[月火水木金土日]曜"),
      "週を付けた曜日の枝を又増やした",
    ).toBe(false);
    expect(締切規則.includes("週末|平日"), "締切の語の頭から週末・平日が消えた").toBe(true);
  });
});
