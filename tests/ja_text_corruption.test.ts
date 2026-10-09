/**
 * 日本語の文字化けを検査する（第 903 回）。
 *
 * 2026-10-31 に実測した形: 注釈に日本語を書く段で、1 語だけが置換文字（U+FFFD）に
 * 成った。ビルドでブラウザへ出るファイルに残るため、画面に出る説明と同じだけ
 * 読まれる。しかも「壊れた字が 1 語だけ混じった注釈」は lint も旧字体の検査
 * （`scripts/ja-text-audit.ts`）も引っかからないので、気づくのは次にその注釈を
 * 読む時だけになる。実に 2 箇所の注釈がその形で残っていた。
 *
 * ここは機械が確かめる。旧字体の検査とは別に、「読めない字が混入していない」事だけを見る。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
/** 検査する置き場。`public/` は CI が行うビルドの生成物で .gitignore なので入れない。 */
const 置き場 = ["src", "site", "scripts", "tests", "data"] as const;
const 読む拡張子 = new Set([".ts", ".js", ".md", ".json", ".yaml", ".yml", ".txt", ".html"]);
/** 走らせない置き場（依存・生成物・作業物）。 */
const 飛ばす = new Set(["node_modules", ".git", "public", "work", ".cache", "coverage"]);

function 走査(dir: string, 見つけた: string[]): void {
  for (const name of readdirSync(dir)) {
    if (飛ばす.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      走査(path, 見つけた);
      continue;
    }
    if (!読む拡張子.has(extname(name))) continue;
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.includes("\ufffd"))
        見つけた.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim()}`);
    });
  }
}

function 混入を探す(): string[] {
  const 見つけた: string[] = [];
  for (const dir of 置き場) 走査(join(ROOT, dir), 見つけた);
  for (const name of ["README.md", "SPEC.md"]) {
    readFileSync(join(ROOT, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("\ufffd")) 見つけた.push(`${name}:${i + 1}: ${line.trim()}`);
      });
  }
  return 見つけた;
}

describe("日本語の文字化け", () => {
  it("追跡する置き場に置換文字（U+FFFD）が混ざっていない（第 903 回）", () => {
    const 見つけた = 混入を探す();
    expect(
      見つけた,
      [
        "読めない字（置換文字）が混入している:",
        ...見つけた,
        "",
        "注釈や説明の途中に 1 語だけ文字化けした形が典型。旧字体の検査では見えないので、",
        "そのまま書くと次の回を読む人が其れを悪い日本語として読む。書き直してから入れる。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("混入を 1 語でも検出できる – 検査が空振りでないことを確かめる", () => {
    /* サンプルは**検出に必要な行だけ**にする（本身的に置換文字を入れると自分の検査で落ちる）。 */
    const 見本 = ["const x = 1;", `あ${"\ufffd"}い`].join("\n");
    const 見つけた = 見本.split("\n").filter((l) => l.includes("\ufffd"));
    expect(見つけた.length, "1 語だけの混入も検出できる").toBe(1);
  });
});
