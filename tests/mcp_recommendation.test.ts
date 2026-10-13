import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const now = "2026-10-13T00:00:00Z";
interface Venue {
  key: string;
  title: string;
  full_name?: string;
  categories: string[];
  tags?: string[];
  scope?: string;
  editions: unknown[];
}
function venue(
  key: string,
  title: string,
  scope: string,
  categories = ["systems"],
  date = "2027-01-01T00:00:00Z",
): Venue {
  return {
    key,
    title,
    full_name: title,
    scope,
    categories,
    editions: [
      {
        id: `${key}-2027`,
        year: 2027,
        link: `https://example.org/${key}`,
        deadlines: [
          {
            kind: "paper",
            precision: "exact",
            utc: date,
            tz_raw: "UTC",
            verification: { status: "confirmed" },
          },
        ],
      },
    ],
  };
}
function sandbox(conferences: Venue[]) {
  const root = tempWork("kamiyobi-mcp-recommendation-");
  for (const dir of ["src", "public", "data"]) mkdirSync(join(root, dir), { recursive: true });
  cpSync(join(REPO_ROOT, "src/mcp.ts"), join(root, "src/mcp.ts"));
  cpSync(join(REPO_ROOT, "site"), join(root, "site"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const data = {
    conferences,
    categories: { systems: "Systems", ai: "AI", db: "Databases" },
    generated_at: now,
    snapshot_metadata: { generated_at: now },
  };
  for (const file of [
    "public/catalog.json",
    "public/recommendation-index.json",
    "data/snapshot.json",
  ])
    writeFileSync(join(root, file), JSON.stringify(data));
  writeFileSync(
    join(root, "run.ts"),
    `import { runStdio } from "./src/mcp.ts"; runStdio(Date.parse(${JSON.stringify(now)}));`,
  );
  return root;
}
interface Reply {
  result?: {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: {
      total: number;
      offset: number;
      limit: number;
      returned: number;
      next_offset: number | null;
      evaluated_at: string;
      generated_at: string;
      uses_embeddings: boolean;
      uses_reranker: boolean;
      input: { received: number; used: number; truncated: boolean };
      rows: Array<{
        rank: number;
        venue_key: string;
        fit: { score: number; confidence: string };
        availability: { status: string };
        deadline: Record<string, unknown> | null;
        axes: Record<string, unknown>;
      }>;
    };
  };
}
function call(root: string, args: Record<string, unknown>): Reply {
  const result = spawnSync(process.execPath, [join(root, "run.ts")], {
    encoding: "utf8",
    timeout: 20000,
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recommend_venues", arguments: args },
    })}\n`,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Reply;
}
const input = [
  venue("gpu-programming", "GPU programming", "gpu parallel programming"),
  venue("gpu-memory", "GPU memory", "gpu memory management"),
  venue("gpu-kernels", "GPU kernels", "gpu kernel optimization"),
];

describe("MCP recommendation results with independent raw fixtures", () => {
  it("paginates ranked candidates without repeats and retains absolute rank", () => {
    const root = sandbox(input);
    const paper = "GPU programming memory kernels";
    const pages = [0, 1, 2, 3].map(
      (offset) => call(root, { paper, limit: 1, offset }).result?.structuredContent,
    );
    for (const [index, page] of pages.entries()) {
      expect(page?.total).toBe(3);
      expect(page?.offset).toBe(index);
      expect(page?.evaluated_at).toBe(new Date(now).toISOString());
      expect(page?.generated_at).toBe(now);
      expect(page?.uses_embeddings).toBe(false);
      expect(page?.uses_reranker).toBe(false);
      expect(page?.next_offset).toBe(index < 2 ? index + 1 : null);
      expect(page?.rows.map((r) => r.rank)).toEqual(index < 3 ? [index + 1] : []);
    }
    expect(
      pages
        .slice(0, 3)
        .flatMap((page) => page?.rows.map((row) => row.venue_key))
        .sort(),
    ).toEqual(["gpu-kernels", "gpu-memory", "gpu-programming"]);
  });

  it("shares the browser fallback: rejects category-only matches and respects a named venue", () => {
    const root = sandbox([
      venue("ipsj-sigdbs", "情報処理学会 データベースシステム研究会 (DBS)", "", ["db"]),
    ]);
    const unrelated = call(root, { paper: "unrelated db request" }).result?.structuredContent;
    expect(unrelated?.total).toBe(0);
    expect(unrelated?.rows).toEqual([]);
    const named = call(root, { paper: "データベースの解析 ipsj-sigdbs" }).result?.structuredContent;
    expect(named?.rows.map((row) => row.venue_key)).toEqual(["ipsj-sigdbs"]);
  });

  it("keeps an explicitly named venue ahead of other matching candidates", () => {
    const root = sandbox(input);
    const result = call(root, { paper: "GPU programming memory kernels gpu-memory", limit: 1 });
    expect(result.result?.structuredContent?.rows.map((row) => row.venue_key)).toEqual([
      "gpu-memory",
    ]);
  });

  it("uses recommendation-index provenance when the screen catalog and snapshot are absent", () => {
    const root = sandbox(input);
    rmSync(join(root, "public/catalog.json"));
    rmSync(join(root, "data/snapshot.json"));
    const result = call(root, { paper: "GPU programming" }).result;
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.generated_at).toBe(now);
    expect(result?.structuredContent?.rows.length).toBeGreaterThan(0);
  });

  it("rejects cached maturity labels and reports actual recorded counts", () => {
    const root = sandbox([input[0]]);
    const path = join(root, "public/catalog.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.conferences[0].recommendation_axes = {
      venue_maturity: { status: "established", evidence: { yearsObserved: 99 } },
    };
    writeFileSync(path, JSON.stringify(data));
    const result = call(root, { paper: "GPU programming" }).result;
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.rows[0].axes).toMatchObject({
      venue_evidence: { yearsObserved: 1, profileCoverage: 0 },
    });
    expect(result?.structuredContent?.rows[0].axes).not.toHaveProperty("venue_maturity");
    expect(result?.content[0].text).toContain("収録データ: 開催年 1年分 ／ 論文サンプル 0件");
    expect(result?.content[0].text).not.toMatch(/会議の続いている年数|確立|成長中|新規/);
  });

  it("retains published full-catalog coverage while assigning the current paper's fit score", () => {
    const root = sandbox([input[0]]);
    const path = join(root, "public/catalog.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.conferences[0].recommendation_axes = {
      research_fit: { score: null, categories: ["systems"], tags: [] },
      venue_evidence: {
        yearsObserved: 4,
        profileCoverage: 2,
        dblpLinked: true,
        publisherSource: false,
        rankListed: true,
      },
      deadline_precision: "exact",
      evidence_quality: "none",
      deadline_trust: {
        date: "unverified",
        time: "unverified",
        timezone: "unverified",
        kind: "unverified",
        sourceFreshness: "snapshot-fallback",
        conflicts: 0,
      },
    };
    writeFileSync(path, JSON.stringify(data));
    const response = call(root, { paper: "GPU programming" }).result;
    const result = response?.structuredContent;
    expect(result?.rows[0].axes).toMatchObject({
      venue_evidence: { yearsObserved: 4, profileCoverage: 2 },
      research_fit: { score: result?.rows[0].fit.score },
    });
    expect(response?.content[0].text).toContain("収録データ: 開催年 4年分 ／ 論文サンプル 2件");
  });

  it("preserves abstract-only input, date-only uncertainty and a deadline-free journal", () => {
    const dated = venue("gpu-date", "GPU scheduling", "gpu scheduling");
    (dated.editions[0] as { deadlines: unknown[] }).deadlines = [
      {
        kind: "paper",
        precision: "date-only",
        local_date: "2027-01-02",
        tz_raw: "UTC",
        earliest_utc: "2027-01-02T00:00:00Z",
        latest_utc: "2027-01-02T23:59:59Z",
      },
    ];
    const journal: Venue = {
      key: "gpu-journal",
      title: "GPU Journal",
      scope: "gpu scheduling",
      categories: ["systems"],
      tags: ["journal"],
      editions: [],
    };
    const root = sandbox([dated, journal]);
    const result = call(root, {
      paper: JSON.stringify([{ abstract: "GPU scheduling and parallel\nGPU kernels" }]),
    }).result;
    expect(result?.isError).not.toBe(true);
    const structured = result?.structuredContent;
    expect(structured?.input).toEqual({ received: 1, used: 1, truncated: false });
    expect(result?.content[0].text).toContain("GPU scheduling and parallel GPU kernels");
    expect(result?.content[0].text.startsWith("「GPU scheduling and parallel GPU kernels」")).toBe(
      true,
    );
    const dateRow = structured?.rows.find((row) => row.venue_key === "gpu-date");
    expect(dateRow?.deadline).toMatchObject({
      precision: "date-only",
      utc: null,
      jst: null,
      local_date: "2027-01-02",
    });
    expect(structured?.rows.find((row) => row.venue_key === "gpu-journal")).toMatchObject({
      availability: { status: "ongoing", timestamp: null },
      deadline: null,
    });
    const journalLine = result?.content[0].text
      .split("\n")
      .find((line) => line.includes("GPU Journal"));
    expect(journalLine).toContain("常時受付（締切なし）");
    expect(journalLine).not.toContain("2026-10-13");
    expect(journalLine).not.toContain("残り0日");
  });

  it("reports a passed submission deadline as a reference rather than open", () => {
    const root = sandbox([
      venue("gpu-past", "GPU programming", "gpu programming", ["systems"], "2026-01-01T00:00:00Z"),
    ]);
    expect(
      call(root, { paper: "GPU programming" }).result?.structuredContent?.rows[0],
    ).toMatchObject({
      availability: { status: "past" },
      deadline: { utc: "2026-01-01T00:00:00Z" },
    });
  });

  it.each([-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("rejects invalid offsets: %s", (offset) => {
    const root = sandbox(input);
    const result = call(root, { paper: "GPU programming", offset }).result;
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("offset は 0 以上の整数");
  });

  it("enforces the documented 30-result limit and exposes the next page", () => {
    const root = sandbox(
      Array.from({ length: 32 }, (_, i) => venue(`gpu-${i}`, `GPU topic ${i}`, `gpu topic ${i}`)),
    );
    const result = call(root, { paper: "GPU topic", limit: 999.9 }).result;
    expect(result?.structuredContent).toMatchObject({
      total: 32,
      returned: 30,
      limit: 30,
      next_offset: 30,
    });
    expect(result?.content[0].text).toContain("上限 30 を超えた");
  });
});
