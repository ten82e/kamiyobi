/**
 * 文の見本の殘り（第 717 回）。
 *
 * 實測（2026-10-06 – 收錄の全體 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使ふ固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）– 文の見本 106 文の
 * 行き止まりは 9 文まで減つた（第 700 回の初めは 51）。此の回は其の內の二つを直した:
 * `共著者と相談`（著者の群へ – `共著者` は既に其の群に居る）と `最終版`（`最終稿` と同じ物なので
 * 同じ寄せへ。實測 `最終版` 0 行 / `最終稿` 149 行）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}

function 行列表(語: string): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 品書()
    .filter((行) => 照合(行) === true)
    .sort();
}

describe("文の見本の殘り（第 717 回）", () => {
  it("共著者と相談は、著者の群の斷りを受ける", () => {
    expect(行列表("共著者と相談").length, "行が出た").toBe(0);
    const 文 = String(Recommender.uiWordNoteJa("共著者と相談", false) || "");
    expect(文, "默つた").not.toBe("");
    expect(文, "打たれた語を書き返して居ん").toContain("「共著者と相談」");
    expect(文, "著者の群の斷りで無い").toContain("著者や発表者の役");
    /* 同じ群の語（元から居る）の扱ひを變へて居ない。 */
    expect(行列表("共著者").length).toBe(0);
    expect(String(Recommender.uiWordNoteJa("共著者", false) || "")).toContain("著者や発表者の役");
  });

  it("最終版の提出は、の を拔いて既存の寄せに渡す（第 720 回）", () => {
    /* 實測（2026-10-06）: `最終版の提出` は 0 行・案内も無しだつた（`の` の一枚で語が割れ、
     * 寄せが效かなかつた）。**語を寄せ先へ直すのではなく、`の` を拔く** – 既存の寄せ
     *（`最終版提出` → 種別「カメラレディ締切」）に渡すので、同じ事を二箇所に書かずに濟む。*/
    const 正 = 行列表("カメラレディ");
    expect(正.length, "この検査の前提（カメラレディに行が出る）が崩れた").toBeGreaterThan(0);
    expect(行列表("最終版の提出"), "カメラレディと別の行").toEqual(正);
    expect(行列表("最終版提出"), "の 無しと別の行").toEqual(正);
  });

  it("カメラレディの準備は、の準備 を拔いて其の語へ渡す（第 721 回）", () => {
    /* 同じ形の二つ目。語その物が行を持つので、案内では無く行が出る形に成る。 */
    const 正 = 行列表("カメラレディ");
    expect(正.length, "この検査の前提（カメラレディに行が出る）が崩れた").toBeGreaterThan(0);
    expect(行列表("カメラレディの準備"), "カメラレディと別の行").toEqual(正);
  });

  it("最終版は寄せない（意味が広がる語 – 第 246 回の境界をそのままにする）", () => {
    /* この回の初めに `最終稿` と同じ寄せ（種別「カメラレディ締切」）へ入れてみたが、
     * **既存の検査が「意味が広がる語」として張っていた**（`最終版` は何の最終版か決まらない）
     * ので取り下げた – 譲った事をここにも書く（第 706 回と同じ手）。 */
    expect(行列表("最終稿").length, "この検査の前提（最終稿に行が出る）が崩れた").toBeGreaterThan(
      0,
    );
    expect(
      String(Recommender.querySynonymNotes("最終版").join("")),
      "最終版を寄せた（意味が広がる語）",
    ).toBe("");
  });
});
