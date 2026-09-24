/**
 * 名前は収録の名簿に在るのに締切の行が 1 本も無い会議を、0 件の案内が言うかの検査
 * （SPEC §7・第 294 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 品書の会議 687 件のうち 248 件が、一覧に差し込む
 * データに締切行を 1 本も持たない（NETYS・FORTE・CADE・CoNLL など – 締切がデータの切れ目より
 * 先にある会議たち）。`NETYS` を引くと 0 件で「過去の締切も表示 / 推定を含める / 別の語で試す」
 * だけ – どれを勧めても 1 件も増えない。`NETYS 2027` は「検索語のうち「NETYS」・「2027」は
 * 収録データにも見当たりません」と言い、これは噓だった（NETYS は名簿に在り、収録には
 * 2028-03-30 の締切が在る）。
 *
 * 第 296 回では、同じ案内が打ち方に日付を添えると壊れていたことを扱う（実測で `NETYS 2027` に
 * 「似た名前の会議が 35 件」– 35 の内訳は品書の key に年を持つ別々の会議だった）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 画面の時計。ビルドの実測と同じ 2026-08-09（JST 正午）に固定して、開催日の向きを数える。 */
const SCREEN_NOW = Date.UTC(2026, 7, 9, 3, 0, 0);

type Conf = {
  acronym?: string;
  title?: string;
  full_name?: string;
  key?: string;
  editions?: unknown[];
  /** 品の窓に締切が入らない会議にだけ、品書が載せる収録側の締切日（第 295 回）。 */
  record_deadline_last?: string | null;
};
type NameOnly = {
  example: string;
  count: number;
  terms: string[];
  recordLast?: string | null | "";
  /** その会のこれからの開催日（第 297 回）。 */
  eventNext?: string;
} | null;

/* `site` は共有ハーネスがビルドを作り終えてから決まるので、品書は引くたびに読む。 */
function conferences(): Conf[] {
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as {
    conferences: Conf[];
  };
  return catalog.conferences;
}

/* 品の窓に締切が 1 つも無いので、品書に行を組み込まれなかった会議。 */
function noRow(): Conf[] {
  return conferences().filter((c) => !(c.editions || []).length);
}

function example(): { name: string; key: string } {
  const conf = noRow()[0];
  return {
    name: String(conf?.acronym || conf?.title || conf?.key || ""),
    key: String(conf?.key || ""),
  };
}

/* 画面と同じ関数で名簿を引く（検査が別の世界を語らないために）。日の向きは、一覧の過去判定と
   同じ品選びの関数で見る – 検査の側に同じ規則を書き写さない。 */
function nameOnly(query: string, rowKeys: string[] = [], confs: Conf[] = conferences()): NameOnly {
  const run = new Function(
    "DATA",
    "SCREEN_NOW",
    `${jsFunction(siteRuntime("recommender.js"), "jstNoonMs")};
     const Recommender = { jstNoonMs };
     ${jsFunction(siteRuntime(), "nameOnlyConferenceMatch")};
     return (q, keys) =>
       nameOnlyConferenceMatch(q, keys.map((k) => ({ conf: { key: k } })), SCREEN_NOW);`,
  )({ conferences: confs } as never, SCREEN_NOW) as (q: string, keys: string[]) => NameOnly;
  return run(query, rowKeys);
}

/* 画面が「収録の全体を読み込む」へ送っていいのかを、品書が申告している（build の `record_deadline_last`）。 */
function deadlineDays(conf: Conf): string[] {
  const out: string[] = [];
  (conf.editions || []).forEach((raw) => {
    const deadlines = (raw as { deadlines?: unknown[] }).deadlines || [];
    deadlines.forEach((d) => {
      const day = d as { local_date?: string; value?: string; utc?: string };
      const v = day.local_date || day.value || day.utc || "";
      if (v.slice(0, 10).length === 10) out.push(v.slice(0, 10));
    });
  });
  return out;
}

