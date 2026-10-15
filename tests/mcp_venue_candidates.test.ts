import { spawn } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("returns every ambiguous venue as structured identity data and accepts its key on the same MCP connection", async () => {
  const root = tempWork("kamiyobi-mcp-candidates-");
  for (const dir of ["src", "site"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const dir of ["data", "public"]) mkdirSync(join(root, dir));
  const conferences = Array.from({ length: 31 }, (_, i) => ({
    key: `series-${i}`,
    title: `Series ${i}`,
    full_name: `システム研究会 ${i}`,
    ...(i ? { acronym: `S${i}` } : {}),
    link: `https://example.org/series/${i}`,
    legacy_keys: ["shared-old"],
    categories: ["systems"],
    rank: {},
    editions: [
      {
        id: `edition-${i}`,
        year: 2029,
        event_date_precision: "not-announced",
        place: "Tokyo, Japan",
        link: `https://example.org/edition/${i}`,
        deadlines:
          i % 2 === 0 ? [{ kind: "paper", utc: "2029-01-10T00:00:00Z", tz_raw: "UTC" }] : [],
      },
    ],
  }));
  const official = "https://www.ipsj.or.jp/journal/cfp/27-R.html";
  const sharedDeadline = (label: string) => ({
    kind: "paper",
    label,
    round: 1,
    precision: "date-only",
    local_date: "2026-12-01",
  });
  const linkedVenues = [
    {
      key: "jip",
      title: "JIP",
      categories: ["security"],
      rank: { ccf: "A" },
      tags: ["security"],
      editions: [
        {
          id: "jip-compsac2027-si",
          year: 2027,
          link: official,
          deadlines: [sharedDeadline("投稿締切")],
        },
      ],
    },
    {
      key: "ipsj-27-r-compsac",
      title: "Partner Archive",
      legacy_keys: ["old-partner"],
      categories: ["systems"],
      rank: { core: "B" },
      tags: ["storage"],
      editions: [
        {
          id: "ipsj-27-r26",
          year: 2026,
          link: official,
          deadlines: [sharedDeadline("Submission")],
        },
        {
          id: "partner28",
          year: 2028,
          link: "https://example.org/partner28",
          deadlines: [{ kind: "paper", utc: "2029-01-10T00:00:00Z", tz_raw: "UTC" }],
        },
      ],
    },
  ];
  const generatedAt = "2028-01-01T00:00:00Z";
  writeFileSync(
    join(root, "data/snapshot.json"),
    JSON.stringify({
      snapshot_metadata: { generated_at: generatedAt },
      conferences: [...conferences, ...linkedVenues],
    }),
  );
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({ generated_at: "2027-12-01T00:00:00Z", conferences: conferences.slice(0, 1) }),
  );
  writeFileSync(
    join(root, "run.ts"),
    'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2028-01-02T00:00:00Z"));',
  );
  const child = spawn(process.execPath, ["run.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let id = 0;
  async function call(args: Record<string, unknown>) {
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
  }
  try {
    for (const args of [
      { name: "Series", scope: "screen" },
      { name: "システム研究会", scope: "all" },
      { key: "ＳＨＡＲＥＤ－ＯＬＤ", scope: "screen" },
    ]) {
      const result = await call(args);
      const data = result.structuredContent;
      expect(data).toMatchObject({
        lookup_status: "ambiguous",
        matched_by: args.key ? "legacy_key" : "name",
        query: args.key || args.name,
        scope: "all",
        generated_at: generatedAt,
        candidate_count: 31,
      });
      expect(data.candidates).toEqual(
        conferences.map((conf) => ({
          venue_key: conf.key,
          title: conf.title,
          full_name: conf.full_name,
          acronym: conf.acronym ?? null,
          official_url: conf.link,
        })),
      );
      expect(data).not.toHaveProperty("venue_key");
      expect(data).not.toHaveProperty("editions");
      expect(data).not.toHaveProperty("rows");
      expect(result.content[0].text).not.toContain("開催回の会期");
      const selected = await call({
        key: data.candidates[7].venue_key,
        name: "Series",
        scope: "all",
      });
      expect(selected.structuredContent).toMatchObject({
        venue_key: "series-7",
        deadline_total: 0,
        editions: [
          {
            edition_id: "edition-7",
            year: 2029,
            place: "Tokyo, Japan",
            official_url: "https://example.org/edition/7",
          },
        ],
      });
      expect(selected.content[0].text).not.toContain("31 の会議");
    }
    for (const args of [
      { key: "ipsj-27-r-compsac" },
      { key: "old-partner" },
      { name: "Partner Archive" },
    ]) {
      const selected = await call({ ...args, scope: "all" });
      expect(selected.structuredContent).toMatchObject({
        venue_key: "ipsj-27-r-compsac",
        title: "Partner Archive",
        deadline_total: 2,
        next_submission: { edition_id: "partner28" },
      });
      expect(selected.structuredContent).not.toHaveProperty("candidates");
      expect(selected.content[0].text).toContain("会議: Partner Archive（key: ipsj-27-r-compsac");
      expect(
        selected.structuredContent.rows.map((row: { edition_id: string }) => row.edition_id).sort(),
      ).toEqual(["jip-compsac2027-si", "partner28"]);
    }
    const sharedOnly = structuredClone(linkedVenues);
    sharedOnly[1].editions.pop();
    writeFileSync(
      join(root, "data/snapshot.json"),
      JSON.stringify({
        snapshot_metadata: { generated_at: generatedAt },
        conferences: [...conferences, ...sharedOnly],
      }),
    );
    const shared = await call({ key: "ipsj-27-r-compsac", scope: "all" });
    expect(shared.structuredContent).toMatchObject({
      venue_key: "ipsj-27-r-compsac",
      title: "Partner Archive",
      deadline_total: 1,
      next_submission: null,
      editions: [{ edition_id: "ipsj-27-r26" }],
      rows: [{ venue_key: "jip" }],
    });
    expect(shared.content[0].text).toContain("会議: Partner Archive（key: ipsj-27-r-compsac");
    const classification = (result: { content: { text: string }[] }) =>
      result.content[0].text.split("\n").filter((line) => /^(分野|ランク|主題):/.test(line));
    expect(classification(shared)).toEqual([
      "分野: システム",
      "ランク: CORE B",
      "主題: ストレージ",
    ]);
    for (const args of [{ key: "old-partner" }, { name: "Partner Archive" }]) {
      expect(classification(await call({ ...args, scope: "all" }))).toEqual([
        "分野: システム",
        "ランク: CORE B",
        "主題: ストレージ",
      ]);
    }
    expect(classification(await call({ key: "jip", scope: "all" }))).toEqual([
      "分野: セキュリティ",
      "ランク: CCF A",
      "主題: セキュリティ",
    ]);
    // 属性が未収録でも、共有募集の統合先の属性で補わない。
    const {
      categories: _categories,
      rank: _rank,
      tags: _tags,
      ...withoutClassification
    } = sharedOnly[1];
    writeFileSync(
      join(root, "data/snapshot.json"),
      JSON.stringify({ conferences: [...conferences, sharedOnly[0], withoutClassification] }),
    );
    expect(classification(await call({ key: "ipsj-27-r-compsac", scope: "all" }))).toEqual([
      "分野: 未確認",
      "ランク: ランク未確認",
    ]);
  } finally {
    reader.close();
    child.kill();
  }
});
