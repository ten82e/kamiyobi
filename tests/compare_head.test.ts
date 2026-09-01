/**
 * scripts/compare-head.ts — update-data.yml が data ファイルの実質差分検出に使う
 * ヘルパーのユニットテスト。generated_at / _comment（日々変わる抽出日付）を
 * 無視して、実質変更のときだけ 1 を返すことを保証する。
 */

import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareToHead, normalizeData, readFromHead } from "../scripts/compare-head.ts";

describe("normalizeData", () => {
  it("drops top-level generated_at", () => {
    const a = normalizeData({ generated_at: "2026-08-13T00:00:00Z", conferences: [] });
    const b = normalizeData({ generated_at: "2026-08-12T00:00:00Z", conferences: [] });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("drops _comment recursively (per-conference extraction dates)", () => {
    const a = normalizeData({
      conferences: {
        whpc: {
          _comment: "… (2026-08-10)",
          editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } },
        },
      },
    });
    const b = normalizeData({
      conferences: {
        whpc: {
          _comment: "… (2026-08-13)",
          editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } },
        },
      },
    });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("detects substantive deadline changes", () => {
    const a = normalizeData({
      conferences: { whpc: { editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } } } },
    });
    const b = normalizeData({
      conferences: { whpc: { editions: { 2026: { deadlines: [{ date: "2026-08-28" }] } } } },
    });
    expect(a).not.toBe(b);
  });

  it("normalizes key order (YAML vs JSON equivalence)", () => {
    const a = normalizeData({ b: 1, a: { d: 2, c: 3 } });
    const b = normalizeData({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("returns null for primitives", () => {
    expect(normalizeData(null)).toBeNull();
    expect(normalizeData(42)).toBeNull();
    expect(normalizeData("text")).toBeNull();
  });

  it("baseline: only top-level observed_at is stripped", () => {
    const path = "data/source-observation-baseline.json";
    const a = normalizeData(
      {
        observed_at: "2026-08-26T05:00:00Z",
        parse_warning_count: 9,
        nested: { observed_at: "keep" },
      },
      path,
    );
    const b = normalizeData(
      {
        observed_at: "2026-08-27T05:00:00Z",
        parse_warning_count: 9,
        nested: { observed_at: "keep" },
      },
      path,
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // nested observed_at is preserved (not stripped recursively)
    expect(a).toContain('"observed_at":"keep"');
  });

  it("baseline: substantive changes are detected", () => {
    const path = "data/source-observation-baseline.json";
    const a = normalizeData({ observed_at: "x", parse_warning_count: 9 }, path);
    const b = normalizeData({ observed_at: "y", parse_warning_count: 10 }, path);
    expect(a).not.toBe(b);
  });

  it("snapshot: strips generated_at and _comment but keeps evidence timestamps", () => {
    const path = "data/snapshot.json";
    const evidence = { retrievedAt: "2026-08-25T00:00:00Z", verifiedAt: "2026-08-25T00:00:00Z" };
    const a = normalizeData(
      { generated_at: "2026-08-26T00:00:00Z", _comment: "old", data: { evidence } },
      path,
    );
    const b = normalizeData(
      { generated_at: "2026-08-27T00:00:00Z", _comment: "new", data: { evidence } },
      path,
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // evidence timestamps are preserved
    expect(a).toContain('"retrievedAt"');
  });

  it("overrides: only _comment is stripped, not other top-level fields", () => {
    const path = "data/primary_overrides.yaml";
    const a = normalizeData({ venue: { _comment: "2026-08-26", deadlines: ["2026-09-01"] } }, path);
    const b = normalizeData({ venue: { _comment: "2026-08-27", deadlines: ["2026-09-01"] } }, path);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("overrides: substantive changes are detected", () => {
    const path = "data/primary_overrides.yaml";
    const a = normalizeData({ venue: { _comment: "x", deadlines: ["2026-09-01"] } }, path);
    const b = normalizeData({ venue: { _comment: "y", deadlines: ["2026-09-02"] } }, path);
    expect(a).not.toBe(b);
  });
});

describe("compareToHead", () => {
  it("reads tracked files larger than execFileSync's default buffer", () => {
    const path = "data/snapshot.json";
    expect(statSync(path).size).toBeGreaterThan(1024 * 1024);
    expect(readFromHead(path)).not.toBeNull();
  });

  it("returns 0 when the working tree matches HEAD", () => {
    // data/snapshot.json は HEAD と同一（このテストが変更を加えていない前提）。
    expect(compareToHead("data/snapshot.json")).toBe(0);
  });

  it("returns 0 for a path that does not parse", () => {
    // 存在しないファイルは「コミットしない」側（読めない = 0）に倒す。
    expect(compareToHead("data/no-such-file.json")).toBe(0);
  });
});
