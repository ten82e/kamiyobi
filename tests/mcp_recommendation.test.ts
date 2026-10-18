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
  link?: string;
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
      candidate_venues: number;
      ignored_filters: string[];
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
        official_url: string | null;
        fit: { score: number; confidence: string };
        availability: { status: string };
        deadline: Record<string, unknown> | null;
        axes: Record<string, unknown>;
      }>;
    };
  };
}
function callSequence(root: string, argumentsList: unknown[], tool = "recommend_venues"): Reply[] {
  const result = spawnSync(process.execPath, [join(root, "run.ts")], {
    encoding: "utf8",
    timeout: 20000,
    input: `${argumentsList
      .map((args, i) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: i + 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      )
      .join("\n")}\n`,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Reply);
}
function call(root: string, args: Record<string, unknown>): Reply {
  return callSequence(root, [args])[0];
}
const input = [
  venue("gpu-programming", "GPU programming", "gpu parallel programming"),
  venue("gpu-memory", "GPU memory", "gpu memory management"),
  venue("gpu-kernels", "GPU kernels", "gpu kernel optimization"),
];

it.each(
  ["search_venues", "recommend_venues"].flatMap((tool) =>
    ["GPU parallel programming", "GPUの並列プログラミング"].map((text) => ({ tool, text })),
  ),
)("reports ignored category filters for $tool ($text)", ({ tool, text }) => {
  const root = sandbox([
    venue("gpu-systems", "GPU parallel programming systems", "gpu parallel programming"),
    venue("gpu-db", "GPU parallel programming databases", "gpu parallel programming", ["db"]),
  ]);
  try {
    const args = { [tool === "search_venues" ? "query" : "paper"]: text, limit: 5 };
    const filters = [
      { category: "db" },
      { categories: ["db"] },
      { category: "systems", categories: ["db"] },
    ];
    const replies = callSequence(
      root,
      [args, ...filters.map((filter) => ({ ...args, ...filter }))],
      tool,
    );
    const baseline = replies[0].result!;
    expect(baseline.isError).not.toBe(true);
    expect(baseline.structuredContent!.candidate_venues).toBe(2);
    expect(baseline.structuredContent!.total).toBe(2);
    expect(baseline.structuredContent!.ignored_filters).toEqual([]);
    for (const [index, filter] of filters.entries()) {
      const result = replies[index + 1].result!;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent!.ignored_filters).toEqual(Object.keys(filter));
      expect(result.structuredContent!.candidate_venues).toBe(2);
      expect(result.structuredContent!.rows).toEqual(baseline.structuredContent!.rows);
      expect(result.content.map((block) => block.text).join("\n")).toContain(
        `無視した絞り込み ${Object.keys(filter).join("・")}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP recommendation results with independent raw fixtures", () => {
  it("reports missing retrieval history even when cached axes claim fresh", () => {
    const item = venue("gpu", "GPU", "gpu parallel programming");
    const root = sandbox([item]);
    try {
      const result = call(root, { paper: "gpu parallel programming", limit: 1 }).result!;
      expect(result.structuredContent!.rows).toHaveLength(1);
      expect(result.structuredContent!.rows[0].axes.deadline_trust).toMatchObject({
        sourceFreshness: "unknown",
      });
      expect(result.content.map((c) => c.text).join("\n")).toContain("取得状態: 取得履歴なし");
      const catalogPath = join(root, "public/catalog.json");
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      catalog.conferences[0].recommendation_axes = result.structuredContent!.rows[0].axes;
      catalog.conferences[0].recommendation_axes.deadline_trust.sourceFreshness = "fresh";
      writeFileSync(catalogPath, JSON.stringify(catalog));
      const cached = call(root, { paper: "gpu parallel programming", limit: 1 }).result!;
      expect(cached.structuredContent!.rows[0].axes.deadline_trust).toMatchObject({
        sourceFreshness: "unknown",
      });
      expect(cached.content.map((c) => c.text).join("\n")).toContain("取得状態: 取得履歴なし");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["fresh", "cache-fallback", "snapshot-fallback"])(
    "preserves explicit %s retrieval status and reports conflicts",
    (status) => {
      const item = venue("gpu", "GPU", "gpu parallel programming");
      const edition = item.editions[0] as { deadlines: Array<Record<string, unknown>> };
      edition.deadlines[0].origins = [{ sourceClass: "official-cfp", freshness: status }];
      edition.deadlines[0].conflicts = [{ sourceClass: "aggregator" }];
      const root = sandbox([item]);
      try {
        const result = call(root, { paper: "gpu parallel programming", limit: 1 }).result!;
        expect(result.structuredContent!.rows).toHaveLength(1);
        expect(result.structuredContent!.rows[0].axes.deadline_trust).toMatchObject({
          sourceFreshness: status,
          conflicts: 1,
        });
        const text = result.content.map((c) => c.text).join("\n");
        expect(text).toContain("締切の競合: 1 件");
        if (status === "fresh") expect(text).not.toContain("取得状態:");
        else
          expect(text).toContain(
            status === "cache-fallback"
              ? "取得状態: 前回の取得データを使用"
              : "取得状態: 保存済みの収録データを使用",
          );
        expect(text).not.toContain("今回あたって確認");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("reports each independently verified deadline field without promoting other fields", () => {
    const item = venue("gpu", "GPU", "gpu parallel programming");
    const edition = item.editions[0] as { deadlines: Array<Record<string, unknown>> };
    edition.deadlines[0].evidence = [
      { sourceClass: "official-cfp", verifiedFields: ["date"] },
      { sourceClass: "publisher", verifiedFields: ["time"] },
      { sourceClass: "curated-manual", verifiedFields: ["timezone"] },
      { sourceClass: "aggregator", verifiedFields: ["kind"] },
    ];
    edition.deadlines[0].origins = [{ sourceClass: "official-cfp", freshness: "cache-fallback" }];
    const root = sandbox([item]);
    try {
      const result = call(root, { paper: "gpu parallel programming", limit: 1 }).result!;
      expect(result.structuredContent!.rows).toHaveLength(1);
      expect(result.structuredContent!.rows[0].axes.deadline_trust).toEqual({
        date: "official",
        time: "publisher",
        timezone: "curated-manual",
        kind: "aggregator",
        sourceFreshness: "cache-fallback",
        conflicts: 0,
      });
      const text = result.content.map((c) => c.text).join("\n");
      expect(text).toContain(
        "締切の確認状況: 日付 公式確認 ／ 時刻 出版社確認 ／ タイムゾーン 手動確認 ／ 種別 集約情報",
      );
      expect(text).toContain("取得状態: 前回の取得データを使用");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const result = call(root, { paper: "GPU programming" }).result;
    expect(result?.structuredContent?.rows[0]).toMatchObject({
      availability: { status: "past" },
      deadline: { utc: "2026-01-01T00:00:00Z" },
    });
    expect(result?.content[0].text).toContain("うち 1 件は締切が過ぎた会議です");
    expect(result?.content[0].text).toContain("次回の開催に向けた参考");
  });

  it("does not count a date-only uncertain deadline as a closed venue", () => {
    const uncertain = venue("gpu-uncertain", "GPU uncertain", "GPU programming");
    uncertain.editions = [
      {
        id: "gpu-uncertain-2026",
        year: 2026,
        deadlines: [
          {
            kind: "paper",
            precision: "date-only",
            local_date: "2026-10-13",
            earliest_utc: "2026-10-12T10:00:00Z",
            latest_utc: "2026-10-14T11:59:59Z",
          },
        ],
      },
    ];
    const root = sandbox([uncertain, venue("gpu-open", "GPU open", "GPU programming")]);
    const result = call(root, { paper: "GPU programming" }).result;
    expect(result?.structuredContent?.rows).toHaveLength(2);
    expect(
      result?.structuredContent?.rows.find((row) => row.venue_key === "gpu-uncertain")?.availability
        .status,
    ).toBe("uncertain");
    expect(result?.content[0].text).not.toContain("締切が過ぎた会議です");
  });

  it("excludes an expired prediction from recommendation candidates", () => {
    const predicted = venue("gpu-predicted", "GPU predicted", "GPU programming");
    predicted.editions = [
      {
        id: "gpu-predicted-2026",
        year: 2026,
        estimated: true,
        estimate: { window_start: "2026-01-01", window_end: "2026-01-10" },
        deadlines: [
          {
            kind: "paper",
            precision: "date-only",
            local_date: "2026-01-05",
            earliest_utc: "2026-01-04T10:00:00Z",
            latest_utc: "2026-01-06T11:59:59Z",
          },
        ],
      },
    ];
    const result = call(sandbox([predicted]), { paper: "GPU programming" }).result;
    expect(result?.structuredContent?.total).toBe(1);
    expect(result?.structuredContent?.rows[0]).toMatchObject({
      availability: { status: "unknown", timestamp: null },
      deadline: null,
    });
    expect(result?.content[0].text).toContain("投稿締切未確認");
    expect(result?.content[0].text).not.toContain("締切が過ぎた会議です");
    expect(result?.content[0].text).not.toContain("2026-01-05");
  });

  it.each([-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("rejects invalid offsets: %s", (offset) => {
    const root = sandbox(input);
    const result = call(root, { paper: "GPU programming", offset }).result;
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("offset は 0 以上の整数");
  });

  it.each([null, [], "GPU programming", 42, false])(
    "rejects a non-object arguments value and permits recovery on the same connection: %j",
    (args) => {
      const [invalid, recovered] = callSequence(sandbox(input), [
        args,
        { paper: "GPU programming" },
      ]);
      expect(invalid.result?.isError).toBe(true);
      expect(invalid.result?.content[0].text).toContain("arguments はオブジェクト");
      expect(invalid.result?.structuredContent).toBeUndefined();
      expect(recovered.result?.isError).not.toBe(true);
      expect(recovered.result?.structuredContent?.rows[0].venue_key).toBe("gpu-programming");
    },
  );

  it.each([
    { paper: null, message: "paper は文字列" },
    { paper: ["GPU programming"], message: "paper[0] は title・abstract を持つ論文オブジェクト" },
    { paper: [], message: "paper に論文を1件以上" },
    { paper: true, message: "paper は文字列" },
    { paper: 99, message: "paper は文字列" },
  ])(
    "rejects unsupported paper input and accepts a corrected JSON string: $paper",
    ({ paper, message }) => {
      const [invalid, recovered] = callSequence(sandbox(input), [
        { paper },
        { paper: JSON.stringify({ title: "GPU programming" }) },
      ]);
      expect(invalid.result?.isError).toBe(true);
      expect(invalid.result?.content[0].text).toContain(message);
      expect(invalid.result?.structuredContent).toBeUndefined();
      expect(recovered.result?.isError).not.toBe(true);
      expect(recovered.result?.structuredContent?.rows[0].venue_key).toBe("gpu-programming");
    },
  );

  it.each(["recommend_venues", "search_venues"])(
    "%s accepts structured papers without losing title, abstract, keywords, venue or newlines",
    (tool) => {
      const root = sandbox(input);
      const field = tool === "recommend_venues" ? "paper" : "query";
      for (const paper of [
        { title: "GPU programming" },
        { title: "An investigation", keywords: ["GPU memory management"] },
        { title: "GPU", venue: "GPU memory" },
        { abstract: "GPU memory management and\nGPU memory allocation" },
        {
          title: "An investigation",
          abstract: "GPU kernel optimization",
          keywords: ["GPU", "kernels"],
          venue: "GPU kernels",
        },
        {
          title: 'GPU "memory" allocation',
          abstract: "memory management\nGPU scheduling",
          keywords: "memory, GPU",
        },
        {
          title: "GPUメモリ管理",
          abstract: "GPUのメモリ割り当てとカーネルの実行方式を評価する。",
          keywords: ["GPU", "memory"],
          venue: null,
        },
        { title: null, abstract: "GPU programming" },
        [{ title: "GPU programming" }, { abstract: "GPU memory management" }],
      ]) {
        const [encoded, structured] = callSequence(
          root,
          [
            { [field]: JSON.stringify(paper), limit: 30 },
            { [field]: paper, limit: 30 },
          ],
          tool,
        );
        expect(encoded.result?.isError).not.toBe(true);
        expect(encoded.result?.structuredContent?.total).toBeGreaterThan(0);
        expect(structured.result?.isError, JSON.stringify(structured)).not.toBe(true);
        expect(structured.result?.structuredContent).toEqual(encoded.result?.structuredContent);
        expect(structured.result?.content).toEqual(encoded.result?.content);
      }
    },
  );

  it.each(["recommend_venues", "search_venues"])(
    "%s rejects malformed structured papers and permits a corrected object on the same connection",
    (tool) => {
      const field = tool === "recommend_venues" ? "paper" : "query";
      for (const paper of [
        null,
        [],
        true,
        99,
        {},
        { title: " " },
        { title: {} },
        { abstract: ["GPU"] },
        { title: "GPU", keywords: ["memory", 4] },
        { title: "GPU", venue: {} },
        { title: "GPU", source: "unexpected" },
        [{ title: "GPU" }, null],
      ]) {
        const [invalid, recovered] = callSequence(
          sandbox(input),
          [{ [field]: paper }, { [field]: { title: "GPU programming" } }],
          tool,
        );
        expect(invalid.result?.isError).toBe(true);
        expect(invalid.result?.structuredContent).toBeUndefined();
        expect(invalid.result?.content[0].text).toContain(field);
        if (Array.isArray(paper) && paper.length > 0)
          expect(invalid.result?.content[0].text).toContain(`${field}[1]`);
        expect(invalid.result?.content[0].text).not.toMatch(/\[object Object\]|undefined|NaN/);
        expect(recovered.result?.isError).not.toBe(true);
        expect(recovered.result?.structuredContent?.rows[0].venue_key).toBe("gpu-programming");
      }
    },
  );

  it("applies the existing twenty-paper limit equally to structured batches and JSON strings", () => {
    const papers = [
      ...Array.from({ length: 20 }, (_, i) => ({ title: `GPU programming study ${i}` })),
      { title: "GPU memory management" },
    ];
    const [twenty, encoded, structured] = callSequence(sandbox(input), [
      { paper: papers.slice(0, 20) },
      { paper: JSON.stringify(papers) },
      { paper: papers },
    ]);
    expect(structured.result?.isError).not.toBe(true);
    expect(structured.result?.structuredContent).toEqual(encoded.result?.structuredContent);
    expect(structured.result?.structuredContent?.rows).toEqual(
      twenty.result?.structuredContent?.rows,
    );
    expect(structured.result?.content[0].text).toContain("GPU programming study 0");
    expect(structured.result?.structuredContent?.input).toEqual({
      received: 21,
      used: 20,
      truncated: true,
    });
  });

  it("advertises text, structured objects and batches for both venue tools", () => {
    const root = sandbox(input);
    const child = spawnSync(process.execPath, [join(root, "run.ts")], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      encoding: "utf8",
      timeout: 20000,
    });
    expect(child.status, child.stderr).toBe(0);
    const tools = JSON.parse(child.stdout).result.tools;
    for (const [name, field] of [
      ["recommend_venues", "paper"],
      ["search_venues", "query"],
    ]) {
      const schema = tools.find((tool: { name: string }) => tool.name === name).inputSchema
        .properties[field];
      expect(schema.anyOf.map((item: { type: string }) => item.type).sort()).toEqual([
        "array",
        "object",
        "string",
      ]);
      const object = schema.anyOf.find((item: { type: string }) => item.type === "object");
      expect(Object.keys(object.properties).sort()).toEqual([
        "abstract",
        "keywords",
        "title",
        "venue",
      ]);
      expect(object.additionalProperties).toBe(false);
      expect(object.anyOf.map((branch: { required: string[] }) => branch.required)).toEqual([
        ["title"],
        ["abstract"],
      ]);
      expect(object.anyOf[0].properties.title.pattern).toBe("\\S");
      expect(object.anyOf[1].properties.abstract.pattern).toBe("\\S");
      const batch = schema.anyOf.find((item: { type: string }) => item.type === "array");
      expect(batch.items).toEqual(object);
      expect(batch.minItems).toBe(1);
    }
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
  it("pages beyond two hundred matching venues without hiding the remaining candidates", () => {
    const conferences = Array.from({ length: 231 }, (_, i) =>
      venue(
        `gpu-study-${String(i).padStart(3, "0")}`,
        `GPU memory study ${i}`,
        "gpu memory management",
      ),
    );
    const root = sandbox(conferences);
    try {
      const replies = callSequence(root, [
        { paper: "gpu memory management", limit: 30, offset: 200 },
        { paper: "gpu memory management", limit: 30, offset: 230 },
      ]).map((reply) => reply.result!.structuredContent!);
      expect(replies[0]).toMatchObject({ total: 231, returned: 30, next_offset: 230 });
      expect(replies[0].rows.map((row) => row.rank)).toEqual(
        Array.from({ length: 30 }, (_, i) => 201 + i),
      );
      expect(replies[1]).toMatchObject({ total: 231, returned: 1, next_offset: null });
      expect(replies[1].rows[0].rank).toBe(231);
      expect(new Set(replies.flatMap((page) => page.rows.map((row) => row.venue_key))).size).toBe(
        31,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps a matching venue whose past editions were omitted from the screen catalog", () => {
    const future = venue("gpu-future", "GPU computing", "gpu memory management");
    const past = venue(
      "gpu-past",
      "GPU storage",
      "gpu memory management",
      ["systems"],
      "2025-01-01T00:00:00Z",
    );
    const root = sandbox([future, past]);
    try {
      const path = join(root, "public/catalog.json");
      const screen = JSON.parse(readFileSync(path, "utf8"));
      screen.conferences.find((conf: Venue) => conf.key === "gpu-past").editions = [];
      writeFileSync(path, JSON.stringify(screen));
      const result = call(root, { paper: "gpu memory management", limit: 30 }).result!
        .structuredContent!;
      expect(result.rows.map((row) => row.venue_key).sort()).toEqual(["gpu-future", "gpu-past"]);
      const old = result.rows.find((row) => row.venue_key === "gpu-past")!;
      expect(old.availability.status).toBe("past");
      expect(old.deadline).toMatchObject({ utc: "2025-01-01T00:00:00Z" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains an undated venue without claiming that submissions are open or closed", () => {
    const item = venue("gpu-undated", "GPU memory research", "gpu memory management");
    item.editions = [];
    const root = sandbox([item]);
    try {
      const response = call(root, { paper: "gpu memory management", limit: 30 }).result!;
      expect(response.structuredContent!.rows).toHaveLength(1);
      expect(response.structuredContent!.rows[0]).toMatchObject({
        venue_key: "gpu-undated",
        availability: { status: "unknown", timestamp: null },
        deadline: null,
      });
      expect(response.content[0].text).toContain("投稿締切未確認");
      expect(response.content[0].text).not.toMatch(/NaN|1970|残り.*日|締切が過ぎた/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("retains recommendation links independently of whether a candidate has a submission deadline", () => {
  const dated = venue("gpu-dated-url", "GPU programming dated", "gpu parallel programming");
  dated.link = "https://example.org/dated-series";
  (dated.editions[0] as { link: string }).link = " https://example.org/dated-2027 ";
  const ongoing: Venue = {
    key: "gpu-ongoing-url",
    title: "GPU programming journal",
    categories: ["systems"],
    scope: "gpu parallel programming",
    tags: ["journal"],
    editions: [],
    link: " https://example.org/journal ",
  };
  const unknown: Venue = {
    key: "gpu-unknown-url",
    title: "GPU programming unknown",
    categories: ["systems"],
    scope: "gpu parallel programming",
    editions: [],
    link: "https://example.org/unknown",
  };
  const absent: Venue = {
    ...unknown,
    key: "gpu-absent-url",
    title: "GPU programming absent",
    link: undefined,
  };
  const blank = venue("gpu-blank-url", "GPU programming blank", "gpu parallel programming");
  blank.link = "https://example.org/blank-series";
  (blank.editions[0] as { link: string }).link = " ";
  const root = sandbox([dated, ongoing, unknown, absent, blank]);
  const replies = callSequence(root, [
    { paper: "GPU parallel programming", limit: 10 },
    { paper: "GPUの並列プログラミング", limit: 10 },
  ]);
  for (const reply of replies) {
    expect(reply.result?.isError).not.toBe(true);
    const result = reply.result!;
    const data = result.structuredContent!;
    expect(data.total).toBe(5);
    const expected = [
      ["gpu-dated-url", "https://example.org/dated-2027", "open"],
      ["gpu-ongoing-url", "https://example.org/journal", "ongoing"],
      ["gpu-unknown-url", "https://example.org/unknown", "unknown"],
      ["gpu-absent-url", null, "unknown"],
      ["gpu-blank-url", "https://example.org/blank-series", "open"],
    ] as const;
    for (const [key, url, status] of expected) {
      const row = data.rows.find((row) => row.venue_key === key)!;
      expect(row, key).toBeDefined();
      expect(row.official_url, key).toBe(url);
      expect(row.availability.status, key).toBe(status);
      if (status === "unknown" || status === "ongoing") {
        expect(row.deadline, key).toBeNull();
        expect(row.availability).toMatchObject({ timestamp: null });
      } else expect(row.deadline?.official_url, key).toBe(url);
      if (url) expect(result.content[0].text, key).toContain(url);
    }
  }
});
