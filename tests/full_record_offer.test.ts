/**
 * 「締切まで: かまわない」が、品書（画面に差し込む速く開くためのデータ）の果てで切れていることを
 * 伝えるかの検査（SPEC §7・第 290 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 既定の窓は「かまわない」で、てびきは
 * 「期限なく先の締切も出します」と書いていた。ところが一覧に出る締切は 2026-07-10 〜
 * **2027-02-04**（品書が生成から 180 日先で切れている）で、`data.json` には品書の果てを越える
 * 締切が **133 件（74 会議）** 在り、カレンダー（`deadlines.ics`）には **2028-03-30 まで** 入って
 * いた。2027 年秋の締切を調べようとした人は、収録に在ることを知らずに画面を閉じるしかなかった
 * （品書の外を読む入口は「過去の締切も表示」だけだった）。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

function html(): string {
  return readFileSync(join(site, "index.html"), "utf8");
}

function catalogJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Record<string, unknown>;
}

function dataJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(site, "data.json"), "utf8")) as Record<string, unknown>;
}

/** `conferences[].editions[].deadlines[]` を平坦に並べる（成果物の形に依存しない読み方）。 */
function eachDeadline(root: Record<string, unknown>, use: (day: string) => void): void {
  const confs = (root.conferences || []) as Record<string, unknown>[];
  confs.forEach((conf) => {
    ((conf.editions || []) as Record<string, unknown>[]).forEach((ed) => {
      ((ed.deadlines || []) as Record<string, unknown>[]).forEach((dl) => {
        const raw = dl.utc ?? dl.local_date;
        if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) use(raw.slice(0, 10));
      });
    });
  });
}

function daysOf(root: Record<string, unknown>): string[] {
  const out: string[] = [];
  eachDeadline(root, (day) => out.push(day));
  return out.sort();
}

function icsLastDay(): string {
  const text = readFileSync(join(site, "deadlines.ics"), "utf8").replace(/\r/g, "");
  const days = [...text.matchAll(/^DTSTART;VALUE=DATE:(\d{8})$/gm)].map((m) => m[1]).sort();
  expect(days.length, "VEVENT が無さすぎる").toBeGreaterThan(50);
  const last = days[days.length - 1];
  return `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`;
}

/** ビルド成果物から関数を実行する（語と判断を、検査に写さない）。
 * `node -e` の ESM 判定に引っ掛からないよう、関数だけを立てて呼ぶ。 */
