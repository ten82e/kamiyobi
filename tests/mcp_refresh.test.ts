import { spawn } from "node:child_process";
import { cpSync, mkdirSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const initialTime = "2026-10-13T00:00:00Z";
function data(key: string, generatedAt = initialTime) {
  return {
    generated_at: generatedAt,
    snapshot_metadata: { generated_at: generatedAt },
    categories: { systems: "Systems" },
    conferences: [
      {
        key,
        title: key,
        categories: ["systems"],
        scope: "distributed systems network protocols",
        editions: [
          {
            id: `${key}-2026`,
            year: 2026,
            deadlines: [
              {
                kind: "paper",
                precision: "exact",
                utc: "2026-10-14T00:00:00Z",
                tz_raw: "UTC",
              },
            ],
          },
        ],
      },
    ],
  };
}
interface Result {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    total: number;
    generated_at: string;
    evaluated_at: string;
    rows: Array<{ venue_key: string }>;
  };
}
function server() {
  const root = tempWork("kamiyobi-mcp-refresh-");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "data"));
  cpSync(join(REPO_ROOT, "src/mcp.ts"), join(root, "src/mcp.ts"));
  cpSync(join(REPO_ROOT, "site"), join(root, "site"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const clock = join(root, "clock.txt");
  writeFileSync(clock, String(Date.parse(initialTime)));
  writeFileSync(
    join(root, "run.ts"),
    `
    import { readFileSync } from "node:fs";
    import { runStdio } from "./src/mcp.ts";
    Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, "utf8"));
    runStdio();
  `,
  );
  const child = spawn(process.execPath, [join(root, "run.ts")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let id = 0;
  return {
    root,
    clock,
    write(file: string, key: string, generatedAt = initialTime) {
      writeFileSync(join(root, file), JSON.stringify(data(key, generatedAt)));
    },
    async request(name: string, args: Record<string, unknown> = {}) {
      if (name === "search_deadlines") args = { kind: "paper", ...args };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
      const line = await lines.next();
      if (line.done) throw new Error("MCP exited before replying");
      const reply = JSON.parse(line.value);
      expect(reply.id).toBe(id);
      expect(reply.error).toBeUndefined();
      return reply.result as Result;
    },
    close() {
      reader.close();
      child.kill();
    },
  };
}

it("reloads replaced catalog and snapshot rows on the same connection", async () => {
  const client = server();
  try {
    client.write("public/catalog.json", "Alpha");
    client.write("data/snapshot.json", "Gamma");
    for (const file of ["public/catalog.json", "data/snapshot.json"])
      utimesSync(join(client.root, file), new Date(initialTime), new Date(initialTime));
    expect(
      (await client.request("search_deadlines")).structuredContent?.rows.map((r) => r.venue_key),
    ).toEqual(["Alpha"]);
    expect(
      (await client.request("search_deadlines", { scope: "all" })).structuredContent?.rows.map(
        (r) => r.venue_key,
      ),
    ).toEqual(["Gamma"]);
    // A same-length atomic replacement can preserve its modification time.
    for (const [file, key] of [
      ["public/catalog.json", "Bravo"],
      ["data/snapshot.json", "Delta"],
    ]) {
      const pending = join(client.root, `${file}.next`);
      writeFileSync(pending, JSON.stringify(data(key)));
      utimesSync(pending, new Date(initialTime), new Date(initialTime));
      renameSync(pending, join(client.root, file));
    }
    expect(
      (await client.request("search_deadlines")).structuredContent?.rows.map((r) => r.venue_key),
    ).toEqual(["Bravo"]);
    expect(
      (await client.request("search_deadlines", { scope: "all" })).structuredContent?.rows.map(
        (r) => r.venue_key,
      ),
    ).toEqual(["Delta"]);
  } finally {
    client.close();
  }
});

it("recovers missing and invalid files after a build without restarting", async () => {
  const client = server();
  try {
    client.write("data/snapshot.json", "Saved");
    expect((await client.request("search_deadlines")).structuredContent?.rows[0].venue_key).toBe(
      "Saved",
    );
    const paper = { paper: "Distributed systems network protocols" };
    expect((await client.request("recommend_venues", paper)).content[0].text).toContain(
      "npm run build",
    );
    client.write("public/catalog.json", "Fresh");
    client.write("public/recommendation-index.json", "Fresh");
    expect((await client.request("search_deadlines")).structuredContent?.rows[0].venue_key).toBe(
      "Fresh",
    );
    expect(
      (await client.request("recommend_venues", paper)).structuredContent?.rows[0].venue_key,
    ).toBe("Fresh");
    writeFileSync(join(client.root, "public/recommendation-index.json"), "{");
    expect((await client.request("recommend_venues", paper)).content[0].text).toContain(
      "npm run build",
    );
    client.write("public/catalog.json", "Fixed");
    client.write("public/recommendation-index.json", "Fixed", "2026-10-14T00:00:00Z");
    const recovered = (await client.request("recommend_venues", paper)).structuredContent;
    expect(recovered?.rows[0].venue_key).toBe("Fixed");
    expect(recovered?.generated_at).toBe("2026-10-14T00:00:00Z");
  } finally {
    client.close();
  }
});

it("reloads recommendation candidates when the index alone is replaced", async () => {
  const client = server();
  try {
    client.write("public/recommendation-index.json", "Alpha");
    const paper = { paper: "Distributed systems network protocols" };
    expect(
      (await client.request("recommend_venues", paper)).structuredContent?.rows[0].venue_key,
    ).toBe("Alpha");
    client.write("public/recommendation-index.json", "Bravo");
    expect(
      (await client.request("recommend_venues", paper)).structuredContent?.rows[0].venue_key,
    ).toBe("Bravo");
  } finally {
    client.close();
  }
});

it("evaluates each request at its current time instead of the server startup time", async () => {
  const client = server();
  try {
    client.write("public/catalog.json", "Closing");
    const before = (await client.request("search_deadlines")).structuredContent;
    expect(before?.total).toBe(1);
    expect(before?.evaluated_at).toBe("2026-10-13T00:00:00.000Z");
    writeFileSync(client.clock, String(Date.parse("2026-10-15T00:00:00Z")));
    const after = (await client.request("search_deadlines")).structuredContent;
    expect(after?.evaluated_at).toBe("2026-10-15T00:00:00.000Z");
    expect(after?.total).toBe(0);
  } finally {
    client.close();
  }
});

it("falls back for malformed catalog structures, preserves valid empty windows and recovers on the same connection", async () => {
  const client = server();
  try {
    client.write("data/snapshot.json", "Saved");
    client.write("public/catalog.json", "Initial");
    expect((await client.request("search_deadlines")).structuredContent).toMatchObject({
      total: 1,
      scope: "screen",
      catalog_fallback: false,
      rows: [{ venue_key: "Initial" }],
    });
    for (const malformed of [
      {},
      [],
      "broken",
      { conferences: null },
      { conferences: {} },
      { conferences: "wrong" },
      { conferences: [null] },
      { conferences: ["broken"] },
      { conferences: [[]] },
      { conferences: [data("Initial").conferences[0], null] },
    ]) {
      writeFileSync(join(client.root, "public/catalog.json"), JSON.stringify(malformed));
      const result = await client.request("search_deadlines");
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("有効な会議一覧を読み取れない");
      expect(result.content[0].text).not.toContain("この手元にない");
      expect(result.structuredContent, JSON.stringify(malformed)).toMatchObject({
        total: 1,
        scope: "all",
        catalog_fallback: true,
        generated_at: initialTime,
        rows: [{ venue_key: "Saved" }],
      });
    }
    for (const conferences of [[], [{ key: "metadata-only", title: "Metadata Only" }]]) {
      writeFileSync(
        join(client.root, "public/catalog.json"),
        JSON.stringify({ generated_at: initialTime, conferences }),
      );
      const empty = await client.request("search_deadlines");
      expect(empty.content[0].text).not.toContain("有効な会議一覧を読み取れない");
      expect(empty.structuredContent).toMatchObject({
        total: 0,
        scope: "screen",
        catalog_fallback: false,
        rows: [],
      });
    }
    client.write("public/catalog.json", "Repaired", "2026-10-14T00:00:00Z");
    const repaired = await client.request("search_deadlines");
    expect(repaired.structuredContent).toMatchObject({
      total: 1,
      scope: "screen",
      catalog_fallback: false,
      generated_at: "2026-10-14T00:00:00Z",
      rows: [{ venue_key: "Repaired" }],
    });
  } finally {
    client.close();
  }
});

it("reports absent deadline dates without losing conference counts and refreshes the range on one connection", async () => {
  const client = server();
  const stats = async () => (await client.request("collection_stats")).content[0].text;
  try {
    writeFileSync(join(client.root, "data/snapshot.json"), JSON.stringify({ conferences: [] }));
    const empty = await stats();
    expect(empty).toContain("会議 0 件 / 版 0 件");
    expect(empty).toContain("締切の行 0 行（締切の日付は未収録）");
    expect(empty).not.toMatch(/undefined|NaN|Invalid Date/);

    const eventOnly = data("EventOnly");
    eventOnly.conferences[0].editions[0].deadlines = [];
    writeFileSync(join(client.root, "data/snapshot.json"), JSON.stringify(eventOnly));
    const event = await stats();
    expect(event).toContain("会議 1 件 / 版 1 件");
    expect(event).toContain("締切の行 0 行（締切の日付は未収録）");

    const withDeadlines = data("Dated");
    withDeadlines.conferences[0].editions[0].deadlines.push({
      kind: "paper",
      precision: "exact",
      utc: "2026-11-23T00:00:00Z",
      tz_raw: "UTC",
    });
    writeFileSync(join(client.root, "data/snapshot.json"), JSON.stringify(withDeadlines));
    const dated = await stats();
    expect(dated).toContain("会議 1 件 / 版 1 件");
    expect(dated).toContain("締切の行 2 行（日付の幅 2026-10-14 〜 2026-11-23）");
    expect(dated).not.toContain("締切の日付は未収録");

    writeFileSync(join(client.root, "data/snapshot.json"), JSON.stringify(eventOnly));
    expect(await stats()).toContain("締切の行 0 行（締切の日付は未収録）");
  } finally {
    client.close();
  }
});

it("describes the event scope independently of deadline scope and follows the requested upcoming period", async () => {
  const client = server();
  try {
    const input = data("Full");
    Object.assign(input.conferences[0].editions[0], {
      event_start: "2026-10-14",
      event_end: "2026-10-14",
      event_date_precision: "single-day",
    });
    const later = data("Later").conferences[0];
    Object.assign(later.editions[0], {
      event_start: "2026-11-10",
      event_end: "2026-11-10",
      event_date_precision: "single-day",
      deadlines: [],
    });
    input.conferences.push(later);
    writeFileSync(join(client.root, "data/snapshot.json"), JSON.stringify(input));
    writeFileSync(join(client.root, "public/catalog.json"), JSON.stringify({ conferences: [] }));
    for (const scope of ["screen", "all"]) {
      for (const days of [2, 40]) {
        const result = await client.request("list_upcoming", { scope, days });
        expect(result.structuredContent).toMatchObject({
          scope,
          event_scope: "all",
          days,
          deadline_total: scope === "all" ? 1 : 0,
          event_total: days === 2 ? 1 : 2,
          items: expect.arrayContaining([
            expect.objectContaining({ type: "event", venue_key: "Full" }),
          ]),
        });
        const text = result.content[0].text;
        expect(text).toContain("会期は収録全体から指定期間に重なる開催を表示します");
        expect(text).toContain("upcoming.md の対象期間とは異なる場合があります");
        expect(text).toContain("購読カレンダー deadlines.ics は締切のみです");
        expect(text).not.toMatch(/同じ窓|画面の一覧とカレンダーには出ない/);
      }
    }
  } finally {
    client.close();
  }
});
