/**
 * 種別を打つ人の語（`ピアレビュー結果`・`反論終了`・`早期割引`）と、寄せる先の真実性の検査
 * （SPEC §4・§7・第 345 回）。
 * 実測（2026-10-03 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `査読結果` 13 行・`反論` 27 行・`登録締切` 7 行・`rebuttal` 28 行が通るのに、`ピアレビュー結果`
 * **0 行**・`反論終了` **0 行**・`早期割引` **0 行**だった。加えて `随時受付` は 6 件返していたが、
 * **その 6 件はすべて会議名に "Journal" を含む行**（種別『常時受付』の行では無い – その種別はこの
 * 品書に 0 件）で、件数欄は「種別『常時受付』で探しています」と言っていた（案内と実物がズレていた）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

type 行 = { hay: string; kind?: string };

function 行列表(語: string): 行[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as 行[];
  const matches = Recommender.searchMatcher(語, 基準);
  return rows.filter((row) => matches(String(row.hay)) === true);
}

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

function 群(語: string): string[] {
  const groups = Recommender.queryTokenGroups(語, 基準) as unknown as string[][];
  return groups[0] || [];
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

describe("種別を打つ人の語", () => {
  it("`ピアレビュー結果` は査読結果公開の語に寄せる", () => {
    /* この検査の品書（435 行）には査読結果公開の行が無いので、**語の組**と案内で見る
     * （行数で Assert できるのは実ビルドで測れた物だけ – 第 341 回の教訓）。
     * 実ビルドの品書 872 行では `ピアレビュー結果` 13 行で、全行が種別 review_release。 */
    expect(群("ピアレビュー結果"), "`ピアレビュー結果` が査読結果公開に寄っていない").toContain(
      "査読結果公開",
    );
    expect(全案内("ピアレビュー結果"), "種別を名指さない").toContain("査読結果公開");
    /* 寄せ先が実在する語である事（別の語に寄せた時の行集合は対称差で見る – 下に同じ形）。 */
    expect(対称差("査読結果公開", "査読結果公開"), "寄せ先の語が引けない").toBe(0);
  });

  it("`反論終了` `反論提出` は反論期間終了と同じ行集合", () => {
    expect(行列表("反論期間終了").length, "対照の `反論期間終了` が 0 行").toBeGreaterThan(0);
    expect(
      対称差("反論終了", "反論期間終了"),
      "`反論終了` が `反論期間終了` と違う行を出した",
    ).toBe(0);
    expect(
      対称差("反論提出", "反論期間終了"),
      "`反論提出` が `反論期間終了` と違う行を出した",
    ).toBe(0);
    行列表("反論終了").forEach((行) => {
      expect(String(行.kind), "反論期間終了のはずが別の種別").toBe("rebuttal_end");
    });
  });

  it("早期割引を尋ねる人には登録の締切を出し、収録に区別が無い事をその場で書く", () => {
    expect(行列表("登録締切").length, "対照の `登録締切` が 0 行").toBeGreaterThan(0);
    expect(対称差("早期割引", "登録締切"), "`早期割引` が `登録締切` と違う行を出した").toBe(0);
    expect(対称差("早割", "登録締切"), "`早割` が `登録締切` と違う行を出した").toBe(0);
    行列表("早期割引").forEach((行) => {
      expect(String(行.kind), "登録の締切のはずが別の種別").toBe("registration");
    });
    const 案内 = 全案内("早期割引");
    expect(案内).toContain("登録締切");
    expect(案内, "収録に早期割引の区別が無い事を隠した").toContain("区別は無く");
  });

  it("一つの種別に寄せられない語は寄せない（`early bird`・`リバットル`）", () => {
    /* `early` 11 行は種別が論文・採否通知・査読結果公開・登録に散っていて、早期割引の区別は
     * 品書に 0 箇所。黙って登録締切に寄せない。 */
    expect(行列表("early bird").length, "`early bird` に種別を寄せた").toBe(0);
    expect(全案内("early bird")).not.toContain("種別");
    /* 語 `early` は散った種別にまたがる（実測 11 行: 論文 1・採否通知 4・査読結果公開 5・登録 1）
     * ので、`early` 自体も登録締切に寄せない – 寄せたら此処の種別が全部 registration になる。 */
    const ばら = 行列表("early");
    expect(ばら.length, "対照の `early` が 0 行").toBeGreaterThan(0);
    const 種別 = new Set(ばら.map((行) => String(行.kind)));
    expect(
      種別.size === 1 && 種別.has("registration"),
      "`early` を登録締切に寄せてしまった（意味が広がる）",
    ).toBe(false);
    /* `リバットル` は反論期間開始（8 行）と終了（19 行）にまたがる – 一つの種別へ寄せるのは
     * 意味が広がるので、対応を画面に書く道だけを残す（既の判断 – 検査で守られている）。 */
    expect(行列表("リバットル").length).toBe(0);
    /* 画面側の説明（`emptyDeadlineHint`）が二つの種別を名指す事は、其の側の検査が既に張っている
     * （`tests/build_golden.test.ts` – 表示語を書いていないと落ちる）。此処では寄せ語彙に
     * 入っていない事だけを見る。 */
    expect(全案内("リバットル")).not.toContain("という語で探しています");
  });
});

describe("寄せ先は画面に出る語だけ（案内と実物の一致）", () => {
  it("`随時受付` の寄せ先に英文字の `journal` を入れない", () => {
    /* 実ビルドの品書 872 行での実測（第 345 回）: `随時受付` は 6 件返していたが、その 6 件は
     * すべて会議名に "Journal" を含む行で、件数欄は「種別『常時受付』で探していますと言っていた。
     * 寄せ先から `journal` を落としたので、語の組には其れが入らない。 */
    expect(群("随時受付"), "寄せ先に英文字の journal が入った").not.toContain("journal");
    expect(群("随時受付")).toContain("常時受付");
    expect(群("学会誌")).not.toContain("journal");
    /*英文字を打った人は其の語で探す（日本語の語の側に混ぜない）。 */
    expect(行列表("journal").length, "対照の `journal` が 0 行").toBeGreaterThan(0);
    expect(全案内("学会誌"), "探した種別を書いていない").toContain("常時受付");
  });
});

describe("成果物", () => {
  it("組み立てた品が四つの言い方を持ち、死んだ寄せ先が残っていない", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(rec.includes("ピアレビュー結果"), "`ピアレビュー結果` が成果物から消えた").toBe(true);
    expect(rec.includes("反論期間終了"), "`反論終了` の寄せ先が成果物から消えた").toBe(true);
    expect(rec.includes("収録に早期割引の区別は無く"), "早期割引の案内が成果物から消えた").toBe(
      true,
    );
    /* `リバットル` は寄せ語彙に足さない代わり、種別の別名の表に留める（画面の説明が其れを見る）。 */
    expect(rec.includes('"リバットル"'), "`リバットル` の種別の別名が消えた").toBe(true);
    /* `随時受付` の展開語に英文字 `journal` を戻すと、会議名で当たった行が種別の寄せで出る。 */
    const 印 = rec.indexOf('["随時受付"');
    const 条目 = rec.slice(印, rec.indexOf("]],", 印) + 3);
    expect(条目.includes("常時受付"), "`随時受付` の条目が見つからない").toBe(true);
    expect(条目.includes("journal"), "`随時受付` の寄せ先に英文字の journal が戻った").toBe(false);
  });
});
