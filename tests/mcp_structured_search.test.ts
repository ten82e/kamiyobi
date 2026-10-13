import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { structuredDeadline } from "../src/mcp.ts";
import { REPO_ROOT } from "./helpers.ts";

function searches(argumentsList: Record<string, unknown>[]) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "src/mcp.ts")], {
    cwd: REPO_ROOT,
    input:
      argumentsList
        .map((args, id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "search_deadlines", arguments: args },
          }),
        )
        .join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).result);
}
function search(args: Record<string, unknown>) {
  return searches([args])[0];
}

it("100件を超える検索も全ページを取得でき、ページ幅を変えても重複・欠落がない", () => {
  const args = { scope: "all", kind: "paper", query: "セキュリティ", include_past: true };
  const first = search({ ...args, limit: 100 }).structuredContent;
  expect(first.total).toBeGreaterThan(100);
  const requests = (limit: number) =>
    Array.from({ length: Math.ceil(first.total / limit) }, (_, index) => ({
      ...args,
      limit,
      offset: index * limit,
    }));
  const whole = searches(requests(100)).flatMap((result) => result.structuredContent.rows);
  const pages = searches(requests(40));
  const collected = [];
  for (const [index, result] of pages.entries()) {
    const page = result.structuredContent;
    expect(page.total).toBe(first.total);
    expect(page.offset).toBe(index * 40);
    expect(page.returned).toBe(page.rows.length);
    expect(JSON.parse(result.content[1].text)).toEqual(page);
    for (const row of page.rows) expect(result.content[0].text).toContain(row.display);
    collected.push(...page.rows);
    expect(page.next_offset).toBe(index + 1 === pages.length ? null : (index + 1) * 40);
  }
  expect(collected).toEqual(whole);
  expect(collected).toHaveLength(first.total);
  const end = search({ ...args, offset: first.total }).structuredContent;
  expect(end.rows).toEqual([]);
  expect(end.next_offset).toBeNull();
});

it("0件と不正なページ位置を区別し、先頭に黙って戻らない", () => {
  const zero = search({ scope: "all", query: "not-a-real-venue-987654" });
  expect(zero.structuredContent).toMatchObject({ total: 0, rows: [], next_offset: null });
  for (const offset of [-1, 0.5, "7", null, Number.MAX_SAFE_INTEGER + 1]) {
    const result = search({ query: "セキュリティ", offset });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("offset");
  }
});

it("時刻未確認と推定の情報を保持し、日本時間の確定時刻を捏造しない", () => {
  const row = {
    conf: { key: "example", title: "Example" },
    ed: { id: "example27", estimate: { window_start: "2026-12-01", window_end: "2026-12-10" } },
    dl: {
      kind: "paper",
      track: "short",
      precision: "date-only",
      verification: { status: "verified" },
      earliest_utc: "2026-11-30T10:00:00Z",
      latest_utc: "2026-12-02T11:59:59Z",
    },
    kind: "paper",
    est: false,
    t: Date.parse("2026-11-30T10:00:00Z"),
    localDate: "2026-12-01",
    dateOnly: true,
    hay: "",
  };
  const now = Date.parse("2026-10-13T00:00:00Z");
  expect(structuredDeadline(row, now)).toMatchObject({
    utc: null,
    jst: null,
    local_date: "2026-12-01",
    precision: "date-only",
    track: "short",
    verification: { status: "verified" },
    estimated: false,
    estimate: null,
    uncertainty: { earliest_utc: row.dl.earliest_utc, latest_utc: row.dl.latest_utc },
  });
  expect(structuredDeadline({ ...row, est: true }, now).estimate).toEqual(row.ed.estimate);
  const exact = structuredDeadline(
    {
      ...row,
      dateOnly: false,
      dl: {
        kind: "paper",
        utc: "2026-12-01T23:59:00Z",
        tz_raw: "AoE",
      },
      t: Date.parse("2026-12-01T23:59:00Z"),
    },
    now,
  );
  expect(exact).toMatchObject({ utc: "2026-12-01T23:59:00Z", local_date: null, uncertainty: null });
  expect(exact.jst).toBe("2026-12-02(水) 08:59 JST");
});
