import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-venue-lookup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const name of ["src", "site"]) cpSync(join(repo, name), join(root, name), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
function venue(
  key: string,
  title: string,
  legacy_keys: string[] = [],
  dated = true,
  event_start: string | null = null,
) {
  return {
    key,
    title,
    full_name: title,
    legacy_keys,
    categories: ["systems"],
    tags: [],
    rank: {},
    link: `https://${key}.example.org/`,
    editions: [
      {
        year: 2027,
        id: `${key}27`,
        place: "Tokyo",
        event_start,
        event_end: event_start,
        estimated: false,
        deadlines: dated ? [{ kind: "paper", utc: "2027-01-10T00:00:00Z", tz_raw: "UTC" }] : [],
      },
    ],
  };
}
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({
    generated_at: "2026-10-15T00:00:00Z",
    conferences: [
      venue("nsdi", "NSDI", ["old-nsdi"]),
      venue("sc", "SC"),
      venue("sc-workshop", "SC Workshop"),
      venue("domestic", "システム研究会"),
      venue("empty", "Empty Venue", ["old-empty"], false),
      venue("first", "First", ["shared-old"]),
      venue("second", "Second", ["shared-old"]),
      venue("current", "Current", ["other"]),
      venue("other", "Other"),
      venue("shadow", "Shadow", ["empty"]),
      venue("ai+sys", "AI+Systems"),
      venue("event-only", "Event Only", [], false, "2027-02-01"),
      venue("series-alpha", "Series Alpha"),
      venue("series-beta", "Series Beta", [], false, "2027-02-01"),
      venue("series-gamma", "Series Gamma", [], false),
      ...Array.from({ length: 31 }, (_, i) => venue(`broad-${i}`, `Broad ${i}`, [], i % 2 === 0)),
      {
        ...venue("link-alpha", "LinkChoice Alpha"),
        editions: [
          {
            id: "old-alpha",
            year: 2027,
            link: "https://alpha.example.org/old",
            deadlines: [{ kind: "paper", utc: "2026-01-01T00:00:00Z" }],
          },
          {
            id: "new-alpha",
            year: 2028,
            link: "https://alpha.example.org/new",
            deadlines: [{ kind: "paper", utc: "2027-01-01T00:00:00Z" }],
          },
        ],
      },
      {
        ...venue("link-beta", "LinkChoice Beta"),
        editions: [
          { id: "old-beta", year: 2027, link: "https://beta.example.org/old", deadlines: [] },
          { id: "new-beta", year: 2028, link: "https://beta.example.org/new", deadlines: [] },
          {
            id: "estimate-beta",
            year: 2029,
            link: "https://beta.example.org/estimated",
            estimated: true,
            deadlines: [],
          },
        ],
      },
    ],
  }),
);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2026-10-15T00:00:00Z"));',
);
function call(args: Record<string, unknown>, tool = "venue_info") {
  if (args.scope !== "screen") expect(existsSync(join(root, "public"))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: { scope: "all", ...args } },
    })}\n`,
    timeout: 10000,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout).result;
  expect(result.isError).not.toBe(true);
  return result.content[0].text as string;
}
it("reads actual fixture deadlines through the unmodified canonical key", () => {
  const text = call({ key: "nsdi" });
  expect(text).toContain("nsdi27");
  expect(text).toContain("2027-01-10");
});
it.each([{ key: "ＮＳＤＩ" }, { name: "ＮＳＤＩ" }, { name: "ｼｽﾃﾑ研究会" }])(
  "accepts Japanese input width variants: %j",
  (args) => {
    const text = call(args);
    expect(text).toContain(args.name === "ｼｽﾃﾑ研究会" ? "domestic27" : "nsdi27");
    expect(text).toContain("2027-01-10");
    expect(text).not.toContain("収録に在りません");
  },
);
it.each(["old-nsdi", "ＯＬＤ－ＮＳＤＩ"])(
  "resolves saved old key %s to actual deadlines",
  (key) => {
    const text = call({ key });
    expect(text).toContain("nsdi27");
    expect(text).toContain("2027-01-10");
    expect(text).not.toContain("締切の行が 1 本もありません");
  },
);
it("keeps shared aliases ambiguous and lets a current exact key win over an alias", () => {
  const text = call({ key: "ＳＨＡＲＥＤ－ＯＬＤ" });
  expect(text).toContain("2 つの会議の古い key");
  expect(text).toContain("key: first");
  expect(text).toContain("key: second");
  const current = call({ key: "ＯＴＨＥＲ" });
  expect(current).toContain("other27");
  expect(current).not.toContain("current27");
});
it("does not turn unknown or punctuation-only keys into unrelated venues", () => {
  for (const key of ["ＮＯＳＵＣＨ", "＋＋＋"]) {
    const text = call({ key });
    expect(text).toContain("収録に在りません");
    expect(text).not.toContain("nsdi27");
  }
  expect(call({ key: "ＯＬＤ－ＥＭＰＴＹ" })).toContain("締切の行が 1 本もありません");
});
it("uses an exact width-normalized key from the command line instead of ambiguous name search", () => {
  const child = spawnSync(process.execPath, ["src/mcp.ts", "venue", "ＳＣ"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("sc27");
  expect(child.stdout).not.toContain("sc-workshop27");
  expect(child.stdout).not.toContain("2 の会議");
});

it("preserves punctuation in exact keys and current keys with no deadline rows", () => {
  expect(call({ key: "ＡＩ＋ＳＹＳ" })).toContain("ai+sys27");
  expect(call({ key: "aisys" })).toContain("収録に在りません");
  const empty = call({ key: "ＥＭＰＴＹ" });
  expect(empty).toContain("締切の行が 1 本もありません");
  expect(empty).not.toContain("shadow27");
  expect(empty).not.toContain("2 つの会議");
});

it("distinguishes deadlines outside the screen from deadlines absent from the collection", () => {
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({ generated_at: "2026-10-15T00:00:00Z", conferences: [venue("sc", "SC")] }),
  );
  try {
    for (const args of [{ key: "nsdi" }, { key: "ＯＬＤ－ＮＳＤＩ" }, { name: "ＮＳＤＩ" }]) {
      const text = call({ ...args, scope: "screen" });
      expect(text).toContain("収録全体には 1 件あります");
      expect(text).toContain("NSDI（key: nsdi）");
      expect(text).toContain('scope: "all"');
      expect(text).not.toContain("締切の行が 1 本もありません");
      expect(text).not.toContain("sc27");
    }
  } finally {
    rmSync(join(root, "public"), { recursive: true, force: true });
  }
});
it("sends event-only venues to the upcoming table without promising an ICS deadline event", () => {
  for (const text of [
    call({ key: "event-only" }),
    call({ query: "event-only" }, "search_deadlines"),
  ]) {
    expect(text).toContain("締切の行が 1 本もありません");
    expect(text).toContain("upcoming.md");
    expect(text).toContain("購読カレンダー（deadlines.ics）は締切のみ");
    expect(text).not.toContain("「開催」として載ります");
  }
});

it("disambiguates names against every venue regardless of deadline availability or screen scope", () => {
  const all = call({ name: "ＳＥＲＩＥＳ", scope: "all" });
  expect(all).toContain("3 の会議");
  for (const key of ["series-alpha", "series-beta", "series-gamma"])
    expect(all).toContain(`key: ${key}）`);
  expect(all).not.toContain("series-alpha27");
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "public/catalog.json"),
    JSON.stringify({ conferences: [venue("series-alpha", "Series Alpha")] }),
  );
  try {
    {
      const text = call({ name: "ＳＥＲＩＥＳ", scope: "screen" });
      expect(text).toContain("3 の会議");
      for (const key of ["series-alpha", "series-beta", "series-gamma"])
        expect(text).toContain(`key: ${key}）`);
      expect(text).not.toContain("series-alpha27");
      expect(text).not.toContain("2027-01-10");
    }
    const selected = call({ key: "ＳＥＲＩＥＳ－ＢＥＴＡ", name: "series", scope: "screen" });
    expect(selected).toContain("series-beta27");
    expect(selected).not.toContain("series-alpha27");
    expect(selected).not.toContain("3 の会議");
  } finally {
    rmSync(join(root, "public"), { recursive: true, force: true });
  }
});

it("returns every disambiguation key when more than twenty venues share a name", () => {
  const text = call({ name: "Broad" });
  expect(text).toContain("31 の会議");
  const keys = [...text.matchAll(/key: (broad-\d+)）/g)].map((match) => match[1]);
  expect(keys).toEqual(Array.from({ length: 31 }, (_, i) => `broad-${i}`));
  expect(text).not.toContain("2027-01-10");
});

it("retains latest explicit candidate links for venues with and without deadlines", () => {
  const text = call({ name: "LinkChoice" });
  expect(text).toContain("2 の会議");
  expect(text).toContain("key: link-alpha） https://alpha.example.org/new");
  expect(text).toContain("key: link-beta） https://beta.example.org/new");
  expect(text).not.toContain("/old");
  expect(text).not.toContain("/estimated");
});
