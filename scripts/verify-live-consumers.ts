import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "kamiyobi-live-consumer-mutations-"));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
mkdirSync(join(root, "tests"));
mkdirSync(join(root, "tests/fixtures"));
for (const name of readdirSync(join(repo, "tests/fixtures")))
  if (/^live-consumer-.*\.json$/.test(name))
    cpSync(join(repo, "tests/fixtures", name), join(root, "tests/fixtures", name));
cpSync(
  join(repo, "tests/fixtures/full-pool-sources"),
  join(root, "tests/fixtures/full-pool-sources"),
  { recursive: true },
);
for (const name of ["live_consumers.integration.ts", "live_consumer_site.ts", "full_venue_pool.ts"])
  cpSync(join(repo, "tests", name), join(root, "tests", name));
mkdirSync(join(root, "data"));
for (const name of ["manual.yaml", "curated.generated.yaml", "overrides.yaml"])
  cpSync(join(repo, "data", name), join(root, "data", name));
for (const name of ["config.yaml", "package.json", "tsconfig.json"])
  cpSync(join(repo, name), join(root, name));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
mkdirSync(join(root, ".cache"));
symlinkSync(join(repo, ".cache/embedding-models"), join(root, ".cache/embedding-models"));
writeFileSync(
  join(root, "vitest.config.ts"),
  `import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:["tests/live_consumers.integration.ts"],maxWorkers:1,hookTimeout:1800000,testTimeout:180000}});`,
);
const files = ["site/recommendation.ts"];
const original = Object.fromEntries(
  files.map((file) => [file, readFileSync(join(root, file), "utf8")]),
);
const fingerprint = () =>
  files
    .map((file) =>
      createHash("sha256")
        .update(readFileSync(join(repo, file)))
        .digest("hex"),
    )
    .join(":");
const before = fingerprint();
function run(label: string, broken: boolean) {
  for (const forbidden of [
    "public",
    "data/snapshot.json",
    "data/source-snapshots",
    "data/venue-profiles.json",
    "data/recommender-reranker.json",
  ])
    assert(!existsSync(join(root, forbidden)), `generated prerequisite present: ${forbidden}`);
  const output = join(root, `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "--reporter=json",
      "--outputFile",
      output,
    ],
    { cwd: root, encoding: "utf8", timeout: 1800000, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(join(root, `${label}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert(!result.error, String(result.error));
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.numPendingTests, 0, `${label}: required checks skipped`);
  const assertions = report.testResults.flatMap(
    (suite: {
      assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>;
    }) => suite.assertionResults,
  );
  assert.equal(assertions.length, 304, `${label}: evaluation cases changed`);
  if (broken) {
    assert.notEqual(result.status, 0, `${label}: fault survived`);
    assert(
      assertions.some(
        (test: { status: string; failureMessages: string[] }) =>
          test.status === "failed" &&
          test.failureMessages.some((text) => text.includes("AssertionError")),
      ),
      `${label}: no behavioral assertion failed`,
    );
  } else {
    assert.equal(result.status, 0, `${label}: inspect ${root}`);
    assert.equal(report.numFailedTests, 0);
  }
  console.log(
    `${label}: ${report.numPassedTests} passed / ${report.numFailedTests} failed; generated prerequisites absent`,
  );
}
console.log(`Isolated copy: ${root}`);
run("baseline", false);
const faults = [
  {
    id: "lexical-ranking-disabled",
    file: files[0],
    needle: "(retrieval.get(b.venueKey) ?? 0) - (retrieval.get(a.venueKey) ?? 0)",
    replacement: "0",
  },
  {
    id: "topic-focus-disabled",
    file: files[0],
    needle: "const primary = lines[0];",
    replacement: "if (query) return [{ text: query, weight: 1 }]; const primary = lines[0];",
  },
];
try {
  for (const fault of faults) {
    assert.equal(
      original[fault.file].split(fault.needle).length,
      2,
      `${fault.id}: ambiguous target`,
    );
    writeFileSync(
      join(root, fault.file),
      original[fault.file].replace(fault.needle, fault.replacement),
    );
    run(fault.id, true);
    writeFileSync(join(root, fault.file), original[fault.file]);
  }
} finally {
  for (const file of files) writeFileSync(join(root, file), original[file]);
}
run("restored", false);
assert.equal(fingerprint(), before, "workspace changed during isolated faults");
console.log(
  `Detected ${faults.length}/${faults.length} faults. Workspace unchanged. Logs: ${root}`,
);
