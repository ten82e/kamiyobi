/**
 * 画面自身の語（使い方・並び替え・出典・カテゴリなど）を検索欄に打った人への案内の検査
 * （SPEC §7）。ビルド済みの `emptyDeadlineHint`（0 件案内）と `zeroResultLiveNote`（読み上げ）を
 * そのまま動かす（第 248 回）。
 *
 * tests/build_golden.test.ts は biome の 1 MiB 上限（tests/lint_budget.test.ts）に近いので、
 * 新しい検査はここに置く（同じ抜き出しハーネスは tests/runtime_extract.ts に共有した）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";
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
  /* 操作の語は、操作する場所を言う – ただし並び替えと絞り込みでは場所が違う（第 338 回:
   * 並び替えは列の見出しを押す操作で、『並び順』という欄は在らない）。 */
  const uiSort = hint({ ...clear, query: "並び替え" });
  expect(uiSort, "並び替えが見出しの操作を言っていない").toContain("列の見出し");
  const uiFilter = hint({ ...clear, query: "絞り込み" });
  expect(uiFilter, "絞り込みが操作する欄の場所を言っていない").toContain("上にある欄");
  /* 出典の語は、出典を出している場所を言う。 */
  const uiSource = hint({ ...clear, query: "出典" });
  expect(uiSource, "データ源の場所を言っていない").toContain("データ源");
  /* 参加形式の「対面」側（行に表記が 1 つも無い語）は、収録していないことを言う。 */
  const uiOffline = hint({ ...clear, query: "対面" });
  expect(uiOffline, "参加形式の印の言い方を言っていない").toContain("オンライン参加可");
  expect(uiOffline, "収録していないことを言っていない").toContain("収録していません");
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
  /* 「対面」の読み上げも同じことを言う（行に出る語ではないので、絞れない理由を言う –
   * 実測: HEAD のビルドでは読み上げが空だった）。 */
  const offline = note({ ...empty, query: "対面", termCounts: [{ term: "対面", count: 0 }] });
  expect(offline, "参加形式の印の言い方を読み上げていない").toContain("オンライン参加可");
  /* 読み上げは長い文を流さない（同じ画面の別の検査が 60 字を見ているので、同じ上限で切る）。 */
  for (const word of [
    "使い方",
    "並び替え",
    "絞り込み",
    "フィルタ",
    "出典",
    "カテゴリ",
    "対面",
    "対面開催",
    "オンサイト",
  ]) {
    const live = note({ ...empty, query: word, termCounts: [{ term: word, count: 0 }] });
    expect(live.length, `「${word}」の読み上げが長い: ${live}`).toBeLessThanOrEqual(60);
  }
});

it("日数の範囲の言い方（`1か月以内`・`1週間以内`）を打った人を、実際に効く絞り込みへ送る（SPEC §7）", () => {
  /* 研究計画の締切切り出しでいちばん言う言い方（2026-08-09 生成ビルド・固定時刻で実測:
   * `3日以内` 0 行・`7日以内` 0 行・`1週間以内` 0 行・`1か月以内` 0 行・`90日以内` 0 行、
   * 案内は「語がありません」だけで、締切日からの日数で絞る「締切まで」の選択欄のことを
   * 言っていなかった）。暦日のグループへ展開しない – 表の暦日語は会期の日時も含まれるため
   * 「3 日以内に締切がある行」のつもりで会期が 3 日以内の行が混じる
   * （実測: `2026年8月30日` に当たる 14 行のうち締切がその日の行は 0 行）。 */
  const hint = deadlineHintFunction();
  const live = zeroResultLiveFunction();
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  const win = /<select id="win"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  expect(win, "「締切まで」の選択欄がビルド済み画面に見つからない").toBeTruthy();
  const options = [
    ...String(win ? win[1] : "").matchAll(/<option value="[^"]*">([^<]*)<\/option>/g),
  ].map((m) => String(m[1]));
  expect(options.length, "選択肢が読み取れない（検査が空振りになる）").toBeGreaterThan(1);

  let checked = 0;
  for (const word of [
    "3日以内",
    "7日以内",
    "1週間以内",
    "2週間以内",
    "1か月以内",
    "3ヶ月以内",
    "90日以内",
    "180日以内",
    "1年以内",
  ]) {
    const text = hint({ ...clear, query: word, termCounts: [{ term: word, count: 0 }] });
    expect(text, `「${word}」の案内が行き先を言っていない`).toContain("締切まで");
    expect(text, `「${word}」に対して直らない「語が無い」案内を立てている`).not.toContain(
      "収録データにも見当たりません",
    );
    /* 案内が行き先に挙げる語は、選択欄に実在する選択肢でなければならない
     * （画面に無い値を案内するのは別の噓になる）。 */
    const named = /「締切まで」[^。]*?「([^」]+)」/.exec(text);
    expect(named, `「${word}」の案内に行き先の語が無い`).toBeTruthy();
    expect(options, `案内の「${named ? named[1] : ""}」は選択欄に無い語`).toContain(
      named ? named[1] : "",
    );
    const said = live({ ...empty, query: word, termCounts: [{ term: word, count: 0 }] });
    expect(said, `読み上げが行き先を言っていない（${word}）`).toContain("締切まで");
    // 読み上げは 1 打鍵ごとに流れるので短い形で（同じ場所に出る他の案内と同じ約束）。
    expect(said.length, `読み上げが長すぎる（${word}）`).toBeLessThanOrEqual(60);
    checked += 1;
  }
  expect(checked, "案内を検査した語数が少ない（検査が空振り）").toBeGreaterThan(6);

  /* 行き先が違う語に同じ案内を出さない（`9月` は検索語として当たる – 実測 687 行）。 */
  const month = hint({ ...clear, query: "9月", termCounts: [{ term: "9月", count: 12 }] });
  expect(month, "月の語に期間の絞り込みへ送る案内を出している").not.toContain(
    "検索語としては当たりません",
  );
});
