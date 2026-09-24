/**
 * カレンダー配信用の `deadlines.ics` の検査（SPEC §7・第 266 回）。
 *
 * 締切はこの画面を開いた人にしか見えなかった。研究者の実際の動作は「自分のカレンダーに入れて
 * おく」で、その出口がこれまで無かった（`llms.txt` の一覧にも `.ics` は無く、実在しない物として
 * 検査で縛られていた）。ここでは次の形を見張る：
 *   - RFC 5545 として成立する（CRLF・75 オクテットの折り畳み・TEXT のエスケープ）
 *   - 1 締切 = 1 イベントの終日（JST の暦日）。継続時間を作らない = 締切の推測をしない
 *   - 過ぎた締切は入れない。確かめられない物は消さない
 *   - 「時刻未確認」と「推定」をそのまま書く
 *   - UID はビルドをまたいで同じ（日付が動いても同じ締切として更新される）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DataRecord, icsEscapeText, toIcsText } from "../src/build.ts";
import { site } from "./built_golden_shared.ts";

/* ------------------------------------------------------------------  Helpers */

/** 畳んだ行を開く（カレンダーアプリ側の真似）。 */
function unfoldIcs(raw: string): string[] {
  return raw
    .split("\r\n")
    .reduce<string[]>((acc, line) => {
      if (line.startsWith(" ") && acc.length > 0) acc[acc.length - 1] += line.slice(1);
      else acc.push(line);
      return acc;
    }, [])
    .filter((line) => line !== "");
}

function eventsOf(raw: string): Record<string, string[]>[] {
  const out: Record<string, string[]>[] = [];
  let cur: Record<string, string[]> | null = null;
  for (const line of unfoldIcs(raw)) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i > 0) {
        /* `DTSTART;VALUE=DATE:20261005` のように名前に続く `;…`（属性）を落として
           項目名で引けるようにする（属性ごと名前にすると検査が黙って空振りする）。 */
        const name = line.slice(0, i).split(";")[0];
        const items = cur[name] ?? [];
        items.push(line.slice(i + 1));
        cur[name] = items;
      }
    }
  }
  return out;
}

function rec(over: Record<string, unknown> = {}): DataRecord {
  return {
    type: "deadline",
    categories: ["systems"],
    kind_label: "論文締切",
    estimated: false,
    conf: { key: "sc", title: "SC", link: "https://sc.example/" },
    edition: { year: 2027, edition_id: "sc27", link: "https://sc27.example/" },
    deadline: { precision: "exact", at_utc: new Date("2026-10-04T20:00:00Z") },
    all_day: false,
    ...over,
  } as unknown as DataRecord;
}

const NOW = new Date("2026-08-09T00:00:00Z");

/* ------------------------------------------------------------------  形の正しさ */

