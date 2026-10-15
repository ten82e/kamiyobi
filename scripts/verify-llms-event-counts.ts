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
const root = mkdtempSync(join(tmpdir(), "kamiyobi-event-count-mutations-"));
for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
mkdirSync(join(root, "tests"));
for (const file of ["llms_event_counts.test.ts", "llms_build_counts.test.ts"])
  cpSync(join(repo, "tests", file), join(root, "tests", file));
for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(root, file));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(
  join(root, "vitest.config.ts"),
  'import {defineConfig} from "vitest/config";export default defineConfig({test:{include:["tests/llms*counts.test.ts"],maxWorkers:1}});',
);
const file = "src/build.ts";
const original = readFileSync(join(root, file), "utf8");
function run(label: string, broken: boolean) {
  for (const dir of ["data", "public", ".cache"])
    assert(!existsSync(join(root, dir)), `${label}: generated input present: ${dir}`);
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
    { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  writeFileSync(join(root, `${label}.log`), `${child.stdout ?? ""}${child.stderr ?? ""}`);
  assert(!child.error, String(child.error));
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.numTotalTests, 12, `${label}: required tests missing`);
  assert.equal(report.numPendingTests, 0, `${label}: tests skipped`);
  assert.equal(child.status === 0, !broken, `${label}: inspect ${root}`);
  if (broken) {
    assert(
      report.testResults.some(
        (suite: { assertionResults: Array<{ status: string; failureMessages: string[] }> }) =>
          suite.assertionResults.some(
            (test) =>
              test.status === "failed" &&
              test.failureMessages.some((message) => message.includes("AssertionError")),
          ),
      ),
      `${label}: no count assertion failed`,
    );
    if (label !== "thousands-grouping-lost") {
      const suite = report.testResults.find((suite: { name: string }) =>
        suite.name.endsWith("/llms_build_counts.test.ts"),
      );
      assert(
        suite?.assertionResults.some(
          (test: { status: string; failureMessages: string[] }) =>
            test.status === "failed" &&
            test.failureMessages.some(
              (message) => message.includes("AssertionError") && message.includes("llms.txt"),
            ),
        ),
        `${label}: real build assertions did not detect fault`,
      );
    }
  } else assert.equal(report.numFailedTests, 0);
  for (const dir of ["data", "public", ".cache"])
    assert(!existsSync(join(root, dir)), `${label}: unexpectedly created ${dir}`);
  console.log(
    `${label}: ${report.numPassedTests} passed / ${report.numFailedTests} failed; data/public/cache absent`,
  );
}
const faults = [
  ["build-drops-data", "      data as Record<string, unknown>,", "      undefined,"],
  [
    "build-passes-catalog-instead-of-history",
    "      data as Record<string, unknown>,",
    "      catalog as Record<string, unknown>,",
  ],
  ["fixed-category-counts", "版.filter((e) => e.確かさ === 確かさ).length", "2249"],
  [
    "only-first-edition-counted",
    "jsonRecords(conf.editions).map((edition) => ({\n          確かさ:",
    "jsonRecords(conf.editions).slice(0,1).map((edition) => ({\n          確かさ:",
  ],
  ["wrong-precision-class", "e.確かさ === 確かさ", "e.確かさ !== 確かさ"],
  [
    "exact-dates-included-in-other",
    'e.確かさ !== "exact-range" && e.確かさ !== "single-day"',
    'e.確かさ !== "exact-range" || e.確かさ !== "single-day"',
  ],
  [
    "missing-dates-counted",
    '其の外.filter((e) => String(e.始まる日 ?? "").trim()).length',
    "其の外.length",
  ],
  ["fixed-coverage-count", "千の桁(其の外.length)", '"243"'],
  [
    "thousands-grouping-lost",
    String.raw`const 千の桁 = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");`,
    "const 千の桁 = (n: number): string => String(n);",
  ],
];
console.log(`Isolated copy: ${root}`);
run("baseline", false);
try {
  for (const [label, needle, replacement] of faults) {
    assert.equal(original.split(needle).length, 2, `${label}: ambiguous mutation target`);
    writeFileSync(join(root, file), original.replace(needle, replacement));
    try {
      run(label, true);
    } finally {
      writeFileSync(join(root, file), original);
    }
  }
} finally {
  writeFileSync(join(root, file), original);
}
run("restored", false);
assert.equal(
  readFileSync(join(repo, file), "utf8"),
  original,
  "workspace changed during isolated checks",
);
console.log(
  `Detected ${faults.length}/${faults.length} faults; workspace unchanged. Logs: ${root}`,
);
