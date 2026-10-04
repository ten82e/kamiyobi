import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { tempWork } from "./helpers.ts";

const workflow = load(readFileSync(".github/workflows/update-data.yml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
};
const run = workflow.jobs["write-data-pr"].steps.find(
  (s) => s.name === "Create or update guarded data PR",
)!.run!;
const block = run.slice(
  run.indexOf("# Preserve prior generated history"),
  run.indexOf("\n\nnode --input-type=module"),
);
function fixture(existing = true, unrelated = false) {
  const root = tempWork("updater-fast-forward-");
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, "data/snapshot.json"), "baseline");
  git("add", ".");
  git("commit", "-m", "baseline");
  git("remote", "add", "origin", remote);
  git("push", "origin", "main");
  let old = "";
  if (existing) {
    git("switch", "-c", "automation/data-update");
    writeFileSync(join(repo, "data/snapshot.json"), "prior-generated");
    if (unrelated) writeFileSync(join(repo, "unrelated.txt"), "preserve this edit");
    git("add", ".");
    git("commit", "-m", "prior generated data");
    old = git("rev-parse", "HEAD");
    git("push", "origin", "automation/data-update");
    git("switch", "main");
  }
  writeFileSync(join(repo, "code.txt"), "current main source");
  git("add", ".");
  git("commit", "-m", "current main");
  const main = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  git("switch", "-C", "automation/data-update");
  writeFileSync(join(repo, "data/snapshot.json"), "new validated data");
  git("add", "data/snapshot.json");
  git("commit", "-m", "new validated data");
  const execute = () =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${block}`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          branch: "automation/data-update",
          existing_branch: existing ? "true" : "false",
          start_sha: main,
        },
      },
    );
  return { root, repo, remote, git, old, main, execute };
}
describe("normal automatic data pushes", () => {
  it("publishes a new generated branch without force", () => {
    const f = fixture(false);
    expect(f.execute().status).toBe(0);
    expect(f.git("show", "origin/automation/data-update:data/snapshot.json")).toBe(
      "new validated data",
    );
  });
  it("retains prior update and current-main ancestry while publishing the validated tree", () => {
    const f = fixture();
    expect(f.execute().status).toBe(0);
    for (const ancestor of [f.old, f.main])
      expect(
        spawnSync(
          "git",
          ["merge-base", "--is-ancestor", ancestor, "origin/automation/data-update"],
          { cwd: f.repo },
        ).status,
      ).toBe(0);
    expect(f.git("show", "origin/automation/data-update:code.txt")).toBe("current main source");
    expect(f.git("show", "origin/automation/data-update:data/snapshot.json")).toBe(
      "new validated data",
    );
  });
  it("refuses unrelated branch edits and leaves the remote head intact", () => {
    const f = fixture(true, true);
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("refusing to replace");
    expect(f.git("rev-parse", "origin/automation/data-update")).toBe(f.old);
  });
  it("rejects a concurrent remote advance instead of overwriting it", () => {
    const f = fixture();
    const race = join(f.root, "race");
    execFileSync("git", ["clone", "--branch", "automation/data-update", f.remote, race], {
      stdio: "pipe",
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: race, encoding: "utf8", stdio: "pipe" }).trim();
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(race, "data/snapshot.json"), "concurrent data");
    git("add", ".");
    git("commit", "-m", "concurrent update");
    git("push", "origin", "automation/data-update");
    const advanced = git("rev-parse", "HEAD");
    expect(f.execute().status).not.toBe(0);
    expect(git("rev-parse", "origin/automation/data-update")).toBe(advanced);
  });
});
