import { spawn } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const generatedAt = "2029-01-01T00:00:00Z";
const edition = (id: string, dated = false) => ({
  id,
  year: 2030,
  event_date_precision: "not-announced",
  deadlines: dated ? [{ kind: "paper", utc: "2030-01-05T00:00:00Z", tz_raw: "UTC" }] : [],
});
const conferences = [
  {
    key: "alpha",
    title: "Alpha Systems",
    acronym: "A",
    editions: [edition("alpha30", true), edition("current-collision")],
  },
  { key: "beta", title: "国内システム研究会", editions: [edition("beta30")] },
  { key: "current-collision", title: "Current Key", editions: [edition("current30")] },
  ...Array.from({ length: 31 }, (_, i) => ({
    key: `series-${i}`,
    title: `Series ${i}`,
    acronym: "Shared",
    editions: [edition("shared-edition", i % 2 === 0)],
  })),
];
const identity = (conf: (typeof conferences)[number]) => ({
  venue_key: conf.key,
  title: conf.title,
  full_name: null,
  acronym: "acronym" in conf ? conf.acronym : null,
  official_url: null,
});
interface VenueResponse {
  content: { text: string }[];
  structuredContent: {
    retry_arguments: Record<string, unknown>;
    candidates: unknown[];
    [key: string]: unknown;
  };
}
async function withMcp(
  run: (call: (args: Record<string, unknown>) => Promise<VenueResponse>) => Promise<void>,
) {
  const root = tempWork("kamiyobi-venue-recovery-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const dir of ["data", "public"]) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, "data/snapshot.json"),
    JSON.stringify({ snapshot_metadata: { generated_at: generatedAt }, conferences }),
  );
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({ generated_at: "2028-12-01T00:00:00Z", conferences: [] }),
  );
  writeFileSync(
    join(root, "run.ts"),
    'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-01-02T00:00:00Z"));',
  );
  const child = spawn(process.execPath, ["run.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let id = 0;
  try {
    await run(async (args) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "venue_info", arguments: args } })}\n`,
      );
      const line = await lines.next();
      if (line.done) throw new Error("MCP closed before replying");
      const reply = JSON.parse(line.value);
      expect(reply.id).toBe(id);
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).not.toBe(true);
      return reply.result;
    });
  } finally {
    reader.close();
    child.kill();
  }
}

it("resolves unique edition identifiers and retries without replacing a current venue key", async () => {
  await withMcp(async (call) => {
    for (const [key, target, count] of [
      ["ＡＬＰＨＡ３０", "alpha", 1],
      ["beta30", "beta", 0],
    ] as const) {
      const result = await call({ key, scope: "screen" });
      expect(result.structuredContent).toMatchObject({
        lookup_status: "edition_key",
        query: key,
        scope: "all",
        generated_at: generatedAt,
        ...identity(conferences.find((conf) => conf.key === target)!),
        retry_arguments: { key: target, scope: "all" },
      });
      expect(result.structuredContent).not.toHaveProperty("rows");
      const next = await call(result.structuredContent.retry_arguments);
      expect(next.structuredContent).toMatchObject({ venue_key: target, deadline_total: count });
      expect(next.structuredContent.rows).toHaveLength(count);
      expect(next.structuredContent).not.toHaveProperty("retry_arguments");
    }
    const current = await call({ key: "current-collision", scope: "all" });
    expect(current.structuredContent).toMatchObject({
      venue_key: "current-collision",
      deadline_total: 0,
    });
    expect(current.structuredContent).not.toHaveProperty("retry_arguments");
  });
});

it("returns every owner of a shared edition identifier rather than selecting the first venue", async () => {
  await withMcp(async (call) => {
    const result = await call({ key: "ＳＨＡＲＥＤ－ＥＤＩＴＩＯＮ", scope: "screen" });
    expect(result.structuredContent).toMatchObject({
      lookup_status: "ambiguous",
      matched_by: "edition_key",
      scope: "all",
      generated_at: generatedAt,
      candidate_count: 31,
    });
    expect(result.structuredContent.candidates).toEqual(conferences.slice(3).map(identity));
    expect(result.structuredContent).not.toHaveProperty("venue_key");
    expect(result.structuredContent).not.toHaveProperty("retry_arguments");
    for (const key of ["series-7", "series-30"]) {
      expect(result.content[0].text).toContain(`key: ${key}`);
      const selected = await call({ key, scope: "all" });
      expect(selected.structuredContent).toMatchObject({
        venue_key: key,
        deadline_total: key === "series-7" ? 0 : 1,
      });
    }
  });
});

it("distinguishes missing keys and names from acronym candidates and returns usable exact keys", async () => {
  await withMcp(async (call) => {
    for (const args of [{ key: "NO-SUCH" }, { name: "未収録研究会" }, { key: "＋＋＋" }]) {
      const result = await call({ ...args, scope: "screen" });
      expect(result.structuredContent).toMatchObject({
        lookup_status: "not_found",
        query: args.key || args.name,
        scope: "all",
        generated_at: generatedAt,
        venue_total: 34,
        candidate_count: 0,
        candidates: [],
      });
      expect(result.content[0].text).toContain(
        `その会議（${args.key ? "key" : "name"}: \`${args.key || args.name}\`）`,
      );
      expect(result.structuredContent).not.toHaveProperty("venue_key");
      expect(result.structuredContent).not.toHaveProperty("rows");
      expect(result.structuredContent).not.toHaveProperty("retry_arguments");
    }
    const acronym = await call({ key: "Ａ", scope: "screen" });
    expect(acronym.structuredContent).toMatchObject({
      lookup_status: "not_found",
      candidate_count: 1,
      candidates: [identity(conferences[0])],
      retry_arguments: { key: "alpha", scope: "all" },
    });
    const next = await call(acronym.structuredContent.retry_arguments);
    expect(next.structuredContent).toMatchObject({ venue_key: "alpha", deadline_total: 1 });
    const shared = await call({ key: "ＳＨＡＲＥＤ", scope: "screen" });
    expect(shared.structuredContent).toMatchObject({
      lookup_status: "not_found",
      candidate_count: 31,
    });
    expect(shared.structuredContent.candidates).toEqual(conferences.slice(3).map(identity));
    expect(shared.structuredContent).not.toHaveProperty("retry_arguments");
    expect(shared.content[0].text).toContain("`series-30`");
  });
});
