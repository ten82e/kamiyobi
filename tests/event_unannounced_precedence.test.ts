import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { buildAll, editionSessionJa, ROOT, setRoot } from "../src/build.ts";
import { conferencesFromJson } from "../src/model.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

const cases = [
  {},
  { date_text: "May 17-19, 2030" },
  { event_start: "2030-05-17", event_end: "2030-05-19", date_text: "May 17-19, 2030" },
  {
    event_segments: [
      { start: "2030-05-17", end: "2030-05-17", label: "オンライン" },
      { start: "2030-05-19", end: "2030-05-19", label: "現地開催" },
    ],
  },
];
it.each(cases)(
  "gives explicit unannounced certainty priority over retained date fields: %j",
  (fields) => {
    const ed = { ...fields, event_date_precision: "not-announced" };
    const before = JSON.stringify(ed);
    expect(Recommender.eventCellJa({ ed })).toBe("会期未発表");
    const conf = conferencesFromJson({
      conferences: [
        {
          key: "test",
          title: "Test",
          editions: [{ id: "test30", year: 2030, ...ed, deadlines: [] }],
        },
      ],
    })[0];
    expect(editionSessionJa(conf.editions[0])).toBe("会期未発表");
    expect(editionSessionJa({ ...conf.editions[0], estimated: true })).toBe("会期未発表（推定）");
    expect(JSON.stringify(ed)).toBe(before);
  },
);

it("changes the display with declared certainty while keeping the same source dates", () => {
  const ed = {
    event_start: "2030-05-17",
    event_end: "2030-05-19",
    date_text: "May 17-19, 2030",
    event_date_precision: "exact-range",
  };
  const exact = "2030-05-17(金) 〜 2030-05-19(日)";
  for (const [precision, display] of [
    ["exact-range", exact],
    ["not-announced", "会期未発表"],
    ["month-only", "2030-05（月のみ判明）"],
    ["unverified", `${exact}（日付未確認）`],
    ["not-announced", "会期未発表"],
    ["exact-range", exact],
  ]) {
    ed.event_date_precision = precision;
    const before = JSON.stringify(ed);
    expect(Recommender.eventCellJa({ ed })).toBe(display);
    const conf = conferencesFromJson({
      conferences: [
        {
          key: "test",
          title: "Test",
          editions: [{ id: "test30", year: 2030, ...ed, deadlines: [] }],
        },
      ],
    })[0];
    expect(editionSessionJa(conf.editions[0])).toBe(display);
    expect(JSON.stringify(ed)).toBe(before);
  }
});

it("retains source evidence through a fresh build while showing only the unannounced state in MCP date cells", async () => {
  const root = tempWork("kamiyobi-unannounced-precedence-");
  for (const dir of ["site", "scripts", "src"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"])
    cpSync(join(REPO_ROOT, file), join(root, file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  expect(existsSync(join(root, "data"))).toBe(false);
  const raw = {
    conferences: cases.slice(1).map((fields, i) => ({
      key: `unknown-${i}`,
      title: `会期未発表検証${i}`,
      categories: ["systems"],
      editions: [
        {
          id: `unknown-${i}-30`,
          year: 2030,
          ...fields,
          event_date_precision: "not-announced",
          deadlines: [{ kind: "paper", utc: "2030-05-01T00:00:00Z", tz_raw: "UTC" }],
        },
      ],
    })),
  };
  const input = conferencesFromJson(raw);
  const before = JSON.stringify(input);
  const previousRoot = ROOT;
  setRoot(root);
  try {
    await buildAll(input, {}, join(root, "out"), new Date("2030-04-15T00:00:00Z"), {
      noEmbeddings: true,
      localEmbeddingsOnly: true,
      venuePapers: {},
      reranker: null,
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(existsSync(join(root, "data"))).toBe(false);
    const data = JSON.parse(readFileSync(join(root, "out/data.json"), "utf8"));
    const catalog = JSON.parse(readFileSync(join(root, "out/catalog.json"), "utf8"));
    expect(data.conferences).toHaveLength(3);
    for (const conf of data.conferences) {
      const ed = conf.editions[0];
      expect(ed.event_date_precision).toBe("not-announced");
      expect(Recommender.eventCellJa({ ed })).toBe("会期未発表");
      expect(
        catalog.conferences.find((c: { key: string }) => c.key === conf.key).editions[0],
      ).toEqual(ed);
      for (const file of ["upcoming.md", "upcoming.html"]) {
        const content = readFileSync(join(root, "out", file), "utf8");
        const rows = file.endsWith(".md")
          ? content.split("\n")
          : [...content.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
        const matching = rows.filter((row) => row.includes(conf.title));
        expect(matching, file).toHaveLength(1);
        expect(matching[0], file).toContain("論文締切");
        expect(matching[0], file).toContain("会期未発表");
        expect(matching[0], file).not.toContain("2030-05-17");
        expect(matching[0], file).not.toContain("2030-05-19");
      }
    }
    expect(data.conferences[0].editions[0].date_text).toBe("May 17-19, 2030");
    expect(data.conferences[1].editions[0].event_start).toBe("2030-05-17");
    expect(data.conferences[2].editions[0].event_segments).toEqual(cases[3].event_segments);
    mkdirSync(join(root, "data"));
    const snapshot = JSON.stringify(raw);
    writeFileSync(join(root, "data/snapshot.json"), snapshot);
    writeFileSync(
      join(root, "run.ts"),
      'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2030-04-15T00:00:00Z"));',
    );
    const requests = [
      { name: "search_deadlines", arguments: { query: "会期未発表", scope: "all" } },
      ...raw.conferences.map((conf) => ({ name: "venue_info", arguments: { key: conf.key } })),
      { name: "list_upcoming", arguments: { days: 60 } },
    ];
    const child = spawnSync(process.execPath, ["run.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20000,
      input: `${requests
        .map((params, i) =>
          JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params }),
        )
        .join("\n")}\n`,
    });
    expect(child.status, child.stderr).toBe(0);
    const replies = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(5);
    for (const reply of replies) {
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).not.toBe(true);
    }
    expect(replies[0].result.structuredContent.rows).toHaveLength(3);
    for (const row of replies[0].result.structuredContent.rows) {
      expect(row.event_date_precision).toBe("not-announced");
      const source = raw.conferences.find((conf) => conf.key === row.venue_key)!.editions[0] as {
        date_text?: string;
        event_segments?: unknown[];
      };
      expect(row.date_text).toBe(source.date_text ?? null);
      expect(row.event_segments).toEqual(source.event_segments ?? []);
      if (source.date_text) expect(row.display).toContain(`（原表記: ${source.date_text}）`);
      expect(row.display.split("|").at(-2)?.trim()).toMatch(/^会期未発表(?:（原表記: .+）)?$/);
      expect(row.display).not.toContain("会期 会期未発表");
    }
    for (const reply of replies.slice(1, 4))
      expect(reply.result.structuredContent.editions[0].event_display).toBe("会期未発表");
    expect(replies[4].result.structuredContent.event_total).toBe(0);
    expect(readFileSync(join(root, "data/snapshot.json"), "utf8")).toBe(snapshot);
  } finally {
    setRoot(previousRoot);
  }
});
