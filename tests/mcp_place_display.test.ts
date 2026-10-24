import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("uses the same Japanese place labels in search, upcoming, venue and recommendation results while retaining source names", async () => {
  const root = tempWork("kamiyobi-mcp-places-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const dir of ["data", "public"]) mkdirSync(join(root, dir));
  const cases = [
    { key: "kurashiki", raw: "倉敷市芸文館", display: "倉敷市芸文館 岡山県" },
    { key: "nagoya", raw: "名古屋大学", display: "名古屋大学 愛知県" },
    { key: "sendai", raw: "仙台国際センター 宮城県", display: "仙台国際センター 宮城県" },
    { key: "ambiguous", raw: "名古屋大学 東京キャンパス", display: "名古屋大学 東京キャンパス" },
    { key: "overseas", raw: "Paris, France", display: "Paris, フランス" },
    { key: "online", raw: "Online", display: "オンライン" },
    { key: "unknown", raw: "", display: "" },
  ];
  const data = {
    generated_at: "2030-01-01T00:00:00Z",
    conferences: cases.map((c) => ({
      key: c.key,
      title: `GPU programming ${c.key}`,
      scope: "gpu parallel programming",
      categories: ["systems"],
      rank: {},
      editions: [
        {
          id: `${c.key}30`,
          year: 2030,
          place: c.raw,
          event_start: "2030-01-10",
          event_end: "2030-01-11",
          event_date_precision: "exact-range",
          deadlines: [{ kind: "paper", utc: "2030-01-05T00:00:00Z", tz_raw: "UTC" }],
        },
      ],
    })),
  };
  const source = JSON.stringify(data);
  writeFileSync(join(root, "data/snapshot.json"), source);
  writeFileSync(join(root, "public/recommendation-index.json"), source);
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
      expect(row.place, c.key).toBe(c.raw);
      expect(row.place_ja, c.key).toBe(c.display || null);
      expect(row.display, c.key).toContain(`| ${c.display || "未確認"}`);
      expect(search.content[0].text).toContain(row.display);
      for (const type of ["deadline", "event"]) {
        const item = upcoming.structuredContent.items.find(
          (r: { venue_key: string; type: string }) => r.venue_key === c.key && r.type === type,
        );
        expect(item.place_ja, `${type}: ${c.key}`).toBe(
          c.display || (type === "event" ? "未確認" : null),
        );
      }
      const eventLine = upcoming.content[0].text
        .split("\n")
        .find((line: string) => line.includes(`key: ${c.key}・`));
      expect(eventLine, c.key).toContain(`| ${c.display || "未確認"}`);
      const venue = await call("venue_info", { key: c.key });
      expect(venue.structuredContent.rows[0].place, c.key).toBe(c.raw);
      expect(venue.structuredContent.rows[0].place_ja, c.key).toBe(c.display || null);
      expect(venue.structuredContent.editions[0].place_ja, c.key).toBe(c.display || "未確認");
      expect(venue.content[0].text).toContain(row.display);
    }
    for (const paper of ["GPU parallel programming", "GPUの並列プログラミング"]) {
      const recommendation = await call("recommend_venues", { paper, limit: 10 });
      expect(recommendation.structuredContent.total).toBe(7);
      for (const c of cases) {
        const row = recommendation.structuredContent.rows.find(
          (r: { venue_key: string }) => r.venue_key === c.key,
        );
        expect(row.deadline.place, c.key).toBe(c.raw);
        expect(row.deadline.place_ja, c.key).toBe(c.display || null);
        expect(recommendation.content[0].text).toContain(row.deadline.display);
      }
    }
    expect(readFileSync(join(root, "data/snapshot.json"), "utf8")).toBe(source);
    expect(readFileSync(join(root, "public/recommendation-index.json"), "utf8")).toBe(source);
  } finally {
    reader.close();
    child.kill();
  }
});
