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

/** 画面の 1 行ぶんの材料（画面と同じ入口から取つた値が入る）。 */
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

describe("画面の一覧をカレンダーに書き出す（第 856 回）", () => {
  it("RFC 5545 の 1 本に成つている（CRLF・75 オクテット・前後の対）", () => {
    const raw = icsViewText(
      [材料(), 材料({ editionId: "ipsj-hpc-2027-03", kind: "registration" })],
      NOW,
      生成,
    );
    expect(raw.startsWith("BEGIN:VCALENDAR\r\n"), "前が VCALENDAR でない").toBe(true);
    expect(raw.trimEnd().endsWith("END:VCALENDAR"), "後ろが VCALENDAR でない").toBe(true);
    /* CRLF だけ（裸の LF を混ぜない – RFC 5545 §3.1）。 */
    expect(
      raw.split("\n").some((l) => !l.endsWith("\r") && l !== ""),
      "裸の LF がある",
    ).toBe(false);
    /* 1 行は 75 オクテット以内（文字数ではない – 日本語は 1 字 3 オクテット）。 */
    const 長い = raw.split("\r\n").filter((l) => new TextEncoder().encode(l).length > 75);
    expect(長い, "75 オクテットを超える行がある").toEqual([]);
    const 件 = 件々(raw);
    expect(件.length, "2 件入つて居ない").toBe(2);
    for (const e of 件) {
      expect(e.has("UID"), "UID がない").toBe(true);
      expect(e.has("DTSTAMP"), "DTSTAMP がない").toBe(true);
      expect(e.has("SUMMARY"), "SUMMARY がない").toBe(true);
      expect(e.has("DESCRIPTION"), "DESCRIPTION がない").toBe(true);
      /* 終日（`VALUE=DATE`）で、終はりの日は初めの日の翌日。 */
      const 始 = String(e.get("DTSTART") ?? "");
      const 終 = String(e.get("DTEND") ?? "");
      expect(始, "DTSTART が終日でない").toMatch(/^\d{8}$/);
      expect(終, "DTEND が初めの日の翌日でない").toBe(
        new Date(
          Date.UTC(Number(始.slice(0, 4)), Number(始.slice(4, 6)) - 1, Number(始.slice(6, 8)) + 1),
        )
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, ""),
      );
    }
  });

  it("TEXT のエスケープと折り畳みが効いている（RFC 5545 §3.1・§3.3.11）", () => {
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
    /* 値の中に生の改行を残さない（本文は `\n` に転義する）。 */
    const 本文 = String(e.get("DESCRIPTION") ?? "");
    expect(本文, "本文に生の改行が残つている").not.toContain("\n");
    expect(本文, "本文の改行が転義されて居ない").toContain("\\n");
  });

  it("見えている物だけが入り、件数は説明欄にも出る（黙つて減らさない）", () => {
    const 三 = [
      材料(),
      材料({ editionId: "b27", kind: "abstract" }),
      材料({ editionId: "c27", kind: "journal" }),
    ];
    const raw = icsViewText(三, NOW, 生成);
    expect(件々(raw).length, "3 件入つて居ない").toBe(3);
    const 説明 = 開く(raw).find((l) => l.startsWith("X-WR-CALDESC:")) ?? "";
    expect(説明, "件数を言つて居ない").toContain("3 件");
    expect(説明, "寫しである事を言つて居ない").toContain("購読ではなく");
    expect(説明, "配付物の名前を敎へて居ない").toContain("deadlines.ics");
    expect(開く(raw), "見出しが配付物と同じ").toContain(`X-WR-CALNAME:${ICS_VIEW_CAL_NAME_JA}`);
    /* 日が読めない行は入れない（カレンダーに日付の無い物を置けない）。 */
    const 壞れ = icsViewText(
      [材料({ day: "" }), 材料({ editionId: "ok", kind: "paper" })],
      NOW,
      生成,
    );
    expect(件々(壞れ).length, "日が読めない行を入れた").toBe(1);
  });

  it("UID は配付物と同じ組み方で、同じ入力なら同じ", () => {
    const 一度 = icsViewText([材料()], NOW, 生成);
    const 二度 = icsViewText([材料()], NOW, 生成);
    expect(一度, "同じ入力で違う物を書いた").toBe(二度);
    const uid = String(件々(一度)[0].get("UID"));
    expect(uid, "UID の形が違う").toMatch(/^kamiyobi-sigcomm2027-paper@kamiyobi$/);
    /* 同じ版・同じ種別の 2 件は、UID が重ならない（受け手が 1 件に潰さない）。 */
    const 二つ = icsViewText(
      [材料(), 材料({ day: "20270305", at: Date.UTC(2027, 2, 5) })],
      NOW,
      生成,
    );
    const uids = 件々(二つ).map((e) => String(e.get("UID")));
    expect(new Set(uids).size, "UID が重なっている").toBe(2);
  });

  it("器（VEVENT の並び）が、配付物と同じ", () => {
    /* 同じ器を使つている事を、実際に組んだ物の**並び**で見る（書き寫すと片方だけ直した時に
     * ずれる – 第 856 回に共通の関数へ寄せたその理由）。 */
    const 配付 = 件々(toIcsText([rec()], NOW));
    const 寫し = 件々(icsViewText([材料()], NOW, 生成));
    expect(配付.length, "この検査の前提（配付物の 1 件）が崩れた").toBeGreaterThan(0);
    expect(寫し.length, "この検査の前提（寫しの 1 件）が崩れた").toBeGreaterThan(0);
    expect([...寫し[0].keys()], "配付物と器が違う").toEqual([...配付[0].keys()]);
  });

  it("画面の繋ぎがある（押せる物・押した時の動き・配付する ics.js）", () => {
    const dir = builtSite();
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html, "押せる物がない").toContain('id="exportIcs"');
    /* 押した時の動きは配付する `app.js` にある（書き出しの関数と、押した時の繋ぎ）。 */
    const app = siteRuntime();
    expect(app, "書き出しの函数がない").toContain("icsViewText");
    expect(app, "押した時の繋ぎがない").toContain('addEventListener("click", exportShownIcs)');
    expect(jsFunction(app, "exportIcsLabelJa"), "文言が違う").toContain(
      "カレンダー（.ics）でダウンロード",
    );
    /* 折り方と器は配付する `ics.js` にある（画面が読む物 – 別に持つとずれる）。 */
    expect(existsSync(join(dir, "ics.js")), "ics.js を配付して居ない").toBe(true);
    const ics = readFileSync(join(dir, "ics.js"), "utf8");
    expect(ics, "共通の器がない").toContain("icsEventBody");
    expect(ics, "折り畳みがない").toContain("icsFoldLine");
    /* 索引（llms.txt）にも載せる（何が何處にあるかを読む人と AI に言う）。 */
    const llms = readFileSync(join(dir, "llms.txt"), "utf8");
    expect(llms, "索引が ics.js を書いて居ない").toContain("ics.js");
  });

  it("確認の状態と延長の札が、書き出す 1 本にも入る（第 861 回）", () => {
    /* 配付するカレンダーと同じ約束 – 画面から書き出した 1 本にも、一覧の札を本文に書く
     * （書き出した物を配る人・貼る人が、確かめて居ない締切を確定として扱はない樣に）。 */
    const 題 = icsViewText(
      [
        材料({
          dl: { verification: { status: "manual-required" } },
        }),
        材料({ editionId: "b27", kind: "abstract", dl: { label: "Extended deadline" } }),
      ],
      NOW,
      生成,
    );
    const 本文 = 開く(題);
    const 狀態 = 本文.filter((l) => l.includes("状態: "));
    expect(狀態.length, "札が本文にない").toBe(2);
    expect(題, "確認の状態を書いていない").toContain(
      String(Recommender.verificationStatusLabelJa({ status: "manual-required" })),
    );
    expect(題, "延長の印を書いていない").toContain(String(Recommender.extendedLabelJa()));
    /* 確認済みと未設定では書かない（画面も印を出さない）。 */
    const 確認済み = 開く(
      icsViewText([材料({ dl: { verification: { status: "verified" } } })], NOW, 生成),
    );
    expect(確認済み.filter((l) => l.includes("状態: ")).length, "確認済みに印を付けた").toBe(0);
    const 無し = 開く(icsViewText([材料()], NOW, 生成));
    expect(無し.filter((l) => l.includes("状態: ")).length, "状態のない行に印を付けた").toBe(0);
  });

  it("押すと、その一覧の 1 本が落ちて来る（DOM を真似する）", () => {
    /* 拔き出した関数を、最小の DOM で走らせる（落ちて來る物の名前と中身の型を見る）。 */
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
      /* 書き出しの別は `candidateScopeOnScreen()` が論文の欄を読んで決める。 */
      getElementById: () => ({ value: "" }),
    };
    class Blob {
      parts: unknown[];
      opts: { type?: string };
      constructor(parts: unknown[], opts: { type?: string }) {
        this.parts = parts;
        this.opts = opts;
      }
    }
    const URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
    const 走らせる = new Function(
      "shownIcsText",
      "Blob",
      "URL",
      "document",
      "state",
      "candidateScopeOnScreen",
      vmSafeSource(`${src}\nreturn exportShownIcs;`),
    )(
      () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      Blob,
      URL,
      document,
      { mode: "deadlines" },
      /* 書き出しの別の規則その物は `tests/candidate_csv_export.test.ts` が持つ。ここは
       * 締切の一覧として落ちて来る物の名前を見る。 */
      () => false,
    ) as () => void;
    走らせる();
    expect(落ちた.length, "1 本も落ちて來ない").toBe(1);
    /* 名前に JST の日が入る（CSV と同じ約束 – 端末の時刻合わせで日付が一日ずれない）。 */
    expect(落ちた[0].name, "名前が違う").toMatch(/^kamiyobi-deadlines-\d{8}\.ics$/);
  });

  it("押した時の動きが、見えている行だけを渡す（配付物を読み直さない）", () => {
    /* `app.js` の関数を拔き出して走らせ、渡した行だけが材料に成る事を見る（DOM は眞似する）。 */
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
    expect(出た[0].day, "JST の暦日が違う").toBe("20270212");
    expect(出た[0].kindWord, "種別の日本語が画面と違う").toBe("論文締切");
    expect(出た[0].dateField, "日付の欄の名が画面と違う").toBe("締切");
    expect(出た[0].title, "会議名が年を添えた形に成つて居ない").toContain("2027");
    /* 日付だけの行は「時刻未確認」と書く（配付物と同じ約束）。 */
    expect(出た[1].day, "日付だけの行の日が違う").toBe("20270301");
    expect(出た[1].whenText, "日付だけの行に時刻を作つた").toContain("時刻未確認");
    expect(出た[1].estimated, "推定を落とした").toBe(true);
  });

  it("推薦の候補を書き出す時は、説明欄が候補の写しだと言う（第 864 回）", () => {
    const 締切 = icsViewText([材料()], NOW, 生成);
    const 候補 = icsViewText([材料()], NOW, 生成, { scopeJa: "「投稿先を探す」が挙げた候補" });
    const 説明 = (raw: string): string =>
      開く(raw).find((l) => l.startsWith("X-WR-CALDESC:")) ?? "";
    expect(説明(締切), "締切の一覧の説明が違う").toContain("画面で絞り込んだ 1 件");
    expect(説明(候補), "候補の説明が違う").toContain("画面で「投稿先を探す」が挙げた候補 1 件");
    /* どちらも「購読ではなく写し」である事は同じ。 */
    for (const raw of [締切, 候補])
      expect(説明(raw), "写しである事を言つていない").toContain("購読ではなく");
  });

  it("推薦の候補のボタンが、候補の語で出る（第 864 回）", () => {
    const app = siteRuntime();
    const 文言 = new Function(
      "countJa",
      vmSafeSource(`${jsFunction(app, "exportIcsLabelJa")}\nreturn exportIcsLabelJa;`),
    )((n: number) => String(n)) as (n: number, recMode?: boolean) => string;
    expect(文言(12), "一覧の文言が違う").toBe("この一覧の 12 件をカレンダー（.ics）でダウンロード");
    expect(文言(12, true), "候補の文言が違う").toBe(
      "この候補 12 件をカレンダー（.ics）でダウンロード",
    );

    expect(app, "推薦の別を渡していない").toContain("shownIcsText(candidateScopeOnScreen())");
    expect(app, "書き出しの別の正本がない").toContain("function candidateScopeOnScreen()");
    /* 候補の時も、候補が空なら出さない（hidden の条件から推薦の別を外した）。 */
    expect(app, "推薦では出さないままに成つている").not.toContain(
      "exportIcsBtn.hidden = recMode || !shown.length;",
    );
    expect(app, "候補が出て居ない時に候補の名で出している").toContain(
      "exportIcsBtn.hidden = !shown.length || (recMode && !候補を書き出す);",
    );
  });
});

it("推薦候補の ICS にも投稿トラックを書き出す", () => {
  const raw = icsViewText([材料({ kindNote: "regular" })], NOW, 生成, {
    scopeJa: "「投稿先を探す」が挙げた候補",
  });
  const 摘要 = 開く(raw).find((l) => l.startsWith("SUMMARY:")) ?? "";
  expect(摘要, "推薦候補の摘要に投稿トラックがない").toContain("論文締切（regular）");
  /* 本文（DESCRIPTION）の計画の計画の欄にも出る。 */
  const 本文 = 開く(raw).find((l) => l.startsWith("DESCRIPTION:")) ?? "";
  expect(本文, "推薦候補の説明に投稿トラックがない").toContain("種別: 論文締切（regular）");
  /* 計画の計画が無い時は黙る。 */
  const 無し = icsViewText([材料()], NOW, 生成, { scopeJa: "「投稿先を探す」が挙げた候補" });
  const 摘要無し = 開く(無し).find((l) => l.startsWith("SUMMARY:")) ?? "";
  expect(摘要無し, "トラックがないのに空の括弧がある").not.toContain("（）");
  expect(摘要無し, "トラックがない行の摘要が変わっている").toBe("SUMMARY:SIGCOMM 2027：論文締切");
});
