/**
 * 「打ちたい語」と「表に出る語」が噛み合わない検査（SPEC §7）。
 * ビルド済みサイトは tests/built_site.ts 経由で共有する（1 ファイルに全検査を並べると
 * biome の既定の上限にぶつかる – tests/lint_budget.test.ts）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; kind: string };

function rows(): Row[] {
  const parsed = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown;
  return Recommender.candidateRows(parsed as { conferences: unknown }) as Row[];
}

it("「〆切」で引いた人が「締切」で引いた人と同じ行に出会える（略字は照合の内側で折る）", () => {
  /* 「〆」は「締」の略字で、収録元が原表記のまま入る行がある（2026-08-09 生成の実測:
   * 情報処理学会研究会の「発表申込〆切(延長後)」）。NFKC は漢字の略字を折込まないので、
   * `〆切` は 4 行に当たり、同じ意味の `締切`（700 行）で引いた人と同じ画面に
   * 出会えなかった。 */
  const all = rows();
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay))).length;
  };
  const shime = hits("締切");
  expect(shime, "締切で引ける行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(hits("〆切"), "略字が折込まれていない（`〆切` が単独の語のまま残った）").toBe(shime);

  /* 折込みは両側に効いていること（実データに両方の表記が揃うとは限らないので、
   * 合成した行で確かめる）。 */
  expect(
    Recommender.searchMatcher("発表申込締切")("研究会 発表申込〆切(延長後)"),
    "検索語が「締」で原表記が「〆」の行に当たらない",
  ).toBe(true);
  expect(
    Recommender.searchMatcher("発表申込〆切")("研究会 発表申込締切"),
    "検索語が「〆」で原表記が「締」の行に当たらない",
  ).toBe(true);
  /* 照合に使う文字列（hay）に略字が残っていないこと – ここが残ると「締切」で引いた人が
   * その行をまだ逃がす。 */
  expect(
    all.filter((row) => String(row.hay).includes("〆")).length,
    "検索に使う文字列に略字が残っている（照合側が折れていない）",
  ).toBe(0);
  /* 無関係な語は変わらないこと（折込みを広げ過ぎていないことの確認）。 */
  expect(Recommender.searchMatcher("論文締切")("論文締切 2026年10月"), "語のかけ算が壊れた").toBe(
    true,
  );
  /* 画面に出す文字は書き換えていない – 収録の原表記は略字のまま残っている
   * （2026-08-09 生成の実測: ビルド後の data.json にも「〆」が 7 箇所残る）。 */
  expect(
    readFileSync(join(REPO_ROOT, "data", "manual.yaml"), "utf8"),
    "収録の原表記から略字が消えた（表示を書き換えた可能性がある）",
  ).toContain("〆");
  /* てびき: built の index.html に直接当てる（app.js を継いだ文字列だと、コードの中の
   * 日本語が混ざって空振りする – 第 239 回の実測）。 */
  expect(
    readFileSync(join(builtSite(), "index.html"), "utf8"),
    "てびきに折込む語の組を書いていない",
  ).toContain("<code>〆</code> → <code>締</code>");
});

it("「投稿締切」「論文提出」で引いた人が種別「論文締切」の行に出会える", () => {
  /* 日本の研究者がいちばん書く言い方なのに、表の語は「論文締切」なので噛み合わなかった
   * （2026-08-09 生成の実測: `投稿締切` 2 行 / `論文投稿` 1 行 / `論文提出` 0 行 /
   * `原稿提出` 0 行、同じ意味の `論文締切` は 454 行）。 */
  const all = rows();
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay)));
  };
  const paper = hits("論文締切").length;
  expect(paper, "論文締切の行が無い（検査が空振り）").toBeGreaterThan(0);
  for (const query of ["投稿締切", "論文投稿", "論文提出", "原稿提出", "投稿", "提出"]) {
    expect(hits(query).length, `「${query}」で種別「論文締切」の行に出会えない`).toBe(paper);
  }
  /* 寄せ先が誤っていないこと – 原文の "paper" に寄せると採否通知の行が混ざる
   * （`論文募集` で実測した失敗）。出る行は投稿締切の種類だけにする。 */
  const kinds = [...new Set(hits("投稿締切").map((row) => String(row.kind)))];
  expect(kinds, "寄せた行に投稿締切以外の種別が混ざった").toEqual(["paper"]);
  /* 寄せたことは件数欄に出す（寄せるだけだと、なぜ出たか分からない）。 */
  expect(Recommender.querySynonymNotes("投稿締切").join("")).toContain(
    "種別「論文締切」で探しています",
  );
  /* 絞り込みは壊れていない – 語のかけ算はそのまま効く。 */
  const both = hits("セキュリティ 提出").length;
  expect(both, "語のかけ算で 0 件になった").toBeGreaterThan(0);
  expect(both, "語のかけ算が絞れていない").toBeLessThan(paper);
});
