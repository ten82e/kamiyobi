/**
 * 0 件案内の「打ち直しの見当」（第 256 回）。
 *
 * 2026-08-09 生成ビルドで自然な打ち方 93 語を調べると 47 語が 0 件で、案内はどれにも
 * 同じ「検索語を短くする」を出していた。短くしても 0 件の語（`高速計算` `採択率`
 * `博士前期`）にその助言は直らない – 短くした語が収録に無いので、打ち直しても 0 件の
 * まま画面が動かない。逆に効く打ち直し（`生成AI` → `AI`）には、その語と件数を出せる。
 * ここでは「効く見当だけを、打たれた形で、正しい件数で出す」を見る（SPEC §7）。
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { data, site } from "./built_golden_shared.ts";
import { deadlineHintFunction, zeroResultLiveFunction } from "./runtime_extract.ts";

type Reco = {
  shorterHitWordsJa: (
    query: string,
    hays: readonly string[],
    nowMs?: number,
    limit?: number,
  ) => Array<{ word: string; count: number; how: string; pair?: string }>;
  candidateRows: (catalog: unknown, now?: number) => Array<{ hay: string }>;
  journalRows: (conferences: unknown, now?: number) => Array<{ hay: string }>;
};

let Rec: Reco;
const NOW = Date.parse("2026-08-09T00:00:00Z");

beforeAll(async () => {
  const mod = await import(pathToFileURL(`${site}/recommender.js`).href);
  Rec = mod.default as unknown as Reco;
  expect(existsSync(`${site}/recommender.js`), "ビルド済み recommender が無い").toBe(true);
});

/* 合成の収録（数の期待値を独立に数えられるようにするため – 実データの件数はデータの
 * 更新で動くので、ここではabsoluteな件数を検証に使わない）。 */
const HAYS = [
  "ai security symposium 2027 提案募集",
  "ai hpc workshop 提案募集 論文",
  "計算科学シンポジウム 提案募集",
  "学生 論文 賞 提案募集",
  "ネットワーク ワークショップ 提案募集",
  "論文誌 特別号 提案募集",
];

it("効く打ち直しを、打たれた形と件数で出す（ビルド済み recommender）", () => {
  const hits = Rec.shorterHitWordsJa("生成AI", HAYS, NOW);
  expect(hits.length, "見当が出ていない").toBeGreaterThan(0);
  /* 見本は小文字に折らない – `ai` と出しても読み手はそのまま打てない。 */
  expect(hits.map((h) => h.word)).toContain("AI");
  expect(hits[0].count, "AI を含む行は 2 件").toBe(2);
});

it("当たっている語は短くしない（語を外す案内と混ざる）", () => {
  /* `ネットワーク` は 1 行に当たっている。この語を `ネットワー` に縮める見当は、
   * 「その語を外すと増えます」と同時に立つと打ち直しの方針が二つになる。 */
  const hits = Rec.shorterHitWordsJa("ネットワーク福岡", HAYS, NOW);
  expect(hits.map((h) => h.word)).not.toContain("ネットワー");
  /* `論文誌` は当たっている（1 行）。短くした `論文` は 3 行に出る – 当たっている語に
   * これ以上見当を付けないなら、見当は空になる（当たっている語の短縮は外す案内と混ざる）。 */
  expect(Rec.shorterHitWordsJa("論文誌", HAYS, NOW)).toEqual([]);
});

it("割った組みは、両方を書く行の数を数える", () => {
  const hits = Rec.shorterHitWordsJa("学生論文", HAYS, NOW);
  const split = hits.filter((h) => h.how === "split");
  expect(split.length, "分割の見当が出ていない").toBeGreaterThan(0);
  /* `学生` は 1 行、`論文` は 2 行に出るが、両方を書く行は 1 行。打ち直した人に見えるのは
   * その 1 行なので、大きいほう（2）を言ってはならない。 */
  expect(split[0].count).toBe(1);
});

it("短くしても 0 件の語は見当を出さない（効かない助言の出どころを止める）", () => {
  expect(Rec.shorterHitWordsJa("博士前期", HAYS, NOW)).toEqual([]);
  expect(Rec.shorterHitWordsJa("", HAYS, NOW)).toEqual([]);
  expect(Rec.shorterHitWordsJa(undefined as unknown as string, HAYS, NOW)).toEqual([]);
  expect(Rec.shorterHitWordsJa("量子", [], NOW)).toEqual([]);
  /* 語が多すぎると打ち直しの見当が絞れないので手を出さない。 */
  expect(Rec.shorterHitWordsJa("あ い う え お か き", HAYS, NOW)).toEqual([]);
});

