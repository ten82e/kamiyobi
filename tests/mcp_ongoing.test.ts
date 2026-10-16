import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const repo = join(import.meta.dirname, "..");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-mcp-ongoing-"));
  roots.push(root);
  for (const dir of ["src", "site", "scripts"])
    cpSync(join(repo, dir), join(root, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(root, file));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "data"));
  writeFileSync(
    join(root, "run.ts"),
    'import {runStdio} from "./src/mcp.ts";globalThis.fetch=async()=>{throw new Error("network forbidden")};runStdio(Date.parse(process.argv[2]));',
  );
  return root;
}
interface Deadline {
  venue_key: string;
  kind: string;
  kind_label: string;
  full_name: string;
  edition_id: string;
  year: number | null;
  round: number | null;
  precision: string | null;
  utc: string | null;
  jst: string | null;
  local_date: string | null;
  timezone: string | null;
  event_start: string | null;
  event_end: string | null;
  display: string;
  official_url: string;
}
interface Page {
  total: number;
  returned: number;
  offset: number;
  next_offset: number | null;
  scope: string;
  generated_at: string;
  catalog_fallback: boolean;
  catalog_error?: { code: string };
  rows: Deadline[];
}
function client(root: string, now = "2030-01-01T00:00:00Z") {
  const child = spawn(process.execPath, ["run.ts", now], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const replies = reader[Symbol.asyncIterator]();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    async call(name: string, args: Record<string, unknown>) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
      const reply = await replies.next();
      expect(reply.done, stderr).toBe(false);
      const message = JSON.parse(reply.value!);
      expect(message.id).toBe(id);
      expect(message.error).toBeUndefined();
      expect(message.result.isError, JSON.stringify(message.result)).not.toBe(true);
      return message.result as { structuredContent: Page; content: Array<{ text: string }> };
    },
    close() {
      reader.close();
      child.kill();
    },
  };
}
function venue(key: string, title: string, options: Record<string, unknown> = {}) {
  return {
    key,
    title,
    full_name: `分散システム ${title}`,
    link: `https://${key}.example.org/`,
    categories: ["systems"],
    rank: {},
    tags: [],
    editions: [],
    ...options,
  };
}
function dated(key: string, date: string, extra: Record<string, unknown> = {}) {
  return venue(key, `Delta Distributed ${key}`, {
    editions: [
      {
        id: `${key}-2030`,
        year: 2030,
        place: "Tokyo, Japan",
        estimated: false,
        deadlines: [{ kind: "paper", utc: date, tz_raw: "UTC" }],
      },
    ],
    ...extra,
  });
}
const screenAt = "2030-01-01T00:00:00Z";
const allAt = "2029-12-31T00:00:00Z";
const alpha = venue("alpha", "Alpha Distributed Journal", {
  tags: ["journal"],
  rank: { core: "A" },
});
const beta = venue("beta", "Beta 分散システム論文誌", {
  tags: ["journal", "domestic-jp"],
  rank: { core: "B" },
});
const gamma = venue("gamma", "Gamma Distributed Journal", {
  tags: ["journal"],
  rank: { core: "C" },
});
const screen = [
  dated("conference", "2030-01-03T00:00:00Z"),
  alpha,
  beta,
  dated("special-issue", "2030-01-04T00:00:00Z", { tags: ["journal"] }),
  dated("closed-issue", "2029-12-20T00:00:00Z", { tags: ["journal"] }),
  venue("empty-conference", "Distributed Conference"),
];
const all = screen
  .map((conf) =>
    conf.key === "alpha" ? { ...conf, full_name: "Archive 分散システム Alpha" } : conf,
  )
  .concat(gamma);
const root = sandbox();
mkdirSync(join(root, "public"));
const catalogText = JSON.stringify({ generated_at: screenAt, conferences: screen });
const snapshotText = JSON.stringify({
  snapshot_metadata: { generated_at: allAt },
  conferences: all,
});
writeFileSync(join(root, "public/catalog.json"), catalogText);
writeFileSync(join(root, "data/snapshot.json"), snapshotText);
const keys = (page: Page) => page.rows.map((row) => row.venue_key);

