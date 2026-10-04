import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";
import { expect, it } from "vitest";
import { RECOMMENDATION_GATE_INPUTS, recommendationGatePolicyId } from "../src/semantic-content.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("invalidates a sealed policy when baseline, fixtures, floors or gate wiring change", () => {
  const root = tempWork("kamiyobi-gate-policy-");
  const rootUrl = pathToFileURL(`${root}/`);
  for (const path of RECOMMENDATION_GATE_INPUTS) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(REPO_ROOT, path)));
  }
  const original = recommendationGatePolicyId();
  expect(recommendationGatePolicyId(rootUrl)).toBe(original);
  for (const path of [
    "data/benchmarks/real-paper-feature-baseline.json",
    "data/benchmarks/real-paper-features.jsonl",
    "data/benchmarks/real-paper-heldout.json",
    "data/benchmarks/real-paper-required-manifest.json",
    "src/bench-recommender.ts",
    ".github/workflows/recommendation-bundle.yml",
  ]) {
    const target = join(root, path);
    const originalBytes = readFileSync(target);
    writeFileSync(target, Buffer.concat([originalBytes, Buffer.from("\n")]));
    expect(recommendationGatePolicyId(rootUrl), path).not.toBe(original);
    writeFileSync(target, originalBytes);
  }
  writeFileSync(join(root, "data/snapshot.json"), "deadline-only update");
  expect(recommendationGatePolicyId(rootUrl)).toBe(original);
  const cli = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/semantic-content.ts"), "--gate-policy"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout).toBe(original);
});

it("runs the workflow reuse check and refuses missing or previous policy identities", () => {
  const workflow = loadYaml(
    readFileSync(join(REPO_ROOT, ".github/workflows/recommendation-bundle.yml"), "utf8"),
  ) as {
    jobs: { build: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
  };
  const step = workflow.jobs.build.steps.find(
    (step) => step.name === "Reuse sealed bundle or mark semantic change",
  )!;
  expect(step.env?.GATE_POLICY_ID).toContain("steps.content.outputs.gate_id");
  const check = step.run!.match(/if node -e '([\s\S]*?)' "\$manifest"; then/)?.[1];
  expect(check).toBeTruthy();
  const root = tempWork("kamiyobi-reuse-policy-");
  const manifest = join(root, "recommendation-bundle.json");
  const policy = recommendationGatePolicyId();
  const run = (gatePolicy: string | undefined) => {
    writeFileSync(
      manifest,
      JSON.stringify({
        semantic_content_id: "unchanged",
        gate_policy_id: gatePolicy,
        required_gate: "passed",
        full_benchmark: "passed",
      }),
    );
    return spawnSync(process.execPath, ["-e", check!, manifest], {
      encoding: "utf8",
      env: { ...process.env, CONTENT_ID: "unchanged", GATE_POLICY_ID: policy },
    }).status;
  };
  expect(run(policy)).toBe(0);
  expect(run(undefined)).not.toBe(0);
  expect(run("previous-policy")).not.toBe(0);
});

it("blocks the production restore CLI when a bundle is unavailable", () => {
  const root = tempWork("kamiyobi-restore-fail-");
  const cli = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/restore-recommendation-bundle.ts"), root, root],
    { encoding: "utf8" },
  );
  expect(cli.status).not.toBe(0);
  expect(cli.stderr).toContain("semantic deployment blocked");
});
