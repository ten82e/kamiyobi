import { spawn } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("keeps official links consistent in MCP deadline, event and venue responses without inventing edition URLs", async () => {
  const root = tempWork("kamiyobi-mcp-official-urls-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "data"));
  const cases = [
    {
      key: "absent",
      edition: undefined,
      venue: "https://example.org/absent",
      expected: "https://example.org/absent",
    },
    {
      key: "null",
      edition: null,
      venue: "https://example.org/null",
      expected: "https://example.org/null",
    },
    {
      key: "empty",
      edition: "",
      venue: "https://example.org/empty",
      expected: "https://example.org/empty",
    },
    {
      key: "blank",
      edition: " \t\n",
      venue: " https://example.org/blank ",
      expected: "https://example.org/blank",
    },
    {
      key: "specific",
      edition: " https://example.org/2030 ",
      venue: "https://example.org/series",
      expected: "https://example.org/2030",
    },
    { key: "unrecorded", edition: undefined, venue: undefined, expected: null },
    { key: "both-blank", edition: " ", venue: "\t", expected: null },
  ];
  writeFileSync(
    join(root, "data/snapshot.json"),
    JSON.stringify({
      conferences: cases.map((c) => ({
        key: c.key,
        title: c.key,
        link: c.venue,
        categories: [],
        rank: {},
        editions: [
          {
            id: `${c.key}30`,
            year: 2030,
            link: c.edition,
            event_start: "2030-01-10",
            event_end: "2030-01-11",
            event_date_precision: "exact-range",
            deadlines: [{ kind: "paper", utc: "2030-01-05T00:00:00Z", tz_raw: "UTC" }],
          },
        ],
      })),
    }),
  );
  writeFileSync(
    join(root, "run.ts"),
    'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2030-01-01T00:00:00Z"));',
  );
  const child = spawn(process.execPath, ["run.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let id = 0;
  async function call(name: string, args: Record<string, unknown>) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`,
    );
    const line = await lines.next();
    if (line.done) throw new Error("MCP closed before replying");
    const reply = JSON.parse(line.value);
    expect(reply.id).toBe(id);
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).not.toBe(true);
    return reply.result;
  }
  try {
    const search = await call("search_deadlines", { kinds: ["paper"], scope: "all" });
    const upcoming = await call("list_upcoming", { days: 30, scope: "all" });
    expect(search.structuredContent.rows).toHaveLength(7);
    expect(upcoming.structuredContent.items).toHaveLength(14);
    for (const c of cases) {
      const row = search.structuredContent.rows.find(
        (r: { venue_key: string }) => r.venue_key === c.key,
      );
      expect(row.official_url, c.key).toBe(c.expected);
      if (c.expected) expect(row.display.endsWith(` ${c.expected}`), c.key).toBe(true);
      else expect(row.display).not.toMatch(/https?:\/\//);
      expect(search.content[0].text).toContain(row.display);
      for (const type of ["deadline", "event"]) {
        const item = upcoming.structuredContent.items.find(
          (r: { venue_key: string; type: string }) => r.venue_key === c.key && r.type === type,
        );
        expect(item.official_url, `${type}: ${c.key}`).toBe(c.expected);
      }
      const eventLine = upcoming.content[0].text
        .split("\n")
        .find((line: string) => line.includes(`key: ${c.key}・`));
      expect(eventLine, c.key).toBeDefined();
      if (c.expected) expect(eventLine.endsWith(` ${c.expected}`), c.key).toBe(true);
      else expect(eventLine).not.toMatch(/https?:\/\//);
      const venue = await call("venue_info", { key: c.key, scope: "all" });
      expect(venue.structuredContent.rows[0].official_url, c.key).toBe(c.expected);
      expect(
        venue.structuredContent.official_url,
        "venue URL must remain independent of edition URL",
      ).toBe(c.venue?.trim() || null);
      expect(venue.content[0].text).toContain(row.display);
      expect(
        venue.structuredContent.editions[0].official_url,
        "edition URLs must remain specific to that edition",
      ).toBe(c.key === "specific" ? c.expected : null);
    }
  } finally {
    reader.close();
    child.kill();
  }
});
