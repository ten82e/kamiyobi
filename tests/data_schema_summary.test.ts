import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

interface DataLike {
  conferences?: Array<Record<string, unknown>>;
}

/** `llms.txt` の「data.json のスキーマ要約」の節（列の節は別の話）。 */
function 要約の節(text: string): string {
  const 始 = text.indexOf("## data.json のスキーマ要約");
  const 終 = text.indexOf("## data.csv の列");
  expect(始, "要約の節が無い").toBeGreaterThan(0);
  expect(終, "列の節が無い").toBeGreaterThan(始);
  return text.slice(始, 終);
}

/** 節の箇条書きに出る識別子（`- name:` の形の行から取る）。 */
function 名指した鍵(節: string): Set<string> {
  const 鍵 = new Set<string>();
  for (const line of 節.split("\n")) {
    if (!/^\s*- /.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) 鍵.add(m[0]);
  }
  return 鍵;
}

/** ある `data.json` の層ごとの鍵。 */
function 層ごとの鍵(data: DataLike): Record<string, Set<string>> {
  const 層: Record<string, Set<string>> = {
    トップ: new Set(Object.keys(data)),
    会議: new Set(),
    版: new Set(),
    締切: new Set(),
  };
  for (const c of data.conferences ?? []) {
    for (const k of Object.keys(c)) 層.会議.add(k);
    for (const e of (c.editions ?? []) as Array<Record<string, unknown>>) {
      for (const k of Object.keys(e)) 層.版.add(k);
      for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
        for (const k of Object.keys(dl)) 層.締切.add(k);
      }
    }
  }
  return 層;
}

describe("data.json のスキーマ要約（llms.txt）", () => {
  it("實データに出る鍵を、どの層も書き漏らしていない", () => {
    const out = builtSite();
    const 文書 = 名指した鍵(要約の節(readFileSync(join(out, "llms.txt"), "utf8")));
    const 足りない: string[] = [];
    let 見た = 0;
    const 見る = (名: string, data: DataLike): void => {
      見た += 1;
      for (const [層名, 鍵] of Object.entries(層ごとの鍵(data)))
        for (const k of 鍵) if (!文書.has(k)) 足りない.push(`${名}／${層名}: ${k}`);
    };
    const 検査用 = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as DataLike;
    見る("検査用", 検査用);
    expect(
      [...層ごとの鍵(検査用).締切].length,
      "締切の欄を読めない（前提が崩れた）",
    ).toBeGreaterThan(5);
    /* 検査用のビルドは、公式訂正の当時の入力を固定した物（`tests/built_site.ts`）。
     * 任意の欄（`event_segments`・`event_review` など）はその入力には出ないので、本番の
     * ビルドも見る（CI は検査の前に `public/` を作る）。片方だけでは、その入力に出ない欄の
     * 書き漏らしに気づけない – 2026-10-16 実測: 版の `event_segments` が要約に無く、
     * 検査用の入力には 1 版も出ないので素通りしていた。 */
    const 本番 = join(REPO_ROOT, "public", "data.json");
    if (existsSync(本番)) 見る("本番", JSON.parse(readFileSync(本番, "utf8")) as DataLike);
    expect(見た, "どのビルドも見ていない").toBeGreaterThan(0);
    /* 欄を足したら要約にも書く。書かないと、索引だけを読む AI はその欄の存在に気づかない。 */
    expect(足りない, `要約が名指していない欄: \n${足りない.join("\n")}`).toEqual([]);
  });
});

