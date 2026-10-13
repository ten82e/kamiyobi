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

// Run serially: mutation checks must never overlap ordinary tests or builds.
const repo = join(import.meta.dirname, "..");
const isolated = mkdtempSync(join(tmpdir(), "kamiyobi-retrieval-mutations-"));
const copied = [
  "src/embedding-runtime.ts",
  "src/embedding-profiles.ts",
  "src/util.ts",
  "tests/real_papers_models.integration.ts",
  "tests/recommendation_retrieval.test.ts",
  ...readdirSync(join(repo, "tests/fixtures"))
    .filter((name) => /^real-model-.*\.json$/.test(name))
    .sort()
    .map((name) => `tests/fixtures/${name}`),
  "package.json",
  "tsconfig.json",
];
for (const directory of ["src", "tests/fixtures", ".cache"])
  mkdirSync(join(isolated, directory), { recursive: true });
for (const file of copied) cpSync(join(repo, file), join(isolated, file));
cpSync(join(repo, "site"), join(isolated, "site"), { recursive: true });
symlinkSync(join(repo, "node_modules"), join(isolated, "node_modules"));
mkdirSync(join(repo, ".cache/embedding-models"), { recursive: true });
symlinkSync(join(repo, ".cache/embedding-models"), join(isolated, ".cache/embedding-models"));
writeFileSync(
  join(isolated, "vitest.config.ts"),
  `import { defineConfig } from "vitest/config";
export default defineConfig({test: {include: ["tests/real_papers_models.integration.ts", "tests/recommendation_retrieval.test.ts"], maxWorkers: 1, hookTimeout: 600000, testTimeout: 180000}});\n`,
);

const changedFiles = [
  "site/recommender.ts",
  "src/embedding-profiles.ts",
  "src/embedding-runtime.ts",
];
const originals = Object.fromEntries(
  changedFiles.map((file) => [file, readFileSync(join(isolated, file), "utf8")]),
);
const fingerprint = () =>
  [...copied, ...changedFiles, "site/app.ts"]
    .map((file) =>
      createHash("sha256")
        .update(readFileSync(join(repo, file)))
        .digest("hex"),
    )
    .join(":");