function marked(): Conf[] {
  return conferences().filter((c) => c.record_deadline_last !== undefined);
}

function noteFor(name: string, over: Record<string, unknown>): string {
  const found = nameOnly(name) || { example: name, count: 1, terms: [name] };
  return hintFor(name, { nameOnly: { ...found, example: name, ...over } });
}

function fullRecordButton(): string {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const m = /id="fullRecordButton"[^>]*>([^<]+)</.exec(html);
  expect(m, "「収録の全体を読み込む」のボタンが画面に無い").not.toBeNull();
  return String(m?.[1]);
}

function hintFor(query: string, over: Record<string, unknown> = {}): string {
  const hint = deadlineHintFunction();
  return hint({
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    est: false,
    hiddenKindWords: [],
    catalogConferences: conferences().length,
    queryMatch: { catalog: 0, journal: 0 },
    hidden: { past: 120, est: 30, window: 0, rank: 0, cats: 0, domestic: 0, online: 0, kind: 0 },
    loadedLastDay: "2027-02-04",
    recordLastDay: "2028-03-30",
    horizonDays: 180,
    termCounts: [],
    query,
    ...over,
  });
}

describe("名簿に在る会議の話を 0 件の案内が言う（第 294 回）", () => {
  it("品書には、締切行を 1 本も持たない会議が本当に在る", () => {
    // ここが 0 件だと下の検査は空振りになる – 実測で守る。
    expect(noRow().length, "品書に行の無い会議が見つからない").toBeGreaterThan(0);
    expect(example().name).toBeTruthy();
  });

  it("名簿に在る語を「収録データにも見当たりません」と言わない", () => {
    const name = example().name;
    const found = nameOnly(name);
    expect(found, `${name} が名簿から引けない`).not.toBeNull();
    expect(found?.terms).toContain(name);
    const out = hintFor(`${name} 2027`, {
      nameOnly: found || undefined,
      termCounts: [
        { term: name, count: 0 },
        { term: "2027", count: 0 },
      ],
    });
    // 「検索語のうち…」の文その物を見て、名簿に在る語が並んでいないことを確かめる。
    const at = out.indexOf("検索語のうち");
    expect(at, "語が外せる案内が消えた").toBeGreaterThan(-1);
    const seg = out.slice(at, out.indexOf("。", at) + 1);
    expect(seg, "名簿に在る語を収録に無いと言った").not.toContain(name);
    expect(seg, "本当に無い語まで消した").toContain("2027");
  });

  it("締切が行に無いことを切れ目の日数といっしょに言い、全体を読み込むへ送る", () => {
    // 品書に申告が無い（古いビルド・日付の読めない物）ときは、出る約束を言わない。
    const found = nameOnly(example().name);
    const out = hintFor(example().name, {
      nameOnly: found ? { ...found, example: "", recordLast: "" } : undefined,
    });
    expect(out).toContain("収録の名簿");
    expect(out, "データの切れ目の日数が無い").toContain("2027-02-04");
    expect(out, "押し先を送っていない").toContain("収録の全体を読み込む");
    // 収録の側にも締切が 1 本も無い会（実測 248 件中 74 件）が在るので、出る約束をしない。
    expect(out, "出ると約束した").not.toContain("その会議の締切も探します");
    expect(out, "引き直すと言っていない").toContain("同じ語を引き直します");
    expect(out, "効かない打ち直しを並べた").not.toContain("別の語で試す");
  });

  it("例に挙げるのは、打った語すべてに当たる会議が 1 件だけるとき", () => {
    const name = example().name;
    expect(nameOnly(name)?.example, "1 件に絞れる例を挙げていない").toBe(name);
    // 多くの会議の名前に含まれる語では、先頭を例に挙げない（件数だけを出す）。
    const many = nameOnly("international");
    expect(many?.count, "検証に使えるだけの当たり数が無い").toBeGreaterThan(1);
    expect(many?.example, "曖昧なのに例を挙げた").toBe("");
  });

  it("名前の途中に隠れただけの語を、名簿の語として数えない", () => {
    const long = conferences().find((c) =>
      String(c.full_name || "")
        .split(" ")
        .some((w) => w.length >= 8),
    );
    const word = String(long?.full_name || "")
      .split(" ")
      .find((w) => w.length >= 8) as string;
    expect(word, "名前の途中で切る語が見つからない").toBeTruthy();
    const mid = word.slice(2, 6).toLowerCase();
    const whole = nameOnly(word.toLowerCase());
    const found = nameOnly(mid);
    if (found) {
      expect(
        found.example !== String(long?.acronym || ""),
        `${mid} を ${String(long?.acronym)} の語と数えた`,
      ).toBe(true);
    }
    // 語の途中（`tern` など）は、語そのもの（`international` など）より広く当たらない。
    expect(found?.count || 0).toBeLessThanOrEqual(whole?.count || 0);
  });

  it("収録の全体を読んだあとは黙る（行が出るので名簿の話は要らない）", () => {
    const name = example().name;
    expect(nameOnly(name, [example().key]), "行が在る会議を名簿の話に立てた").toBeNull();
    const out = hintFor(name, { nameOnly: nameOnly(name, [example().key]) || undefined });
    expect(out).not.toContain("収録の名簿");
  });

  it("名簿に在る語のときは「別の語で試す」を勧めない（窓が狭くても）", () => {
    const out = hintFor(example().name, {
      nameOnly: nameOnly(example().name) || undefined,
      window: "7",
    });
    expect(out).toContain("収録の名簿");
    expect(out, "語を変えても増えない人に、語を変えろと言った").not.toContain("別の語で試す");
  });

  it("「締切まで」の窓が狭いときは、他の案内に重ねる", () => {
    const out = hintFor(example().name, {
      nameOnly: nameOnly(example().name) || undefined,
      window: "7",
      hidden: {
        past: 120,
        est: 30,
        window: 412,
        rank: 0,
        cats: 0,
        domestic: 0,
        online: 0,
        kind: 0,
      },
    });
    expect(out).toContain("収録の名簿");
    expect(out, "窓の話が消えた").toContain("「締切まで」を「かまわない」に変更");
    expect(out, "原因が二つあるのに絞り込んだ").toContain("多いのは");
  });

  it("切れ目の日数を知らないビルドでは、数を作らない", () => {
    const out = hintFor(example().name, {
      nameOnly: nameOnly(example().name) || undefined,
      loadedLastDay: "",
    });
    expect(out).toContain("収録の名簿");
    expect(out, "日数をでっち上げた").not.toContain("一覧に出せる締切は");
  });

  it("案内が送る押し先は、画面のボタンと同じ語（書き写しでズレない）", () => {
    const html = readFileSync(join(site, "index.html"), "utf8");
    const label = (/id="fullRecordButton"[^>]*>([^<]+)</.exec(html)?.[1] || "").trim();
    expect(label).toBeTruthy();
    const base = nameOnly(example().name) || { example: "", count: 1, terms: [] };
    // 収録の側が不明 / 締切ゼロ / これからの締切が在る – ボタンにふれる三つの形で同じ語を使う。
    for (const recordLast of ["", null, "2028-03-30"] as const) {
      const out = hintFor(example().name, {
        nameOnly: { ...base, example: "", recordLast, recordFuture: true },
      });
      expect(out, `ボタン名が書き写し（${String(recordLast)} の形）`).toContain(label);
    }
  });

  it("描画側が、名簿の話を案内に渡している（渡し忘れで案内が黙らない）", () => {
    const app = siteRuntime();
    expect(app).toMatch(
      /nameOnly:\s*nameOnlyRecordInfo\(\s*nameOnlyConferenceMatch\(\s*searchQuery,\s*rows,\s*Date\.now\(\)\s*\)/,
    );
    // 読み込めている行を照合して「行が在るか」で判断している。
    expect(jsFunction(app, "nameOnlyConferenceMatch")).toContain("withRows");
  });
});

describe("収録の側に何が待っているかで、0 件の案内が言い分ける（第 295 回）", () => {
  it("申告を付けるのは、品の窓に締切が 1 本も入らない会議だけ", () => {
    const list = marked();
    expect(list.length, "品書が収録側の締切を申告していない").toBeGreaterThan(0);
    const wrong = list.filter((c) => deadlineDays(c).length > 0);
    expect(wrong, "締切の在る会議に申告が混じっている").toEqual([]);
    // 締切の在る会議には付いていない（品書の側で既に読める – 二重に数えさせない）。
    const unmarked = conferences().filter(
      (c) => deadlineDays(c).length > 0 && marked().includes(c),
    );
    expect(unmarked, "締切の読める会議まで申告した").toEqual([]);
  });

  it("申告の形は、収録に締切が 1 本も無い（null）か暦日か", () => {
    const list = marked();
    const bad = list.filter(
      (c) =>
        c.record_deadline_last !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(c.record_deadline_last)),
    );
    expect(bad, "読み方の分からない申告が混じっている").toEqual([]);
    const nulls = list.filter((c) => c.record_deadline_last === null);
    expect(nulls.length, "収録に締切の無い会が 1 件も申告されていない").toBeGreaterThan(0);
    expect(nulls[0]?.key, "締切ゼロの例が特定できない").toBeTruthy();
  });

  it("収録に締切が 1 本も無い会は、読んでも増えないと言う", () => {
    const out = noteFor(example().name, { recordLast: null, recordFuture: false });
    expect(out, "収録に締切が無いと言っていない").toContain("締切を 1 本も持っていません");
    expect(out, "空振りを送っている").toContain("押しても 1 件も増えません");
    expect(out, "出る約束をした").not.toContain("載せられます");
    expect(out, "日付を作った").not.toMatch(/その会には \d{4}-\d{2}-\d{2}/);
    // 締切が 1 本も無いのが原因なので、データの切れ目の話を混ぜない。
    expect(out, "原因をデータの切れ目にした").not.toContain("一覧に出せる締切は");
    expect(out, "ボタン名が書き写し").toContain(fullRecordButton());
  });

  it("収録にこれからの締切が在る会は、その日を言って読み込むへ送る", () => {
    const out = noteFor(example().name, { recordLast: "2028-03-30", recordFuture: true });
    expect(out, "収録の締切日を言っていない").toContain("2028-03-30");
    expect(out, "読み込めば出ると言っていない").toContain("その締切も一覧に載せられます");
    expect(out, "切れ目の日数が無い").toContain("2027-02-04");
    expect(out, "過ぎた締切と言った").not.toContain("過ぎた締切");
    expect(out, "ボタン名が書き写し").toContain(fullRecordButton());
    // 収録の側の日と、一覧に出せる日を、それぞれ別々に言わせている。
    expect(out, "収録の側の日の言い方が違う").toContain("2028-03-30 の締切が収録に在ります");
    expect(out, "一覧に出せる日の言い方が違う").toContain("一覧に出せる締切は 2027-02-04 まで");
  });

  it("収録にあるのが過ぎた締切だけの会は、過去の表示も一緒に勧める", () => {
    const out = noteFor(example().name, { recordLast: "2026-06-27", recordFuture: false });
    expect(out, "過ぎた締切と言っていない").toContain("過ぎた締切（2026-06-27）だけ");
    // 「過去の締切も表示」は他の案内も言うので、この案内自身の文であることを確かめる。
    expect(out, "過去の表示を送っていない").toContain("「過去の締切も表示」もいっしょにオン");
    expect(out, "これからの締切と言った").not.toContain("載せられます");
  });

  it("例を 1 件に絞れない会議では、収録側の話をしない", () => {
    const many = nameOnly("international");
    expect((many?.count || 0) > 1, "1 件に絞れる語になってしまった").toBe(true);
    expect(many?.recordLast, "曖昧な会議に収録側の話を添えた").toBe("");
    const out = hintFor("international", { nameOnly: many || undefined });
    expect(out, "曖昧な会議に締切日を教えた").not.toMatch(/その会には \d{4}-\d{2}-\d{2}/);
    expect(out, "曖昧な会議に空振りを読ませた").not.toContain("載せられます");
  });

  it("収録側の締切がこれからか過ぎたかは、行と同じ暦日の基準で見る", () => {
    const fn = jsFunction(siteRuntime(), "nameOnlyRecordInfo");
    const run = new Function(
      "Recommender",
      `${fn}; return (found, now) => nameOnlyRecordInfo(found, now);`,
    )({
      // 画面の行と同じ `jstNoonMs`（JST 正午 = UTC 03:00）を再現する。
      jstNoonMs: (raw: unknown, fallback: number): number => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? "").trim());
        if (!m) return fallback;
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 3, 0, 0);
      },
    } as never) as (
      found: {
        example: string;
        count: number;
        terms: string[];
        recordLast: string | null | "";
      } | null,
      now: number,
    ) => { recordLast: string | null | ""; recordFuture: boolean } | null;
    const base = { example: "NETYS", count: 1, terms: ["netys"] };
    const now = Date.UTC(2026, 7, 9, 3, 0, 0);
    expect(
      run({ ...base, recordLast: "2028-03-30" }, now)?.recordFuture,
      "来月を過ぎたと言った",
    ).toBe(true);
    expect(
      run({ ...base, recordLast: "2026-06-27" }, now)?.recordFuture,
      "過ぎた日をこれからの日と言った",
    ).toBe(false);
    // 当日の締切を「過ぎた」と呼ばない（人が読んだ日がその日だから）。
    expect(
      run({ ...base, recordLast: "2026-08-09" }, now)?.recordFuture,
      "当日を過ぎた日にした",
    ).toBe(true);
    expect(
      run({ ...base, recordLast: "2027-3-4" }, now)?.recordLast,
      "読めない日を日付として通した",
    ).toBe("");
    expect(
      run({ ...base, recordLast: null }, now)?.recordLast,
      "締切ゼロを不明に潰した",
    ).toBeNull();
    expect(run(null, now), "名簿に何も無いときに数を作った").toBeNull();
  });

  it("画面の品選びが、品書の申告を読んでいる", () => {
    const app = readFileSync(join(process.cwd(), "site/app.ts"), "utf8");
    expect(app, "品書の申告を読まないで名簿の案内をしている").toContain(
      "conf.record_deadline_last",
    );
    expect(app, "収録の側の向きを見ないで案内している").toContain("Recommender.jstNoonMs(");
    const build = readFileSync(join(process.cwd(), "src/build.ts"), "utf8");
    expect(build, "品書に収録側の締切日を載せていない").toContain("record_deadline_last");
  });
});

