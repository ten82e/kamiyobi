import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-upcoming-pages-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
const now = "2026-10-15T14:59:59Z";
function venue(key: string, edition: Record<string, unknown>) {
  return {
    key,
    title: key,
    full_name: key,
    link: `https://${key}.example.org/`,
    categories: ["systems"],
    rank: {},
    tags: [],
    editions: [
      {
        id: key,
        year: 2026,
        event_start: null,
        event_end: null,
        place: "Tokyo, Japan",
        estimated: false,
        deadlines: [],
        ...edition,
      },
    ],
  };
}
const conferences = [
  ...Array.from({ length: 123 }, (_, i) =>
    venue(`deadline${String(i).padStart(3, "0")}`, {
      deadlines: [
        {
          kind: i === 122 ? "notification" : "paper",
          utc: new Date(Date.parse("2026-10-16T01:00:00Z") + i * 1000).toISOString(),
          tz_raw: "UTC",
        },
      ],
    }),
  ),
  venue("date-only", {
    deadlines: [
      {
        kind: "paper",
        precision: "date-only",
        local_date: "2026-10-15",
        earliest_utc: "2026-10-14T10:00:00Z",
        latest_utc: "2026-10-16T12:00:00Z",
      },
    ],
  }),
  venue("estimated-deadline", {
    estimated: true,
    deadlines: [{ kind: "paper", utc: "2026-10-16T02:00:00Z", tz_raw: "UTC" }],
  }),
  ...Array.from({ length: 117 }, (_, i) =>
    venue(`event${String(i).padStart(3, "0")}`, {
      event_start: "2026-10-16",
      event_end: "2026-10-16",
      event_date_precision: i === 0 ? "unverified" : i === 1 ? "month-only" : "single-day",
    }),
  ),
  venue("today-event", {
    event_start: "2026-10-15",
    event_end: "2026-10-15",
    event_date_precision: "single-day",
  }),
  venue("split-event", {
    event_start: "2026-10-15",
    event_end: "2026-10-16",
    event_date_precision: "split-dates",
    event_segments: [
      { start: "2026-10-15", end: "2026-10-15", label: "first" },
      { start: "2026-10-16", end: "2026-10-16", label: "second" },
    ],
  }),
  venue("past-event", { event_start: "2026-10-14", event_end: "2026-10-14" }),
  venue("beyond-event", { event_start: "2026-10-18", event_end: "2026-10-18" }),
  venue("estimated-event", { event_start: "2026-10-16", event_end: "2026-10-16", estimated: true }),
];
mkdirSync(join(root, "data"));
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({ snapshot_metadata: { generated_at: "2026-10-15T00:00:00Z" }, conferences }),
);
mkdirSync(join(root, "public"));
writeFileSync(
  join(root, "public/catalog.json"),
  JSON.stringify({ generated_at: "2026-10-14T00:00:00Z", conferences: conferences.slice(0, 1) }),
);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse(process.argv[2]));',
);
function calls(args: Record<string, unknown>[], at = now) {
  const child = spawnSync(process.execPath, ["run.ts", at], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 12 * 1024 * 1024,
    input: `${args.map((arguments_, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_upcoming", arguments: { days: 2, scope: "all", ...arguments_ } } })).join("\n")}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).result);
}
function page(args: Record<string, unknown> = {}) {
  const result = calls([args])[0];
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent;
}
it("returns every deadline and event through stable pages without duplicates or omissions", () => {
  const first = page();
  expect(first).toMatchObject({
    total: 245,
    deadline_total: 125,
    event_total: 120,
    offset: 0,
    limit: 100,
    returned: 100,
    next_offset: 100,
  });
  const collect = (limit: number) =>
    calls(
      Array.from({ length: Math.ceil(first.total / limit) }, (_, i) => ({
        limit,
        offset: i * limit,
      })),
    ).flatMap((result, i) => {
      const p = result.structuredContent;
      expect(p.offset).toBe(i * limit);
      expect(p.returned).toBe(p.items.length);
      expect(p.next_offset).toBe(p.offset + p.returned < 245 ? p.offset + p.returned : null);
      return p.items;
    });
  const whole = collect(100);
  expect(collect(37)).toEqual(whole);
  expect(whole).toHaveLength(245);
  const deadlines = whole.filter((item: { type: string }) => item.type === "deadline");
  const events = whole.filter((item: { type: string }) => item.type === "event");
  expect(deadlines.map((item: { venue_key: string }) => item.venue_key).sort()).toEqual(
    [
      ...Array.from({ length: 123 }, (_, i) => `deadline${String(i).padStart(3, "0")}`),
      "date-only",
      "estimated-deadline",
    ].sort(),
  );
  expect(
    events
      .filter((item: { venue_key: string }) => item.venue_key === "split-event")
      .map((item: { event_start: string }) => item.event_start),
  ).toEqual(["2026-10-15", "2026-10-16"]);
  expect(
    new Set(
      events.map(
        (item: { venue_key: string; event_start: string }) =>
          `${item.venue_key}:${item.event_start}`,
      ),
    ).size,
  ).toBe(120);
  expect(
    events
      .map(
        (item: { venue_key: string; event_start: string }) =>
          `${item.venue_key}:${item.event_start}`,
      )
      .sort(),
  ).toEqual(
    [
      ...Array.from({ length: 117 }, (_, i) => `event${String(i).padStart(3, "0")}:2026-10-16`),
      "today-event:2026-10-15",
      "split-event:2026-10-15",
      "split-event:2026-10-16",
    ].sort(),
  );
  expect(page({ offset: 245 })).toMatchObject({ items: [], returned: 0, next_offset: null });
});
it("keeps date-only deadlines, estimated deadlines and uncertain event dates distinct", () => {
  const all = calls([
    { offset: 0, limit: 100 },
    { offset: 100, limit: 100 },
    { offset: 200, limit: 100 },
  ]).flatMap((r) => r.structuredContent.items);
  expect(all.find((r: { venue_key: string }) => r.venue_key === "date-only")).toMatchObject({
    type: "deadline",
    precision: "date-only",
    utc: null,
    jst: null,
    local_date: "2026-10-15",
  });
  expect(
    all.find((r: { venue_key: string }) => r.venue_key === "estimated-deadline"),
  ).toMatchObject({ type: "deadline", estimated: true });
  expect(all.find((r: { venue_key: string }) => r.venue_key === "event000")).toMatchObject({
    type: "event",
    event_date_precision: "unverified",
    event_start: "2026-10-16",
  });
  expect(all.find((r: { venue_key: string }) => r.venue_key === "event001")).toMatchObject({
    type: "event",
    event_date_precision: "month-only",
  });
  expect(all.find((r: { venue_key: string }) => r.venue_key === "estimated-event")).toBeUndefined();
});
it("keeps events ending today until JST midnight, then advances the calendar window", () => {
  const today = page({ limit: 100 });
  expect(today.items.some((r: { venue_key: string }) => r.venue_key === "today-event")).toBe(true);
  const next = calls(
    [{ limit: 100 }, { limit: 100, offset: 100 }, { limit: 100, offset: 200 }],
    "2026-10-15T15:00:00Z",
  ).flatMap((r) => r.structuredContent.items);
  expect(next.some((r: { venue_key: string }) => r.venue_key === "today-event")).toBe(false);
  expect(next.some((r: { venue_key: string }) => r.venue_key === "beyond-event")).toBe(true);
  expect(next.filter((r: { venue_key: string }) => r.venue_key === "split-event")).toHaveLength(1);
});
it("reports deadline filters and screen scope without silently restricting full-collection events", () => {
  expect(page({ kinds: ["notification"] })).toMatchObject({
    total: 121,
    deadline_total: 1,
    event_total: 120,
    event_scope: "all",
  });
  expect(page({ scope: "screen" })).toMatchObject({
    total: 121,
    deadline_total: 1,
    event_total: 120,
    scope: "screen",
    event_scope: "all",
    generated_at: "2026-10-14T00:00:00Z",
    event_generated_at: "2026-10-15T00:00:00Z",
  });
});
it("rejects invalid offsets, caps the page size, and returns an explicit empty result", () => {
  for (const offset of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const result = calls([{ offset }])[0];
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("offset");
  }
  expect(page({ limit: 1000 })).toMatchObject({ limit: 100, returned: 100 });
  const result = calls([{}], "2027-01-01T00:00:00Z")[0];
  expect(result.structuredContent).toMatchObject({ total: 0, items: [], next_offset: null });
});
it("supports JSON and page controls through the actual CLI", () => {
  writeFileSync(join(root, "clock.mjs"), `Date.now=()=>Date.parse(${JSON.stringify(now)});`);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "./clock.mjs",
      "src/mcp.ts",
      "upcoming",
      "2",
      "--json",
      "--offset",
      "100",
      "--limit",
      "7",
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    offset: 100,
    limit: 7,
    returned: 7,
    next_offset: 107,
    total: 245,
  });
});
