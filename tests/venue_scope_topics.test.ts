import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommender.ts";
import { topicProfileTexts } from "../src/embedding-profiles.ts";
import { applyVenueScopes } from "../src/merge.ts";
import { makeConference, REPO_ROOT } from "./helpers.ts";
import { jsFunction } from "./runtime_extract.ts";

it("adds independently sourced topics without altering candidate identity or deadlines", () => {
  const original = [
    makeConference({ key: "wide", title: "Wide" }),
    makeConference({ key: "other", title: "Other" }),
  ];
  const input = JSON.parse(JSON.stringify(original));
  const result = applyVenueScopes(input, {
    wide: { source_url: "https://official.example/cfp", topics: ["storage", "networking"] },
    absent: { source_url: "https://official.example/other", topics: ["statistics"] },
  });
  expect(result.map((c) => c.key)).toEqual(["wide", "other"]);
  expect(result[0].official_scope).toEqual(["storage", "networking"]);
  expect(result[0].editions).toEqual(original[0].editions);
  expect(input).toEqual(original);
  expect(result[1]).toEqual(original[1]);
});
it("rejects incomplete CFP topic evidence rather than silently claiming it is official", () => {
  for (const raw of [
    [],
    { wide: { topics: ["storage"] } },
    { wide: { source_url: "https://official.example", topics: [""] } },
  ])
    expect(() => applyVenueScopes([], raw)).toThrow();
});
it("embeds separate CFP topics and never reads paper fields", () => {
  const actual = topicProfileTexts([
    {
      key: "wide",
      title: "Wide",
      full_name: "Research Conference",
      official_scope: ["storage, networking; memory management"],
      papers: ["evaluation trap"],
      paper_abstracts: ["abstract trap"],
    },
    { key: "other", title: "Other", scope: "language models" },
  ]);
  expect(actual).toEqual({
    keys: ["wide", "wide", "wide", "other"],
    texts: [
      "Research Conference. storage",
      "Research Conference. networking",
      "Research Conference. memory management",
      "Other. language models",
    ],
  });
});
it("retrieves a matching official topic even when the broad venue centroid is orthogonal", () => {
  const topics = {
    wide: [
      [0.8, 0.6],
      [-1, 0],
    ],
  };
  expect(R.semanticSimilarity("wide", [1, 0], { wide: [0, 1] }, null, topics)).toBeCloseTo(0.8);
  expect(R.semanticScore("wide", [1, 0], { wide: [0, 1] }, null, topics)).toBe(75);
  expect(R.semanticSimilarity("wide", [1, 0], { wide: [0, 1] }, null, {})).toBe(0);
});
it("validates topic vector dimensions and malformed components in the actual browser parser", () => {
  const source = readFileSync(join(REPO_ROOT, "site/app.ts"), "utf8");
  const declarations = ["isRecord", "vector", "topicVectorMap"]
    .map((name) => jsFunction(source, name))
    .join("\n");
  const parse = new Function(`${stripTypeScriptTypes(declarations)}; return topicVectorMap;`)() as (
    value: unknown,
    dim: number,
  ) => unknown;
  expect(parse({ wide: [[1, 0]] }, 2)).toEqual({ wide: [[1, 0]] });
  for (const value of [null, { wide: [[1]] }, { wide: [[1, NaN]] }, { wide: ["bad"] }])
    expect(parse(value, 2)).toBeNull();
  expect(parse(undefined, 2)).toEqual({});
});

it("uses distinct topic evidence without boosting repeated copies of one topic", () => {
  const one = R.semanticSimilarity("wide", [1, 0], { wide: [0, 1] }, null, { wide: [[0.8, 0.6]] });
  const duplicate = R.semanticSimilarity("wide", [1, 0], { wide: [0, 1] }, null, {
    wide: [
      [0.8, 0.6],
      [0.8, 0.6],
      [0.8, 0.6],
    ],
  });
  const distinct = R.semanticSimilarity("wide", [1, 0], { wide: [0, 1] }, null, {
    wide: [
      [0.8, 0.6],
      [0.8, -0.6],
    ],
  });
  expect(duplicate).toBe(one);
  expect(distinct).toBeGreaterThan(one);
  expect(distinct).toBeLessThanOrEqual(1);
});

it("expands real scientific English plurals without matching embedded letter sequences", () => {
  const text = (title: string) => R.queryText([{ title, abstract: "", keywords: "", venue: "" }]);
  expect(text("Large language models with uncertainty")).toContain("neural machine learning");
  expect(text("LLMs with uncertainty")).toContain("neural machine learning");
  expect(text("INLA for statistical inference")).toContain(
    "integrated nested Laplace approximation",
  );
  expect(text("Inland geography and llama behavior")).not.toContain(
    "integrated nested Laplace approximation",
  );
  expect(text("Inland geography and llama behavior")).not.toContain("neural machine learning");
});

it("adds Japanese field vocabulary to international CFP topics without altering English profiles", () => {
  const venue = {
    key: "international",
    full_name: "International Interface Conference",
    categories: ["hci"],
    official_scope: ["Tangible and ubiquitous computing"],
  };
  const english = topicProfileTexts([venue], { hci: "Human-Computer Interaction" }, false);
  const japanese = topicProfileTexts([venue], { hci: "Human-Computer Interaction" }, true);
  expect(english.texts[0]).toBe(
    "International Interface Conference. Tangible and ubiquitous computing. Human-Computer Interaction",
  );
  expect(japanese.texts[0]).toMatch(/^Tangible and ubiquitous computing\./);
  expect(japanese.texts[0]).toMatch(/International Interface Conference$/);
  expect(japanese.texts[0]).toContain("ユーザインタフェース");
  expect(japanese.texts[0]).toContain("Tangible and ubiquitous computing");
  expect(venue).toEqual({
    key: "international",
    full_name: "International Interface Conference",
    categories: ["hci"],
    official_scope: ["Tangible and ubiquitous computing"],
  });
});

it("keeps autoregressive modeling distinct from ordinary regression", () => {
  const autoregressive = R.queryText([
    { title: "自己回帰モデルの推定", abstract: "", keywords: "", venue: "" },
  ]);
  expect(autoregressive).toContain("autoregressive modeling");
  expect(autoregressive).not.toContain("regression statistical learning");
  const regression = R.queryText([
    { title: "回帰モデルの汎化", abstract: "", keywords: "", venue: "" },
  ]);
  expect(regression).toContain("regression statistical learning");
});
