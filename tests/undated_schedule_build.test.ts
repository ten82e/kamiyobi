import { cpSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { buildAll, ROOT, setRoot } from "../src/build.ts";
import { makeConference, makeEdition, REPO_ROOT, tempWork } from "./helpers.ts";

it("retains unannounced editions in the initial catalog while excluding them from dated public tables", async () => {
  const root = tempWork("kamiyobi-undated-catalog-");
  for (const dir of ["site", "scripts", "src"])
    cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"])
    cpSync(join(REPO_ROOT, file), join(root, file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const input = [null, "2027-01-01", "2028-02-22"].map((date, i) =>
    makeConference({
      key: `undated-${i}`,
      title: `未発表研究会${i}`,
      editions: [
        makeEdition({
          year: 2030,
          edition_id: `edition-${i}`,
          event_date_precision: "not-announced",
          event_start: date ? new Date(date) : null,
          event_end: date ? new Date(date) : null,
        }),
      ],
    }),
  );
  const saved = JSON.stringify(input);
  const previousRoot = ROOT;
  setRoot(root);
  try {
    expect(existsSync(join(root, "data"))).toBe(false);
    await buildAll(input, {}, join(root, "out"), new Date("2028-02-20T03:00:00Z"), {
      noEmbeddings: true,
      localEmbeddingsOnly: true,
      venuePapers: {},
      reranker: null,
    });
    const catalog = JSON.parse(readFileSync(join(root, "out/catalog.json"), "utf8"));
    const data = JSON.parse(readFileSync(join(root, "out/data.json"), "utf8"));
    const rows = Recommender.scheduleOnlyEditions(catalog);
    expect(rows.map((r) => r.key).sort()).toEqual(["undated-0", "undated-1", "undated-2"]);
    for (let i = 0; i < input.length; i++) {
      const conf = catalog.conferences.find((c: { key: string }) => c.key === `undated-${i}`);
      expect(conf.editions).toEqual(
        data.conferences.find((c: { key: string }) => c.key === conf.key).editions,
      );
      expect(conf.editions[0]).toMatchObject({
        id: `edition-${i}`,
        year: 2030,
        event_date_precision: "not-announced",
      });
      for (const file of ["upcoming.md", "upcoming.html"]) {
        expect(readFileSync(join(root, "out", file), "utf8")).not.toContain(`未発表研究会${i}`);
      }
    }
    expect(JSON.stringify(input)).toBe(saved);
    expect(existsSync(join(root, "data"))).toBe(false);
  } finally {
    setRoot(previousRoot);
  }
});
