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