describe("deadlines.ics の形（RFC 5545）", () => {
  it("CRLF で書き、前後が VCALENDAR で閉じている", () => {
    const raw = toIcsText([rec()], NOW);
    expect(raw, "CRLF で書いていない（RFC 5545 は CRLF 必須）").toContain("\r\n");
    expect(raw.split("\n").some((l) => !l.endsWith("\r") && l !== "")).toBe(false);
    expect(raw.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(raw.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    const head = unfoldIcs(raw);
    expect(head).toContain("VERSION:2.0");
    expect(head).toContain("PRODID:-//kamiyobi//deadlines//JA");
    expect(head).toContain("CALSCALE:GREGORIAN");
    expect(head).toContain("METHOD:PUBLISH");
  });

  it("1 行 75 オクテット以内で、畳んでも開いてもとと同じになる", () => {
    const long = rec();
    (long.conf as { title: string }).title =
      "並列処理と分散システムと機械学習のための高性能計算ワークショップ";
    (long.edition as { link: string }).link =
      "https://example.org/ conferences/2027/very-long-path-with-japanese-日本語";
    const raw = toIcsText([long], NOW);
    for (const line of raw.split("\r\n")) {
      expect(
        Buffer.byteLength(line, "utf8"),
        `${line.slice(0, 30)}… が ${Buffer.byteLength(line, "utf8")} オクテットある`,
      ).toBeLessThanOrEqual(75);
    }
    // 文字の途中で切っていない（切っていれば開いたときに復元できない）。
    const values = unfoldIcs(raw).filter((l) => l.startsWith("DESCRIPTION:"));
    expect(values.join("\n"), "説明が復元できない").toContain("高性能計算ワークショップ");
  });

  it("TEXT の特殊文字をエスケープする", () => {
    // バックスラッシュ -> セミコロン -> カンマ -> 改行 の順で換える（先に変えると二重に換わる）。
    expect(icsEscapeText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    const raw = toIcsText([rec({ kind_label: "論文締切; Round 1, final" })], NOW);
    const ev = eventsOf(raw)[0];
    const summary = (ev.SUMMARY ?? [])[0] ?? "";
    expect(summary).toContain("\\;");
    expect(summary).toContain("\\,");
    // 値の本体は失われていない。
    expect(summary.replace(/\\([;,\\])/g, "$1")).toContain("Round 1, final");
  });
});

/* ------------------------------------------------------------------  中身の正直さ */

describe("締切の日時を推測しない", () => {
  it("終日イベントで出します（継続時間を作らない）", () => {
    const ev = eventsOf(toIcsText([rec()], NOW))[0];
    expect((ev.DTSTART ?? [])[0], "終日（VALUE=DATE）で出ていない").toMatch(/^20261005$/);
    expect((ev.DTEND ?? [])[0], "終日の終わりが翌日になっていない").toBe("20261006");
    const keys = Object.keys(ev);
    expect(
      keys.some((k) => k === "DTSTART" && ev[k][0].includes("T")),
      "時刻付きで出している（締切の時間帯を作っている）",
    ).toBe(false);
    // 時刻その物は説明に JST で書く（捨てているのではない）。
    expect((ev.DESCRIPTION ?? [])[0]).toContain("2026-10-05 05:00（JST）");
  });

  it("UTC では前日に見える瞬間でも、JST の暦日を入れる", () => {
    // 2026-10-04T20:00Z = 2026-10-05 05:00 JST（画面の「日時（JST）」欄と同じ日）。
    const ev = eventsOf(toIcsText([rec()], NOW))[0];
    expect((ev.DTSTART ?? [])[0]).toBe("20261005");
  });

  it("時刻未確認の締切は、その旨を説明に書く", () => {
    const r = rec();
    (r as unknown as { deadline: unknown }).deadline = {
      precision: "date-only",
      local_date: "2026-12-01",
    };
    const ev = eventsOf(toIcsText([r], NOW))[0];
    expect((ev.DTSTART ?? [])[0]).toBe("20261201");
    expect((ev.DESCRIPTION ?? [])[0], "時刻未確認と書いていない").toContain("時刻未確認");
  });

  it("過ぎた締切は入れないが、過ぎたか確かめられない物は残す", () => {
    const past = rec({ deadline: { at_utc: new Date("2026-08-01T00:00:00Z") } });
    expect(toIcsText([past], NOW), "過ぎた締切が入っている").not.toContain("BEGIN:VEVENT");
    /* 生成の日（JST では 2026-08-09 09:00）その物の日付なら、まだ過ぎたか確かめられないので
       残す。2 日前の日付は本当に過ぎているので消える（前者を消すと「消えた」が噓になる）。 */
    const uncertain = rec();
    (uncertain as unknown as { deadline: unknown }).deadline = {
      precision: "date-only",
      local_date: "2026-08-09",
    };
    expect(toIcsText([uncertain], NOW), "確かめられないという理由で消している").toContain(
      "BEGIN:VEVENT",
    );
    const gone = rec();
    (gone as unknown as { deadline: unknown }).deadline = {
      precision: "date-only",
      local_date: "2026-08-07",
    };
    expect(toIcsText([gone], NOW), "確かめられない物を残している").not.toContain("BEGIN:VEVENT");
  });

  it("上流の推定は要約に書く（カレンダーでも推定だと分かる）", () => {
    const ev = eventsOf(toIcsText([rec({ estimated: true })], NOW))[0];
    expect((ev.SUMMARY ?? [])[0], "推定と書いていない").toContain("（推定）");
    expect((ev.DESCRIPTION ?? [])[0]).toContain("公式で裏を取れていません");
  });
});

/* ------------------------------------------------------------------  購読の約束 */

describe("同じ締切として更新される", () => {
  it("ビルドが変わっても UID は同じ（日付が動いても同じ締切として更新される）", () => {
    const a = eventsOf(toIcsText([rec()], new Date("2026-08-09T00:00:00Z")))[0];
    const b = eventsOf(toIcsText([rec()], new Date("2026-09-23T03:00:00Z")))[0];
    expect((b.UID ?? [])[0], "ビルドのたびに UID が変わっている").toBe((a.UID ?? [])[0]);
    expect((a.UID ?? [])[0]).toContain("@kamiyobi");
    // 日付が変わっても同じ UID（= 購読先では古い日付のイベントが残り続けない）。
    const moved = rec({ deadline: { at_utc: new Date("2026-11-04T20:00:00Z") } });
    const c = eventsOf(toIcsText([moved], new Date("2026-08-09T00:00:00Z")))[0];
    expect((c.UID ?? [])[0], "締切日が動いただけで新しい締切になっている").toBe((a.UID ?? [])[0]);
  });

  it("同じ会議に同じ種別の締切が 2 つあっても混ざらない", () => {
    const raw = toIcsText(
      [
        rec({ deadline: { at_utc: new Date("2026-10-04T20:00:00Z") } }),
        rec({ deadline: { at_utc: new Date("2026-11-04T20:00:00Z") } }),
      ],
      NOW,
    );
    const evs = eventsOf(raw);
    expect(evs).toHaveLength(2);
    const uids = evs.map((e) => (e.UID ?? [])[0]);
    expect(new Set(uids).size, "UID が重複している").toBe(2);
  });

  it("1 締切 = 1 イベントで、会期は入れない", () => {
    const raw = toIcsText(
      [
        rec(),
        {
          type: "event",
          kind_label: "開催",
          conf: { key: "sc", title: "SC" },
          edition: { year: 2027, edition_id: "sc27" },
          start: new Date("2026-11-15T00:00:00Z"),
        },
      ] as unknown as DataRecord[],
      NOW,
    );
    expect(raw.split("BEGIN:VEVENT").length - 1).toBe(1);
    expect(raw).not.toContain("20261115");
  });

  it("説明に収録元とデータ生成時刻を書く（カレンダーの中で出典が切れない）", () => {
    const ev = eventsOf(toIcsText([rec()], new Date("2026-08-09T00:00:00Z")))[0];
    const desc = (ev.DESCRIPTION ?? [])[0] ?? "";
    expect(desc).toContain("収録: kamiyobi 締切一覧");
    expect(desc).toContain("データ生成: 2026-08-09 09:00（JST）");
    expect((ev.URL ?? [])[0]).toBe("https://sc27.example/");
  });

  it("収録が 0 件でも形式は成立する（イベントだけ作らない）", () => {
    for (const arg of [null, undefined, []]) {
      const raw = toIcsText(arg as DataRecord[] | null | undefined, NOW);
      expect(raw).toContain("BEGIN:VCALENDAR");
      expect(raw.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
      expect(raw, "何もない状態から締切を作った").not.toContain("BEGIN:VEVENT");
    }
  });
});

/* ------------------------------------------------------------------  ビルド成果物 */

describe("ビルド成果物に出るカレンダーのファイル", () => {
  function icsText(): string {
    const path = join(site, "deadlines.ics");
    expect(existsSync(path), "deadlines.ics が無い").toBe(true);
    return readFileSync(path, "utf8");
  }

  it("全てのイベントが必須項目を持ち、日が飛んでいない", () => {
    const raw = icsText();
    const evs = eventsOf(raw);
    expect(evs.length, "イベントが 1 件もない").toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const ev of evs) {
      for (const name of ["UID", "DTSTAMP", "DTSTART", "SUMMARY", "DESCRIPTION"]) {
        expect((ev[name] ?? []).length, `${name} が無いイベントがある`).toBeGreaterThan(0);
      }
      const uid = (ev.UID ?? [])[0] ?? "";
      expect(seen.has(uid), `UID が重複している: ${uid}`).toBe(false);
      seen.add(uid);
      const day = (ev.DTSTART ?? [])[0] ?? "";
      expect(day, "終日（8 桁）で出ていない").toMatch(/^\d{8}$/);
      expect((ev.DTEND ?? [])[0] ?? "", "翌日になっていない").not.toBe(day);
    }
    for (const line of raw.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8"), "75 オクテットを越える行がある").toBeLessThanOrEqual(
        75,
      );
    }
  });

  it("生成日より前の日付のイベントを入れない", () => {
    const evs = eventsOf(icsText());
    const data = JSON.parse(readFileSync(join(site, "data.json"), "utf8")) as {
      generated_at?: string;
    };
    expect(data.generated_at, "data.json が読めない").toBeTruthy();
    /* 生成時刻は UTC なので、JST の暦日に直してから比べる（画面と同じ規則）。
       生成当日の締切は残り数時間でも残るので、生成前日までは許す。 */
    const genJst = new Date(new Date(String(data.generated_at)).getTime() + 9 * 3_600_000);
    const floor = new Date(genJst.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    for (const ev of evs) {
      const day = (ev.DTSTART ?? [])[0] ?? "";
      expect(day >= floor, `生成日より前の締切が入っている: ${day}`).toBe(true);
    }
  });

  it("てびきが載せている種別は、そのままカレンダーにも載る（2 か所で語彙を増やさない）", () => {
    /* `upcoming.md` の種別欄は画面と同じ収録語（`kind_label`）で書かれている。
       `data.csv` の種別欄は上流の英字（`Paper submission` など）なので照合先にならない
       （実測で気づいた – 語彙の正本は 1 本しか無いとは限らない）。 */
    const md = readFileSync(join(site, "upcoming.md"), "utf8").split("\n");
    const first = md.findIndex((l) => l.trim().startsWith("|"));
    /* 行の先頭のパイプを落としてから分ける（ヘッダだけ違う分け方をすると列の番号が
       1 ずれて、隣の「ラウンド」の値が種別として読めてしまう – 実発生）。 */
    const cellsOf = (line: string): string[] =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, "|"));
    const i = cellsOf(md[first]).indexOf("種別");
    expect(i, "upcoming.md に種別欄が無い").toBeGreaterThan(-1);
    const mdKinds = new Set<string>();
    for (const l of md.slice(first + 2)) {
      if (!l.trim().startsWith("|")) continue;
      const v = (cellsOf(l)[i] ?? "").trim();
      // 会期（開催）の行はカレンダーに入れないので照合しない。
      if (v !== "" && v !== "開催") mdKinds.add(v);
    }
    expect(mdKinds.size, "upcoming.md から種別が読めない").toBeGreaterThan(0);
    const icsKinds = new Set<string>();
    for (const ev of eventsOf(icsText())) {
      const m = /種別: ([^\\]*)/.exec((ev.DESCRIPTION ?? [])[0] ?? "");
      if (m && m[1].trim() !== "") icsKinds.add(m[1].trim());
    }
    const missing = [...mdKinds].filter((k) => !icsKinds.has(k));
    expect(missing, `てびきに有る種別がカレンダーに無い: ${missing.join(" / ")}`).toEqual([]);
  });

  it("llms.txt の出力一覧に 1 本だけ載る", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    expect(txt).toContain("deadlines.ics");
    expect(txt.match(/^- deadlines\.ics：/gm)?.length, "出力一覧の行が 1 本ではない").toBe(1);
  });
});

