/**
 * `llms.txt` の索引が、各成果物の収録範囲を実測の値で言っているかの検査（SPEC §7・第 291 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 索引は `catalog.json` を「締切画面向けの現在・
 * 近日期間カタログ。」とだけ書き、**生成から 180 日先で切れている**こと（実測の締切は
 * 2026-07-10 〜 2027-02-04・872 件）も、`data.json` が 2019-05-25 〜 2028-03-30 の 3,253 件を
 * 載せることも、`deadlines.ics` が 928 件・2028-03-30 までを載せることも言わなかった。
 * 機械に「この先いつまでの締切が出せるか」を訊かれた人は、索引だけ見て答えを作る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadlineSpan, toLlmsTxt } from "../src/build.ts";
import { site } from "./built_golden_shared.ts";

function llms(): string {
  return readFileSync(join(site, "llms.txt"), "utf8");
}

function indexLine(name: string): string {
  const line = llms()
    .split("\n")
    .find((l) => l.startsWith(`- ${name}：`));
  expect(line, `索引に ${name} の行が無い（検査が空振り）`).toBeDefined();
  return String(line);
}

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(site, name), "utf8")) as Record<string, unknown>;
}

function icsEventCount(): number {
  const text = readFileSync(join(site, "deadlines.ics"), "utf8");
  const n = (text.match(/^BEGIN:VEVENT/gm) || []).length;
  expect(n, "VEVENT が無さすぎる").toBeGreaterThan(50);
  return n;
}

function icsDays(): { first: string; last: string } {
  const days = [...llmsIcsDays()].sort();
  return { first: days[0], last: days[days.length - 1] };
}

function llmsIcsDays(): string[] {
  const text = readFileSync(join(site, "deadlines.ics"), "utf8").replace(/\r/g, "");
  return [...text.matchAll(/^DTSTART;VALUE=DATE:(\d{8})$/gm)].map(
    (m) => `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`,
  );
}

describe("索引が収録範囲を実測で言う（第 291 回）", () => {
  it("`catalog.json` の行が、品書を実測した件数・両端の日・窓の日数を言う", () => {
    const line = indexLine("catalog.json");
    const span = deadlineSpan(json("catalog.json"));
    expect(span, "品書から締切の範囲が数えられない").not.toBeNull();
    const measured = String(span!.deadline_count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(line).toContain(`${measured} 件`);
    expect(line).toContain(span!.first_day);
    expect(line, "品書の末尾の日を索引が言っていない").toContain(span!.last_day);
    const windowDays = (json("catalog.json").window as { upcoming_days?: number })?.upcoming_days;
    expect(typeof windowDays, "品書に窓の日数が無い").toBe("number");
    expect(line, "何日先までを載せるかを索引が言っていない").toContain(
      `${String(windowDays)} 日先`,
    );
    // 数え直した値と索引が食い違っていないこと（違う数を 2 か所に書く設計にしない）。
    // 第 300 回に同じ行へカレンダーの内訳（総数と締切の件数）を足したので、件数の個数を数える
    // 代わりに「同じ数を二度書いていないか」を見る – 内訳は別の事実で、重複ではない。
    const counts = (line.match(/([\d,]+) 件/g) ?? []).map((m) => m.replace(/ 件$/, ""));
    expect(
      counts.length,
      "件数の申告が無さすぎる（索引が数を言わなくなった）",
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(counts).size, `同じ件数を二度書いている: ${counts.join(" / ")}`).toBe(
      counts.length,
    );
  });

  it("`data.json` の行が、収録全体を実測した件数と範囲を言う", () => {
    const line = indexLine("data.json");
    const span = deadlineSpan(json("data.json"));
    expect(span, "収録全体から締切の範囲が数えられない").not.toBeNull();
    const measured = String(span!.deadline_count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(line).toContain(`${measured} 件`);
    expect(line).toContain(span!.first_day);
    expect(line).toContain(span!.last_day);
  });

  it("`deadlines.ics` の行が、カレンダーの件数と範囲を、配信物から数えた値で言う", () => {
    const line = indexLine("deadlines.ics");
    const count = icsEventCount();
    const days = icsDays();
    const measured = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(line).toContain(`${measured} 件`);
    expect(line).toContain(days.first);
    expect(line, "カレンダーの末尾の日を索引が言っていない").toContain(days.last);
    expect(line, "画面に並べる期間より長いことを索引が言っていない").toContain(
      "画面に並べる期間より長い",
    );
  });

  it("索引が、品書より先を読む道を `data.json` に示している", () => {
    const catalogLine = indexLine("catalog.json");
    expect(catalogLine).toContain("`data.json`");
    expect(catalogLine, "画面の入口の語を索引が書いていない").toContain("収録の全体を読み込む");
    // 注記が必要な理由が実在する: 品書の末尾はカレンダーより手前で切れている。
    const catalogSpan = deadlineSpan(json("catalog.json"));
    expect(
      String(catalogSpan?.last_day) < icsDays().last,
      `品書の末尾 ${String(catalogSpan?.last_day)} がカレンダーの末尾より後ろ`,
    ).toBe(true);
  });

  it("索引の行は句点のあとに空白を空けない（機械が 2 項目と取り違える）", () => {
    const bad = llms()
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes("。 "));
    expect(bad, `空白で文を繋いでいる行: ${bad.length} 本`).toEqual([]);
  });

  it("範囲を渡さないビルドでも索引は黙って従来どおり出る", () => {
    const text = toLlmsTxt({ site: { upcoming_days: 180 } });
    expect(text).toContain("- catalog.json：締切画面向けの現在・近日期間カタログ。");
    expect(text).not.toContain("載る締切は");
    expect(text).toContain("- deadlines.ics：");
  });

  it("締切の範囲は JST の暦日で数え、形のおかしい品書では黙る", () => {
    // 15:30 UTC は JST では翌日 – 画面とカレンダーが見る暦日に揃う。
    const shifted = deadlineSpan({
      conferences: [
        { editions: [{ deadlines: [{ utc: "2027-02-04T15:30:00Z" }] }] },
        { editions: [{ deadlines: [{ utc: "2026-11-01T06:00:00Z" }] }] },
      ],
    });
    expect(shifted).toEqual({
      deadline_count: 2,
      first_day: "2026-11-01",
      last_day: "2027-02-05",
    });
    // 時刻の無い日付（時刻未確認）もその暦日で数える。
    expect(
      deadlineSpan({
        conferences: [{ editions: [{ deadlines: [{ local_date: "2027-01-09" }] }] }],
      }),
    ).toEqual({ deadline_count: 1, first_day: "2027-01-09", last_day: "2027-01-09" });
    // 「0 件」と「知らない」を混ぜない – 形がおかしい物では値を作らない。
    expect(deadlineSpan(null)).toBeNull();
    expect(deadlineSpan({})).toBeNull();
    expect(deadlineSpan({ conferences: [] })).toBeNull();
    expect(
      deadlineSpan({ conferences: [{ editions: [{ deadlines: [{ note: "日付なし" }] }] }] }),
    ).toBeNull();
  });
});
