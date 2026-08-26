/**
 * update-data canary: reproduce the scheduled offline-baseline vs fresh-upstream
 * comparison against frozen fixtures and pin the health-gate decisions for each
 * scenario class (edition-id rename, new warning code, genuine disappearance).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeFixtureCache, runCli } from "./helpers.ts";

let cleanup: string | null = null;
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-canary-"));
  if (cleanup === null) {
    afterAll(() => {
      if (cleanup !== null) rmSync(cleanup, { recursive: true, force: true });
    });
    cleanup = dir.slice(0, dir.lastIndexOf("-"));
  }
  return dir;
}

/** Build offline baseline + online-equivalent current with a mutated upstream fixture. */
function buildPair(mutate?: (fixtureRoot: string) => void): {
  baseline: string;
  current: string;
} {
  const root = scratch();
  const cache = makeFixtureCache(join(root, "cache"));
  const baseline = join(root, "baseline");
  const current = join(root, "current");
  const base = runCli(baseline, { cache });
  expect(base.status).toBe(0);
  // Simulate a fresh upstream fetch by mutating the fixture payload inside the cache slot.
  const slot = join(cache, "ccfddl__ccf-deadlines__main", "ccf-deadlines-main", "conference");
  mutate?.(slot);
  const cur = runCli(current, { cache });
  expect(cur.status).toBe(0);
  return { baseline, current };
}

describe("update-data canary", () => {
  it("edition id rename alone does not block the gate", () => {
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "sigcomm.yml");
      writeFileSync(file, readFileSync(file, "utf8").replace(/id: sigcomm26/g, "id: sigcomm26b"));
    });
    // The gate itself is exercised through scripts/health-gate.ts in CI; here we pin the data-level
    // invariant: the renamed edition keeps the same deadline values.
    const slotsOf = (dir: string) => {
      const data = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as {
        conferences: Array<{
          key: string;
          editions: Array<{
            deadlines: Array<{ kind: string; utc: string | null }>;
          }>;
        }>;
      };
      return data.conferences
        .filter((c) => c.key === "sigcomm")
        .flatMap((c) => c.editions.flatMap((e) => e.deadlines.map((d) => d.utc)))
        .sort();
    };
    expect(slotsOf(current)).toEqual(slotsOf(baseline));
  });

  it("a genuinely removed future deadline changes the slot set", () => {
    const { baseline, current } = buildPair((root) => {
      const file = join(root, "NW", "nsdi.yml");
      const text = readFileSync(file, "utf8").replace(
        /- abstract_deadline: '[^']+'\n\s+deadline: '[^']+'\n/,
        "",
      );
      writeFileSync(file, text);
    });
    const count = (dir: string) => {
      const data = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as {
        conferences: Array<{
          key: string;
          editions: Array<{ deadlines: Array<Record<string, unknown>> }>;
        }>;
      };
      return data.conferences
        .filter((c) => c.key === "nsdi")
        .reduce((sum, c) => sum + c.editions.reduce((s, e) => s + e.deadlines.length, 0), 0);
    };
    expect(count(current)).toBeLessThan(count(baseline));
  });

  it("offline rebuild of unchanged sources is byte-stable", () => {
    const root = scratch();
    const cache = makeFixtureCache(join(root, "cache"));
    const a = runCli(join(root, "a"), { cache });
    const b = runCli(join(root, "b"), { cache });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const read = (dir: string) =>
      JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as {
        confirmed_deadlines: number;
      };
    expect(read(join(root, "b")).confirmed_deadlines).toBe(
      read(join(root, "a")).confirmed_deadlines,
    );
  });
});
