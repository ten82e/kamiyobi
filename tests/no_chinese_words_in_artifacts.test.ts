/**
 * 出來上がり（利用者が實際に讀む物）に、日本語で無い語を混ぜない（第 740 回）。
 *
 * 第 706 回に `快照`・`檔案`、第 733 回に `值`、第 738 回に `文件`（何れも中國語。日本語では
 * 「スナップショット／寫し」「ファイル」「値」）が**利用者に出る文**に混じつて居た。どれも
 * 人に見付けて貰つて直した物で、守りが無かつた。
 *
 * 何故**別の檔案**にしたか – 既存の同じ目的の檢査（`tests/built_golden_2.test.ts`）の語一覽へ
 * 足すと、**同じ檔案の別の檢査が落ちる**（語一覽は抽出されて `node -e` で動く檢査に取り込まれ、
 * 語が素の文字として實行される – 第 738・739 回に二度踏んだ）。此處は語を自分で持ち、**抽出の
 * 卷き添へに成らん**樣にした。
 *
 * 見る範圍 – **出來上がりだけ**（`public/` の HTML・索引・表・CSV）。`SPEC.md` や `README.md` は
 * 此の計畫の內側の文書で、舊字體（`檔案` の樣な字）を**わざと**使つて居るので、範圍に入れない
 * （入れると計畫自身の言葉遣ひを彈く）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 日本語の文に混ざると讀めなくなる語（文字番號で持つ – 此の檔案の見た目にも出さない）。 */
const 混ぜない語: Array<[string, number[]]> = [
  ["中國語の「ファイル」", [0x6587, 0x4ef6]],
  ["中國語の「値」", [0x503c]],
  ["中國語の「增」", [0x589e]],
  ["中國語の「スナップショット」", [0x5feb, 0x7167]],
  ["舊字の「ファイル」（計畫の內側では使ふが、出來上がりでは使はない）", [0x6a94, 0x6848]],
];

const 見る物 = [
  "index.html",
  "upcoming.html",
  "404.html",
  "llms.txt",
  "upcoming.md",
  "health.md",
  "data.csv",
];

describe("出來上がりに、日本語で無い語を混ぜない（第 740 回）", () => {
  it("利用者が讀む物に、混ざると讀めなくなる語が無い", () => {
    const site = builtSite();
    let 見た = 0;
    for (const name of 見る物) {
      const path = join(site, name);
      if (!existsSync(path)) continue;
      見た += 1;
      /* 引用（`` `…` `` で括つた實物の記録）は外してから見る – 説明の爲に引用する事が在る。 */
      const 本文 = readFileSync(path, "utf8").replace(/`[^`\n]*`/g, "");
      for (const [呼び名, 符] of 混ぜない語) {
        const 語 = String.fromCharCode(...符);
        expect(本文.includes(語), `${name} に${呼び名}の語が混ざつて居る`).toBe(false);
      }
    }
    /* 空振り防止（一つの檔案も見て居ない檢査に成つて居ないか）。 */
    expect(見た, "出來上がりを一つも見て居ない（建ててから走らせる事）").toBeGreaterThanOrEqual(5);
  });
});
