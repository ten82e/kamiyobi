/**
 * カレンダー（`deadlines.ics`）に分野が載っているかの検査（SPEC §7・第 292 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 928 個の `VEVENT` のうち `CATEGORIES` を持つ物は
 * **0 個**で、`DESCRIPTION` は 会議 / 種別 / 締切 / 開催地 / 詳細 / 収録 の 6 項目だけだった。
 * セキュリティの会議だけをカレンダーに入れたい人は 928 件を丸ごと購読するしかなく、
 * カレンダーの検索で分野の語を引く術も無かった（てびきは「画面の絞り込みは効かない」としか
 * 言っていなかった）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DataRecord, icsCategoryLabels, icsCategoryList, toIcsText } from "../src/build.ts";
import { site } from "./built_golden_shared.ts";
import { siteRuntime } from "./runtime_extract.ts";

const NOW = new Date("2026-08-09T00:00:00Z");

/** RFC 5545 の折り畳み（CRLF + 空白 1 文字）を戻す。 */
function unfoldIcs(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .reduce((acc: string[], line) => {
      if ((line.startsWith(" ") || line.startsWith("\t")) && acc.length) {
        acc[acc.length - 1] += line.slice(1);
      } else acc.push(line);
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
        const name = line.slice(0, i).split(";")[0];
        const items = cur[name] ?? [];
        items.push(line.slice(i + 1));
        cur[name] = items;
      }
    }
  }
  return out;
}

/** 説明行の `項目: 値` を、escaping と折り畳みを戻して取り出す。 */
function fieldOf(raw: string, name: string): string {
  const ev = eventsOf(raw)[0];
  const item = (ev?.DESCRIPTION || [])
    .join("")
    .split("\\n")
    .find((l) => l.startsWith(`${name}:`));
  return item ? item.slice(name.length + 1).trim() : "";
}

function builtEvents(): Record<string, string[]>[] {
  return eventsOf(readFileSync(join(site, "deadlines.ics"), "utf8"));
}

/** 収録の形（`categories` は会議に付く – `src/model.ts` の `Conference`）。 */
function rec(cats: string[] = ["security"]): DataRecord {
  return {
    type: "deadline",
    kind_label: "論文締切",
    estimated: false,
    conf: { key: "sec", title: "SEC", link: "https://sec.example/", categories: cats },
    edition: { year: 2027, edition_id: "sec27", link: "https://sec27.example/" },
    deadline: { precision: "exact", at_utc: new Date("2026-10-04T20:00:00Z") },
    all_day: false,
  } as unknown as DataRecord;
}

/* ビルドした実行時処理から、画面が見ている分野の語の一覧を取り出す（書き写さない）。 */
function screenCategoryWords(): Set<string> {
  const src = siteRuntime("recommender.js");
  const m = src.match(/CATEGORY_LABELS_JA\s*=\s*\{([\s\S]*?)\n\s*\};/);
  expect(m, "recommender.js から分野の語一覧が見つからない").not.toBeNull();
  const words = [...String(m?.[1]).matchAll(/:\s*"([^"]+)"/g)].map((x) => x[1]);
  expect(words.length, "分野の語が少なすぎる（検査が空振り）").toBeGreaterThan(4);
  return new Set(words);
}

