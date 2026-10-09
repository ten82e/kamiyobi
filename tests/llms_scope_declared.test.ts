/**
 * `llms.txt` の索引が、各成果物の収録範囲を実測の値で言っているかの検査（SPEC §7・第 291 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 索引は `catalog.json` を「締切画面向けの現在・
 * 近日期間カタログ。」とだけ書き、**生成から 180 日先で切れている**こと（実測の締切は
 * 2026-07-10 〜 2027-02-04・872 件）も、`data.json` が 2019-05-25 〜 2028-03-30 の 3,253 件を
 * 載せることも、`deadlines.ics` が 928 件・2028-03-30 までを載せることも言わなかった。
 * 機械に「この先いつまでの締切が出せるか」を訊かれた人は、索引だけ見て答えを作る。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadlineSpan, toLlmsTxt } from "../src/build.ts";
import { data, site } from "./built_golden_shared.ts";
import { REPO_ROOT } from "./helpers.ts";

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
  it("`data.json` の行が、正典を實測した件数と両端の日を言う（第 927 回）", () => {
    /* 第 726 回が `catalog.json` についてしたのと同じで、**正典**（`data.json`）實測の
     * 件数と範囲を索引が言っているか。実測 2026-11-12: 索引は「4,984 件（2019-05-25 〜
     * 2028-03-30）」と書いて居て、`data.json` と一致した – 一致して居るので**守ればよい**
     * （次の增發で古くなるのを防ぐ）。索引の數は建造が實測して書く（第 291 回の決まり）。 */
    const line = indexLine("data.json");
    const 正典 = json("data.json") as {
      conferences?: Array<{ editions?: Array<{ deadlines?: unknown[] }> }>;
    };
    const 締切: Array<Record<string, unknown>> = [];
    for (const c of 正典.conferences ?? []) {
      for (const e of c.editions ?? []) {
        for (const dl of e.deadlines ?? []) 締切.push(dl as Record<string, unknown>);
      }
    }
    expect(締切.length, "正典から締切が数えられない").toBeGreaterThan(0);
    const 数 = String(締切.length).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(line, `正典の ${数} 件を索引が言っていない`).toContain(`${数} 件`);
    /* 両端の日（JST の暦日 – `local_date` が無い行は UTC の日）。 */
    const 日々 = 締切
      .map((dl) => String(dl.local_date ?? String(dl.utc ?? "").slice(0, 10)))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const 最早 = 日々[0];
    expect(最早, "正典から日を探せない").toBeDefined();
    expect(line, "最早の日に索引が触れて居ない").toContain(String(日々[0]));
    expect(line, "最晩の日に索引が触れて居ない").toContain(String(日々[日々.length - 1]));
  });
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

it("索引が、カレンダーの購読先の URL を言う（第 877 回）", () => {
  /* 索引を読む機械が「カレンダーを購読したい」に答えられる様に、**絶対 URL** を書く。
   * 實測 2026-10-12: 索引に `github.io` が 1 箇所も無く、購讀先を答へるには README を讀む
   * 必要が在った。ファイル名だけでは 1 度ダウンロードするやり方になり、每日朝に入れ替はる
   * 物が古い儘になる（画面は「購読先に指定すると毎日置き換わる」と言つて居る）。 */
  const base = String(data.site?.base_url ?? "").replace(/\/+$/, "");
  expect(base, "此の檢查の前提（配信 URL）が崩れた").not.toBe("");
  const 本文 = llms();
  expect(本文, "配信の絶對 URL を言つて居ん").toContain(
    `配信している絶対 URL（\`site.base_url\` が正本）: ${base}`,
  );
  expect(本文, "購讀先の URL を言つて居ん").toContain(`${base}/deadlines.ics`);
  /* 畫面の URL も（「どこで見られるか」に答へる）。 */
  expect(本文, "畫面の URL を言つて居ん").toContain(`- 画面: ${base}/`);
  /* 購讀と 1 度のダウンロードの違いを隱さない（編集のない購讀は每日更新される）。 */
  expect(本文, "購讀と download の違いを言つて居ん").toContain("ダウンロードするだけでは");
  expect(本文, "每日入れ替はる事を言つて居ん").toContain("毎日朝の更新のあと");
});

describe("data.csv の値の書き方", () => {
  it("状態の列は、値の意味が索引（llms.txt）に書いてある（第 926 回）", () => {
    /* 實測 2026-11-11: `data.csv` の `verification_status` には 3 種の値が在る。AI が
     * `manual-required` を何と讀むかは索引を見ないと分からん – 畫面の札とは別の言葉
     * （第 848 回の約束）なので、解釈が違ふと困る。索引には今 全部の値が書いてある
     * （實測で確かめた）が、**列を足した時に書かない**と又落入する – 機械で確かめられる。 */
    const csv = join(REPO_ROOT, "public", "data.csv");
    const llmsPath = join(REPO_ROOT, "public", "llms.txt");
    if (!existsSync(csv) || !existsSync(llmsPath)) return; // 生成物は CI が作る
    /* 値の**意味**が要る列だけを見る（会議名・URL・日付は列に依らないので対象外）。 */
    const 対象 = [
      "verification_status",
      "verification_source_class",
      "deadline_precision",
      "estimated",
      "extended",
      "date_field",
    ];
    const notes = new Map<string, string>();
    for (const line of readFileSync(llmsPath, "utf8").split("\n")) {
      const m = line.match(/^- ([a-z_]+)：(.*)$/);
      if (m) notes.set(m[1], m[2]);
    }
    /* CSV は**引用符の中にカンマ**がある（`evidence` 列の JSON）ので、Split だけでは列が
     * ずれる – 引用符の狀態を見て 1 文字ずつ讀む（第 926 回で実際にずれた）。 */
    const 割る = (line: string): string[] => {
      const out: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (quoted && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            quoted = !quoted;
          }
          continue;
        }
        if (ch === "," && !quoted) {
          out.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      out.push(cur);
      return out;
    };
    const 行 = readFileSync(csv, "utf8").split("\n");
    const 頭 = 割る(行.shift() ?? "");
    const 索引 = new Map<string, Set<string>>();
    for (const line of 行) {
      if (!line) continue;
      const 値 = 割る(line);
      for (const col of 対象) {
        const i = 頭.indexOf(col);
        if (i < 0) continue;
        const v = (値[i] ?? "").trim().replace(/^"|"$/g, "");
        if (!v) continue;
        if (!索引.has(col)) 索引.set(col, new Set());
        (索引.get(col) as Set<string>).add(v);
      }
    }
    const 未記載: string[] = [];
    for (const [col, vals] of 索引) {
      const note = notes.get(col) ?? "";
      for (const v of vals) {
        if (!note.includes(v)) 未記載.push(`${col} の値「${v}」が索引に書かれて居ない`);
      }
    }
    expect(
      未記載,
      `索引（llms.txt）に書かれて居ない値がある:\n${未記載.join("\n")}\n` +
        "状态・種別・真偽の列は値の意味が要る（讀む人が同じ値に別の解釈を持つと困る）。",
    ).toEqual([]);
    expect(索引.size, "此の檢査の前提（列が読めて居ない）が崩れた").toBe(対象.length);
  });
});
