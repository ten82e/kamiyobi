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
