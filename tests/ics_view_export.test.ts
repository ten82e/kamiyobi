/**
 * 画面の「この一覧の N 件をカレンダー（.ics）で」の検査（第 856 回）。
 *
 * 配付する `deadlines.ics` は収録の全部で、購読すると毎日入れ替わるが**絞り込みは効かない**。
 * 「国内研究会だけ」「自分の分野だけ」をカレンダーに入れたい人は、いまの一覧から同じ 1 本を
 * 作れるようにした。ここでは次を見張る：
 *   - RFC 5545 として成立する（CRLF・75 オクテットの折り畳み・TEXT のエスケープ）
 *   - **見えている物だけ**が入り、件数は説明欄にも出る（黙って減らさない）
 *   - 器（`VEVENT` の並び）が配付物と**同じ**である（書き写すと片方だけ直したときにずれる）
 *   - UID は配付物と同じ組み方で、同じ入力なら同じ値
 *   - 画面の繋ぎ（押せる物・押したときの動き・配付する `ics.js`）が在る
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ICS_VIEW_CAL_NAME_JA,
  icsViewText,
  jstParts,
  type ScreenDeadlineInput,
} from "../site/ics.ts";
import Recommender from "../site/recommender.ts";
import { type DataRecord, toIcsText } from "../src/build.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

const NOW = new Date("2026-10-08T12:00:00Z");
const 生成 = new Date("2026-10-04T12:38:58Z");

/** 画面の 1 行ぶんの材料（畫面と同じ入口から取つた値が入る）。 */
function 材料(over: Partial<ScreenDeadlineInput> = {}): ScreenDeadlineInput {
  return {
    key: "sigcomm",
    editionId: "sigcomm2027",
    year: 2027,
    title: "SIGCOMM 2027",
    kind: "paper",
    kindWord: "論文締切",
    dateField: "締切",
    day: "20270212",
    whenText: "2027-02-12 20:59（JST）",
    at: Date.UTC(2027, 1, 12, 11, 59),
    categories: ["nw"],
    place: "Osaka, 日本",
    link: "https://example.org/cfp",
    session: "2027-08-21(土) 〜 2027-08-25(水)",
    ...over,
  };
}

/** 配付物を組む側の記録（`tests/ics_feed.test.ts` と同じ形）。 */
function rec(over: Record<string, unknown> = {}): DataRecord {
  return {
    type: "deadline",
    categories: ["systems"],
    kind_label: "論文締切",
    date_field: "締切",
    estimated: false,
    conf: { key: "sc", title: "SC", link: "https://sc.example/", categories: ["systems"] },
    edition: {
      year: 2027,
      edition_id: "sc27",
      link: "https://sc27.example/",
      place: "Denver, アメリカ",
    },
    deadline: { precision: "exact", at_utc: new Date("2027-02-12T11:59:00Z") },
    all_day: false,
    ...over,
  } as unknown as DataRecord;
}

/** 畳んだ行を開く（カレンダーアプリ側の真似）。 */
function 開く(raw: string): string[] {
  return raw
    .split("\r\n")
    .reduce<string[]>((acc, line) => {
      if (line.startsWith(" ") && acc.length > 0) acc[acc.length - 1] += line.slice(1);
      else acc.push(line);
      return acc;
    }, [])
    .filter((line) => line !== "");
}

/** `VEVENT` ごとに、名前 → 値（同じ名前は並び）に分ける。**並びの順も見る**。 */
function 件々(raw: string): Array<Map<string, string[]>> {
  const out: Array<Map<string, string[]>> = [];
  let cur: Map<string, string[]> | null = null;
  for (const line of 開く(raw)) {
    if (line === "BEGIN:VEVENT") {
      cur = new Map();
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).split(";")[0];
    const values = cur.get(name) ?? [];
    values.push(line.slice(i + 1));
    cur.set(name, values);
  }
  return out;
}

