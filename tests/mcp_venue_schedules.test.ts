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
const root = mkdtempSync(join(tmpdir(), "kamiyobi-venue-schedules-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
mkdirSync(join(root, "data"));
const review = {
  edition_id: "reviewed-split",
  source_date_text: "June 1 & 5-6, 2029",
  source_date_text_alternatives: ["June 1, June 5-6, 2029"],
  source_start: "2029-06-01",
  source_end: "2029-06-06",
  source_url: "https://example.org/review-source",
  reviewed_on: "2029-05-30",
  held_year: 2029,
  note: "開催回の年と開催年を照合済み",
};
const editions = [
  {
    id: "month",
    year: 2029,
    event_start: "2029-06-17",
    event_end: "2029-06-19",
    event_date_precision: "month-only",
    link: "https://example.org/month",
  },
  {
    id: "split",
    year: 2028,
    event_date_precision: "split-dates",
    event_segments: [
      { start: "2029-06-01", end: "2029-06-01", label: "オンライン" },
      { start: "2029-06-05", end: "2029-06-06", label: "現地開催" },
    ],
    link: "https://example.org/split",
  },
  { id: "unknown", year: 2030, event_date_precision: "not-announced" },
  { id: "estimate", year: 2031, event_start: "2031-06-01", estimated: true },
];
function venue(key: string, eds: unknown[]) {
  return {
    key,
    title: key,
    categories: [],
    rank: {},
    link: "https://example.org/current",
    editions: eds,
  };
}
writeFileSync(
  join(root, "data/snapshot.json"),
  JSON.stringify({
    conferences: [
      venue(
        "fresh",
        editions.map((ed) => ({ ...ed, place: "Tokyo, Japan", deadlines: [] })),
      ),
      venue("estimated-only", [editions[3]]),
      venue("reviewed", [
        {
          ...editions[1],
          id: "reviewed-split",
          date_text: review.source_date_text,
          event_review: review,
          deadlines: [],
        },
      ]),
      venue("reviewed-dated", [
        {
          ...editions[1],
          id: "reviewed-split",
          date_text: review.source_date_text,
          event_review: review,
          deadlines: [{ kind: "paper", utc: "2029-05-01T00:00:00Z", tz_raw: "UTC" }],
        },
      ]),
      venue("same-date-text", [
        {
          id: "same-date",
          year: 2029,
          event_start: "2029-06-01",
          event_end: "2029-06-01",
          event_date_precision: "single-day",
          date_text: "2029-06-01(金)",
          deadlines: [],
        },
      ]),
      {
        ...venue("identity-en", []),
        title: "RCS",
        acronym: "RCS",
        full_name: "Research Computing Symposium",
      },
      {
        ...venue("identity-ja", [editions[0]]),
        title: "システム研究会",
        acronym: "SYS",
        full_name: "情報処理システム研究会",
      },
      {
        ...venue("identity-dated", [
          {
            id: "dated",
            year: 2029,
            deadlines: [{ kind: "paper", utc: "2029-06-01T00:00:00Z", tz_raw: "UTC" }],
          },
        ]),
        title: "RCS",
        acronym: "RCS",
        full_name: "Reliable Computing Symposium",
      },
      { ...venue("identity-same", []), title: "Same", acronym: "Same", full_name: "Same" },
      { ...venue("identity-missing", []), link: null },
      venue("fresh-secondary", [
        { id: "foreign", year: 2040, event_start: "2040-01-01", deadlines: [] },
      ]),
      venue("mixed", [
        {
          id: "deadline",
          year: 2029,
          deadlines: [{ kind: "paper", utc: "2029-05-01T00:00:00Z", tz_raw: "UTC" }],
        },
        { ...editions[1], deadlines: [] },
      ]),
      venue(
        "many",
        Array.from({ length: 127 }, (_, i) => ({
          id: `event-${i}`,
          year: 2029 + i,
          event_start: `${2029 + i}-06-01`,
          event_end: `${2029 + i}-06-01`,
          event_date_precision: "single-day",
          deadlines: [],
        })),
      ),
    ],
  }),
);
writeFileSync(
  join(root, "run.ts"),
  'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2029-05-31T00:00:00Z"));',
);
function call(args: Record<string, unknown>, tool = "venue_info") {
  for (const dir of ["public", ".cache"]) expect(existsSync(join(root, dir))).toBe(false);
  const child = spawnSync(process.execPath, ["run.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })}\n`,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()).result;
  expect(result.isError).not.toBe(true);
  return {
    data: result.structuredContent,
    text: result.content[0].text,
  };
}
it("returns actual edition schedules directly, with raw precision, segments and edition URLs", () => {
  const { data, text } = call({ key: "ＦＲＥＳＨ" });
  expect(data).toMatchObject({
    venue_key: "fresh",
    deadline_total: 0,
    upcoming_deadline_total: 0,
    past_deadline_total: 0,
    next_submission: null,
    next_estimated_submission: null,
    latest_past_submission: null,
    rows: [],
    event_scope: "all",
    event_generated_at: null,
    evaluated_at: "2029-05-31T00:00:00.000Z",
  });
  expect(data.editions.map((ed: { edition_id: string }) => ed.edition_id)).toEqual([
    "month",
    "split",
    "unknown",
  ]);
  expect(data.editions[0]).toMatchObject({
    year: 2029,
    event_start: "2029-06-17",
    event_end: "2029-06-19",
    event_date_precision: "month-only",
    event_display: "2029-06（月のみ判明）",
    official_url: "https://example.org/month",
    place: "Tokyo, Japan",
    place_ja: "Tokyo, 日本",
  });
  expect(data.editions[1]).toMatchObject({
    year: 2028,
    event_start: null,
    event_end: null,
    event_segments: editions[1].event_segments,
    official_url: "https://example.org/split",
  });
  expect(data.editions[2]).toMatchObject({
    event_start: null,
    event_end: null,
    official_url: null,
    event_date_precision: "not-announced",
    event_display: "会期未発表",
  });
  expect(text).toContain(
    "2029（month） | 2029-06（月のみ判明） | Tokyo, 日本 https://example.org/month",
  );
  expect(text).toContain(
    "2028（split） | 2029-06-01(金)（オンライン） / 2029-06-05(火) 〜 2029-06-06(水)（現地開催）",
  );
  expect(text).not.toContain("2029-06-17");
  expect(text).not.toContain("2031-06-01");
  expect(text).not.toContain("foreign");
});
it("also returns schedule-only editions beside a venue's deadline rows", () => {
  const { data, text } = call({ key: "mixed" });
  expect(data).toMatchObject({ venue_key: "mixed", deadline_total: 1 });
  expect(data.rows).toHaveLength(1);
  expect(data.editions.map((ed: { edition_id: string }) => ed.edition_id)).toEqual([
    "deadline",
    "split",
  ]);
  expect(text).toContain("2028（split） | 2029-06-01(金)（オンライン）");
  expect(text).toContain("https://example.org/split");
});
it("does not cap schedule-only editions at three, sixty or one hundred", () => {
  const { data, text } = call({ key: "many" });
  expect(data.editions.map((ed: { edition_id: string }) => ed.edition_id)).toEqual(
    Array.from({ length: 127 }, (_, i) => `event-${i}`),
  );
  expect(text.split("\n").filter((line: string) => line.startsWith("- "))).toHaveLength(127);
  expect(text).toContain("2155（event-126）");
});
it("asks to disambiguate event-only venues instead of returning the first venue's schedules", () => {
  const { data, text } = call({ name: "fresh" });
  expect(data).toMatchObject({
    lookup_status: "ambiguous",
    candidate_count: 2,
    candidates: [{ venue_key: "fresh" }, { venue_key: "fresh-secondary" }],
  });
  expect(data).not.toHaveProperty("editions");
  expect(data).not.toHaveProperty("venue_key");
  expect(text).toContain("2 の会議");
  expect(text).toContain("key: fresh）");
  expect(text).toContain("key: fresh-secondary）");
  expect(text).toContain("key: fresh） https://example.org/month");
  expect(text).not.toContain("開催回の会期");
  expect(text).not.toContain("2029-06（月のみ判明）");
});

it("does not advertise estimated dates as recorded event schedules", () => {
  const { data, text } = call({ key: "estimated-only" });
  expect(data.editions).toEqual([]);
  expect(text).toContain("会期も確認できていない");
  expect(text).not.toContain("2031-06-01");
});

it("retains canonical names, full names and acronyms independently of deadlines and language", () => {
  for (const [key, title, acronym, fullName, total] of [
    ["identity-en", "RCS", "RCS", "Research Computing Symposium", 0],
    ["identity-ja", "システム研究会", "SYS", "情報処理システム研究会", 0],
    ["identity-dated", "RCS", "RCS", "Reliable Computing Symposium", 1],
  ] as const) {
    const { data, text } = call({ key });
    expect(data).toMatchObject({
      venue_key: key,
      title,
      acronym,
      full_name: fullName,
      official_url: "https://example.org/current",
      deadline_total: total,
    });
    expect(text).toContain(`正式名: ${fullName}`);
    expect(text.match(/正式名:/g)).toHaveLength(1);
  }
});
it("does not invent missing identity fields or repeat identical full names", () => {
  const missing = call({ key: "identity-missing" });
  expect(missing.data).toMatchObject({
    venue_key: "identity-missing",
    title: "identity-missing",
    full_name: null,
    acronym: null,
    official_url: null,
  });
  expect(missing.text).not.toContain("正式名:");
  expect(missing.text).not.toContain("公式ページ:");
  const same = call({ key: "identity-same" });
  expect(same.data).toMatchObject({ title: "Same", full_name: "Same", acronym: "Same" });
  expect(same.text).not.toContain("正式名:");
});

it("preserves original event wording and full review records for scheduled and deadline-bearing venues", () => {
  for (const key of ["reviewed", "reviewed-dated"]) {
    const { data, text } = call({ key });
    expect(data.editions).toHaveLength(1);
    expect(data.editions[0]).toMatchObject({
      date_text: review.source_date_text,
      event_date_precision: "split-dates",
      event_segments: editions[1].event_segments,
      event_review: review,
    });
    expect(text).toContain("（開催回の年と開催年を照合済み）（原表記: June 1 & 5-6, 2029）");
    if (key === "reviewed-dated") {
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0]).toMatchObject({
        date_text: review.source_date_text,
        event_date_precision: "split-dates",
        event_segments: editions[1].event_segments,
        event_review: review,
      });
    }
  }
  const searched = call(
    { query: "reviewed-dated", kinds: ["paper"], include_past: true, scope: "all" },
    "search_deadlines",
  );
  expect(searched.data.rows).toHaveLength(1);
  expect(searched.data.rows[0]).toMatchObject({
    date_text: review.source_date_text,
    event_date_precision: "split-dates",
    event_segments: editions[1].event_segments,
    event_review: review,
  });
});
it("leaves absent review data null and avoids duplicating unchanged event wording", () => {
  const missing = call({ key: "fresh" });
  expect(missing.data.editions[2]).toMatchObject({
    date_text: null,
    event_review: null,
    event_segments: [],
  });
  const same = call({ key: "same-date-text" });
  expect(same.data.editions[0]).toMatchObject({ date_text: "2029-06-01(金)", event_review: null });
  expect(same.text.match(/2029-06-01\(金\)/g)).toHaveLength(1);
  expect(same.text).not.toContain("原表記:");
});

it("retains event evidence for each upcoming segment, including one-item pages", () => {
  const all = call({ days: 10, limit: 100 }, "list_upcoming");
  const items = all.data.items;
  const selected = items.filter((item: { venue_key: string }) => item.venue_key === "reviewed");
  expect(selected).toHaveLength(2);
  expect(
    selected.map((item: { event_start: string; event_end: string }) => [
      item.event_start,
      item.event_end,
    ]),
  ).toEqual([
    ["2029-06-01", "2029-06-01"],
    ["2029-06-05", "2029-06-06"],
  ]);
  for (const [index, row] of selected.entries()) {
    const expected = {
      type: "event",
      venue_key: "reviewed",
      edition_id: "reviewed-split",
      year: 2028,
      event_start: index === 0 ? "2029-06-01" : "2029-06-05",
      event_end: index === 0 ? "2029-06-01" : "2029-06-06",
      event_date_precision: "split-dates",
      event_segments: editions[1].event_segments,
      date_text: review.source_date_text,
      event_review: review,
      segment_label: index === 0 ? "オンライン" : "現地開催",
    };
    expect(row).toMatchObject(expected);
    const page = call({ days: 10, limit: 1, offset: items.indexOf(row) }, "list_upcoming");
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0]).toMatchObject(expected);
    expect(page.text).toContain(`（${expected.segment_label}） |`);
    expect(page.text).toContain(
      "\n  会期の注記: （開催回の年と開催年を照合済み）（原表記: June 1 & 5-6, 2029）",
    );
  }
});
it("does not invent reviews or duplicate unchanged wording in upcoming event text", () => {
  const result = call({ days: 10, limit: 100 }, "list_upcoming");
  const row = result.data.items.find(
    (item: { venue_key: string }) => item.venue_key === "same-date-text",
  );
  expect(row).toMatchObject({
    event_review: null,
    event_segments: [],
    date_text: "2029-06-01(金)",
  });
  const page = call(
    { days: 10, limit: 1, offset: result.data.items.indexOf(row) },
    "list_upcoming",
  );
  expect(page.data.items).toHaveLength(1);
  expect(page.data.items[0].venue_key).toBe("same-date-text");
  expect(page.text.match(/2029-06-01\(金\)/g)).toHaveLength(1);
  expect(page.text).not.toContain("原表記:");
});