/* ------------------------------------------------------------------  画面の導線 */

describe("画面のカレンダーへの導線（第 266 回）", () => {
  function page(): string {
    return readFileSync(join(site, "index.html"), "utf8");
  }

  it("一覧のそばに導線が有り、絞り込みが引き継がれないと書いてある", () => {
    const p = page();
    const link = /<a id="icsLink" class="btn-reset" href="deadlines\.ics"[^>]*>([^<]*)<\/a>/.exec(
      p,
    );
    expect(link, "カレンダーへの導線が無い").toBeTruthy();
    expect(link![1], "導線の名前がカレンダーだと分からない").toContain("カレンダー");
    expect(link![0], "何が起きるか注記が無い").toMatch(/title="[^"]*RFC 5545/);
    expect(link![0], "絞り込みが引き継がれないことを隠している").toContain("絞り込みは引き継がれ");
  });

  it("てびきに、中身の約束を書いている（時刻未確認・推定・購読）", () => {
    const p = page();
    const i = p.indexOf("<dt>カレンダーに追加（.ics）</dt>");
    expect(i, "てびきの項目が無い").toBeGreaterThan(-1);
    const entry = p.slice(i, p.indexOf("</dd>", i));
    for (const word of [
      "絞り込みは引き継がれません",
      "時刻未確認",
      "推定",
      "購読先",
      "JST の暦日",
    ]) {
      expect(entry, `てびきが ${word} を書いていない`).toContain(word);
    }
  });

  it("紙には導線を刷らない（紙から押せない）", () => {
    const css = [...page().matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    const print = /@media print\s*\{([\s\S]*?)\n\}/.exec(css)?.[0] ?? "";
    expect(print, "印刷用の規則が見つからない").not.toBe("");
    expect(print, "押せない導線を紙に刷っている").toContain("#icsLink");
  });

  it("リンクの行と閉じタグが素直に対応している（検査が読める形）", () => {
    const p = page();
    expect(p.match(/href="deadlines\.ics"/g)?.length, "導線が 1 本も無い").toBeGreaterThanOrEqual(
      1,
    );
    expect(p.match(/id="icsLink"/g)?.length, "押せる導線が 1 本ではない").toBe(1);
    expect(p, "閉じタグが折り畳まれて読めない").not.toMatch(/<\/a\s*\n\s*>/);
  });
});