/** 實データに出る「取りうる値」を集める（欄ごと）。 */
function 値の集合(data: DataLike): Record<string, Set<string>> {
  const 集: Record<string, Set<string>> = {};
  const 足 = (名: string, v: unknown): void => {
    if (v === undefined || v === null || v === "") return;
    if (!集[名]) 集[名] = new Set<string>();
    集[名].add(String(v));
  };
  for (const c of data.conferences ?? []) {
    for (const k of Object.keys((c.rank ?? {}) as object)) 足("會議のランクの列", k);
    for (const e of (c.editions ?? []) as Array<Record<string, unknown>>) {
      足("開催回の狀態", e.status);
      足("會期の確かさ", e.event_date_precision);
      const est = e.estimate as Record<string, unknown> | undefined;
      if (est) {
        足("推定の作り方", est.method);
        足("推定の信賴度", est.confidence);
      }
      for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
        足("締切の種別", dl.kind);
        足("締切の精度", dl.precision);
        const v = dl.verification as Record<string, unknown> | undefined;
        if (v) {
          足("確かめた狀態", v.status);
          足("確かめた狀態", v.source_class);
          const pi = v.provider_identity as Record<string, unknown> | undefined;
          if (pi) {
            足("確かめた狀態", pi.provider);
            足("確かめた狀態", pi.strength);
          }
        }
        for (const x of (dl.evidence ?? []) as Array<Record<string, unknown>>) {
          足("來歷の確かさ", x.confidence);
          足("來歷の元の種類", x.sourceClass);
          for (const f of (x.verifiedFields ?? []) as unknown[]) 足("確かめた欄", f);
        }
        for (const x of (dl.superseded_deadlines ?? []) as Array<Record<string, unknown>>) {
          足("上書きの理由", x.reason);
          足("上書きの狀態", x.status);
        }
        for (const x of (dl.conflicts ?? []) as Array<Record<string, unknown>>)
          足("競合の精度", x.precision);
      }
    }
  }
  return 集;
}

/** 要約のどの行が、どの欄の値を並べているか（行を特定する印）。 */
const 値の行: Array<[string, string]> = [
  ["會議のランクの列", "  - rank: object："],
  ["會期の確かさ", "    - event_date_precision: string："],
  ["推定の作り方", "`method` は"],
  ["推定の信賴度", "`confidence` は 'low'"],
  ["締切の種別", "      - kind: string："],
  ["締切の精度", "      - precision: 'exact'"],
  ["開催回の狀態", "      - status: 'confirmed'"],
  ["確かめた狀態", "画面の札と「確認元」はここから出る"],
  ["來歷の確かさ", "`confidence` は 'official'"],
  ["來歷の元の種類", "`sourceClass` が確かめた元の種類"],
  ["確かめた欄", "`verifiedFields` が確かめた欄"],
  ["上書きの理由", "`reason` は"],
  ["上書きの狀態", "`status` は 'superseded'"],
  ["競合の精度", "`precision` は 'exact'|'date-only'"],
];

describe("data.json のスキーマ要約（値の側）", () => {
  it("實データに出る値は、要約のその欄の行に書いてある", () => {
    const out = builtSite();
    const 節 = 要約の節(readFileSync(join(out, "llms.txt"), "utf8"));
    const 行々 = 節.split("\n");
    const 足りない: string[] = [];
    const 見た = new Set<string>();
    const 見る = (名: string, data: DataLike): void => {
      const 集 = 値の集合(data);
      for (const [欄, 印] of 値の行) {
        const 行 = 行々.find((l) => l.includes(印));
        expect(行, `要約に「${欄}」の行が無い（印: ${印}）`).toBeTruthy();
        for (const 値 of 集[欄] ?? [])
          if (!String(行).includes(`'${値}'`)) 足りない.push(`${欄}: '${値}'（${名}）`);
        見た.add(欄);
      }
    };
    const 検査用 = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as DataLike;
    見る("検査用", 検査用);
    /* 檢查用のビルドに出ない値（'assumption' など）は本番で見る（欄を名指す検査と同じ理由）。 */
    const 本番 = join(REPO_ROOT, "public", "data.json");
    if (existsSync(本番)) 見る("本番", JSON.parse(readFileSync(本番, "utf8")) as DataLike);
    expect(見た.size, "値の欄を一つも見ていない").toBeGreaterThan(10);
    expect(足りない, `要約が書いていない値: \n${足りない.join("\n")}`).toEqual([]);
  });
});
