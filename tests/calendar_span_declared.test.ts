/**
 * カレンダー配信が「何件をいつまで載せるか」を、購読する前と押す前の両方で申告するか（SPEC §4.2・§7）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）:
 * - `X-WR-CALDESC` の値が **半角スペースで始まっていた**（`" kamiyobi が…"`）。RFC 5545 §3.1 は
 *   名前とコロンとの間に空白を置かないと定めており、相手はそれを値の一部に残す。
 * - CALDESC は「画面の絞り込みは効かない（**上の全件**）」と書いていたが、カレンダー側に「上」は
 *   無い。しかも収録は **2026-08-09 〜 2028-03-30 の 928 件**で、画面に並べる期間（既定 180 日）より
 *   ずっと長い。いつまでが入るかを購読側にも画面にも書いていなかったので、画面と同じ期間を
 *   想像して取り込む人とズレた。
 * - 画面の「カレンダーに追加（.ics）」のそばにも、件数も範囲も無かった（ツールチップに
 *   「絞り込みは引き継がれません」とあるだけ）。
 *
 * ここでは (a) CALDESC の値が空白で始まらないこと、(b) CALDESC が実測の件数と期間を言うこと、
 * (c) `catalog.json` と `index.html` の埋め込みが、配信物を実測した同じ値を載せること、
 * (d) 画面の注記がその値を読むこと、(e) 値が化けているときは注記を黙ること、を見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { data, site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function ics(): string {
  // CRLF なので `\r` を落としてから読む（`.` は `\r` にも効く – 第 288 回で自分で踏んだ）。
  return readFileSync(join(site, "deadlines.ics"), "utf8").replace(/\r/g, "");
}

/** 折り返し（続け頭の空白 1 文字）を戻した、1 プロパティ 1 行の本文。 */
function unfolded(): string {
  return ics().replace(/\n[ \t]/g, "");
}

