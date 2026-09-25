/**
 * 「其れより前」・「より後」・月の初め・月末の別の言い方（第 390 回）。
 *
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * - `8月以降` 772 行・`9月以降の締切` 557 行が通るのに、助詞で打った `8月より後` `9月より後`
 *   `来月より後` `来年より後` `明日より後` `8月より後ろ` `8月よりあと` は**0 行で案内も無し**。
 *   → 其の方の幅の規則に字面だけ寄せる（寄せ先は実在する – 対称差 0）。
 * - `月の終わり` 189 行が通るのに `月の末日` `月末日` `8月の末日` `8月末日` は**0 行**。
 *   → 同じ規則に「末日」を加える（裸の `末日` は寄せない – 其の方の意味に混じる）。
 * - `月初` `月初め` `月前半` は案内が出るのに `月の初め` `月の頭` `月初の頃` は**0 行で案内も無し**。
 * - `当面` `近いうち` `直近` `早め` は案内が出るのに `近日` `近日中` `もうすぐ` `早いうち`
 *   `もう間もなく` は**0 行で案内も無し**。
 * - `以前` と単体で打てば案内が出るのに、月の語を付けた `8月以前` `3月以前` `去年以前`
 *   `8月より前` `先月より前` は**0 行で案内も無し**（照合が完全一致と語の先頭の形しか見て
 *   なかった – 語の末尾に付いた形を受ける）。此の表は「其れより前」の幅を持たない（既定で過ぎた
 *   締切を除く為）ので、絞らずに次に打てる道を名指す。
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
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

/** 画面の件数欄に出る案内（site/app.ts の見張りと同じ入力の集まり）。 */
function 画面の案内(語: string): string {
  const 文: string[] = [];
  for (const 欄 of [
    "uiWordLiveNoteJa",
    "columnQueryLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const) {
    const 値 = (Recommender as unknown as Record<string, (語: string) => string>)[欄](語);
    if (値) 文.push(String(値));
  }
  return 文.join(" | ");
}

/** 寄せた先と同じ行だけ出す事を張る（絶対数はハーネスで変わる – 第 384 回）。 */
function 同じ行列表か(打ち方: string, 正本の打ち方: string) {
  const 正 = 当たり列表(正本の打ち方);
  expect(正.length, `品書に寄せ先の行が無い: ${正本の打ち方}`).toBeGreaterThan(0);
  expect(対称差(当たり列表(打ち方), 正), `当たり列表が違う: ${打ち方}`).toBe(0);
}

describe("其れより前・より後・月初・月末の別の言い方", () => {
  it("『より後』は『以降』と同じ行だけ出す", () => {
    同じ行列表か("8月より後", "8月以降");
    同じ行列表か("9月より後", "9月以降");
    同じ行列表か("来月より後", "来月以降");
    /* 「後ろ」は「後」より先に読まないと `以降ろ` に化ける（実測で 0 行に落ちた – ソースの注）。 */
    同じ行列表か("8月より後ろ", "8月以降");
    同じ行列表か("8月よりあと", "8月以降");
  });

  it("『末日』は『月末』と同じ行だけ出し、裸の『末日』は寄せない", () => {
    同じ行列表か("月の末日", "月末");
    同じ行列表か("8月の末日", "8月末");
    同じ行列表か("月末日", "月末");
    同じ行列表か("8月末日", "8月末");
    /* 裸の語は寄せない – 「締切末日」の様な別の話に混じる（測って引込まない）。 */
    expect(当たり列表("末日"), "裸の『末日』を寄せてしまった").toEqual([]);
    expect(画面の案内("末日"), "裸の『末日』に案内を立てた").toBe("");
  });

  it("其れより前は絞らない – 代わりに次に打てる二つの道を名指す", () => {
    for (const 語 of ["8月以前", "3月以前", "去年以前", "8月より前", "先月より前"]) {
      expect(当たり列表(語), `幅を作ってしまった: ${語}`).toEqual([]);
      const 文 = 画面の案内(語);
      expect(文, `案内が出ていない: ${語}`).toContain("過去の締切も表示");
      /* 案内が名指す道は本物 – 其れを打つと行が出る（此の検査が其れを張る – 第 338 回）。 */
      expect(文).toContain("1月から7月");
      expect(当たり列表("1月から7月").length, "案内が名指した幅が行を持たない").toBeGreaterThan(0);
      expect(当たり列表("1月").length, "案内が名指した月が行を持たない").toBeGreaterThan(0);
    }
  });

  it("案内は『品書に何も無い』とは言わない – 既定で過ぎた物を除くからだと書く", () => {
    const 文 = 画面の案内("8月以前");
    expect(文).toContain("過ぎた締切");
    expect(文, "品書の話をしていない – 案内が収録の有無を語らない決まり").not.toContain("品書");
    expect(文).not.toContain("情報は在りません");
    /* 其れより後の案内を此の語に混じらない（其の方の幅は解ける – 案内を乗せると塞ぐ）。 */
    expect(画面の案内("8月以降")).not.toContain("其れより前");
    expect(当たり列表("8月以降").length, "其れより後が消えた").toBeGreaterThan(0);
  });

  it("月初・曖昧な幅の別の言い方も同じ案内を通す", () => {
    for (const 語 of ["月の初め", "月の頭", "月初の頃"]) {
      const 文 = 画面の案内(語);
      expect(文, `案内が出ていない: ${語}`).toContain("月初の決まりは無い");
      expect(文).toContain("上旬");
    }
    for (const 語 of ["近日", "近日中", "もうすぐ", "早いうち", "もう間もなく"]) {
      const 文 = 画面の案内(語);
      expect(文, `案内が出ていない: ${語}`).toContain("曖昧な幅では絞れません");
      expect(文, "締切までの欄へ導していない").toContain("7 日以内");
      expect(当たり列表(語), `曖昧な幅で絞った: ${語}`).toEqual([]);
    }
    /* 其の方の分け方（上旬・中旬・下旬）は無傷 – 案内を混じらない。 */
    expect(当たり列表("8月上旬").length, "上旬が消えた").toBeGreaterThan(0);
    expect(画面の案内("8月上旬")).not.toContain("其れより前");
  });

  it("裸の『前』は其の侭通り、其の語の案内を混じない", () => {
    expect(当たり列表("前").length, "裸の『前』まで塞いだ").toBeGreaterThan(0);
    expect(画面の案内("前"), "裸の『前』に案内を立てた").not.toContain("其れより前");
  });

  it("案内の文と語の列が成果物に入って居る（正規表現を二箇所に書いていない）", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 寄せ先の語の列は書き換えの関数に一つだけ（使う所と合わせて二箇所）。 */
    expect(成果物.split("より後の言い方").length - 1).toBe(2);
    /* 絞らない案内は「其れより前」の話として一つ – 同じ話を別の群に書き写して居ない事の張る。 */
    expect(成果物.split("という其れより前の幅では絞りません").length - 1).toBe(1);
    expect(成果物.split("という其れより前の幅では絞り込めません").length - 1).toBe(1);
    /* 語の末尾を受ける規則も一箇所（宣言・其れを見る所・其の中の語 – 実測 3 回）。 */
    expect(成果物.split("語尾の案内").length - 1).toBe(3);
  });
});
