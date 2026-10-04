/**
 * 0 件の時に出す打ち直しの候補が、其の方の語で**絞れる物**だけの検査。SPEC §4・§7・第 364 回。
 * 実測（2026-10-21 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `締切間近` を打った人に「『締切』なら 709 件」（収録の 81%）、`論文賞` に「『論文』なら
 * 461 件」（53%）、`祝日 締切` にも『締切』を出していた – 其れらは絞り込みで無く、この画面が別に
 * 「其の語では絞れません」と言う語なので、打ち直しとして出すのは噓だった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 実品書(): string[] {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return (Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>).map((r) =>
    String(r.hay),
  );
}

/** 品書を組み立てる（其の方の語が何行に在るか自分で決めて張る – 実データに振り回されない）。 */
function 組品書(行々: string[]): string[] {
  return 行々;
}

const 十九行 = (() => {
  const 列: string[] = [];
  for (let i = 0; i < 15; i++) 列.push(`Alpha 論文 提出 2026-0${(i % 9) + 1}-1${i % 9}`);
  for (let i = 0; i < 3; i++) 列.push(`Beta 機械学習 workshop 2026-07-1${i}`);
  列.push("Gamma 機械学習 査読 2026-08-02");
  return 列;
})();

describe("打ち直しの候補は絞れる物だけ", () => {
  it("半分以上の行に当たる語は候補に出さない（組み立てた品書 – 実測値に依らない張りの形）", () => {
    /* 19 行中 15 行が『論文』、4 行が『機械学習』。`論文賞 機械学習` と打たれたら、
     * 『論文』（79%）は絞り込みで無いので出さず、『機械学習』は出す。 */
    const 品 = 組品書(十九行);
    const 候補 = Recommender.shorterHitWordsJa("論文賞 機械学習", 品, 基準);
    const 語々 = 候補.map((c) => c.word);
    expect(語々, "半分の行に当たる語を打ち直しに出した").not.toContain("論文");
    expect(語々.join(" "), "絞れる候補まで落とした").toContain("機械学習");
    for (const 候補 of Recommender.shorterHitWordsJa("論文賞 機械学習", 品, 基準)) {
      expect(
        候補.count * 2,
        `候補 \`${候補.word}\` が品書の半分超` + `（${候補.count}/${品.length}）`,
      ).toBeLessThan(品.length);
    }
  });

  it("品書が少ない時は半分でも落とさない（絞り込みなので – 実測の品書 872 行では常に効く）", () => {
    const 品 = 組品書([
      "Alpha 論文 2026-09-01",
      "Beta 機械学習 2026-09-02",
      "Gamma 機械学習 2026-09-03",
    ]);
    const 語々 = Recommender.shorterHitWordsJa("論文賞 機械学習", 品, 基準).map((c) => c.word);
    expect(語々.join(" "), "4 行未満の品書で候補を落とし過ぎた").toContain("論文");
  });

  it("実ビルドの品書でも、其の方の三形は絞れない語を打ち直さない", () => {
    const 品 = 実品書();
    expect(品.length, "検査の品書が読めない（検査が空振り）").toBeGreaterThan(100);
    for (const 打ち方 of ["締切間近", "論文賞", "祝日 締切"]) {
      const 候補 = Recommender.shorterHitWordsJa(打ち方, 品, 基準);
      for (const c of 候補) {
        expect(
          c.count * 2,
          `\`${打ち方}\` の候補 \`${c.word}\` ${c.count} 件は品書 ${品.length} 行の半分超`,
        ).toBeLessThan(品.length);
        expect(
          Recommender.wholeTableQueryWordJa(c.word),
          `\`${打ち方}\` の候補が表その物の語 \`${c.word}\``,
        ).toBe("");
      }
    }
  });

  it("表その物を指す語は、行数が少なくても打ち直しに出さない（第 245 回と噛み合わせる）", () => {
    /* 組み立てた品書: 19 行中 4 行が『締切日』を含む（4/19 なので半分の歯止めは通る）。
     * 『締切日』はこの画面が「其の語では絞れません」と別に言う語なので、其方へ打ち直せと
     * 言ってはならない – 表その物の語の歯止めが其処を塞ぐ（実測 – 其方を取り除いた改ざんで
     * 検出出来る事を確かめた）。 */
    const 列: string[] = [];
    for (let i = 0; i < 15; i++) 列.push(`Alpha 論文 提出 2026-0${(i % 9) + 1}-1${i % 9}`);
    for (let i = 0; i < 4; i++) 列.push(`Beta 締切日 workshop 2026-07-1${i}`);
    const 語々 = Recommender.shorterHitWordsJa("論文賞 締切日", 組品書(列), 基準).map(
      (c) => c.word,
    );
    expect(語々, "表その物を指す語を打ち直しに出した").not.toContain("締切日");
    expect(
      Recommender.wholeTableQueryWordJa("締切日"),
      "表その物の語の表から『締切日』が消えた",
    ).toBe("締切日");
  });

  it("他の打ち直し（語を絞る見当）は其侭働く（取り壊さない）", () => {
    const 品 = 実品書();
    const 見る: Array<[string, string]> = [
      ["機械学習 東京", "機械学習"],
      ["AI 穴場 関西", "穴場"],
      ["量子 委託", "量子"],
      ["ネットワーク 延長した締切", "ネットワーク"],
      ["セキュリティ 招待講演", "セキュリティ"],
    ];
    let 当たった = 0;
    for (const [打ち方, 期待] of 見る) {
      const 語々 = Recommender.shorterHitWordsJa(打ち方, 品, 基準).map((c) => c.word);
      if (語々.includes(期待)) 当たった += 1;
    }
    expect(当たった, "絞れる候補まで落ちた（其方達は見本に出る筈）").toBeGreaterThanOrEqual(4);
  });

  it("其の場の案内と打ち直しが噛み合わない形にしない（『締切』を打ち直しに出さない – 第 331 回）", () => {
    const 品 = 実品書();
    /* 『近い』の案内は「この表は近いの幅を決めない」と言い、其の足元で『締切』なら 709 件と
     * 言うのは自己矛盾だった（実測 – 案内が先に立って其の方は出ない形にする）。 */
    expect(Recommender.uiWordNoteJa("締切間近"), "締切の近さの案内が消えた").toContain("7 日");
    const 候補 = Recommender.shorterHitWordsJa("締切間近", 品, 基準).map((c) => c.word);
    expect(候補, "『近い』の案内が出る形で『締切』を打ち直しに出した").not.toContain("締切");
    expect(候補, "`今週` を打ち直しに出した – 其の方の語は画面のボタンへ導す側").not.toContain(
      "今週",
    );
  });

  it("品書が読めない打ち方では候補を出さない（空振りしない – 其の方の形は其侭）", () => {
    expect(Recommender.shorterHitWordsJa("", 組品書(十九行), 基準)).toEqual([]);
    expect(Recommender.shorterHitWordsJa(undefined, 組品書(十九行), 基準)).toEqual([]);
    expect(
      Recommender.shorterHitWordsJa("論文賞 機械学習", undefined as unknown as string[], 基準),
    ).toEqual([]);
  });
});
