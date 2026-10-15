import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-mcp-interrupted-mutations-"));
for (const directory of ["src", "site"])
  cpSync(join(repo, directory), join(root, directory), { recursive: true });
mkdirSync(join(root, "tests/fixtures"), { recursive: true });
for (const file of [
  "mcp_interrupted_models.integration.ts",
  "mcp_recovery_case.ts",
  "interrupted_model_download.mjs",
  "live_consumer_site.ts",
  "full_venue_pool.ts",
])
  cpSync(join(repo, "tests", file), join(root, "tests", file));
cpSync(join(repo, "tests/fixtures"), join(root, "tests/fixtures"), { recursive: true });
mkdirSync(join(root, "data"));
for (const file of ["manual.yaml", "curated.generated.yaml", "overrides.yaml"])
  cpSync(join(repo, "data", file), join(root, "data", file));
for (const file of ["config.yaml", "package.json", "tsconfig.json"])
  cpSync(join(repo, file), join(root, file));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(
  join(root, "vitest.config.ts"),
  'import {defineConfig} from "vitest/config";export default defineConfig({test:{include:["tests/mcp_interrupted_models.integration.ts"],maxWorkers:1,hookTimeout:1200000,testTimeout:180000}});',
);
const files = ["src/semantic-profile-cache.ts", "src/embedding-runtime.ts"];
const originals = Object.fromEntries(
  files.map((file) => [file, readFileSync(join(repo, file), "utf8")]),
);
function run(label: string, broken: boolean) {
  for (const file of [
    "public",
    "data/snapshot.json",
    "data/venue-profiles.json",
    "data/recommender-reranker.json",
  ])
    assert(!existsSync(join(root, file)), `generated prerequisite present: ${file}`);
  const output = join(root, `${label}.json`);
  const child = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "--reporter=json",
      "--outputFile",
      output,
    ],
    { cwd: root, encoding: "utf8", timeout: 1200000, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(join(root, `${label}.log`), `${child.stdout ?? ""}${child.stderr ?? ""}`);
  assert(!child.error, String(child.error));
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.numTotalTests, 25, "evaluation case count changed");
  assert.equal(report.numPendingTests, 0, "required evaluation skipped");
  assert.equal(child.status === 0, !broken, `inspect ${root}/${label}.log`);
  if (broken) {
    assert.equal(
      report.numFailedTests,
      25,
      "every recovery check must fail for this preparation fault",
    );
    assert(
      report.testResults.some(
        (suite: {
          assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>;
        }) =>
          suite.assertionResults.some(
            (test) =>
              test.fullName.includes("interrupted recovery") &&
              test.status === "failed" &&
              test.failureMessages.some(
                (message) =>
                  message.includes("AssertionError") &&
                  message.includes("preparation retry must recover"),
              ),
          ),
      ),
      `${label}: no recovery behavior assertion failed`,
    );
  } else assert.equal(report.numFailedTests, 0);
  console.log(
    `${label}: ${report.numPassedTests} passed / ${report.numFailedTests} failed; generated prerequisites absent`,
  );
}
console.log(`Isolated copy: ${root}`);
run("baseline", false);
try {
  for (const [label, file, needle, replacement] of [
    [
      "partial-cache-rejected",
      files[1],
      "if (existsSync(target)) continue;",
      'if (existsSync(target)) throw new Error("injected refusal to retry incomplete cache");',
    ],
  ]) {
    assert.equal(originals[file].split(needle).length, 2, `${label}: ambiguous mutation target`);
    writeFileSync(join(root, file), originals[file].replace(needle, replacement));
    try {
      run(label, true);
    } finally {
      writeFileSync(join(root, file), originals[file]);
    }
  }
} finally {
  for (const file of files) writeFileSync(join(root, file), originals[file]);
}
run("restored", false);
for (const file of files)
  assert.equal(readFileSync(join(repo, file), "utf8"), originals[file], "workspace changed");
console.log(`Detected 1/1 fault. Workspace unchanged. Logs: ${root}`);