function assertNoDeadline(row: Deadline) {
  expect(row).toMatchObject({
    kind: "journal",
    kind_label: "常時受付",
    edition_id: row.venue_key,
    year: null,
    round: null,
    precision: null,
    utc: null,
    jst: null,
    local_date: null,
    timezone: null,
    event_start: null,
    event_end: null,
  });
  expect(row.display).toContain("常時受付");
  expect(row.display).toContain("会期 該当なし");
  expect(JSON.stringify(row)).not.toContain("2030-01-01");
  expect(row.official_url).toBe(`https://${row.venue_key}.example.org/`);
}

it("returns ongoing submissions through real stdio without inventing deadline metadata", async () => {
  const c = client(root);
  try {
    for (const [query, kind] of [
      ["journal", "journal"],
      ["常時受付", "常時受付"],
      ["", "journal"],
    ]) {
      const result = await c.call("search_deadlines", { query, kind, scope: "screen" });
      const page = result.structuredContent;
      expect(page).toMatchObject({
        total: 2,
        returned: 2,
        scope: "screen",
        catalog_fallback: false,
        generated_at: screenAt,
      });
      expect(keys(page)).toEqual(["alpha", "beta"]);
      page.rows.forEach(assertNoDeadline);
    }
    const regular = (
      await c.call("search_deadlines", { query: "", kind: "paper", scope: "screen" })
    ).structuredContent;
    expect(keys(regular)).toEqual(["conference", "special-issue"]);
    expect(regular.rows[0]).toMatchObject({
      round: 1,
      precision: "exact",
      utc: "2030-01-03T00:00:00Z",
    });
    const upcoming = (await c.call("list_upcoming", { days: 7, scope: "screen" }))
      .structuredContent as unknown as { items: Array<{ type: string; venue_key: string }> };
    expect(upcoming.items.map((item) => [item.type, item.venue_key])).toEqual([
      ["deadline", "conference"],
      ["deadline", "special-issue"],
    ]);
    const stats = await c.call("collection_stats", {});
    expect(stats.content.map((item) => item.text).join("\n")).toContain("締切の行 3 行");
  } finally {
    c.close();
  }
  expect(readFileSync(join(root, "public/catalog.json"), "utf8")).toBe(catalogText);
  expect(readFileSync(join(root, "data/snapshot.json"), "utf8")).toBe(snapshotText);
  expect(existsSync(join(root, ".cache"))).toBe(false);
});

it("keeps dated submissions before journals and pages without duplication on the same connection", async () => {
  const c = client(root);
  try {
    const collected: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Page = (
        await c.call("search_deadlines", {
          query: "分散システム",
          scope: "screen",
          limit: 1,
          offset,
        })
      ).structuredContent;
      expect(page.total).toBe(4);
      expect(page.offset).toBe(offset);
      expect(page.returned).toBe(1);
      collected.push(...keys(page));
      offset = page.next_offset;
      expect(collected.length).toBeLessThanOrEqual(4);
    }
    expect(collected).toEqual(["conference", "special-issue", "alpha", "beta"]);
    for (const kinds of [[], ["all"], ["paper", "journal"]]) {
      const page = (await c.call("search_deadlines", { query: "", kinds, scope: "screen" }))
        .structuredContent;
      expect(keys(page)).toEqual(collected);
    }
    const withPast = (
      await c.call("search_deadlines", {
        query: "分散システム",
        include_past: true,
        scope: "screen",
      })
    ).structuredContent;
    expect(keys(withPast)).toEqual(["closed-issue", ...collected]);
  } finally {
    c.close();
  }
});

it("applies rank, domestic and participation filters without assuming a journal has a venue", async () => {
  const c = client(root);
  try {
    for (const [extra, expected] of [
      [{ rank: "A" }, ["alpha"]],
      [{ domestic: true }, ["beta"]],
      [{ online: true }, []],
      [{ within_days: 1 }, []],
      [{ kinds: ["paper"] }, ["conference", "special-issue"]],
    ] as const) {
      const response = await c.call("search_deadlines", {
        query: "",
        kind: "journal",
        scope: "screen",
        ...extra,
      });
      const page = response.structuredContent;
      expect(keys(page), JSON.stringify(extra)).toEqual(expected);
      if ("within_days" in extra) {
        expect(response.content.map((item) => item.text).join("\n")).toContain(
          "within_days を省いてください",
        );
        const retry = (await c.call("search_deadlines", { kind: "journal", scope: "screen" }))
          .structuredContent;
        expect(keys(retry)).toEqual(["alpha", "beta"]);
      }
    }
  } finally {
    c.close();
  }
});