const before = fingerprint();
const noGeneratedData = () => {
  assert(!existsSync(join(isolated, "data")), "isolated data/ must not exist");
  assert(!existsSync(join(isolated, "public")), "isolated public/ must not exist");
};
interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages: string[];
}
interface TestReport {
  numPassedTests: number;
  numPendingTests: number;
  numFailedTests: number;
  testResults: Array<{ assertionResults: AssertionResult[] }>;
}
function run(id: string) {
  noGeneratedData();
  const output = join(isolated, `${id}.json`);
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "--reporter=json",
      "--outputFile",
      output,
    ],
    {
      cwd: isolated,
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, KAMIYOBI_REAL_MODEL_REPORT: join(isolated, `${id}-evaluation.json`) },
    },
  );
  writeFileSync(join(isolated, `${id}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert(!result.error, String(result.error));
  assert(existsSync(output), `missing test report: ${id}`);
  const report = JSON.parse(readFileSync(output, "utf8")) as TestReport;
  noGeneratedData();
  return { status: result.status, report };
}
let baselineCount: number | null = null;
const requiredModelChecks = [
  "real paper evaluation separates profiles, preserves inputs and uses the specified models",
  "every initial recommendation, including the former English and Japanese misses, stays in the top five",
  "keeps every confirmation recommendation within the top five",
  "routes escaped paper content through the correct actual model",
  "keeps suitable venues in the top five of raw semantic retrieval for every paper input",
];
function requirePassing(id: string) {
  const { status, report } = run(id);
  assert.equal(status, 0, `${id}: check ${isolated}`);
  assert.equal(report.numPendingTests, 0);
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  for (const name of requiredModelChecks)
    assert(
      assertions.some((result) => result.fullName === name && result.status === "passed"),
      `${id}: required model check did not run: ${name}`,
    );
  if (baselineCount === null) baselineCount = report.numPassedTests;
  else assert.equal(report.numPassedTests, baselineCount, `${id}: test coverage changed`);
  console.log(`${id}: ${report.numPassedTests} passed; data/ and public/ absent`);
}
const mutations: Array<{ id: string; file: string; edits: Array<[string, string]> }> = [
  {
    id: "canonical-key-lost",
    file: "site/recommender.ts",
    edits: [
      ["opts.semanticSimilarities && Object.hasOwn(semanticScores ?? {}, row.conf.key)", "false"],
      [
        "const similarityKey = Object.hasOwn(opts.semanticSimilarities ?? {}, row.conf.key)\n        ? row.conf.key\n        : key;",
        "const similarityKey = key;",
      ],
    ],
  },
  {
    id: "raw-similarities-discarded",
    file: "site/recommender.ts",
    edits: [["similarity: Number.isFinite(similarity) ? similarity : 0,", "similarity: semantic,"]],
  },
  {
    id: "lexical-overrides-meaning",
    file: "site/recommender.ts",
    edits: [
      [
        "const lexicalRrfWeight = opts.semanticSimilarities ? 0.4 : opts.fieldedLexical ? 1.6 : 1;",
        "const lexicalRrfWeight = opts.fieldedLexical ? 1.6 : 1;",
      ],
      [
        "const semanticRrfWeight = opts.semanticSimilarities ? 1.6 : opts.fieldedLexical ? 0.4 : 1;",
        "const semanticRrfWeight = opts.fieldedLexical ? 0.4 : 1;",
      ],
    ],
  },
  {
    id: "topic-expansion-disabled",
    file: "site/recommender.ts",
    edits: [
      [
        "const aliases = forRetrieval ? { ...JP_EN, ...RETRIEVAL_TOPIC_ALIASES } : JP_EN;",
        "const aliases = forRetrieval ? {} : JP_EN;",
      ],
    ],
  },
  {
    id: "abstract-only-rejected",
    file: "site/recommender.ts",
    edits: [["if (!title && !abstract) return null;", "if (!title) return null;"]],
  },
  {
    id: "rounded-score-orders-candidates",
    file: "site/recommender.ts",
    edits: [
      [
        "const baseA = hasSemantic ? a.fit.rrf * (k + 1) * 50 : a.fit.baseScore;",
        "const baseA = a.fit.baseScore;",
      ],
      [
        "const baseB = hasSemantic ? b.fit.rrf * (k + 1) * 50 : b.fit.baseScore;",
        "const baseB = b.fit.baseScore;",
      ],
    ],
  },
  {
    id: "evaluation-paper-in-profile",
    file: "src/embedding-profiles.ts",
    edits: [
      [
        "texts.push(text || key);",
        'texts.push((text || key) + " PRED: Performance-oriented Random Early Detection for Consistently Stable Performance in Datacenters");',
      ],
    ],
  },
  {
    id: "japanese-uses-english-model",
    file: "src/embedding-runtime.ts",
    edits: [
      [
        "  if (localFilesOnly && !env.cacheDir)",
        "  if (model === EMBEDDING_MULTI_MODEL) { model = EMBEDDING_MODEL; revision = EMBEDDING_REVISION; }\n  if (localFilesOnly && !env.cacheDir)",
      ],
    ],
  },
];

console.log(`Isolated copy: ${isolated}`);
requirePassing("baseline");
try {
  for (const mutation of mutations) {
    let source = originals[mutation.file];
    for (const [needle, replacement] of mutation.edits) {
      assert.equal(
        source.split(needle).length - 1,
        1,
        `${mutation.id}: mutation must target exactly once`,
      );
      source = source.replace(needle, replacement);
    }
    writeFileSync(join(isolated, mutation.file), source);
    const { status, report } = run(mutation.id);
    const failures = report.testResults.flatMap((suite) =>
      suite.assertionResults.filter((result) => result.status === "failed"),
    );
    assert.notEqual(status, 0, `${mutation.id}: mutation survived`);
    assert(report.numFailedTests > 0, `${mutation.id}: no failed test`);
    assert(
      failures.some((failure) =>
        failure.failureMessages.some((message) => message.includes("AssertionError")),
      ),
      `${mutation.id}: no behavioral assertion failed`,
    );
    assert.equal(report.numPendingTests, 0, `${mutation.id}: tests were skipped`);
    console.log(
      `${mutation.id}: detected (${report.numFailedTests} failed); ${failures.map((result) => result.fullName).join("; ")}`,
    );
    writeFileSync(join(isolated, mutation.file), originals[mutation.file]);
  }
} finally {
  for (const file of changedFiles) writeFileSync(join(isolated, file), originals[file]);
  assert.equal(fingerprint(), before, "workspace changed during mutation checks");
}
requirePassing("restored");
console.log(
  `Detected ${mutations.length}/${mutations.length} mutations; workspace unchanged. Logs: ${isolated}`,
);