it("画面の案内は、効く見当を名指しし、効かないときは「短くする」と言わない", () => {
  const hint = deadlineHintFunction();
  const base = {
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    est: false,
    hidden: { past: 1200, est: 134 },
    hiddenKindWords: [],
    queryMatch: { catalog: 0, journal: 0 },
    termCounts: [{ term: "生成AI", count: 0 }],
    urlQuery: false,
    catalogConferences: 12,
  };
  const named = hint({
    ...base,
    query: "生成AI",
    shorterHits: [{ word: "AI", count: 1083, how: "shorten" }],
  });
  expect(named).toContain("検索語を「AI」に打ち替える");
  expect(named).toContain("1,083 件");
  expect(named, "効く見当があるのに一般的助言を並べている").not.toContain("検索語を短くする");

  const none = hint({ ...base, query: "博士前期", shorterHits: [] });
  expect(none, "短くしても 0 件の語に「短くする」と言っている").not.toContain("検索語を短くする");
  expect(none).toContain("別の語で試す");
});

it("読み上げは打ち直しを先に言い、60 字を越えるなら短い形に落ちる", () => {
  const live = zeroResultLiveFunction();
  const base = {
    hiddenKindWords: [],
    termCounts: [{ term: "生成AI", count: 0 }],
    urlQuery: false,
    queryMatch: { catalog: 0, journal: 0 },
    catalogConferences: 12,
    query: "生成AI",
    clearable: true,
    pastShown: false,
    hidden: { past: 1200, est: 134 },
  };
  const withAlt = live({
    ...base,
    shorterHits: [{ word: "AI", count: 1083, how: "shorten" }],
  });
  expect(withAlt).toContain("「AI」なら 1,083 件当たります");
  expect(withAlt.length, `読み上げが長い: ${withAlt.length} 字`).toBeLessThanOrEqual(60);
  /* 見当が無いときは従来どおり、語が収録に無いことを言う（打ち直しの文で隠さない）。 */
  const plain = live({ ...base, shorterHits: [] });
  expect(plain).toContain("語「生成AI」は収録データにありません");
  /* 長い語で見当を付けると 60 字に収まらないことがある – そのときは見当を出さない。 */
  const longWord = live({
    ...base,
    termCounts: [{ term: "分散並列処理基盤システム", count: 0 }],
    query: "分散並列処理基盤システム",
    shorterHits: [{ word: "分散並列処理基盤", count: 1200, how: "shorten" }],
  });
  expect(longWord.length, `読み上げが長い: ${longWord.length} 字`).toBeLessThanOrEqual(60);
});

it("実データのビルドで、打ち直しの見当が実際の収録から出る", async () => {
  const rows = Rec.candidateRows(data, NOW).concat(Rec.journalRows(data.conferences, NOW));
  const seen: Record<string, boolean> = {};
  const hays: string[] = [];
  rows.forEach((row) => {
    const hay = String(row.hay);
    if (seen[hay]) return;
    seen[hay] = true;
    hays.push(hay);
  });
  /* `生成AI` は収録に無い語 – – 短くした `AI` は出る（第 256 回の実測で 1,083 件）。 */
  const hits = Rec.shorterHitWordsJa("生成AI", hays, NOW);
  expect(hits.length, "実データで見当が出ていない").toBeGreaterThan(0);
  const named = hits.map((h) => h.word);
  expect(
    named.some((w) => w.toUpperCase() === "AI"),
    `見当が AI でない: ${named.join(",")}`,
  ).toBe(true);
  /* 見当として出した語が本当に当たることは、収録と同じ正規化を通した数え上げで確かめる
   * （素の `includes("ai")` は大文字の `AI` を数えないので、独立した期待値にならない）。 */
  const mod = await import(pathToFileURL(`${site}/recommender.js`).href);
  const matcher = (
    mod.default as unknown as { searchMatcher: (q: string, n: number) => (h: string) => boolean }
  ).searchMatcher("AI", NOW);
  expect(hits[0].count).toBe(hays.filter((hay) => matcher(hay)).length);
  /* 収録に無い語（`GPU`）は見当も出さない – 見当が出ないこと自体が案内の分岐になる。 */
  expect(Rec.shorterHitWordsJa("GPU", hays, NOW)).toEqual([]);
});