function property(name: string): string {
  const m = new RegExp(`^${name}:(.*)$`, "m").exec(unfolded());
  expect(m, `${name} が無い`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

/** 生（折り返し前）の 1 行。先頭スペースの有無はこの形でしか見えない。 */
function rawLine(name: string): string {
  const m = new RegExp(`^${name}:.*$`, "m").exec(ics());
  expect(m, `${name} の行が無い`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

function days(): string[] {
  return [...ics().matchAll(/^DTSTART;VALUE=DATE:(\d{8})$/gm)].map((m) => m[1]).sort();
}

function isoDay(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

function catalogJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Record<string, unknown>;
}

type Span = { event_count: number; first_day: string; last_day: string };

function declaredSpan(source: Record<string, unknown> | null): Span {
  expect(source, "catalog の calendar が無い（ビルドが申告を載せていない）").toBeTruthy();
  return source as unknown as Span;
}

/** ビルド成果物に実在する数を数え直す（ハードコードした数字を assertions にしない）。 */
function measured(): Span {
  const list = days();
  expect(list.length, "VEVENT が無さすぎる").toBeGreaterThan(50);
  return {
    event_count: list.length,
    first_day: isoDay(list[0]),
    last_day: isoDay(list[list.length - 1]),
  };
}

function runtimeNote(span: Span): string {
  const runtime = siteRuntime("app.js");
  const note = new Function(
    `const countJa = (${jsFunction(runtime, "countJa")});
     ${jsFunction(runtime, "icsScopeNoteJa")};
     return icsScopeNoteJa;`,
  )() as (value: Span) => string;
  return note(span);
}

describe("カレンダー配信の収録範囲の申告", () => {
  it("説明欄の値は半角スペースで始まらない（RFC 5545 §3.1）・画面の位置に依存した語を残さない", () => {
    const line = rawLine("X-WR-CALDESC");
    expect(line.startsWith("X-WR-CALDESC: "), "値の先頭が空白（相手は値の一部に残す）").toBe(false);
    expect(line.startsWith("X-WR-CALDESC:kamiyobi"), `実際の先頭: ${line.slice(0, 40)}`).toBe(true);
    const desc = property("X-WR-CALDESC");
    // 「上の全件」はカレンダー側に「上」が無いので直した（第 289 回）。
    expect(desc).not.toContain("上の全件");
    expect(desc).toContain("絞り込み");
    expect(desc).toContain("引き継がれない");
  });

  it("説明欄が、入る件数と収録の最初・最後の締切日を実測の値で言う", () => {
    const span = measured();
    const desc = property("X-WR-CALDESC");
    expect(desc, `件数が無い: ${desc.slice(0, 120)}`).toContain(`${span.event_count} 件`);
    expect(desc).toContain(span.first_day);
    expect(desc).toContain(span.last_day);
    // 生成時刻も載せる（購読先が古いのに気づけるように）。
    expect(desc).toContain("データ生成:");
  });

  it("`catalog.json` の申告が、配信物を実測した値と一致する（画面はここで数えない）", () => {
    const span = declaredSpan(catalogJson().calendar as Record<string, unknown> | null);
    expect(span).toEqual(measured());
  });

  it("`index.html` に差し込まれた品書にも同じ申告が入っている（画面が読むのはこちら）", () => {
    const html = readFileSync(join(site, "index.html"), "utf8");
    const span = declaredSpan(catalogJson().calendar as Record<string, unknown> | null);
    const literal = `"calendar": {"event_count": ${span.event_count}, "first_day": "${span.first_day}", "last_day": "${span.last_day}"}`;
    expect(html, "埋め込み品書に calendar が無い").toContain(literal);
    // 注記の枠が紙に載らないこと（購読の案内は画面で読む物）。
    const from = html.indexOf("@media print");
    expect(from, "印刷用の規則その物が見つからない").toBeGreaterThan(0);
    const css = html.slice(from, html.indexOf("</style>", from));
    expect(css).toContain("#icsScope");
  });

  it("画面の注記は、件数・範囲・絞り込みが引き継がれないことを目に見える形で言う", () => {
    const span = declaredSpan(catalogJson().calendar as Record<string, unknown> | null);
    const note = runtimeNote(span);
    expect(note).toContain(String(span.event_count).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    expect(note).toContain(span.first_day);
    expect(note).toContain(span.last_day);
    expect(note).toContain("絞り込みは引き継がれません");
    // 大きな数の区切り（1,234 の形）も同じ数え方であること。
    expect(
      runtimeNote({ event_count: 12345, first_day: "2026-01-01", last_day: "2027-01-01" }),
    ).toContain("12,345 件");
  });

  it("申告が化けているときは注記を作らない（「0 件」と「知らない」を混ぜない）", () => {
    const runtime = siteRuntime("app.js");
    const span = new Function(
      `const isRecord = (${jsFunction(runtime, "isRecord")});
       ${jsFunction(runtime, "calendarSpan")};
       return calendarSpan;`,
    )() as (value: unknown) => Span | undefined;
    expect(
      span({ event_count: 0, first_day: "2026-01-01", last_day: "2027-01-01" }),
    ).toBeUndefined();
    expect(
      span({ event_count: 10, first_day: "2026/01/01", last_day: "2027-01-01" }),
    ).toBeUndefined();
    expect(span({ event_count: 10, first_day: "2026-01-01" })).toBeUndefined();
    expect(span("2026-01-01")).toBeUndefined();
    expect(span(undefined)).toBeUndefined();
    expect(span({ event_count: 10, first_day: "2026-01-01", last_day: "2027-01-01" })).toEqual({
      event_count: 10,
      first_day: "2026-01-01",
      last_day: "2027-01-01",
    });
  });

  it("注記が必要な理由が実在する（収録の期間はこの一覧の窓より長い）", () => {
    const span = declaredSpan(catalogJson().calendar as Record<string, unknown> | null);
    const window = catalogJson().window as { upcoming_days: number };
    const generated = Date.parse(String(data.generated_at));
    const windowEnd = generated + window.upcoming_days * 86400000;
    expect(
      Date.parse(span.last_day) > windowEnd,
      `収録の末尾 ${span.last_day} が窓 ${window.upcoming_days} 日（${new Date(windowEnd).toISOString().slice(0, 10)}）を越えていない`,
    ).toBe(true);
  });

  it("てびきが、収録の期間が一覧の窓より長いことを利用者の語で言っている", () => {
    const html = readFileSync(join(site, "index.html"), "utf8");
    const guide = html.slice(html.indexOf("<dt>カレンダーに追加（.ics）</dt>"));
    const item = guide.slice(0, guide.indexOf("</dd>"));
    expect(item).toContain("収録の期間は");
    expect(item).toContain("この一覧に並べる期間より長い");
    expect(item).toContain("一覧の上");
    // 数字をてびきに写すと、配信物とズレる（数字は 1 か所 – 品書から出る）。
    expect(item).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
