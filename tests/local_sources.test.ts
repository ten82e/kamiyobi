/**
 * Local source data integrity: every deadline written in local YAML is either
 * an exact instant with a recognized tz or a date-only value without a tz.
 *
 * Interactive HPC (SC26) の締切が「date 8/15 + tz UTC」と
 * 入力され、公式「14th August 2026」+ ポータル 8/14 AoE に対し 1 日遅れた。
 * 変換コード自体は正しかったため、このテストは変換の意味論ではなく
 * 「ローカルデータの各エントリが無言で落ちない・未知 tz にならない」ことを
 * 検証する（parse 失敗はビルドで警告のうえ静かにスキップされるため）。
 *
 * #382: 会期 date_text も同じ理由で検査する。#376 は締切検査だけでは緑のまま
 * JSON / upcoming から落ちた。
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  isConfirmedTimezone,
  parseDateRange,
  parseInstant,
  resetWarnings,
  warningCounts,
} from "../src/model.ts";
import { LocalSource, parseFile } from "../src/sources/local.ts";
import { REPO_ROOT } from "./helpers.ts";

interface RawDeadline {
  src: string;
  key: string;
  date: string;
  tz: string;
  precision: string;
}

function rawDeadlines(): RawDeadline[] {
  const out: RawDeadline[] = [];

  // Canonical local inputs: conferences は配列（各エントリに key）。
  for (const filename of ["manual.yaml", "curated.generated.yaml"]) {
    const source = loadYaml(readFileSync(join(REPO_ROOT, "data", filename), "utf8")) as {
      conferences?: Array<{ key?: string; editions?: Array<{ deadlines?: unknown[] }> }>;
    };
    for (const conf of source?.conferences ?? []) {
      for (const ed of conf.editions ?? []) {
        for (const dl of ed.deadlines ?? []) {
          const rec = dl as Record<string, unknown>;
          out.push({
            src: filename,
            key: conf.key ?? "?",
            date: String(rec.date ?? ""),
            tz: String(rec.tz ?? rec.timezone ?? ""),
            precision: String(rec.precision ?? "exact"),
          });
        }
      }
    }
  }

  // data/overrides.yaml: conferences はキー → { editions: { <年>: { deadlines } } }。
  const ovr = loadYaml(readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")) as {
    conferences?: Record<string, { editions?: Record<string, { deadlines?: unknown[] }> }>;
  };
  for (const [key, conf] of Object.entries(ovr?.conferences ?? {})) {
    for (const ed of Object.values(conf.editions ?? {})) {
      for (const dl of ed.deadlines ?? []) {
        const rec = dl as Record<string, unknown>;
        out.push({
          src: "overrides.yaml",
          key,
          date: String(rec.date ?? ""),
          tz: String(rec.tz ?? rec.timezone ?? ""),
          precision: String(rec.precision ?? "exact"),
        });
      }
    }
  }

  // data/primary_overrides.yaml: 一次ソース自動抽出の結果（overrides.yaml と同じ構造）。
  // パース失敗は cli が静かに {} を返すため（2026-08-12 whpc で実証）、ここで必ず検出する。
  const prim = loadYaml(
    readFileSync(join(REPO_ROOT, "data", "primary_overrides.yaml"), "utf8"),
  ) as {
    conferences?: Record<string, { editions?: Record<string, { deadlines?: unknown[] }> }>;
  };
  for (const [key, conf] of Object.entries(prim?.conferences ?? {})) {
    for (const ed of Object.values(conf.editions ?? {})) {
      for (const dl of ed.deadlines ?? []) {
        const rec = dl as Record<string, unknown>;
        out.push({
          src: "primary_overrides.yaml",
          key,
          date: String(rec.date ?? ""),
          tz: String(rec.tz ?? rec.timezone ?? ""),
          precision: String(rec.precision ?? "exact"),
        });
      }
    }
  }
  return out;
}

describe("local source data integrity", () => {
  it("preserves legacy keys for consolidated local conferences (#677)", () => {
    const conferences = new Map(
      parseFile(join(REPO_ROOT, "data", "extra.yaml")).map((conference) => [
        conference.key,
        conference,
      ]),
    );
    expect(conferences.get("csp-2027")?.legacy_keys).toEqual(["csp-ei-2027", "ieee-csp-2027"]);
    expect(conferences.get("keir-cikm2026")?.legacy_keys).toEqual(["keir-cikm-2026"]);
  });

  it("every local deadline has a valid exact or date-only representation", () => {
    resetWarnings();
    const rows = rawDeadlines();
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((row) => row.precision === "date-only")).toHaveLength(174);

    for (const row of rows) {
      if (row.precision === "date-only") {
        expect(row.date, `${row.src} ${row.key}: invalid date-only value`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
        expect(row.tz, `${row.src} ${row.key}: date-only value must not have a timezone`).toBe("");
        continue;
      }
      expect(row.precision).toBe("exact");
      if (row.src === "primary_overrides.yaml" && !isConfirmedTimezone(row.tz)) {
        // fetch-primary records the source verbatim; a missing zone is not UTC.
        expect(parseInstant(row.date, row.tz)).toBeNull();
        continue;
      }
      const at = parseInstant(row.date, row.tz);
      expect(
        at,
        `${row.src} ${row.key}: unparsable date ${JSON.stringify(row.date)} tz=${JSON.stringify(row.tz)}`,
      ).not.toBeNull();
      expect(at!.getUTCFullYear()).toBeGreaterThanOrEqual(2015);
      expect(at!.getUTCFullYear()).toBeLessThanOrEqual(2032);
    }

    // 未知 tz は「unknown timezone ...; observation rejected」と警告する。
    // ゼロであること = tz タイポ（AEO / utc+8 等）が混入していないこと。
    const counts = warningCounts();
    const unknownTz = Object.keys(counts).filter((k) => k.startsWith("unknown timezone"));
    expect(unknownTz).toEqual([]);
  });

  it("every extra.yaml date_text parses or is an explicit year-only / TBD exception (#382)", () => {
    const extra = loadYaml(readFileSync(join(REPO_ROOT, "data", "extra.yaml"), "utf8")) as {
      conferences?: Array<{
        key?: string;
        editions?: Array<{ year?: number; date_text?: string; date?: string }>;
      }>;
    };
    const allowNull = new Set(["TBD 2027", "2026年11月下旬～12月上旬（詳細未定）"]);
    const rows: Array<{ key: string; year: number; text: string }> = [];
    for (const conf of extra?.conferences ?? []) {
      for (const ed of conf.editions ?? []) {
        const text = String(ed.date_text ?? ed.date ?? "").trim();
        if (!text) continue;
        rows.push({ key: conf.key ?? "?", year: Number(ed.year) || 2026, text });
      }
    }
    expect(rows.length).toBeGreaterThan(50);
    const unexpected: string[] = [];
    for (const row of rows) {
      if (/^\d{4}$/.test(row.text) || allowNull.has(row.text)) continue;
      const [start, end] = parseDateRange(row.text, row.year);
      if (start === null || end === null) {
        unexpected.push(`${row.key}: ${JSON.stringify(row.text)}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("every YAML data file parses without error", () => {
    // primary_overrides.yaml のパース失敗は cli が静かに {} を返して全エントリを
    // 消す（2026-08-12 whpc で実証: _comment 内の「: 」でパースエラー→ビルドは成功）。
    // YAML 自体が壊れていると loadYaml が throw するので、ここで全ファイルを検証する。
    const files = [
      "data/extra.yaml",
      "data/overrides.yaml",
      "data/primary_overrides.yaml",
      "data/primary.yaml",
      "config.yaml",
    ];
    for (const f of files) {
      expect(
        () => loadYaml(readFileSync(join(REPO_ROOT, f), "utf8")),
        `${f} must parse`,
      ).not.toThrow();
    }
  });

  it("primary.yaml and fetch-primary.ts do not advertise the retired fetch_primary.py (#384)", () => {
    const primary = readFileSync(join(REPO_ROOT, "data", "primary.yaml"), "utf8");
    const src = readFileSync(join(REPO_ROOT, "src", "fetch-primary.ts"), "utf8");
    const generated = readFileSync(join(REPO_ROOT, "data", "primary_overrides.yaml"), "utf8");
    expect(primary, "primary.yaml must name the TS extractor").toContain("src/fetch-primary.ts");
    expect(primary).not.toContain("fetch_primary.py");
    expect(src).not.toContain('"#":');
    expect(src).toContain("const header =");
    expect(src).toContain("# 自動生成。src/fetch-primary.ts");
    expect(generated).not.toContain("fetch_primary.py");
    expect(generated).toContain("fetch-primary.ts");
  });

  it("overrides.yaml does not advertise the retired scripts/merge.py (#386)", () => {
    const header = readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")
      .split("\n")
      .slice(0, 8)
      .join("\n");
    expect(header, "overrides.yaml header must name src/merge.ts").toContain("src/merge.ts");
    expect(header).toContain("applyOverrides");
    expect(header).not.toContain("merge.py");
    expect(header).not.toContain("apply_overrides");
  });
});

it("unions categories and tags when the same local key spans files (#768)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-local-merge-"));
  const venue = (categories: string, tags: string, year: number, id: string) =>
    [
      "conferences:",
      "  - key: demo",
      "    title: Demo",
      `    categories: [${categories}]`,
      `    tags: [${tags}]`,
      `    legacy_keys: [demo-old, ${id}-old]`,
      `    scope: [shared, ${categories}]`,
      "    category_assignments:",
      `      - {category: ${categories}, reason: manual-review, evidence: '${id}'}`,
      "    editions:",
      `      - year: ${year}`,
      `        id: ${id}`,
      "        deadlines:",
      "          - {kind: paper, date: '2026-09-01', precision: date-only}",
      "",
    ].join("\n");
  const first = join(dir, "manual.yaml");
  const second = join(dir, "curated.yaml");
  writeFileSync(first, venue("ai", "", 2026, "demo-2026"));
  writeFileSync(second, venue("security", "workshop", 2027, "demo-2027"));
  const loaded = await new LocalSource([first, second]).load();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.categories.sort()).toEqual(["ai", "security"]);
  expect(loaded[0]!.tags).toEqual(["workshop"]);
  expect(loaded[0]!.legacy_keys).toEqual(["demo-old", "demo-2026-old", "demo-2027-old"]);
  expect(loaded[0]!.scope).toEqual(["shared", "ai", "security"]);
  expect(loaded[0]!.category_assignments).toEqual([
    { category: "ai", reason: "manual-review", evidence: "demo-2026" },
    { category: "security", reason: "manual-review", evidence: "demo-2027" },
  ]);
  expect(loaded[0]!.editions.map((edition) => edition.year)).toEqual([2026, 2027]);
});

it("merges rank, dblp, link, full_name, and acronym when the same local key spans files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-local-merge-rank-"));
  const first = join(dir, "manual.yaml");
  const second = join(dir, "curated.yaml");
  writeFileSync(
    first,
    [
      "conferences:",
      "  - key: testconf",
      "    title: TestConf",
      "    rank: { ccf: B }",
      "    editions:",
      "      - year: 2026",
      "        id: testconf26",
      "        event_start: '2026-10-15'",
      "        event_end: '2026-10-10'", // inverted dates
      "        deadlines:",
      "          - {kind: paper, date: '2026-05-01', precision: date-only}",
    ].join("\n"),
  );
  writeFileSync(
    second,
    [
      "conferences:",
      "  - key: testconf",
      "    title: TestConf",
      "    full_name: Full Test Conference",
      "    acronym: TC",
      "    link: https://testconf.org",
      "    dblp: conf/testconf",
      "    rank: 'CORE: A*, THCPL: A'",
      "    editions:",
      "      - year: 2027",
      "        id: testconf27",
      "        deadlines:",
      "          - {kind: paper, date: '2027-05-01', precision: date-only}",
    ].join("\n"),
  );

  const loaded = await new LocalSource([first, second]).load();
  expect(loaded).toHaveLength(1);
  const conf = loaded[0]!;
  expect(conf.full_name).toBe("Full Test Conference");
  expect(conf.acronym).toBe("TC");
  expect(conf.link).toBe("https://testconf.org");
  expect(conf.dblp).toBe("conf/testconf");
  expect(conf.rank).toEqual({ ccf: "B", core: "A*", thcpl: "A" });
  // Verify inverted event date normalization: start <= end
  const ed26 = conf.editions.find((e) => e.year === 2026)!;
  expect(ed26.event_start!.toISOString().slice(0, 10)).toBe("2026-10-10");
  expect(ed26.event_end!.toISOString().slice(0, 10)).toBe("2026-10-15");
});