describe("畫面の一覧をカレンダーに書き出す（第 856 回）", () => {
  it("RFC 5545 の 1 本に成つて居る（CRLF・75 オクテット・前後の對）", () => {
    const raw = icsViewText(
      [材料(), 材料({ editionId: "ipsj-hpc-2027-03", kind: "registration" })],
      NOW,
      生成,
    );
    expect(raw.startsWith("BEGIN:VCALENDAR\r\n"), "前が VCALENDAR で無い").toBe(true);
    expect(raw.trimEnd().endsWith("END:VCALENDAR"), "後ろが VCALENDAR で無い").toBe(true);
    /* CRLF だけ（裸の LF を混ぜない – RFC 5545 §3.1）。 */
    expect(
      raw.split("\n").some((l) => !l.endsWith("\r") && l !== ""),
      "裸の LF が在る",
    ).toBe(false);
    /* 1 行は 75 オクテット以内（文字数ではない – 日本語は 1 字 3 オクテット）。 */
    const 長い = raw.split("\r\n").filter((l) => new TextEncoder().encode(l).length > 75);
    expect(長い, "75 オクテットを超える行が在る").toEqual([]);
    const 件 = 件々(raw);
    expect(件.length, "2 件入つて居ない").toBe(2);
    for (const e of 件) {
      expect(e.has("UID"), "UID が無い").toBe(true);
      expect(e.has("DTSTAMP"), "DTSTAMP が無い").toBe(true);
      expect(e.has("SUMMARY"), "SUMMARY が無い").toBe(true);
      expect(e.has("DESCRIPTION"), "DESCRIPTION が無い").toBe(true);
      /* 終日（`VALUE=DATE`）で、終はりの日は初めの日の翌日。 */
      const 始 = String(e.get("DTSTART") ?? "");
      const 終 = String(e.get("DTEND") ?? "");
      expect(始, "DTSTART が終日で無い").toMatch(/^\d{8}$/);
      expect(終, "DTEND が初めの日の翌日で無い").toBe(
        new Date(
          Date.UTC(Number(始.slice(0, 4)), Number(始.slice(4, 6)) - 1, Number(始.slice(6, 8)) + 1),
        )
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, ""),
      );
    }
  });

  it("TEXT のエスケープと折り畳みが効いて居る（RFC 5545 §3.1・§3.3.11）", () => {
    const raw = icsViewText(
      [
        材料({
          title: "A,B;C\\D 研究会",
          place: "会場, 日本",
          session: "2027-08-21(土) 〜 2027-08-25(水)",
        }),
      ],
      NOW,
      生成,
    );
    const e = 件々(raw)[0];
    expect(String(e.get("SUMMARY")), "SUMMARY のコンマが逃げて居ない").toContain("\\,");
    expect(String(e.get("SUMMARY")), "SUMMARY のセミコロンが逃げて居ない").toContain("\\;");
    expect(String(e.get("SUMMARY")), "SUMMARY のバックスラッシュが逃げて居ない").toContain("\\\\");
    expect(String(e.get("LOCATION")), "LOCATION のコンマが逃げて居ない").toContain("\\,");
    /* 値の中に生の改行を殘さない（本文は `\n` に転義する）。 */
    const 本文 = String(e.get("DESCRIPTION") ?? "");
    expect(本文, "本文に生の改行が殘つて居る").not.toContain("\n");
    expect(本文, "本文の改行が転義されて居ない").toContain("\\n");
  });

  it("見えて居る物だけが入り、件數は説明欄にも出る（默つて減らさない）", () => {
    const 三 = [
      材料(),
      材料({ editionId: "b27", kind: "abstract" }),
      材料({ editionId: "c27", kind: "journal" }),
    ];
    const raw = icsViewText(三, NOW, 生成);
    expect(件々(raw).length, "3 件入つて居ない").toBe(3);
    const 説明 = 開く(raw).find((l) => l.startsWith("X-WR-CALDESC:")) ?? "";
    expect(説明, "件數を言つて居ない").toContain("3 件");
    expect(説明, "寫しである事を言つて居ない").toContain("購読ではなく");
    expect(説明, "配付物の名前を敎へて居ない").toContain("deadlines.ics");
    expect(開く(raw), "見出しが配付物と同じ").toContain(`X-WR-CALNAME:${ICS_VIEW_CAL_NAME_JA}`);
    /* 日が讀めない行は入れない（カレンダーに日付の無い物を置けない）。 */
    const 壞れ = icsViewText(
      [材料({ day: "" }), 材料({ editionId: "ok", kind: "paper" })],
      NOW,
      生成,
    );
    expect(件々(壞れ).length, "日が讀めない行を入れた").toBe(1);
  });

  it("UID は配付物と同じ組み方で、同じ入力なら同じ", () => {
    const 一度 = icsViewText([材料()], NOW, 生成);
    const 二度 = icsViewText([材料()], NOW, 生成);
    expect(一度, "同じ入力で違ふ物を書いた").toBe(二度);
    const uid = String(件々(一度)[0].get("UID"));
    expect(uid, "UID の形が違ふ").toMatch(/^kamiyobi-sigcomm2027-paper@kamiyobi$/);
    /* 同じ版・同じ種別の 2 件は、UID が重ならない（受け手が 1 件に潰さない）。 */
    const 二つ = icsViewText(
      [材料(), 材料({ day: "20270305", at: Date.UTC(2027, 2, 5) })],
      NOW,
      生成,
    );
    const uids = 件々(二つ).map((e) => String(e.get("UID")));
    expect(new Set(uids).size, "UID が重なつて居る").toBe(2);
  });

  it("器（VEVENT の並び）が、配付物と同じ", () => {
    /* 同じ器を使つて居る事を、實際に組んだ物の**並び**で見る（書き寫すと片方だけ直した時に
     * ずれる – 第 856 回に共通の函數へ寄せた其の理由）。 */
    const 配付 = 件々(toIcsText([rec()], NOW));
    const 寫し = 件々(icsViewText([材料()], NOW, 生成));
    expect(配付.length, "此の檢査の前提（配付物の 1 件）が崩れた").toBeGreaterThan(0);
    expect(寫し.length, "此の檢査の前提（寫しの 1 件）が崩れた").toBeGreaterThan(0);
    expect([...寫し[0].keys()], "配付物と器が違ふ").toEqual([...配付[0].keys()]);
  });

  it("畫面の繋ぎが在る（押せる物・押した時の動き・配付する ics.js）", () => {
    const dir = builtSite();
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html, "押せる物が無い").toContain('id="exportIcs"');
    /* 押した時の動きは配付する `app.js` に在る（書き出しの函數と、押した時の繋ぎ）。 */
    const app = siteRuntime();
    expect(app, "書き出しの函數が無い").toContain("icsViewText");
    expect(app, "押した時の繋ぎが無い").toContain('addEventListener("click", exportShownIcs)');
    expect(jsFunction(app, "exportIcsLabelJa"), "文言が違ふ").toContain(
      "カレンダー（.ics）でダウンロード",
    );
    /* 折り方と器は配付する `ics.js` に在る（畫面が讀む物 – 別に持つとずれる）。 */
    expect(existsSync(join(dir, "ics.js")), "ics.js を配付して居ない").toBe(true);
    const ics = readFileSync(join(dir, "ics.js"), "utf8");
    expect(ics, "共通の器が無い").toContain("icsEventBody");
    expect(ics, "折り畳みが無い").toContain("icsFoldLine");
    /* 索引（llms.txt）にも載せる（何が何處に在るかを讀む人と AI に言ふ）。 */
    const llms = readFileSync(join(dir, "llms.txt"), "utf8");
    expect(llms, "索引が ics.js を書いて居ない").toContain("ics.js");
  });

  it("押すと、その一覧の 1 本が落ちて来る（DOM を眞似する）", () => {
    /* 拔き出した函數を、最小の DOM で走らせる（落ちて來る物の名前と中身の型を見る）。 */
    const src = jsFunction(siteRuntime(), "exportShownIcs");
    const 落ちた: Array<{ name: string; type: string }> = [];
    const anchor = {
      href: "",
      download: "",
      click: () => 落ちた.push({ name: anchor.download, type: "" }),
    };
    const document = {
      createElement: () => anchor,
      body: { appendChild: () => {}, removeChild: () => {} },
    };
    class Blob {
      constructor(
        public parts: unknown[],
        public opts: { type?: string },
      ) {}
    }
    const URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
    const 走らせる = new Function(
      "shownIcsText",
      "Blob",
      "URL",
      "document",
      vmSafeSource(`${src}\nreturn exportShownIcs;`),
    )(() => "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", Blob, URL, document) as () => void;
    走らせる();
    expect(落ちた.length, "1 本も落ちて來ない").toBe(1);
    /* 名前に JST の日が入る（CSV と同じ約束 – 端末の時刻合わせで日付が一日ずれない）。 */
    expect(落ちた[0].name, "名前が違ふ").toMatch(/^kamiyobi-deadlines-\d{8}\.ics$/);
  });

  it("押した時の動きが、見えて居る行だけを渡す（配付物を讀み直さない）", () => {
    /* `app.js` の函數を拔き出して走らせ、渡した行だけが材料に成る事を見る（DOM は眞似する）。 */
    const src = jsFunction(siteRuntime(), "shownIcsInput");
    const 行 = [
      {
        conf: { key: "sc", title: "SC", categories: ["systems"], link: "https://sc.example/" },
        ed: { id: "sc27", year: 2027, place: "Denver, アメリカ", link: "https://sc27.example/" },
        dl: { kind: "paper" },
        kind: "paper",
        est: false,
        t: Date.UTC(2027, 1, 12, 11, 59),
        dateOnly: false,
      },
      {
        conf: { key: "ipsj-hpc", title: "情報処理学会 HPC 研究会", categories: ["hpc"] },
        ed: { id: "ipsj-hpc-2027-03", year: 2027, place: "京都, 日本" },
        dl: { kind: "registration" },
        kind: "registration",
        est: true,
        t: Date.UTC(2027, 2, 1, 3),
        dateOnly: true,
        localDate: "2027-03-01",
      },
    ];
    const 材料を組む = new Function(
      "shown",
      "Recommender",
      "jstParts",
      vmSafeSource(`${src}\nreturn shownIcsInput;`),
    )(行, Recommender, jstParts) as () => ScreenDeadlineInput[];
    const 出た = 材料を組む();
    expect(出た.length, "行が材料に成つて居ない").toBe(2);
    expect(出た[0].day, "JST の暦日が違ふ").toBe("20270212");
    expect(出た[0].kindWord, "種別の日本語が畫面と違ふ").toBe("論文締切");
    expect(出た[0].dateField, "日付の欄の名が畫面と違ふ").toBe("締切");
    expect(出た[0].title, "會議名が年を添へた形に成つて居ない").toContain("2027");
    /* 日付だけの行は「時刻未確認」と書く（配付物と同じ約束）。 */
    expect(出た[1].day, "日付だけの行の日が違ふ").toBe("20270301");
    expect(出た[1].whenText, "日付だけの行に時刻を作つた").toContain("時刻未確認");
    expect(出た[1].estimated, "推定を落とした").toBe(true);
  });
});
