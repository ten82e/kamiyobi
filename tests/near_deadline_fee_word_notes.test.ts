/**
 * 締切の近さと費用の言い方が、案内に辿り着かない抜け（第 382 回）。
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 近さは `締切間近` `締切目前` `締切が近い` `近い締切` `間近の締切` が案内に出るのに、
 * `締切間もなく` `間もなく締切` `締切直前` `直前の締切` `締切が間近い` `今にも締切`
 * `締切間近な会議` `締切目前の会議` は **0 行で案内も無し**だった。費用は `参加費` `受講料`
 * `旅費` `学生割引` が案内に出るのに、`掲載料` `出版費` `登録手数料` `参加手数料` `学割`
 * `早期割引料` `登録費用` `fee` は **0 行で案内も無し**だった（其の方の群に語が抜けただけ）。
 * 収録に費用の欄は無い（品書の文本に "fee" 0 箇所 – 此處の検査が其れを見る）ので
 * 「持っていません」は噓では無い。近い幅は勝手に決める事も出来ないので（締切の推測をしない）、
 * 案内は画面に実在する『締切まで 7 日以内』のボタンと `今週` `来週` へ導すだけにする。
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

function 全案内(語: string): string {
  const 入口 = [
    "columnQueryLiveNoteJa",
    "uiWordLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const;
  const 表 = Recommender as unknown as Record<
    (typeof 入口)[number],
    (q: string) => string | undefined
  >;
  return 入口.map((名) => String(表[名](語) || "")).join(" | ");
}

const 近さ = [
  "締切間もなく",
  "間もなく締切",
  "締切直前",
  "直前の締切",
  "締切が間近い",
  "今にも締切",
  "締切間近な会議",
  "締切目前の会議",
];

const 費用 = [
  "掲載料",
  "出版費",
  "登録手数料",
  "参加手数料",
  "学割",
  "早期割引料",
  "登録費用",
  "fee",
];

describe("締切の近さの言い方", () => {
  it("近さをまわし言葉で打っても、画面に実在する絞り方へ導す案内が出る", () => {
    for (const 語 of 近さ) {
      /* 当たりは 0 行の侭 – 「近い」の幅を決めて行を作っていない事の証明。 */
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("近いの幅は決まりません");
      /* 案内が名指すのは画面に実在するボタンと、其の方の語だけ（発明した絞り方を教えない）。 */
      expect(案内, `画面に無い絞りを教えた: ${語}`).toContain("締切まで 7 日以内");
      expect(案内).toContain("今週");
      expect(案内).toContain("来週");
      /* 件数や日数を發明しない。 */
      expect(案内, `件数を書いた: ${語}`).not.toMatch(/\d+ 件/);
    }
  });

  it("其の方の語は当たりとして通る（案内だけ出て行を絞れない状態にしない）", () => {
    for (const 語 of ["今週", "来週"]) {
      expect(当たり列表(語).length, `当たりが消えた: ${語}`).toBeGreaterThan(0);
      expect(全案内(語), `其の方が案内に落ちた: ${語}`).not.toContain("近いの幅は決まりません");
    }
    /* 既に案内の出て居た五語も其侭（語を足した事で群が壊れていない）。 */
    for (const 語 of ["締切間近", "近い締切"]) {
      expect(全案内(語), `既存の案内が消えた: ${語}`).toContain("近いの幅は決まりません");
    }
  });
});

describe("費用の言い方", () => {
  it("費用の欄を別の名前で打っても「持っていません」の案内が出る", () => {
    for (const 語 of 費用) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("費用の欄はありません");
      expect(案内, `行き先を書かない案内: ${語}`).toContain("公式ページ");
    }
    /* 「持っていません」が噓でない事 – 収録の文本に費用の語が混いていない（実測）。 */
    expect(品書().filter((行) => String(行.hay).toLowerCase().includes("fee")).length).toBe(0);
  });

  it("当たりの在る語を収録に無いと言わない（`早期割引` は 1 行通る）", () => {
    expect(当たり列表("早期割引").length).toBeGreaterThan(0);
    expect(全案内("早期割引")).not.toContain("費用の欄はありません");
  });

  it("空格で別の語を並べた形は、其の方の語が通る方だけ同じ案内に辿る", () => {
    /* 実測: `fee 料金` は費用の案内に辿る（`fee` が群の語なので空格に割れた形も受ける –
     * 群の `multiword` の約束）。逆に `締切 直前` は案内が出ない – 空格に割れた時に群の語と
     * 分かる形に成っていない為で、其の方の語（`締切` 単独）は表その物の語なので絞り込めない。
     * 望ましい振る舞いとして張るのは繋げた形（`締切直前`）まで – 下の通り。 */
    expect(全案内("fee 料金")).toContain("費用の欄はありません");
    expect(当たり列表("fee 料金")).toEqual([]);
    expect(全案内("締切 直前")).not.toContain("近いの幅は決まりません");
    expect(全案内("締切 直前")).not.toContain("費用の欄はありません");
    expect(全案内("締切直前")).toContain("近いの幅は決まりません");
  });

  it("足した語が成果物に入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of [
      "締切間もなく",
      "今にも締切",
      "締切目前の会議",
      "掲載料",
      "学割",
      "登録費用",
    ]) {
      const 数 = (成果物.match(new RegExp(`"${語}"`, "g")) || []).length;
      expect(数, `条目の数が違う: ${語}`).toBe(1);
    }
  });
});