/* ------------------------------------------------  出口の在りかを言う場所（第 267 回） */

describe("出口の在りかを言う場所が、実物とずれていない", () => {
  function page(): string {
    return readFileSync(join(site, "index.html"), "utf8");
  }

  it("JavaScript が動かないときの案内に、カレンダーの出口が有る（数を言い切らない）", () => {
    const p = page();
    const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(p);
    expect(block, "案内ブロックが無い").not.toBeNull();
    const inner = String(block![1]);
    /* ここは「2 つのファイルで直接読めます」と数を言い切っていた場所である。物を足すたびに
       噓になるので、数を書かない形にしてある（第 266 回で `.ics` を足したときにも直さなかった）。 */
    expect(
      inner.match(/[一二三四五六七八九十0-9]+ つのファイル/),
      "ファイルを数で言い切っている（次に物を足すと噓になる）",
    ).toBeNull();
    const link = /<a href="deadlines\.ics"[^>]*>deadlines\.ics<\/a>/.exec(inner);
    expect(link, "JavaScript が動かない人への案内にカレンダーが無い").toBeTruthy();
    expect(link![0], "どんな形かを書いていない").toMatch(/終日|JST/);
    expect(inner, "カレンダーの意味（表が見えない人に効く）を書いていない").toContain("カレンダー");
  });

  it("静的な直近一覧のページにも出口が有り、指す先が実在する", () => {
    const up = readFileSync(join(site, "upcoming.html"), "utf8");
    const link =
      /締切を自分のカレンダーに入れるには <a href="deadlines\.ics">deadlines\.ics<\/a>（([^<]*)/.exec(
        up,
      );
    expect(link, "upcoming.html にカレンダーへの導線が無い").toBeTruthy();
    expect(link![1], "終日であること（時間帯を作らない）を書いていない").toContain("終日");
    expect(link![1], "このページの絞り込みが無いことを隠している").toContain("絞り込み");
    /* 先頭の案内の文は、サブパス配信の下で動くよう相対パスで、しかも実在する物だけを
       指す（ページの本体は会議の公式ページへの外部リンクなので、そこは数えない）。 */
    const lead = /<p>([\s\S]*?)<\/p>/.exec(up);
    expect(lead, "先頭の案内の文が無い").not.toBeNull();
    const hrefs = [...String(lead![1]).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length, "案内のリンクが読めない").toBeGreaterThanOrEqual(4);
    for (const href of hrefs) {
      expect(href, `絶対パスのリンクがある: ${href}`).not.toMatch(/^(?:\/|https?:)/);
      expect(existsSync(join(site, href)), `案内が指す ${href} がビルド先に無い`).toBe(true);
    }
  });

  it("llms.txt が、画面の中にカレンダーの導線があると正直に書いている", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const line = txt.split("\n").find((l) => l.startsWith("- index.html："));
    expect(line, "index.html の説明が無い").toBeTruthy();
    expect(line!, "索引が画面の導線を 2 つのままと言う（実物は 3 つ）").toContain(
      "`deadlines.ics` への導線",
    );
  });

  it("説明文の全角句読点のうしろに半角空白を置かない（生成文の見た目の乱れ）", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const bad = [...txt.matchAll(/[、。」）：] (?=[\u3041-\u30ff\u4e00-\u9fff])/g)].map((m) =>
      txt.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + 14),
    );
    expect(bad, `全角の読点のうしろに空白がある: ${bad.join(" / ")}`).toEqual([]);
  });
});
