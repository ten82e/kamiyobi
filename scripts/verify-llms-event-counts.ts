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
for (const dir of ["src", "site", "scripts"])
  cpSync(join(repo, dir), join(root, dir), { recursive: true });
mkdirSync(join(root, "tests"));
for (const file of ["llms_event_counts.test.ts", "llms_build_counts.test.ts"])
  cpSync(join(repo, "tests", file), join(root, "tests", file));
for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(root, file));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
writeFileSync(
  join(root, "vitest.config.ts"),
  'import {defineConfig} from "vitest/config";export default defineConfig({test:{include:["tests/llms*counts.test.ts"],maxWorkers:1,testTimeout:180000}});',
);
const file = "src/build.ts";
const original = readFileSync(join(root, file), "utf8");
const cliFile = "src/cli.ts";
const cliOriginal = readFileSync(join(root, cliFile), "utf8");
const ccfFile = "src/sources/ccfddl.ts";
const aiFile = "src/sources/aideadlines.ts";
const archiveFile = "src/sources/base.ts";
const originals = new Map(
  [file, cliFile, ccfFile, aiFile, archiveFile].map((path) => [
    path,
    readFileSync(join(root, path), "utf8"),
  ]),
);
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
  assert.equal(report.numTotalTests, 19, `${label}: required tests missing`);
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
      for (const entry of label.startsWith("archive-")
        ? ["archive CLI"]
        : label.startsWith("upstream-")
          ? ["upstream CLI", "archive CLI"]
          : label.startsWith("cli-")
            ? ["CLI", "upstream CLI", "archive CLI"]
            : ["API", "CLI", "upstream CLI", "archive CLI"]) {
        const transportFault = label.startsWith("archive-transport-");
        const detected = suite?.assertionResults.filter(
          (test: { fullName: string; status: string; failureMessages: string[] }) =>
            test.fullName.startsWith(`${entry} build `) &&
            test.status === "failed" &&
            test.failureMessages.some(
              (message) =>
                message.includes("AssertionError") &&
                (transportFault
                  ? message.includes("縮退した内容を配信しないため中断する") &&
                    message.includes("expected 2 to be +0")
                  : message.includes("llms.txt") ||
                    message.includes("independently specified input counts")),
            ),
        );
        assert(
          transportFault ? detected?.length === 2 : detected && detected.length > 0,
          `${label}: ${entry} ${transportFault ? "CLI success" : "count"} assertions did not detect fault`,
        );
      }
    }
  } else assert.equal(report.numFailedTests, 0);
  for (const dir of ["data", "public", ".cache"])
    assert(!existsSync(join(root, dir)), `${label}: unexpectedly created ${dir}`);
  console.log(
    `${label}: ${report.numPassedTests} passed / ${report.numFailedTests} failed; data/public/cache absent`,
  );
}
const faults = [
  [
    "archive-transport-extraction-drops-input-rows",
    'execFileSync("tar", ["-xzf", archive, "-C", staging]);',
    'execFileSync("tar", ["-xzf", archive, "-C", staging, "--exclude=*/counts.yaml"]);',
    archiveFile,
  ],
  [
    "archive-transport-extracted-root-not-passed-to-loaders",
    'setMetadata(repo, ref, root, "fresh", now);\n  return root;',
    'setMetadata(repo, ref, root, "fresh", now);\n  return slot;',
    archiveFile,
  ],
  [
    "archive-ccf-loader-drops-editions",
    'return parseTree(join(root, "conference"));',
    'return parseTree(join(root, "conference")).map(conf=>({...conf,editions:conf.editions.slice(0,1)}));',
    ccfFile,
  ],
  [
    "archive-ai-loader-drops-editions",
    'return parseTree(join(root, "src", "data", "conferences"));',
    'return parseTree(join(root, "src", "data", "conferences")).map(conf=>({...conf,editions:conf.editions.slice(0,1)}));',
    aiFile,
  ],
  [
    "upstream-loses-ccf-before-merge",
    "    sourceGroups,\n    overrides.aliases",
    "    sourceGroups.map((group, index) => index === 0 ? [] : group),\n    overrides.aliases",
    cliFile,
  ],
  [
    "upstream-loses-ai-before-merge",
    "    sourceGroups,\n    overrides.aliases",
    "    sourceGroups.map((group, index) => index === 1 ? [] : group),\n    overrides.aliases",
    cliFile,
  ],
  [
    "upstream-overrides-not-passed",
    "confs = applyOverrides(confs, overrides);",
    "confs = applyOverrides(confs, {});",
    cliFile,
  ],
  [
    "cli-drops-conferences",
    "await buildAll(confs, config, outdir, now, {",
    "await buildAll([], config, outdir, now, {",
    cliFile,
  ],
  [
    "cli-drops-later-editions",
    "await buildAll(confs, config, outdir, now, {",
    "await buildAll(confs.map(conf => ({...conf, editions: conf.editions.slice(0, 1)})), config, outdir, now, {",
    cliFile,
  ],
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
  for (const [label, needle, replacement, target = file] of faults) {
    const before = originals.get(target)!;
    assert.equal(before.split(needle).length, 2, `${label}: ambiguous mutation target`);
    writeFileSync(join(root, target), before.replace(needle, replacement));
    try {
      run(label, true);
    } finally {
      writeFileSync(join(root, target), before);
    }
  }
} finally {
  for (const [path, before] of originals) writeFileSync(join(root, path), before);
}
run("restored", false);
assert.equal(
  readFileSync(join(repo, file), "utf8"),
  original,
  "workspace changed during isolated checks",
);
assert.equal(readFileSync(join(repo, cliFile), "utf8"), cliOriginal, "CLI workspace changed");
for (const [path, before] of originals)
  assert.equal(readFileSync(join(repo, path), "utf8"), before, `${path}: workspace changed`);
console.log(
  `Detected ${faults.length}/${faults.length} faults; workspace unchanged. Logs: ${root}`,
);
