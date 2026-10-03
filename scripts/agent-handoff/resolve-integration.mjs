import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = path.join(repo, "work/agent-verification/integration");
const tree = path.join(root, "tree");
const prep = JSON.parse(fs.readFileSync(path.join(root, "preparation.json"), "utf8"));
const notes = [];
for (const name of prep.conflicts) {
  const inputs = path.join(root, "merge-inputs", name);
  const result = spawnSync(
    "git",
    [
      "merge-file",
      "--diff3",
      "-p",
      "-L",
      "UI-working-tree",
      "-L",
      "shared-base",
      "-L",
      "updater-candidate",
      ...["current", "base", "incoming"].map((variant) => path.join(inputs, variant)),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  assert(
    result.status > 0 && result.status <= 127,
    `${name}: ${result.error?.message || result.stderr}`,
  );
  fs.writeFileSync(path.join(tree, name), result.stdout);
}
function text(name, variant) {
  return fs.readFileSync(path.join(root, "merge-inputs", name, variant), "utf8");
}
function resolve(name, choose, reason) {
  const target = path.join(tree, name);
  const source = fs.readFileSync(target, "utf8");
  let count = 0;
  const result = source.replace(
    /^<<<<<<< UI-working-tree\n([\s\S]*?)^\|\|\|\|\|\|\| shared-base\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> updater-candidate\n/gm,
    (_, current, base, incoming) => {
      count++;
      return choose(current, base, incoming);
    },
  );
  assert(count > 0, `${name}: expected a conflict`);
  assert(!/^<<<<<<<|^=======|^>>>>>>>/m.test(result));
  fs.writeFileSync(target, result);
  notes.push({ path: name, conflict_sections: count, reason });
}
resolve(
  "SPEC.md",
  (current, base, incoming) => {
    assert(!base.trim());
    return `${current}\n${incoming}`;
  },
  "Retain the Japanese UI and event contracts and append the updater's snapshot/identity/recommendation contracts.",
);
resolve(
  "config.yaml",
  (_current, _base, incoming) => incoming,
  "Use the published EvoMUSART canonical key and reviewed ECIR provider identity, retaining the other UI identities.",
);
const isMap = (value) => value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mergeYaml(base, current, incoming, location = "overrides") {
  if (same(current, incoming)) return current;
  if (same(current, base)) return incoming;
  if (same(incoming, base)) return current;
  if (isMap(current) && isMap(incoming) && (base === undefined || isMap(base))) {
    const result = {};
    for (const key of new Set([
      ...Object.keys(base || {}),
      ...Object.keys(current),
      ...Object.keys(incoming),
    ]))
      result[key] = mergeYaml(base?.[key], current[key], incoming[key], `${location}.${key}`);
    return result;
  }
  throw new Error(`Conflicting override values require explicit review: ${location}`);
}
const currentText = text("data/overrides.yaml", "current");
const incomingText = text("data/overrides.yaml", "incoming");
const current = load(currentText),
  incoming = load(incomingText);
const merged = structuredClone(
  mergeYaml(load(text("data/overrides.yaml", "base")), current, incoming),
);
const evo = merged.conferences["evomusart-2027"].editions["evomusart-202727"];
assert(evo.deadlines.length === 1 && evo.deadlines[0].kind === "paper");
evo.mode = "merge-slots";
evo.remove = [
  {
    kind: "paper",
    label: "Paper submission",
    round: 1,
    values: ["2026-11-02T11:59:00.000Z", "2026-11-01"],
  },
];

function blocks(source) {
  const matches = [...source.matchAll(/^ {2}([\w-]+):\s*$/gm)];
  return new Map(
    matches.map((match, i) => [
      match[1],
      source.slice(match.index, matches[i + 1]?.index ?? source.length),
    ]),
  );
}
const currentBlocks = blocks(currentText),
  incomingBlocks = blocks(incomingText);
const preamble = incomingText.slice(
  0,
  incomingText.match(/^conferences:\n/m).index + "conferences:\n".length,
);
const pieces = [];
for (const key of new Set([
  ...Object.keys(incoming.conferences),
  ...Object.keys(merged.conferences),
])) {
  const value = merged.conferences[key];
  if (value === undefined) continue;
  if (same(value, incoming.conferences[key])) pieces.push(incomingBlocks.get(key));
  else if (same(value, current.conferences[key])) pieces.push(currentBlocks.get(key));
  else
    pieces.push(
      dump({ [key]: value }, { lineWidth: -1, noRefs: true })
        .split("\n")
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n"),
    );
}
assert(pieces.every((piece) => typeof piece === "string"));
const overrideResult = preamble + pieces.join("\n");
assert.deepEqual(load(overrideResult), merged);
fs.writeFileSync(path.join(tree, "data/overrides.yaml"), overrideResult);
notes.push({
  path: "data/overrides.yaml",
  reason:
    "Three-way merge by YAML key; conflicting scalar/array values throw. Preserve UI-only reviewed schedules and IPSJ/JIP precision with all evidence-backed updater corrections. Merge the EvoMUSART paper correction by slot to retain the separately verified abstract deadline.",
});
resolve(
  "src/build.ts",
  (current) => current,
  "Retain event segments and supplemental drawer deadlines; updater changes outside the conflict remain.",
);
resolve(
  "src/merge.ts",
  (current) => current,
  "Retain the shared split-date guards plus UI precision/bounds handling; updater no-cloning/legacy guards outside the conflict remain.",
);
const eventCurrent = text("tests/event_schedule.test.ts", "current");
const extra = text("tests/event_schedule.test.ts", "incoming").match(
  / {2}it\("does not invent an absent historical edition[\s\S]*?\n {2}\}\);/,
)[0];
assert(!eventCurrent.includes(extra));
fs.writeFileSync(
  path.join(tree, "tests/event_schedule.test.ts"),
  eventCurrent.replace(
    '  it("keeps the nominal edition year',
    `${extra}\n  it("keeps the nominal edition year`,
  ),
);
notes.push({
  path: "tests/event_schedule.test.ts",
  reason:
    "Keep UI display assertions and append the updater's missing historical edition regression.",
});
resolve(
  "tests/local_sources.test.ts",
  (current) =>
    current.replace(
      '    expect(rows.filter((row) => row.precision === "date-only")).toHaveLength(192);',
      "    // 192 -> 194: incoming official ECIR notification and EvoMUSART paper corrections.\n" +
        '    expect(rows.filter((row) => row.precision === "date-only")).toHaveLength(194);',
    ),
  "Keep UI date-only corrections plus the two evidence-backed updater date-only override inputs (ECIR notification and EvoMUSART paper).",
);
fs.writeFileSync(
  path.join(tree, "tests/promotion.test.ts"),
  text("tests/promotion.test.ts", "current"),
);
notes.push({
  path: "tests/promotion.test.ts",
  reason:
    "UI tests include all incoming test cases plus Japanese abstract and fixed-clock regressions; keep the current fixture helpers once.",
});
let canaryPart = 0;
resolve(
  "tests/update_data_canary.test.ts",
  (_current, _base, incoming) => {
    canaryPart++;
    return canaryPart === 1
      ? incoming
      : 'import { makeFixtureCache, NOW_ARG, REPO_ROOT, tempWork } from "./helpers.ts";\n';
  },
  "Retain the incoming isolated canary fixture and all helpers required by the combined tests.",
);
assert.equal(canaryPart, 2);
for (const name of prep.conflicts)
  assert(!/^<<<<<<<|^=======|^>>>>>>>/m.test(fs.readFileSync(path.join(tree, name), "utf8")));
// Query-count regressions use the original fixed-clock input, while hosted
// regressions and production builds still use the corrected DASFAA date.
const referencePath = path.join(tree, "tests/fixtures/query-reference-overrides.yaml");
const referenceText = fs.readFileSync(referencePath, "utf8");
if (!load(referenceText).dasfaa) {
  fs.appendFileSync(
    referencePath,
    "\n# Fixed-clock pre-integration input; never used by production.\n" +
      "# Preserves the exact old row 2027-06-07T11:59:00Z observed in the UI query fixture.\n" +
      "dasfaa:\n  editions:\n    dasfaa27:\n      deadlines:\n" +
      "      - {kind: paper, label: Full Paper Submission, round: 1, date: '2027-06-06 23:59:00', tz: AoE}\n",
  );
}
notes.push({
  path: "tests/fixtures/query-reference-overrides.yaml",
  reason:
    "Isolate search-count fixture from the official DASFAA production correction; preserve the original June UTC instant only in the historical test input.",
});
fs.writeFileSync(path.join(root, "resolutions.json"), `${JSON.stringify(notes, null, 2)}\n`);
console.log(
  `Resolved ${prep.conflicts.length} conflict files and isolated the historical query fixture in the dry-run archive; production working files unchanged.`,
);
