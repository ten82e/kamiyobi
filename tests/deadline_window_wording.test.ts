/**
 * 画面の日数の欄の語を写した打ち方（`締切まで30日`）と、時間の単位（`48時間以内`）、
 * 過ぎた締切の言い方の検査。SPEC §4・§7・第 365 回。
 * 実測（2026-10-22 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `締切まで30日` `締切までの30日` `締切まで 30 日` `締切まで1週間` `〆切まで 1 週間`
 * `しめきりまで 3 日` `1時間以内` `24時間以内` `48時間以内` `半日以内` `とっくに過ぎた締切`
 * `終了した会議` `終了済み` `採録済み` `もう終わる` `終わった会議` が **0 行で案内も無し**だった
 * （其の方の `30日以内` 249 行・`7日以内` 60 行・`1日以内` 5 行は通っていた）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string): Array<{ hay: string }> {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書().filter((row) => matches(String(row.hay)) === true);
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
    Recommender.dayRangeNoteJa(語),
    Recommender.dayRangeLiveNoteJa(語),
    Recommender.relativeDayNotes(語, 基準).join(" "),
  ]
    .filter((x) => x)
    .join(" ");
}

/** 画面の日数の欄の語を写した打ち方 → 其の方の幅の検索語（行集合が一字も違わない事）。 */
const 窓の言い方: Array<[string, string]> = [
  ["締切まで30日", "30日以内"],
  ["締切までの30日", "30日以内"],
  ["締切まで 30 日", "30日以内"],
  ["締切までに30日", "30日以内"],
  ["締切まで7日", "7日以内"],
  ["締切まで90日", "90日以内"],
  ["締切まで180日", "180日以内"],
  ["締切まで1週間", "7日以内"],
  ["締切まで2週間", "14日以内"],
  ["〆切まで 1 週間", "7日以内"],
  ["しめきりまで 3 日", "3日以内"],
];

describe("画面の日数の欄の語を写した打ち方", () => {
  it("其の方の幅の検索語と一字も違わない行を出す（行を作らない – 第 337 回）", () => {
    for (const [打ち方, 幅] of 窓の言い方) {
      expect(対称差(打ち方, 幅), `\`${打ち方}\` が \`${幅}\` と違う行を出した`).toBe(0);
    }
    /* 検査の品書（435 行・固定時刻）で其の方の幅が出る形を選んで張っている事を見せる。 */
    const 出る = 窓の言い方.filter(([打ち方]) => 行列表(打ち方).length > 0);
    expect(出る.length, "窓の言い方が検査の品書で 0 行（対称差ゼロが空振り）").toBeGreaterThan(0);
  });

  it("助詞の `で` で「まで」を割らない（第 365 回の実測の根 – 語が壊れて探していた）", () => {
    const 語々 = (
      Recommender as unknown as { queryTokenGroups: (q: string, n: number) => string[][] }
    ).queryTokenGroups("締切まで30日", 基準);
    const 語々々 = 語々.reduce((全, 組) => 全.concat(組 as string[]), [] as string[]);
    expect(語々々, "語が壊れている（`締切ま` で探していた – 直し前の実測）").not.toContain(
      "締切ま",
    );
    expect(語々々, "其の方の語が其のまま残っていない").toContain("締切まで30日");
    /* 他の助詞の切れ目は其侭効く事（割る仕組みを取り壊していない）。 */
    const 割れる = JSON.stringify(
      (
        Recommender as unknown as { queryTokenGroups: (q: string, n: number) => string[][] }
      ).queryTokenGroups("国内の研究会", 基準),
    );
    expect(割れる, "`の` で割らなくなった（他の語まで壊した）").toContain("研究会");
  });

  it("離して打たれた形は繋がった形に寄せるが、頼みの向きが変わる形は寄せない", () => {
    const 語る = (q: string) =>
      JSON.stringify(
        (
          Recommender as unknown as { queryTokenGroups: (q: string, n: number) => string[][] }
        ).queryTokenGroups(q, 基準),
      );
    expect(語る("締切まで 30 日"), "離した形が語に割れた侭").toContain("締切まで30日");
    /* `以上` `前後` が続くと頼みの向きが変わるので寄せない（実測 – 其のまま 0 行の侭）。 */
    expect(語る("締切まで 30 日以上"), "`以上` 付きを同じ幅に寄せてしまった").not.toContain(
      "締切まで30日",
    );
    expect(行列表("締切まで 30 日以上").length, "`以上` 付きに行が出た").toBe(0);
  });

  it("一年を超える幅は黙らせず、其の方の形が検索として効くと見せない", () => {
    for (const 語 of ["締切まで2年", "今日から400日", "締切まで366日"]) {
      expect(全案内(語), `\`${語}\` が 0 行と無言に戻った`).toContain("締切まで");
      expect(行列表(語).length, `\`${語}\` に行が出るようになった（展開の上限は一年）`).toBe(0);
    }
  });
});

describe("時間の単位で打たれた形", () => {
  it("黙って 0 行にせず、締切が日単位であることを言う（幅を勝手に作らない）", () => {
    for (const 語 of [
      "1時間以内",
      "3時間以内",
      "24時間以内",
      "48時間以内",
      "72時間以内",
      "半日以内",
    ]) {
      const 案内 = Recommender.dayRangeNoteJa(語);
      expect(案内, `\`${語}\` が 0 行と無言に戻った`).toContain("日単位");
      /* 「7 日以内が近い」様な誘い方をしない – 其の方は其れより広い幅なので噓になる。 */
      expect(案内, `\`${語}\` の案内がもっと広い幅へ誘導している`).not.toContain("7 日以内");
      expect(行列表(語).length, `\`${語}\` に行が出るようになった – 時間では絞れない`).toBe(0);
    }
  });

  it("読み上げも同じ事を短い文で言う", () => {
    const 文 = Recommender.dayRangeLiveNoteJa("48時間以内");
    expect(文).toContain("日単位");
    expect(文.length, "読み上げが長い").toBeLessThan(70);
  });
});

describe("過ぎた締切の言い方", () => {
  it("画面のトグルの名前を言う（画面の語は画面の正本から読む – 第 319 回）", () => {
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(html, "画面に『過去の締切も表示』の欄が無い").toContain("過去の締切も表示");
    for (const 語 of [
      "とっくに過ぎた締切",
      "過ぎた締切の",
      "終了した会議",
      "終了済み",
      "採録済み",
      "もう終わる",
      "終わった会議",
    ]) {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内, `\`${語}\` が 0 行と無言に戻った`).toContain("過去の締切も表示");
      expect(案内, `\`${語}\` の案内が打ち方を名指していない`).toContain(語);
    }
  });

  it("裸の二語は案内を立てない（第 320 回の決まり – 他の打ち方を潰さない）", () => {
    for (const 語 of ["過ぎた", "とっくに", "論文締切", "締切", "〆切", "締切 履歴"]) {
      expect(Recommender.uiWordNoteJa(語), `\`${語}\` に案内が立ってしまった`).toBe("");
    }
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ['(日間|日|週間|週)(?![以未前後])/g, "$1まで$2$3");', 1],
      ["const HOUR_RANGE_JA = ", 1],
      ["function 時間数から日数Ja", 1],
      ['"採録済み",', 1],
      ['"とっくに過ぎた締切",', 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 18)}`).toBe(数);
    }
    /* 助詞で割る文字は「まで」を含む語では `で` を外す – 其の物の形を見る（第 362 回の型）。 */
    expect(rec, "助詞の割り方が他の文字を巻き添えにしている").toContain(
      '助詞々 = 助詞々.replace("で", "").replace("の", "");',
    );
  });
});
