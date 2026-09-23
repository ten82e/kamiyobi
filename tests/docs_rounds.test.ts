/**
 * 回の記録（README と SPEC）の番人。ビルド成果物を見ないので、大きくならない方に置く
 * （tests/lint_budget.test.ts の検査と同じ理由）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("README と SPEC の回の記録に、同じ見出しが二度並んでいない（重複追記の再発防止・SPEC §7）", () => {
  /* 第 239 回の記録を書いたとき、文書へ追記する手順を 4 度走らせて、同じ項が 4 並んだまま
   * コミットしていた（自查で発覚・2026-08-09 実測: README の第 239 回の変更履歴が 7 行 × 4、
   * 使い方の項も 4 重複）。人間が読む文書で同じ話を 4 回するのは使いにくいし、
   * 「今回の話」の位置が分からなくなる。同じ見出しが並んでいないことを検査にする。 */
  for (const name of ["README.md", "SPEC.md"]) {
    const lines = readFileSync(join(ROOT, name), "utf8").split("\n");
    const heads = lines.filter((line) => /^ {0,2}- \*\*/.test(line));
    expect(heads.length, `${name} の回の記録が見当たらない（検査が空振り）`).toBeGreaterThan(5);
    const counts = new Map<string, number>();
    heads.forEach((line) => {
      counts.set(line, (counts.get(line) || 0) + 1);
    });
    const dup = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([line, n]) => `${n} 度: ${line.slice(0, 54)}`);
    expect(dup, `${name} に同じ見出しが並んでいる`).toEqual([]);
  }
  /* 回の番号でも数える（見出しの語句を言い換えて重複を隠した日にも落ちるようにする）。 */
  for (const name of ["README.md", "SPEC.md"]) {
    const text = readFileSync(join(ROOT, name), "utf8");
    const rounds = [...text.matchAll(/^- \*\*.*?（(?:[^）]*?・)?第 (\d+) 回）/gm)].map((m) => m[1]);
    expect(rounds.length, `${name} の回番号が読めない（書式が変わった）`).toBeGreaterThan(5);
    const counts = new Map<string, number>();
    rounds.forEach((round) => {
      counts.set(round, (counts.get(round) || 0) + 1);
    });
    const dup = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([round, n]) => `第 ${round} 回 × ${n} 度`);
    expect(dup, `${name} に同じ回の記録が複数並んでいる`).toEqual([]);
  }
});
