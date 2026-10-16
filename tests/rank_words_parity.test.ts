/**
 * ランクの語が、出口ごとに同じである事を見る（畫面の列・`upcoming.md`・`deadlines.ics`）。
 *
 * 2026-10-17 まで、ランクは**畫面の列と CSV にしか無かった** – JavaScript を使へない讀者
 * （`upcoming.md`・`upcoming.html`）と購読者（カレンダーしか見ない）には見えていなかつた。
 * 三つの出口が同じ正本（`conferences[].rank` + `rankPairLabelJa`）から語を取る事を、
 * 會場の URL で突き合わせて確かめる（書き寫しではない事・語がずれない事の両方）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 折り返しを戻した ICS。 */
function icsText(): string {
  return readFileSync(join(builtSite(), "deadlines.ics"), "utf8").replace(/\r\n[ \t]/g, "");
}

/** md の表の行を、素のセルに分ける（轉義を戻し、リンクは文字と行き先に分ける）。 */
function mdRows(): Array<{ url: string; rank: string }> {
  const md = readFileSync(join(builtSite(), "upcoming.md"), "utf8");
  const 出: Array<{ url: string; rank: string }> = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| 日付") || line.startsWith("|---")) continue;
    const セル = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
    if (セル.length < 10) continue;
    const url = /\]\(([^)\s]+)\)/.exec(セル[2])?.[1] ?? "";
    if (!url) continue;
    出.push({ url, rank: セル[9] ?? "" });
  }
  return 出;
}

/** ICS の 1 行から、（行き先の URL・ランクの語）を取り出す。 */
function icsRows(): Array<{ url: string; rank: string }> {
  const 出: Array<{ url: string; rank: string }> = [];
  for (const blk of icsText().split("BEGIN:VEVENT").slice(1)) {
    const url = (/URL:([^\r\n]+)/.exec(blk) ?? [])[1]?.trim() ?? "";
    const rank = (/ランク: ([^\\]*)/.exec(blk) ?? [])[1]?.trim() ?? "";
    if (!url) continue;
    出.push({ url, rank });
  }
  return 出;
}

it("ランクの語は、md と ICS で同じ（同じ會場なら同じ語）", () => {
  const md = mdRows();
  const ics = icsRows();
  expect(md.length, "upcoming.md の行が読めない").toBeGreaterThan(100);
  expect(ics.length, "deadlines.ics の行が読めない").toBeGreaterThan(100);
  const icsByUrl = new Map<string, string>();
  for (const r of ics) if (!icsByUrl.has(r.url)) icsByUrl.set(r.url, r.rank);
  const ずれ: string[] = [];
  let 突き合わせ = 0;
  for (const r of md) {
    const ics語 = icsByUrl.get(r.url);
    /* 會期だけの行や、カレンダーに入らない種別の行は突き合わせない。 */
    if (ics語 === undefined) continue;
    突き合わせ++;
    /* ランクが無い會場は、md が「未確認」・ICS は行を立てない（決めた書き分け）。 */
    const 望 = ics語 === "" ? "未確認" : ics語;
    if (r.rank !== 望) ずれ.push(`${r.url}: md「${r.rank}」≠ ICS「${ics語 || "(無し)"}」`);
  }
  expect(突き合わせ, "突き合わせられる行が無い（前提が崩れた）").toBeGreaterThan(50);
  expect(ずれ, `ランクの語が出口で違う: \n${ずれ.slice(0, 5).join("\n")}`).toEqual([]);
});

it("md と ICS のどちらにも、ランクを持つ行と持たない行が有る", () => {
  /* 全部に付いていたら、等級が無い會場にも語を立てて居る（md は「未確認」・ICS は無し）。 */
  const md = mdRows();
  const ics = icsRows();
  expect(
    md.filter((r) => r.rank && r.rank !== "未確認").length,
    "md にランクを持つ行が無い",
  ).toBeGreaterThan(0);
  expect(
    md.some((r) => r.rank === "未確認"),
    "md にランク未確認の行が無い",
  ).toBe(true);
  expect(ics.filter((r) => r.rank).length, "ICS にランクを持つ行が無い").toBeGreaterThan(0);
  expect(
    ics.some((r) => r.rank === ""),
    "ICS にランク無しの行が無い",
  ).toBe(true);
});