it("品選びは、品書の申告をそのまま案内に渡している", () => {
  // 検査が別の世界を語らないように、ビルドした品書の申告その物を読む（null と暦日の両方）。
  const list = marked()
    .map((c) => {
      const name = String(c.acronym || c.title || c.key || "");
      const found = nameOnly(name);
      return { name, key: String(c.key || ""), declared: c.record_deadline_last, found };
    })
    .filter((x) => x.found?.example === x.name);
  expect(list.length, "例に絞れる申告済みの会議が 1 件も無い").toBeGreaterThan(0);
  for (const x of list) {
    expect(x.found?.recordLast, `${x.key} の申告を画面が読み違えている`).toBe(
      x.declared === undefined ? "" : x.declared,
    );
  }
  const nulls = list.filter((x) => x.declared === null);
  const dated = list.filter((x) => typeof x.declared === "string" && x.declared);
  expect(
    nulls.length + dated.length,
    "null と暦日の両方を読めているか確かめられない",
  ).toBeGreaterThan(0);
  expect(nulls.length, "締切ゼロの申告を読めている例が無い").toBeGreaterThan(0);
});

it("名簿の案内が原因を言い切った 0 件案内に、効かない条件を並べない", () => {
  for (const over of [
    { recordLast: null, recordFuture: false },
    { recordLast: "2028-03-30", recordFuture: true },
    { recordLast: "2026-06-27", recordFuture: false },
    { recordLast: "", recordFuture: false },
  ]) {
    const out = noteFor(example().name, over);
    expect(out, `効かない条件を並べた（${String(over.recordLast)} の形）`).not.toContain(
      "外せる条件",
    );
    expect(out, `効かない条件を読み上げた（${String(over.recordLast)} の形）`).not.toContain(
      "推定締切を含める」をオン",
    );
  }
  // 締切が過ぎただけの会には、過去表示をオンにすると自分で言う（押し先を二重に教えない）。
  const past = noteFor(example().name, { recordLast: "2026-06-27", recordFuture: false });
  expect(past, "過去表示の送り先が消えた").toContain("「過去の締切も表示」もいっしょにオン");
  // 向きを渡されない（古い描画側の形）ときは、これからだとも過ぎたのだとも教えない。
  const blind = noteFor(example().name, { recordLast: "2028-03-30" });
  expect(blind, "向きを数えないで過ぎた締切と言った").not.toContain("過ぎた締切");
  expect(blind, "向きを数えないで載せられると言った").not.toContain("載せられます");
  expect(blind, "向きが不明なときに引き直しを送っていない").toContain("同じ語を引き直します");
});

