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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

type Conf = {
  acronym?: string;
  title?: string;
  full_name?: string;
  key?: string;
  editions?: unknown[];
};
type NameOnly = { example: string; count: number; terms: string[] } | null;

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

/* 画面と同じ関数で名簿を引く（検査が別の世界を語らないために）。 */
function nameOnly(query: string, rowKeys: string[] = []): NameOnly {
  const fn = jsFunction(siteRuntime(), "nameOnlyConferenceMatch");
  const run = new Function(
    "DATA",
    `${fn}; return (q, keys) => nameOnlyConferenceMatch(q, keys.map((k) => ({ conf: { key: k } })));`,
  )({ conferences: conferences() } as never) as (q: string, keys: string[]) => NameOnly;
  return run(query, rowKeys);
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
    const out = hintFor(example().name, { nameOnly: nameOnly(example().name) || undefined });
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
    expect(hintFor(example().name, { nameOnly: nameOnly(example().name) || undefined })).toContain(
      label,
    );
  });

  it("描画側が、名簿の話を案内に渡している（渡し忘れで案内が黙らない）", () => {
    const app = siteRuntime();
    expect(app).toMatch(/nameOnly:\s*nameOnlyConferenceMatch\(searchQuery,\s*rows\)/);
    // 読み込めている行を照合して「行が在るか」で判断している。
    expect(jsFunction(app, "nameOnlyConferenceMatch")).toContain("withRows");
  });
});
