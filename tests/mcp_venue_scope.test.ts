import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-venue-scope-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
const snapshotAt = "2029-06-01T00:00:00Z";
const catalogAt = "2029-06-02T00:00:00Z";
const venue = {
  key: "fresh",
  title: "Fresh",
  categories: [],
  rank: {},
  editions: [
    {
      id: "near",
      year: 2029,
      event_start: "2029-06-15",
      deadlines: [{ kind: "paper", utc: "2029-06-05T00:00:00Z" }],
    },
    {
      id: "far",
      year: 2030,
      event_start: "2030-06-15",
      deadlines: [{ kind: "paper", utc: "2030-06-05T00:00:00Z" }],
    },
  ],
};
const eventOnly = {
  key: "event-only",
  title: "Event Only",
  categories: [],
  rank: {},
  editions: [{ id: "event", year: 2029, event_start: "2029-07-01", deadlines: [] }],
};
const snapshot = {
  snapshot_metadata: { generated_at: snapshotAt },
  conferences: [venue, eventOnly],
};
function writeSnapshot(value: unknown = snapshot) {
  writeFileSync(join(root, "data/snapshot.json"), JSON.stringify(value));
}
writeSnapshot();
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-06-03T00:00:00Z"));',
);
function call(args: Record<string, unknown>, raw = false) {
  expect(existsSync(join(root, ".cache"))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "venue_info", arguments: args } })}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()).result;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return raw ? result : result.structuredContent;
}
it("reports the actual fallback source when screen data is absent, without marking an all request as fallback", () => {
  expect(existsSync(join(root, "public"))).toBe(false);
  const screen = call({ key: "fresh", scope: "screen" });
  expect(screen).toMatchObject({
    scope: "all",
    catalog_fallback: true,
    generated_at: snapshotAt,
    event_scope: "all",
    event_generated_at: snapshotAt,
    deadline_total: 2,
    evaluated_at: "2029-06-03T00:00:00.000Z",
  });
  expect(screen.rows.map((r: { edition_id: string }) => r.edition_id)).toEqual(["near", "far"]);
  const all = call({ key: "fresh" });
  expect(all).toMatchObject({
    scope: "all",
    catalog_fallback: false,
    generated_at: snapshotAt,
    event_generated_at: snapshotAt,
    deadline_total: 2,
  });
});
it("keeps deadline scope and timestamp distinct from full-collection schedules, including event-only venues", () => {
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({
      generated_at: catalogAt,
      conferences: [{ ...venue, editions: venue.editions.slice(0, 1) }],
    }),
  );
  try {
    for (const scope of ["screen", "window"]) {
      const data = call({ key: "fresh", scope });
      expect(data).toMatchObject({
        scope: "screen",
        catalog_fallback: false,
        generated_at: catalogAt,
        event_scope: "all",
        event_generated_at: snapshotAt,
        deadline_total: 1,
      });
      expect(data.rows.map((r: { edition_id: string }) => r.edition_id)).toEqual(["near"]);
      expect(data.editions.map((ed: { edition_id: string }) => ed.edition_id)).toEqual([
        "near",
        "far",
      ]);
    }
    const all = call({ key: "fresh", scope: "full" });
    expect(all).toMatchObject({
      scope: "all",
      catalog_fallback: false,
      generated_at: snapshotAt,
      deadline_total: 2,
    });
    const empty = call({ key: "event-only", scope: "screen" });
    expect(empty).toMatchObject({
      scope: "screen",
      catalog_fallback: false,
      generated_at: catalogAt,
      event_scope: "all",
      event_generated_at: snapshotAt,
      rows: [],
      deadline_total: 0,
    });
    expect(empty.editions.map((ed: { edition_id: string }) => ed.edition_id)).toEqual(["event"]);
  } finally {
    rmSync(join(root, "public"), { recursive: true, force: true });
  }
});
it("does not invent generation timestamps from the evaluation clock when provenance is missing", () => {
  writeSnapshot({ conferences: snapshot.conferences });
  try {
    const data = call({ key: "fresh" });
    expect(data).toMatchObject({
      scope: "all",
      generated_at: null,
      event_generated_at: null,
      evaluated_at: "2029-06-03T00:00:00.000Z",
    });
  } finally {
    writeSnapshot();
  }
});

it("distinguishes uncollected deadlines from out-of-screen deadlines in edition labels", () => {
  const expanded = {
    ...venue,
    editions: [
      ...venue.editions,
      { id: "event", year: 2031, event_start: "2031-06-15", deadlines: [] },
      { id: "unknown", year: 2032, event_date_precision: "not-announced", deadlines: [] },
    ],
  };
  writeSnapshot({ ...snapshot, conferences: [expanded] });
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({
      generated_at: catalogAt,
      conferences: [{ ...venue, editions: venue.editions.slice(0, 1) }],
    }),
  );
  try {
    const screen = call({ key: "fresh", scope: "screen" }, true);
    const header = (result: { content: { text: string }[] }) =>
      result.content[0].text.split("\n").find((line) => line.startsWith("版: "));
    expect(header(screen)).toBe(
      "版: event(締切未収録) / far(締切は表示範囲外) / near / unknown(締切未収録)",
    );
    expect(
      screen.structuredContent.rows.map((row: { edition_id: string }) => row.edition_id),
    ).toEqual(["near"]);
    expect(
      screen.structuredContent.editions.map((ed: { edition_id: string }) => ed.edition_id),
    ).toEqual(["near", "far", "event", "unknown"]);
    const all = call({ key: "fresh", scope: "all" }, true);
    expect(header(all)).toBe("版: event(締切未収録) / far / near / unknown(締切未収録)");
    expect(all.structuredContent.rows.map((row: { edition_id: string }) => row.edition_id)).toEqual(
      ["near", "far"],
    );
  } finally {
    writeSnapshot();
    rmSync(join(root, "public"), { recursive: true, force: true });
  }
});