function runInNode(source: string): string {
  const proc = spawnSync("node", ["-e", vmSafeSource(source)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr.slice(0, 400)).toBe(0);
  return proc.stdout.trim();
}

describe("品書の果てを伝える（第 290 回）", () => {
  it("注記が必要な理由が実在する（品書の末尾はカレンダーより手前で切れている）", () => {
    const catalogDays = daysOf(catalogJson());
    expect(catalogDays.length, "品書の締切が行かない").toBeGreaterThan(50);
    const ics = icsLastDay();
    expect(
      catalogDays[catalogDays.length - 1] < ics,
      `品書の末尾 ${catalogDays[catalogDays.length - 1]} がカレンダーの末尾 ${ics} より後ろ`,
    ).toBe(true);
    // `data.json` には品書の果てを越える締切が実際に在る（= 画面から見えているだけ）。
    // 下限はハーネスのビルドから取る（仮の品書で組むので実測 13 件。実ビルドは 133 件）。
    const edge = catalogDays[catalogDays.length - 1];
    let beyond = 0;
    eachDeadline(dataJson(), (day) => {
      if (day > edge) beyond += 1;
    });
    expect(beyond, "品書の果てを越える締切が収録に無い（検査の前提が崩れた）").toBeGreaterThan(5);
  });

  it("既定の読み方は品書だけ（画面を開くたびに 6 MB 強を読ませない）", () => {
    const app = siteRuntime("app.js");
    const out = runInNode(
      [
        `const fullRecordNeeded = ${jsFunction(app, "fullRecordNeeded")};`,
        "console.log(JSON.stringify([",
        '  fullRecordNeeded(false, "all", false),',
        '  fullRecordNeeded(true, "30", false),',
        '  fullRecordNeeded(false, "all", true),',
        '  fullRecordNeeded(false, "90", true),',
        '  fullRecordNeeded(true, "7", true),',
        "]));",
      ].join("\n"),
    );
    expect(JSON.parse(out)).toEqual([false, true, true, false, true]);
  });

  it("「収録の全体を読み込む」が品書の外を読む入口になっている", () => {
    const app = siteRuntime("app.js");
    const page = html();
    expect(page).toContain('id="fullRecordButton"');
    expect(page).toContain('id="fullRecordText"');
    expect(app).toContain('$("fullRecordText").textContent');
    expect(page).toContain("収録の全体を読み込む");
    // 押したとき: 旗を立ててから品書の外を読みに行く（旗だけ立てて読まない、では伝わらない）。
    const listeners = app.slice(app.indexOf('$("fullRecordButton")'));
    const body = listeners.slice(0, 400);
    expect(body).toContain("fullRecordRequested = true;");
    expect(body).toContain("loadHistoryData();");
    // 品書を見ている間だけ出す（読み終えたあとに同じ注記を出し続けない）。
    expect(app).toContain("activeData === DATA");
  });

  it("注記の語が、一番遠い締切日・切れ方の理由・カレンダーの末尾を言う", () => {
    const app = siteRuntime("app.js");
    /* 日の数は品書（`catalog.json` の `window.upcoming_days`）から読む。画面が 180 と
     * 書き写していた昔の形に戻らない見張り（第 293 回）。 */
    const days = (
      JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as {
        window?: { upcoming_days?: number };
      }
    ).window?.upcoming_days;
    expect(days, "品書に品の窓の申告が無い").toBeTypeOf("number");
    const out = runInNode(
      [
        `const countJa = ${jsFunction(app, "countJa")};`,
        `const fullRecordNoteJa = ${jsFunction(app, "fullRecordNoteJa")};`,
        `console.log(fullRecordNoteJa("2027-02-04", "2028-03-30", ${days ?? 0}));`,
      ].join("\n"),
    );
    expect(out).toContain("2027-02-04");
    expect(out, "品書の申告した日数が出ていない").toContain(`${days} 日`);
    expect(out).toContain("収録の全体を読み込む");
    expect(out).toContain("2028-03-30");
    expect(out).toContain("カレンダー");
    // 品の窓の日数を知らない品書では、数を作らない（第 293 回）。
    const noDays = runInNode(
      [
        `const countJa = ${jsFunction(app, "countJa")};`,
        `const fullRecordNoteJa = ${jsFunction(app, "fullRecordNoteJa")};`,
        'console.log(fullRecordNoteJa("2027-02-04", "2028-03-30", 0));',
      ].join("\n"),
    );
    expect(noDays).toContain("収録の全体を読み込む");
    expect(noDays, "日数をでっち上げた").not.toMatch(/生成から [0-9]+ 日/);
    // 品書の果てが読めないときに空の文を作らないこと（語組み立ては呼び出し側で分岐する）。
    const empty = runInNode(
      [
        `const farthest = ${jsFunction(app, "farthestRowDayJa")};`,
        "console.log(JSON.stringify(farthest([])));",
      ].join("\n"),
    );
    expect(JSON.parse(empty)).toBe("");
  });

  it("一番遠い締切日は JST の暦日で出す（端末の時刻合わせで一日ずれない）", () => {
    const app = siteRuntime("app.js");
    const out = runInNode(
      [
        `const farthest = ${jsFunction(app, "farthestRowDayJa")};`,
        "const rows = [",
        '  { t: Date.parse("2026-11-30T15:30:00Z"), tShown: Date.parse("2026-11-30T15:30:00Z") },',
        '  { t: Date.parse("2027-05-01T00:00:00Z"), tShown: Number.NaN },',
        // 一番遠い行を UTC では 5月1日の 15:30 に置く – JST では 5月2日になるので、協定世界時
        // の暦日で数えると姿が変わる（ここで一日ずれた検査を書くと、ずれた実装が通る）。
        '  { t: Date.parse("2027-05-01T15:30:00Z"), tShown: Date.parse("2027-05-01T15:30:00Z") },',
        "];",
        "console.log(JSON.stringify([farthest(rows), farthest([{ t: 0, tShown: 0 }])]));",
      ].join("\n"),
    );
    const [best, epoch] = JSON.parse(out) as string[];
    // 15:30 UTC は JST では翌日 – 画面に出る暦日に揃う（協定世界時で数えると前日になる）。
    expect(best, `JST の暦日になっていない: ${best}`).toBe("2027-05-02");
    expect(epoch).toBe("1970-01-01");
  });

  it("てびきが、既定の窓について実態と違う文を残していない", () => {
    const page = html();
    const from = page.indexOf("<dt>締切まで</dt>");
    expect(from).toBeGreaterThan(0);
    const item = page.slice(from, page.indexOf("</dd>", from));
    expect(item, "実態と違う文がもどっている").not.toContain("期限なく先の締切も出します");
    expect(item).toContain("180 日先で切れています");
    expect(item).toContain("収録の全体を読み込む");
    // 画面に出ない語（実装の呼び名）を利用者に渡さない。
    expect(item).not.toContain("品書");
  });

  it("読み込み状態の語が、過去にも先にも寄っていない", () => {
    const app = siteRuntime("app.js");
    const out = runInNode(
      [
        app.slice(
          app.indexOf("const HISTORY_NOUN_JA"),
          app.indexOf("const HISTORY_ERROR_JA") +
            app.slice(app.indexOf("const HISTORY_ERROR_JA")).indexOf(";") +
            1,
        ),
        "console.log(JSON.stringify({ noun: HISTORY_NOUN_JA, short: HISTORY_LOADING_SHORT_JA }));",
      ].join("\n"),
    );
    const words = JSON.parse(out) as { noun: string; short: string };
    expect(words.noun).toContain("収録");
    expect(
      words.short.startsWith(words.noun),
      `${words.short} が ${words.noun} から始まらない`,
    ).toBe(true);
    // 「過去の締切」だけと宣言すると、品書の果てより先も読む実態とズレる。
    expect(words.noun).not.toBe("過去の締切");
  });

  it("注記の枠は紙に載らない（購読と違い、画面で押して読む物だから）", () => {
    const page = html();
    const from = page.indexOf("@media print");
    expect(from).toBeGreaterThan(0);
    expect(page.slice(from, page.indexOf("</style>", from))).toContain("#fullRecord");
  });
});