it("uses the selected collection for journals and explains a journal outside the screen catalog", async () => {
  const c = client(root);
  try {
    const screenPage = (await c.call("search_deadlines", { query: "Alpha", scope: "screen" }))
      .structuredContent;
    expect(screenPage.rows[0].full_name).toBe(alpha.full_name);
    const allPage = (await c.call("search_deadlines", { query: "", kind: "journal", scope: "all" }))
      .structuredContent;
    expect(keys(allPage)).toEqual(["alpha", "beta", "gamma"]);
    expect(allPage.generated_at).toBe(allAt);
    expect(allPage.rows[0].full_name).toBe("Archive 分散システム Alpha");
    const outside = await c.call("search_deadlines", { query: "Gamma", scope: "screen" });
    expect(outside.structuredContent.total).toBe(0);
    expect(outside.content.map((item) => item.text).join("\n")).toContain(
      "収録の全体には 1 行あります",
    );
    const explanation = await c.call("explain_word", { word: "Alpha", scope: "screen" });
    expect(explanation.content.map((item) => item.text).join("\n")).toMatch(/素の照合で 1 行/);
    expect(explanation.content.map((item) => item.text).join("\n")).toContain("常時受付");
    const unknownScope = await c.call("explain_word", { word: "Gamma", scope: "nosuch" });
    expect(unknownScope.content.map((item) => item.text).join("\n")).toContain(
      "知らない scope「nosuch」",
    );
  } finally {
    c.close();
  }
});

it("keeps ongoing submissions outside the UI's finite deadline windows without hiding them from an unrestricted view", () => {
  const app = siteRuntime();
  const after = new Function(
    `${jsFunction(app, "rowShownDayMs")}\n${jsFunction(app, "rowAfter")}\nreturn rowAfter;`,
  )();
  const now = Date.parse(screenAt);
  const journal = Recommender.journalRows([alpha], now)[0];
  expect(journal).toBeDefined();
  for (const days of [1, 7, 30]) {
    expect(after(journal, now + days * 86400000)).toBe(true);
    expect(after({ ...journal, kind: "paper", t: now, tShown: now }, now + days * 86400000)).toBe(
      false,
    );
  }
  expect(after(journal, Infinity)).toBe(false);
  expect(
    after({ ...journal, kind: "paper", t: now + 86400000, tShown: now + 86400000 }, now + 86400000),
  ).toBe(true);
});

it("does not turn ongoing acceptance into a past deadline as the clock advances", () => {
  const now = Date.parse(screenAt);
  const journal = Recommender.journalRows([alpha], now)[0];
  for (const elapsed of [1, 86400000, 366 * 86400000]) {
    expect(Recommender.deadlineRowIsPast(journal, now + elapsed)).toBe(false);
    expect(Recommender.deadlineRowIsPast({ ...journal, kind: "paper" }, now + elapsed)).toBe(true);
  }
});

it("falls back to collection journals for a missing catalog without treating an empty catalog as missing", async () => {
  rmSync(join(root, "public/catalog.json"));
  let c = client(root);
  try {
    const fallback = (await c.call("search_deadlines", { query: "", kind: "journal" }))
      .structuredContent;
    expect(keys(fallback)).toEqual(["alpha", "beta", "gamma"]);
    expect(fallback).toMatchObject({
      scope: "all",
      catalog_fallback: true,
      generated_at: allAt,
      catalog_error: { code: "CATALOG_NOT_READY" },
    });
  } finally {
    c.close();
    writeFileSync(join(root, "public/catalog.json"), catalogText);
  }
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({ generated_at: screenAt, conferences: [] }),
  );
  c = client(root);
  try {
    const empty = (await c.call("search_deadlines", { query: "", kind: "journal" }))
      .structuredContent;
    expect(empty).toMatchObject({ total: 0, scope: "screen", catalog_fallback: false, rows: [] });
  } finally {
    c.close();
    writeFileSync(join(root, "public/catalog.json"), catalogText);
  }
});

