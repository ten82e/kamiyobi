import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string; [key: string]: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflow(path: string): { text: string; value: Workflow } {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return { text, value: loadYaml(text) as Workflow };
}

function step(job: { steps?: Step[] }, name: string): Step {
  const found = job.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing workflow step: ${name}`);
  return found;
}

describe("automation writer", () => {
  it("has one guarded writer which compares and stages snapshot, primary, and candidates", () => {
    const { text, value } = workflow("../.github/workflows/update.yml");
    const job = value.jobs?.["build-and-deploy"];
    expect(job).toBeDefined();
    expect(job!.steps?.[0]?.with).toMatchObject({ ref: "main", "fetch-depth": 0 });
    const writer = step(job!, "Create guarded data PR");
    const run = String(writer.run);
    expect(writer["continue-on-error"]).toBe(true);
    expect(run).toContain("node scripts/compare-head.ts data/snapshot.json");
    expect(run).toContain("node scripts/compare-head.ts data/primary_overrides.yaml");
    expect(run).toContain("node scripts/compare-head.ts data/discovered_candidates.yaml");
    expect(run).toContain("git add data/discovered_candidates.yaml");
    const guard = step(job!, "Verify main has not moved");
    expect(String(guard.run)).toContain("git rev-parse origin/main");
    expect(guard["continue-on-error"]).toBeUndefined();
    const deployGuard = step(job!, "Verify main immediately before deploy");
    expect(String(deployGuard.run)).toContain("git rev-parse origin/main");
    expect(String(step(job!, "Upload Pages artifact").if)).toContain("main-guard.outcome");
    expect(String(step(job!, "Deploy to GitHub Pages").if)).toContain("deploy-guard.outcome");
    expect(run).toContain("recommendation Top-5 changes");
    expect(run).toContain("sourceStatus(baselineHealth)");
    expect(run).toContain("health transitions: sources");
    expect(run).toContain("future confirmed");
    expect(run).toContain("source failures:");
    expect(text).not.toContain("git pull --rebase");
    expect(text).not.toContain("[skip ci]");
    expect((text.match(/git push origin/g) ?? []).length).toBe(1);
    expect((text.match(/gh pr create/g) ?? []).length).toBe(1);
  });

  it("builds a committed baseline and evaluates its recommendation index against the update", () => {
    const { value } = workflow("../.github/workflows/update.yml");
    const job = value.jobs?.["build-and-deploy"];
    if (!job) throw new Error("missing build-and-deploy job");
    expect(String(step(job, "Build committed baseline").run)).toContain(
      "--offline --no-embeddings",
    );
    expect(String(step(job, "Recommendation Top-5 delta").run)).toContain(
      "--data-delta-before /tmp/kamiyobi-baseline/recommendation-index.json",
    );
    expect(String(step(job, "Validate generated production data").run)).toBe(
      "npm run validate:data -- public/data.json --json",
    );
    const names = job.steps?.map((candidate) => candidate.name) ?? [];
    expect(names.indexOf("Validate generated production data")).toBeGreaterThan(
      names.indexOf("Build deadline bundle"),
    );
    expect(names.indexOf("Verify main immediately before deploy")).toBeGreaterThan(
      names.indexOf("Upload Pages artifact"),
    );
    expect(String(step(job, "Recommendation Top-5 delta").run)).toContain(
      "--data-delta-after public/recommendation-index.json",
    );
  });
});

describe("independently requireable CI jobs", () => {
  it("reports all seven jobs on every push and pull request with their focused contracts", () => {
    const { text, value } = workflow("../.github/workflows/ci.yml");
    expect(text).not.toContain("paths-ignore");
    const jobs = value.jobs ?? {};
    const expected: Record<string, string> = {
      typecheck: "npm run typecheck",
      lint: "npm run check",
      "unit-integration-tests": "npm test",
      "offline-build":
        "node src/cli.ts build --out /tmp/kamiyobi-offline-site --offline --no-embeddings",
      "validate-data": "npm run validate:data -- --json",
      "health-transition": "tests/health_gate.test.ts",
      "recommendation-regression": "--data-delta tests/fixtures/recommendation-data-delta.json",
    };
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, command] of Object.entries(expected)) {
      expect(
        (jobs[name]?.steps ?? []).some((candidate) => String(candidate.run).includes(command)),
      ).toBe(true);
    }
    expect(String(step(jobs["offline-build"]!, "Check offline result").run)).toContain(
      "data.conferences.length < 150",
    );
    const regression = jobs["recommendation-regression"]!;
    expect(String(step(regression, "Build pull-request base recommendation index").run)).toContain(
      "git worktree add",
    );
    expect(String(step(regression, "Compare recommendation indexes").run)).toContain(
      "--data-delta-before /tmp/kamiyobi-base-public/recommendation-index.json",
    );
    expect(String(step(jobs["offline-build"]!, "Check offline result").run)).toContain(
      '"app.js", "recommender.js", "recommendation-core.js", "publish.js"',
    );
  });
});