describe("カレンダーに分野が載る（第 292 回）", () => {
  it("説明の「分野:」と CATEGORIES が、同じ語を同じ順で並べている", () => {
    const withCats = builtEvents().filter((ev) => (ev.CATEGORIES || []).length > 0);
    expect(withCats.length, "CATEGORIES を持つイベントが皆無（検査が空振り）").toBeGreaterThan(10);
    let checked = 0;
    for (const ev of withCats) {
      // `DESCRIPTION` の中の改行は RFC 5545 の escaping で 2 文字の `\n` になっている（実改行で
      // 割ると、説明の項目をまたいで検査が空振りする – 第 292 回）。
      const line = (ev.DESCRIPTION || [])
        .join("")
        .split("\\n")
        .find((l) => l.startsWith("分野:"));
      if (!line) continue;
      const inDesc = line.slice("分野:".length).trim().split("・");
      const inCats = (ev.CATEGORIES || [])[0].split(",");
      expect(inCats, `${inDesc.join("・")} の語が並ばない`).toEqual(inDesc);
      checked += 1;
    }
    expect(checked, "説明と比較できたイベントが少なすぎる").toBeGreaterThan(10);
  });

  it("カレンダーに分野を持つイベントが、全体の 9 割を占める", () => {
    const ev = builtEvents();
    const n = ev.filter((e) => (e.CATEGORIES || []).length > 0).length;
    expect(n / ev.length, `分野を持つイベントが ${n}/${ev.length}`).toBeGreaterThan(0.9);
  });

  it("CATEGORIES の値は画面の分野の語で、英字の内部表記をカレンダーだけに作らない", () => {
    const words = screenCategoryWords();
    const values = builtEvents()
      .flatMap((ev) => (ev.CATEGORIES || []).join(",").split(","))
      .filter(Boolean);
    expect(values.length).toBeGreaterThan(10);
    const unknown = [...new Set(values)].filter((v) => !words.has(v));
    expect(unknown, `画面に無い分野の語: ${unknown.join("・")}`).toEqual([]);
  });

  it("折り畳みで分かれても CATEGORIES の値が復元し、75 バイト超の行が無い", () => {
    const raw = readFileSync(join(site, "deadlines.ics"), "utf8");
    const over = raw
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => Buffer.byteLength(l, "utf8") > 75);
    expect(over, `75 バイト超の行: ${over.length} 本`).toEqual([]);
    // 展開後の CATEGORIES に生のカンマ区切り以外の脱出漏れが無いこと。
    for (const ev of builtEvents()) {
      const value = (ev.CATEGORIES || [])[0] || "";
      expect(value.replace(/\\[\\;,]/g, ""), `脱出されていない区切り: ${value}`).not.toMatch(/[;]/);
    }
  });

  it("イベントの件数は、分野を足しても申告（catalog.json）と同じ", () => {
    const calendar = (
      JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as Record<string, unknown>
    ).calendar as { event_count?: number } | undefined;
    expect(calendar?.event_count, "品書にカレンダーの件数の申告が無い").toBeTypeOf("number");
    expect(builtEvents().length).toBe(calendar?.event_count);
  });

  it("分野の語は画面と同じ入口から取り、重複を落とし、未知の語は原文のままだ", () => {
    expect(icsCategoryLabels(["security", "ai"])).toEqual(["セキュリティ", "人工知能"]);
    expect(icsCategoryLabels(["ai", "ai"])).toEqual(["人工知能"]);
    // 画面が原文で出している語を、カレンダーだけ翻訳した風にしない。
    expect(icsCategoryLabels(["quantum"])).toEqual(["quantum"]);
    expect(icsCategoryLabels([])).toEqual([]);
    expect(icsCategoryLabels(undefined)).toEqual([]);
    expect(icsCategoryLabels(null)).toEqual([]);
  });

  it("CATEGORIES の値は区切りカンマを保ったまま、値の中の記号を逃がす", () => {
    expect(icsCategoryList(["セキュリティ"])).toBe("セキュリティ");
    expect(icsCategoryList(["人工知能", "データベース"])).toBe("人工知能,データベース");
    expect(icsCategoryList(["a,b", "c;d", "e\\f"])).toBe("a\\,b,c\\;d,e\\\\f");
  });

  it("分野の無い会議は CATEGORIES も説明の分野行も作らない（無い物を 0 件にしない）", () => {
    const raw = toIcsText([rec([])], NOW);
    expect(raw).not.toContain("CATEGORIES:");
    expect(raw).not.toContain("分野:");
    const withCat = toIcsText([rec()], NOW);
    expect(withCat).toContain("CATEGORIES:セキュリティ");
    expect(fieldOf(withCat, "分野")).toBe("セキュリティ");
  });

  it("複数分野の行は・で並び、値の順と同じ（受信側の分類と画面の表示がズレない）", () => {
    const raw = toIcsText([rec(["security", "systems", "hpc"])], NOW);
    const ev = eventsOf(raw)[0];
    expect((ev.CATEGORIES || [])[0]).toBe("セキュリティ,システム,高性能計算");
    expect(fieldOf(raw, "分野")).toBe("セキュリティ・システム・高性能計算");
  });
});
