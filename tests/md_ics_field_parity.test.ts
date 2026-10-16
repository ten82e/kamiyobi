/**
 * 人が讀む三つの出口（畫面の列・`upcoming.md`・`deadlines.ics`）が、同じ欄に同じ語を
 * 書く事を見る。今はランク・会期・開催地。
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

type MdRow = { url: string; rank: string; session: string; place: string };

/** md の表の行を、素のセルに分ける（轉義を戻し、リンクは文字と行き先に分ける）。 */
function mdRows(): MdRow[] {
  const md = readFileSync(join(builtSite(), "upcoming.md"), "utf8");
  const 出: MdRow[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| 日付") || line.startsWith("|---")) continue;
    const セル = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
    if (セル.length < 10) continue;
    /* 會期（開催）の行はカレンダーに入れないので突き合わせない。 */
    if (セル[3] === "開催") continue;
    const url = /\]\(([^)\s]+)\)/.exec(セル[2])?.[1] ?? "";
    if (!url) continue;
    出.push({ url, rank: セル[9] ?? "", session: セル[7] ?? "", place: セル[6] ?? "" });
  }
  return 出;
}

type IcsRow = { url: string; rank: string; session: string; place: string; submission: boolean };

/** ICS の 1 行から、行き先の URL と本文の欄を取り出す。 */
function icsRows(): IcsRow[] {
  const 出: IcsRow[] = [];
  for (const blk of icsText().split("BEGIN:VEVENT").slice(1)) {
    const url = (/URL:([^\r\n]+)/.exec(blk) ?? [])[1]?.trim() ?? "";
    if (!url) continue;
    const desc = (/DESCRIPTION:([\s\S]*?)\r?\n[A-Z-]+[:;]/.exec(blk) ?? [])[1] ?? "";
    /* 轉義を戻し、本文の區切り（`\n` の 2 文字）を本物の改行に直してから欄を讀む。 */
    const 素 = desc.replace(/\\([,;\\])/g, "$1").replace(/\\n/g, "\n");
    const 欄 = (名: string): string =>
      (new RegExp(`^${名}: (.*)$`, "m").exec(素) ?? [])[1]?.trim() ?? "";
    出.push({
      url,
      rank: 欄("ランク"),
      session: 欄("会期"),
      place: 欄("開催地"),
      submission: /掲載予定: /.test(素),
    });
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

it("会期と開催地の語も、md と ICS で同じ", () => {
  /* 同じ正本（`editionSessionJa`・`placeJa` + 県名の補い）を呼んでいるが、
   * **片方だけ直した日に食い違う** – 轉義（`Copenhagen\, デンマーク`）をほどいて讀む。
   *
   * 突き合わせは**行き先の URL が 1 本に定まる會場だけ**にする: 同じリンクで複数の開催回を
   * 掲げる會場（IPSJ の研究會など）は、どの行とどの行が同じ物か URL では決まらない
   * （會期が違う行を突き合わせて、誤つたずれを報告した – 2026-10-17 實測）。 */
  const 一意 = (rows: Array<{ url: string }>): Set<string> => {
    const 數 = new Map<string, number>();
    for (const r of rows) 數.set(r.url, (數.get(r.url) ?? 0) + 1);
    return new Set([...數.entries()].filter(([, n]) => n === 1).map(([url]) => url));
  };
  const md = mdRows();
  const icsRowsAll = icsRows();
  const md一意 = 一意(md);
  const ics一意 = 一意(icsRowsAll);
  const icsByUrl = new Map<string, IcsRow>();
  for (const r of icsRowsAll) icsByUrl.set(r.url, r);
  const ずれ: string[] = [];
  let 突き合わせ = 0;
  for (const r of md) {
    if (!md一意.has(r.url) || !ics一意.has(r.url)) continue;
    const ics = icsByUrl.get(r.url);
    if (!ics) continue;
    突き合わせ++;
    if (ics.session && r.session !== ics.session)
      ずれ.push(`${r.url} 会期: md「${r.session}」≠ ICS「${ics.session}」`);
    if (r.place !== ics.place) ずれ.push(`${r.url} 開催地: md「${r.place}」≠ ICS「${ics.place}」`);
  }
  expect(突き合わせ, "突き合わせられる行が無い（前提が崩れた）").toBeGreaterThan(50);
  expect(ずれ, `会期・開催地の語が出口で違う: \n${ずれ.slice(0, 5).join("\n")}`).toEqual([]);
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
