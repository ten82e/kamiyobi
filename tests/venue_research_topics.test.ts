import { expect, it } from "vitest";
import { venueResearchTopics } from "../site/recommendation.ts";

it("keeps collected topic clauses intact and removes duplicate descriptions", () => {
  const conference = {
    official_scope: [" Learning with constraints: memory, communication ", "Storage systems"],
    scope: ["Storage systems", "Distributed\n databases"],
  };
  const original = structuredClone(conference);
  expect(venueResearchTopics(conference)).toEqual([
    "Learning with constraints: memory, communication",
    "Storage systems",
    "Distributed databases",
  ]);
  expect(conference).toEqual(original);
});

it("accepts scalar topic text without inventing descriptions from malformed values", () => {
  expect(
    venueResearchTopics({ official_scope: "Database systems", scope: [null, 42, " "] }),
  ).toEqual(["Database systems"]);
  expect(venueResearchTopics({ official_scope: ["<img src=x>"] })).toEqual(["<img src=x>"]);
  for (const value of [null, {}, "systems", { scope: { title: "Not a topic" } }])
    expect(venueResearchTopics(value)).toEqual([]);
});
