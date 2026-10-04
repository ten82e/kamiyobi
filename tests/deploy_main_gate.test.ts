import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it("runs the deploy main gate and fails lookup errors or empty SHA instead of succeeding as stale", () => {
  const workflow = loadYaml(
    readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8"),
  ) as {
    jobs: { gate: { steps: { name: string; run: string }[] } };
  };
  const step = workflow.jobs.gate.steps.find(
    (step) => step.name === "Check trigger is current main",
  )!;
  const runBlock = step.run.replaceAll("$" + "{{ github.repository }}", "ten82e/kamiyobi");
  const root = tempWork("kamiyobi-main-gate-");
  const git = join(root, "git");
  const output = join(root, "outputs");
  writeFileSync(
    git,
    '#!/bin/bash\nif [ "$LOOKUP_CASE" = error ]; then exit 17; fi\nif [ "$LOOKUP_CASE" = empty ]; then exit 0; fi\nprintf "%s\\trefs/heads/main\\n" "$LOOKUP_SHA"\n',
  );
  chmodSync(git, 0o755);
  const trigger = "a".repeat(40);
  const run = (lookupCase: string, lookupSha = trigger) => {
    writeFileSync(output, "");
    const result = spawnSync("/bin/bash", ["-e", "-c", runBlock], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        TRIGGER_SHA: trigger,
        LOOKUP_CASE: lookupCase,
        LOOKUP_SHA: lookupSha,
      },
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  for (const [mode, sha] of [
    ["error", trigger],
    ["empty", trigger],
    ["ok", "malformed"],
  ]) {
    const result = run(mode!, sha);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.stdout).not.toContain("stale trigger");
  }
  const current = run("ok");
  expect(current.status, current.stderr).toBe(0);
  expect(current.output).toBe("current=true\n");
  const stale = run("ok", "b".repeat(40));
  expect(stale.status, stale.stderr).toBe(0);
  expect(stale.output).toBe("current=false\n");
});
