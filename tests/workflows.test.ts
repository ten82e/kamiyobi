import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Workflow = {
  jobs?: Record<string, { if?: string; permissions?: Record<string, string>; steps?: Step[] }>;
};

const PINS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
  "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0",
  "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0",
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0",
  "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2",
];

function workflow(path: string): { text: string; value: Workflow } {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return { text, value: loadYaml(text) as Workflow };
}

function step(job: { steps?: Step[] }, name: string): Step {
  const found = job.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing workflow step: ${name}`);
  return found;
}

describe("workflow separation", () => {
  it("replaces update.yml with a fixed-branch update writer and no Pages access", () => {
    expect(existsSync(new URL("../.github/workflows/update.yml", import.meta.url))).toBe(false);
    const { text, value } = workflow("../.github/workflows/update-data.yml");
    const generated = value.jobs?.["generate-data"];
    const writer = value.jobs?.["write-data-pr"];
    const fallback = value.jobs?.["trigger-fallback-ci"];
    expect(text).toContain("schedule:");
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toMatch(/\bpages\b|deploy-pages|upload-pages/i);
    expect(generated?.permissions).toEqual({ contents: "read" });
    expect(writer?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(fallback?.permissions).toEqual({ actions: "write", contents: "read" });
    expect(String(step(generated!, "Build committed baseline").run)).toContain(
      "--offline --no-embeddings",
    );
    expect(String(step(generated!, "Fetch primary sources").run)).toContain(
      "fetch-primary.ts --apply",
    );
    expect(String(step(generated!, "Discover candidates").run)).toContain(
      "--candidate-out data/discovered_candidates.yaml",
    );
    expect(String(step(generated!, "Health gate").run)).toContain("--require-baseline");
    expect(String(step(generated!, "Recommendation Top-5 delta").run)).toContain(
      "--data-delta-before",
    );
    const run = String(step(writer!, "Create or update guarded data PR").run);
    expect(run).toContain("automation/data-update");
    expect(run).toContain("git push --force-with-lease");
    expect(run).toContain("git rev-parse origin/main");
    expect(run).toContain("gh pr close");
    expect(run).toContain("Validator category changes");
    expect(run).toContain("gh pr edit");
    expect(run).toContain('git push origin --delete "$branch"');
    expect(String(step(fallback!, "Trigger CI for GITHUB_TOKEN update").run)).toContain(
      "gh workflow run ci.yml --ref automation/data-update",
    );
    expect(String(step(writer!, "Create GitHub App token").uses)).toContain(
      "create-github-app-token@",
    );
    expect(step(writer!, "Create GitHub App token").with).toHaveProperty("client-id");
    expect(step(writer!, "Download generated update").with?.path).toBe("/tmp/kamiyobi-update");
    expect(String(step(writer!, "Restore generated data").run)).toContain("data/");
    expect(String(step(writer!, "Create or update guarded data PR").run)).not.toContain(
      "continue-on-error",
    );
  });

  it("deploys only main and attests the final publish manifest", () => {
    const { text, value } = workflow("../.github/workflows/deploy.yml");
    const build = value.jobs?.build;
    const attest = value.jobs?.attest;
    const deploy = value.jobs?.deploy;
    expect(text).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(text).toMatch(/workflow_run:[\s\S]*branches: \[main\]/);
    expect(String(build?.if)).toContain("head_branch == 'main'");
    expect(text).not.toContain("workflow_dispatch:");
    expect(text).toContain("name: github-pages");
    expect(text).toContain("attestations: write");
    expect(String(step(build!, "Checkout merged main").with?.ref)).toContain("github.sha");
    expect(String(step(build!, "Checkout nightly commit").with?.ref)).toContain(
      "workflow_run.head_sha",
    );
    expect(String(step(build!, "Build merged site").run)).toContain("--offline");
    expect(String(step(build!, "Health gate").run)).toContain("--require-baseline");
    expect(String(step(build!, "Health gate").run)).toContain('cd "$GITHUB_WORKSPACE"');
    expect(String(step(attest!, "Attest publish manifest").with?.["subject-path"])).toBe(
      "public/publish.json",
    );
    expect(build?.permissions).toEqual({ actions: "read", contents: "read" });
    expect(attest?.permissions).toEqual({
      contents: "read",
      attestations: "write",
      "id-token": "write",
    });
    expect(deploy?.permissions).toEqual({ pages: "write", "id-token": "write" });
  });
});

describe("CI contracts", () => {
  it("keeps seven CI jobs, adds dispatch, and reserves the full benchmark for nightly", () => {
    const { text, value } = workflow("../.github/workflows/ci.yml");
    expect(text).toContain("workflow_dispatch:");
    expect(Object.keys(value.jobs ?? {}).sort()).toEqual([
      "health-transition",
      "lint",
      "offline-build",
      "recommendation-regression",
      "typecheck",
      "unit-integration-tests",
      "validate-data",
    ]);
    expect(
      String(
        step(
          value.jobs!["recommendation-regression"]!,
          "Run fixed semantic-score recommendation gate",
        ).run,
      ),
    ).toContain("--v2 tests/fixtures/bench-v2.json");
    const nightly = workflow("../.github/workflows/nightly.yml").text;
    expect(nightly).toContain("schedule:");
    expect(nightly).toContain("release:");
    expect(nightly).toContain("Run full real-paper benchmark");
  });

  it("uses approved full-SHA actions and normal npm installs", () => {
    for (const path of ["ci.yml", "update-data.yml", "deploy.yml", "nightly.yml"]) {
      const text = workflow(`../.github/workflows/${path}`).text;
      expect(text).not.toMatch(/continue-on-error|npm ci --ignore-scripts/);
      expect(text).not.toMatch(/@v\d/);
      for (const pin of PINS.filter((candidate) => text.includes(candidate.split("@")[0]))) {
        expect(text).toContain(pin);
      }
      expect(text).toContain("persist-credentials: false");
    }
  });
});