describe("打ち方に日付を添えても、名前一つと同じ答えになる（第 296 回）", () => {
  /* 品書の key は年を含む物が多い（`ambre-2026` など）ので、年の語を名前の語と一緒に数えると
     別々の会議がまとまって「似た名前」として出る。実測で 35 件（`NETYS 2027`）。 */

  function sameAsName(name: string, extra: string) {
    const alone = nameOnly(name);
    const withDate = nameOnly(`${name} ${extra}`);
    return { alone, withDate };
  }

  it("年だけを添えた打ち方で、名前一つのときと同じ会議に絞れる", () => {
    const name = example().name;
    const { alone, withDate } = sameAsName(name, "2027");
    expect(withDate, "日付を添えたら名簿の案内が消えた").not.toBeNull();
    expect(withDate?.count, "年の語で件数が膨らんだ").toBe(alone?.count);
    expect(withDate?.example, "年の語で例を挙げなくなった").toBe(alone?.example);
    expect(withDate?.recordLast, "年の語で収録側の締切日が消えた").toBe(alone?.recordLast);
    expect(withDate?.count || 0, "例に絞れていない").toBeGreaterThan(0);
  });

  it("和暦風の月の指定を添えても同じ", () => {
    const name = example().name;
    for (const extra of ["2027年3月", "2027-03-15", "3/15", "12月", "2027 年"]) {
      const { alone, withDate } = sameAsName(name, extra);
      expect(withDate?.count, `日の語 ${extra} を名前の語に混ぜた`).toBe(alone?.count);
      expect(withDate?.example, `日の語 ${extra} で例を挙げない`).toBe(alone?.example);
    }
  });

  it("日付だけで引いたときは、名簿の話をしない", () => {
    // 第 293 回の範囲の案内が言う番で、ここでは数を作らない。
    for (const q of ["2027", "2027年", "2027年3月", "2027-03", "12月"]) {
      expect(nameOnly(q), `日付だけの打ち方 ${q} に名簿の件数を作った`).toBeNull();
    }
    // 実測で `2027` には「似た名前の会議が 34 件」出ていた。
    expect(nameOnly("2027"), "年の語だけで名簿を数えた").toBeNull();
  });

  it("語が名前の途中に隠れる打ち方は、日付としても数えない", () => {
    // `netys-2027` の語は名前の語 – 品書の key にこの形が在るなら別物として扱う。
    expect(nameOnly("netys-2027"), "語の形を曲げて名簿に立てた").toBeNull();
    expect(nameOnly("sc2027"), "語の形を曲げて名簿に立てた").toBeNull();
  });

  it("件数は、打った名前の語すべてに当たる物だけを数える", () => {
    const name = example().name;
    const many = nameOnly("international");
    expect(many?.count || 0, "語の組み合わせを見る前提が崩れた").toBeGreaterThan(1);
    const both = nameOnly(`${name} international`);
    if (both) {
      expect(both.count, "いずれかに当たる物まで数えた").toBeLessThanOrEqual(
        Math.min(nameOnly(name)?.count || 0, many?.count || 0),
      );
    }
  });

  it("全ての語に当たる会議が無くても、名簿に在る語は「無い」の列から外れる", () => {
    const name = example().name;
    const both = nameOnly(`${name} international`);
    expect(both, "語が名簿に見えるのに案内が黙った").not.toBeNull();
    expect(both?.count, "該当する会議が無いのに件数を作った").toBe(0);
    expect(both?.terms, "名簿に在る語を返していない").toContain(name);
    const out = hintFor(`${name} international`, {
      nameOnly: both || undefined,
      termCounts: [
        { term: name, count: 0 },
        { term: "international", count: 0 },
      ],
    });
    expect(out, "名簿に在ると言っていない").toContain("収録の名簿");
    expect(out, "切れ目の話をしていない").toContain("2027-02-04");
    expect(out, "名簿に在る語を収録に無いと言った").not.toContain("検索語のうち");
    expect(out, "語を変えれば増えると言った").not.toContain("別の語で試す");
  });

  it("日付を添えた打ち方の 0 件案内も、収録側の話と押し先を送る", () => {
    const name = example().name;
    const found = nameOnly(`${name} 2027`);
    const out = hintFor(`${name} 2027`, { nameOnly: found || undefined });
    expect(out, "名簿に在ると言っていない").toContain("収録の名簿");
    expect(out, "ボタン名が書き写し").toContain(fullRecordButton());
    expect(out, "効かない条件を並べた").not.toContain("外せる条件");
  });
});

