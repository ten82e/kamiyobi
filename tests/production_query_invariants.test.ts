import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const now = Date.parse("2026-08-09T00:00:00Z");
const captured = JSON.parse(
  readFileSync("tests/fixtures/pr958-city-search.json", "utf8"),
) as Array<{ query: string; city: string; conference: Record<string, unknown> }>;

describe("PR958 city names on actual captured rows", () => {
  it.each(captured)("$query reaches every captured $city row", ({ query, city, conference }) => {
    const rows = Recommender.candidateRows({ conferences: [conference] } as never);
    expect(rows.length).toBeGreaterThan(0);
    const japanese = Recommender.searchMatcher(query, now);
    const english = Recommender.searchMatcher(city, now);
    expect(rows.filter((r) => english(r.hay))).toHaveLength(rows.length);
    expect(rows.filter((r) => japanese(r.hay))).toHaveLength(rows.length);
  });
});

it("keeps Japanese query equivalence on the current production snapshot, independent of frozen counts", () => {
  const rows = Recommender.candidateRows(JSON.parse(readFileSync("data/snapshot.json", "utf8")));
  const matched = (query: string) => {
    const match = Recommender.searchMatcher(query, now);
    return rows.flatMap((r, index) => (match(r.hay) ? [index] : []));
  };
  for (const [query, canonical] of [
    ["参加申込締切", "登録締切"],
    ["ソルトレイクシティ", "salt lake city"],
    ["第2週目", "第2週"],
    ["9月第2週目", "9月第2週"],
    ["東京開催", "東京"],
  ]) {
    expect(matched(canonical).length, canonical).toBeGreaterThan(0);
    expect(matched(query), query).toEqual(matched(canonical));
  }
});
