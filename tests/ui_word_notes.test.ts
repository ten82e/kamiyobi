/**
 * 画面自身の語（使い方・並び替え・出典・カテゴリなど）を検索欄に打った人への案内の検査
 * （SPEC §7）。ビルド済みの `emptyDeadlineHint`（0 件案内）と `zeroResultLiveNote`（読み上げ）を
 * そのまま動かす（第 248 回）。
 *
 * tests/build_golden.test.ts は biome の 1 MiB 上限（tests/lint_budget.test.ts）に近いので、
 * 新しい検査はここに置く（同じ抜き出しハーネスは tests/runtime_extract.ts に共有した）。
 */

import { expect, it } from "vitest";
import { deadlineHintFunction, zeroResultLiveFunction } from "./runtime_extract.ts";

/* 条件をすべて外した 0 件の見立て（案内は「いまその条件で何行が隠れているか」を添えるので、
 * 外していない条件の内訳も渡す – 呼び出し側の実装と同じ形にしないと別の話になる – 第 136 回）。 */
const clear = {
  window: "all",
  past: true,
  cats: 0,
  domestic: false,
  rank: "all",
  kind: "",
  query: "",
  est: true,
  hiddenKindWords: [],
  queryMatch: { catalog: 0, journal: 0 },
  termCounts: [],
  catalogConferences: 12,
  hidden: {
    past: 1200,
    est: 134,
    window: 438,
    rank: 416,
    cats: 88,
    domestic: 61,
    online: 462,
    kind: 900,
  },
};

/* 読み上げの見立て（データは入っている前提 – 無いときの説明は別の検査で見る）。 */
const empty = {
  hiddenKindWords: [],
  termCounts: [],
  query: "",
  queryMatch: { catalog: 0, journal: 0 },
  catalogConferences: 12,
};

it("画面自身の語を打った人に、0 件の案内が行き先を言う（SPEC §7）", () => {
  /* 2026-08-09 生成ビルドの実測: `使い方` `並び替え` `出典` `カテゴリ` はいずれも 0 件で、
   * 案内は「語「使い方」は収録データにありません」で終わり、打ち直し方として
   * 「検索語を短くする」しか出していなかった（短くしても増えない語なので直らない）。 */
  const hint = deadlineHintFunction();
  const uiHits = hint({
    ...clear,
    query: "使い方",
    termCounts: [{ term: "使い方", count: 0 }],
  });
  expect(uiHits, "てびきの場所を言っていない").toContain("見方のてびき");
  expect(uiHits, "直らない打ち直し方（語を短くする）を出している").not.toContain(
    "検索語を短くする",
  );
  /* 操作の語は、操作する欄の場所を言う。 */
  const uiOps = hint({ ...clear, query: "並び替え" });
  expect(uiOps, "操作の欄の場所を言っていない").toContain("上にある欄");
  /* 出典の語は、出典を出している場所を言う。 */
  const uiSource = hint({ ...clear, query: "出典" });
  expect(uiSource, "データ源の場所を言っていない").toContain("データ源");
  /* 欄の名前の言い方（この画面で説明文に書かない語）は、打たれた語を書き返さない。 */
  const uiAlias = hint({ ...clear, query: "カテゴリ" });
  expect(uiAlias, "欄の名前への打ち直し方を言っていない").toContain("上の『分野』");
  expect(uiAlias, "実装側の語を案内に書き返している").not.toContain("カテゴリ");
});

it("画面自身の語を打った人に、読み上げでも行き先を言う（SPEC §7）", () => {
  /* 実測: HEAD のビルドでは「使い方」に対して「語「使い方」は収録データにありません」だけを
   * 読んでいた – 収録に無いのは確かだが、打ち直し方が分からない（第 248 回）。 */
  const note = zeroResultLiveFunction();
  const uiWord = note({ ...empty, query: "使い方", termCounts: [{ term: "使い方", count: 0 }] });
  expect(uiWord, "てびきの場所をよみ上げていない").toContain("見方のてびき");
  expect(uiWord, "収録に無い語と言ったままになっている").not.toContain("収録データにありません");
  /* 読み上げは長い文を流さない（同じ画面の別の検査が 60 字を見ているので、同じ上限で切る）。 */
  for (const word of ["使い方", "並び替え", "絞り込み", "フィルタ", "出典", "カテゴリ"]) {
    const live = note({ ...empty, query: word, termCounts: [{ term: word, count: 0 }] });
    expect(live.length, `「${word}」の読み上げが長い: ${live}`).toBeLessThanOrEqual(60);
  }
});
