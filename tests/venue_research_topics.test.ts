import { expect, it } from "vitest";
import { venueResearchSources, venueResearchTopics } from "../site/recommendation.ts";

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

it("returns distinct absolute HTTPS topic sources and ignores malformed links", () => {
  expect(
    venueResearchSources({
      official_scope_sources: [
        " https://official.example/2024/cfp ",
        "https://official.example/2024/cfp",
        "https://other.example/topics",
        "javascript:alert(1)",
        "/relative",
        "https://user:password@official.example",
        "http://official.example",
        42,
        null,
      ],
    }),
  ).toEqual(["https://official.example/2024/cfp", "https://other.example/topics"]);
  for (const value of [null, {}, { official_scope_sources: "https://official.example" }])
    expect(venueResearchSources(value)).toEqual([]);
});

it("accepts scalar topic text without inventing descriptions from malformed values", () => {
  expect(
    venueResearchTopics({ official_scope: "Database systems", scope: [null, 42, " "] }),
  ).toEqual(["Database systems"]);
  expect(venueResearchTopics({ official_scope: ["<img src=x>"] })).toEqual(["<img src=x>"]);
  for (const value of [null, {}, "systems", { scope: { title: "Not a topic" } }])
    expect(venueResearchTopics(value)).toEqual([]);
});