it("does not read the history snapshot when the selected catalog supplies the journals", async () => {
  rmSync(join(root, "data/snapshot.json"));
  const c = client(root);
  try {
    const page = (await c.call("search_deadlines", { query: "", kind: "journal", scope: "screen" }))
      .structuredContent;
    expect(keys(page)).toEqual(["alpha", "beta"]);
  } finally {
    c.close();
    writeFileSync(join(root, "data/snapshot.json"), snapshotText);
  }
});

it("finds the complete ongoing collection in English and Japanese from fresh raw inputs", async () => {
  const full = sandbox();
  expect(existsSync(join(full, "public"))).toBe(false);
  expect(existsSync(join(full, "data/snapshot.json"))).toBe(false);
  writeFileSync(
    join(full, "build.mjs"),
    `
import fs from "node:fs";
import {load} from "js-yaml";
import {freshFullVenuePool} from ${JSON.stringify(join(repo, "tests/full_venue_pool.ts"))};
import {setRoot,buildAll} from "./src/build.ts";
const pool=freshFullVenuePool();
if(pool.conferences.length!==696)throw new Error("full venue pool changed");
setRoot(import.meta.dirname);
globalThis.fetch=async()=>{throw new Error("network forbidden")};
const config=load(fs.readFileSync(${JSON.stringify(join(repo, "config.yaml"))},"utf8"));
await buildAll(pool.conferences,config,"public",new Date("2026-10-16T00:00:00Z"),{noEmbeddings:true,localEmbeddingsOnly:true,venuePapers:{},reranker:null});
const published=JSON.parse(fs.readFileSync("public/data.json","utf8"));
if(published.conferences.find(c=>c.key==="jip").editions.flatMap(e=>e.deadlines).length!==1)throw new Error("dated journal submission lost");
fs.writeFileSync("data/snapshot.json",JSON.stringify({...published,snapshot_metadata:{generated_at:published.generated_at}}));
fs.rmSync(pool.raw,{recursive:true,force:true});
`,
  );
  const built = spawnSync(process.execPath, ["build.mjs"], {
    cwd: full,
    encoding: "utf8",
    timeout: 60000,
  });
  expect(built.error).toBeUndefined();
  expect(built.status, built.stderr).toBe(0);
  const expected = [
    "acm-toit",
    "ccpe",
    "computer-networks",
    "fgcs",
    "ieee-access",
    "ieee-micro",
    "ieee-tnsm",
    "ieice-comex",
    "ieice-elex",
    "ieice-trans-com",
    "ieice-trans-electron",
    "ieice-trans-funda",
    "ieice-trans-inf",
    "internet-of-things",
    "jpdc",
    "jss",
    "tc",
    "tdsc",
    "tmc",
    "ton",
    "tos",
    "tpds",
  ].sort();
  const c = client(full, "2026-10-16T00:00:00Z");
  try {
    for (const scope of ["screen", "all"]) {
      for (const query of ["journal", "常時受付"]) {
        const page = (
          await c.call("search_deadlines", { query, scope, kind: "journal", limit: 100 })
        ).structuredContent;
        expect(keys(page).sort(), `${scope}: ${query}`).toEqual(expected);
        expect(page.total, `${scope}: ${query}`).toBe(22);
        expect(page.generated_at).toBe("2026-10-16T00:00:00Z");
        for (const row of page.rows) {
          expect(row).toMatchObject({
            kind: "journal",
            precision: null,
            utc: null,
            jst: null,
            round: null,
          });
        }
      }
      const broad = (await c.call("search_deadlines", { query: "journal", scope, limit: 100 }))
        .structuredContent;
      expect(broad.total, scope).toBe(23);
      expect(keys(broad).sort(), scope).toEqual([...expected, "jip"].sort());
      expect(
        broad.rows.find((row) => row.venue_key === "jip"),
        scope,
      ).toMatchObject({
        kind: "paper",
        precision: "date-only",
        local_date: "2026-12-01",
        utc: null,
        jst: null,
      });
    }
  } finally {
    c.close();
  }
  expect(existsSync(join(full, ".cache"))).toBe(false);
  expect(existsSync(join(full, "public/embeddings.json"))).toBe(false);
});