describe("0 件の案内が、その会のこれからの開催日を添える（第 297 回）", () => {
  /* 実測（2026-09-24・2026-08-09 生成ビルド）で、過ぎた締切しか持たない会議 174 件のうち 118 件・
     収録に締切の無い会議 74 件のうち 31 件は、品書にこれからの開催日が在る。締切が過ぎただけの
     会と、まだ開かれるだけの会を分けないと、人は「終わった会議の話をした」と誤解する。 */

  function one(name: string, editions: unknown[]): Conf[] {
    return [{ acronym: name, key: name.toLowerCase(), editions } as unknown as Conf];
  }

  it("これからの開催日を、一番近い物から選んでいる", () => {
    const found = nameOnly(
      "FUTCONF",
      [],
      one("FUTCONF", [{ event_start: "2026-10-01" }, { event_start: "2026-09-09" }]),
    );
    expect(found?.eventNext, "一番近い開催日を選んでいない").toBe("2026-09-09");
  });

  it("過ぎた開催日と、推定の開催日は数えない", () => {
    expect(
      nameOnly("FUTCONF", [], one("FUTCONF", [{ event_start: "2026-08-08" }]))?.eventNext,
      "過ぎた開催日をこれからの開催日と言った",
    ).toBe("");
    expect(
      nameOnly("FUTCONF", [], one("FUTCONF", [{ event_start: "2027-01-05", estimated: true }]))
        ?.eventNext,
      "推定の開催日を確定のように言った",
    ).toBe("");
    // 当日は「これから」に残る（一覧の過去判定と同じ目 – 第 295 回）。
    expect(
      nameOnly("FUTCONF", [], one("FUTCONF", [{ event_start: "2026-08-09" }]))?.eventNext,
      "当日の開催日を過ぎた扱いにした",
    ).toBe("2026-08-09");
  });

  it("例に絞れない会議では、開催日も言わない", () => {
    const found = nameOnly("international");
    expect(found?.count || 0, "前提が崩れた").toBeGreaterThan(1);
    expect(found?.eventNext, "曖昧な会議に開催日を添えた").toBe("");
  });

  it("締切ゼロの案内は、開催日と upcoming.html の行き先を添える", () => {
    const name = "CCPE";
    const out = hintFor(name, {
      nameOnly: {
        example: name,
        count: 1,
        terms: [name.toLowerCase()],
        recordLast: null,
        recordFuture: false,
        eventNext: "2026-10-01",
      },
    });
    expect(out, "開催日を言っていない").toContain("開催日（2026-10-01）");
    expect(out, "行き先を言っていない").toContain("upcoming.html");
    expect(out, "押せば増えると約束した").toContain("押しても 1 件も増えません");
    // 画面に出る語に内部語を混ぜない。
    expect(out, "内部語が画面に出た").not.toContain("品書");
  });

  it("過ぎた締切だけの案内は、会議が終わったのではないことを添える", () => {
    const name = "NETYS";
    const out = hintFor(name, {
      nameOnly: {
        example: name,
        count: 1,
        terms: [name.toLowerCase()],
        recordLast: "2026-06-27",
        recordFuture: false,
        eventNext: "2027-06-01",
      },
    });
    expect(out, "過ぎた締切の話を消した").toContain("過ぎた締切（2026-06-27）");
    expect(out, "開催日がこれからだと言っていない").toContain("開催日（2027-06-01）はこれからです");
    expect(out, "終わった会議として扱った").toContain("会議が終わったわけではありません");
    expect(out, "過去表示に送っていない").toContain("「過去の締切も表示」もいっしょにオン");
  });

  it("これからの開催日が読み込めていなければ、従来の文のまま", () => {
    for (const over of [
      { recordLast: null, recordFuture: false },
      { recordLast: "2026-06-27", recordFuture: false },
    ]) {
      const out = noteFor(example().name, over);
      expect(out, "在らない開催日を言った").not.toContain("upcoming.html");
      expect(out, "在らない開催日を言った").not.toContain("開催日（");
    }
  });

  it("実ビルドの品書で、開催日を添えられる会議を数えている", () => {
    let checked = 0;
    let withEvent = 0;
    marked().forEach((conf) => {
      const name = String(conf.acronym || conf.title || conf.key);
      const found = nameOnly(name);
      if (found?.count !== 1) return;
      checked += 1;
      expect(deadlineDays(conf).length, `${name}: 品の窓に締切の在る会議に申告が付いている`).toBe(
        0,
      );
      const editions = (Array.isArray(conf.editions) ? conf.editions : []) as {
        event_start?: string;
        estimated?: boolean;
      }[];
      const future = editions
        .map((e) => (typeof e.event_start === "string" ? e.event_start : ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= "2026-08-09" && e2(d))
        .sort();
      function e2(d: string): boolean {
        return editions.some((e) => e.event_start === d && e.estimated !== true);
      }
      if (future.length) withEvent += 1;
      const day = found.eventNext || "";
      if (day) {
        expect(future[0], `${name}: 一番近い開催日を挙げていない`).toBe(day);
      } else {
        expect(future.length, `${name}: 品書にこれからの開催日が在るのに黙っている`).toBe(0);
      }
    });
    expect(checked, "名前で絞れる締切ゼロの会議が 1 件もない").toBeGreaterThan(0);
    expect(withEvent, "これからの開催日を添えられる会議が 1 件もない").toBeGreaterThan(0);
  });
});
