/** Read-only audit of a built release against the captured ee942cd publication.
 * node scripts/verify-history-release.mjs OUT BASELINE BUNDLE REQUIRED_REPORT FULL_REPORT
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalRealPaperBenchmarkContentId,
  realPaperRegressionReasons,
} from "../src/bench-recommender.ts";
import { embeddingsStale } from "../src/build.ts";
import {
  recommendationGatePolicyId,
  semanticContentIdForArtifacts,
} from "../src/semantic-content.ts";

const [out, baselinePath, bundleDir, requiredPath, fullPath] = process.argv.slice(2);
assert(out && baselinePath && bundleDir && requiredPath && fullPath, "five paths required");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const baselineBytes = readFileSync(baselinePath);
assert.equal(
  hash(baselineBytes),
  "f223d0a92541136594f454cf2caab01f7cf8f2d777756f0168f2f624cbc33320",
);
const baseline = JSON.parse(baselineBytes);
const data = read(join(out, "data.json"));
const byKey = new Map(data.conferences.map((conference) => [conference.key, conference]));
const changedEvents = [];
const identityBindings = [];
const preservedAsHistory = [];
let editions = 0;
let activeValues = 0;
const value = (deadline) => [
  deadline.kind,
  deadline.round ?? 1,
  deadline.track ?? "",
  deadline.precision ?? "exact",
  deadline.utc ?? deadline.local_date,
];
const event = (edition) => [
  edition.event_start ?? null,
  edition.event_end ?? null,
  edition.event_date_precision ?? null,
  edition.event_segments ?? null,
];
const allowedEvents = new Map([
  ["tcc/2023", ["2023-11-29", "2023-12-02", "exact-range", null]],
  ["systor/2024", ["2024-09-23", "2024-09-24", "exact-range", null]],
  ["cscw/2022", ["2022-11-08", "2022-11-22", "exact-range", null]],
]);
for (const conference of baseline.conferences) {
  for (const edition of conference.editions) {
    if (edition.year >= 2026 || edition.estimated) continue;
    editions++;
    const identity = [conference.key, edition.year, edition.id];
    const matches = (byKey.get(conference.key)?.editions ?? []).filter(
      (target) =>
        !target.estimated &&
        target.year === edition.year &&
        (target.id === edition.id || target.legacy_ids?.includes(edition.id)),
    );
    assert.equal(matches.length, 1, `edition lost or duplicated: ${identity}`);
    const target = matches[0];
    if (target.id !== edition.id) identityBindings.push({ from: identity, to: target.id });
    if (JSON.stringify(event(edition)) !== JSON.stringify(event(target))) {
      assert.deepEqual(
        event(target),
        allowedEvents.get(`${conference.key}/${edition.year}`),
        `unsupported event change: ${identity}`,
      );
      changedEvents.push({ identity, before: event(edition), after: event(target) });
    }
    for (const deadline of edition.deadlines ?? []) {
      if (
        target.deadlines.some(
          (current) => JSON.stringify(value(current)) === JSON.stringify(value(deadline)),
        )
      ) {
        activeValues++;
        continue;
      }
      assert.deepEqual(
        identity,
        ["cpal", 2025, "cpal25"],
        `deadline lost: ${identity}, ${value(deadline)}`,
      );
      assert.equal(deadline.utc, "2024-11-26T11:59:59Z");
      const retained = target.deadlines
        .flatMap((current) => current.superseded_deadlines ?? [])
        .find(
          (old) =>
            old.value === deadline.utc &&
            old.precision === deadline.precision &&
            old.status === "superseded",
        );
      assert(retained, "CPAL's published deadline must remain in superseded history");
      preservedAsHistory.push({ identity, deadline: value(deadline), retained });
    }
  }
}
assert.equal(editions, 746);
assert.equal(activeValues, 1387);
assert.equal(preservedAsHistory.length, 1);
assert.deepEqual(
  changedEvents.map((item) => `${item.identity[0]}/${item.identity[1]}`).sort(),
  [...allowedEvents.keys()].sort(),
);
const cpal = byKey
  .get("cpal")
  .editions.filter((edition) => edition.year === 2025 && !edition.estimated);
assert.equal(cpal.length, 1);
assert.deepEqual(event(cpal[0]), ["2025-03-24", "2025-03-27", "exact-range", null]);
assert.deepEqual(cpal[0].deadlines.map((deadline) => [deadline.track, deadline.utc]).sort(), [
  ["proceedings", "2024-12-03T11:59:00Z"],
  ["recent-spotlight", "2025-01-13T11:59:00Z"],
]);
for (const deadline of cpal[0].deadlines) {
  assert.equal(deadline.verification.status, "verified");
  const evidence = deadline.evidence[0];
  assert.equal(hash(readFileSync(resolve(evidence.evidenceRef))), evidence.contentHash);
}

const Recommender = (await import(pathToFileURL(resolve(out, "recommender.js")).href)).default;
const rows = Recommender.candidateRows(data);
const now = Date.parse("2026-08-09T00:00:00Z");
const matched = (query) => {
  const match = Recommender.searchMatcher(query, now);
  return rows.flatMap((row, index) => (match(row.hay) ? [index] : []));
};
const queryResults = [];
for (const [query, canonical] of [
  ["参加申込締切", "登録締切"],
  ["ソルトレイクシティ", "salt lake city"],
  ["第2週目", "第2週"],
  ["9月第2週目", "9月第2週"],
  ["東京開催", "東京"],
]) {
  const expected = matched(canonical);
  assert(expected.length > 0, `empty canonical query: ${canonical}`);
  assert.deepEqual(matched(query), expected, query);
  queryResults.push({ query, canonical, rows: expected.length });
}
const cities = read("tests/fixtures/pr958-city-search.json");
for (const { query, city, conference } of cities) {
  const current = byKey.get(conference.key);
  assert(current, `captured conference missing: ${conference.key}`);
  const actualRows = Recommender.candidateRows({ conferences: [current] });
  const english = Recommender.searchMatcher(city, now);
  const japanese = Recommender.searchMatcher(query, now);
  const cityRows = actualRows.filter((row) => english(row.hay));
  assert(cityRows.length > 0, `city missing from final data: ${city}`);
  assert(
    cityRows.every((row) => japanese(row.hay)),
    `Japanese city query failed: ${query}`,
  );
}

const publish = read(join(out, "publish.json"));
assert.equal(publish.schema_version, 4);
assert.equal(publish.semantic_status, "ready");
for (const [name, expected] of Object.entries(publish.artifacts)) {
  const bytes = readFileSync(join(out, name));
  assert.equal(bytes.byteLength, expected.bytes, name);
  assert.equal(hash(bytes), expected.sha256, name);
}
assert.deepEqual(
  readdirSync(out).sort(),
  [...Object.keys(publish.artifacts), "publish.json"].sort(),
);
const embedding = read(join(out, "embeddings.json"));
assert.equal(embeddingsStale(embedding, data), false);
const bundle = read(join(bundleDir, "recommendation-bundle.json"));
assert.equal(bundle.embeddings_sha256, hash(readFileSync(join(out, "embeddings.json"))));
const semanticId = semanticContentIdForArtifacts(
  data,
  readFileSync("data/recommender-reranker.json"),
);
assert.equal(bundle.semantic_content_id, semanticId);
assert.equal(bundle.gate_policy_id, recommendationGatePolicyId());
assert.equal(bundle.gate_provenance.mode, "verified-reports");
for (const [coverage, path] of [
  ["required", requiredPath],
  ["full", fullPath],
]) {
  const report = read(path);
  const contentId = canonicalRealPaperBenchmarkContentId(coverage);
  assert.equal(report.passed, true);
  assert.equal(report.semantic_content_id, semanticId);
  assert.deepEqual(realPaperRegressionReasons(report, coverage, contentId), []);
  assert.equal(bundle.gate_provenance[coverage].report_sha256, hash(readFileSync(path)));
  assert.equal(bundle.gate_provenance[coverage].benchmark_content_id, contentId);
}
console.log(
  JSON.stringify(
    {
      passed: true,
      data_sha256: hash(readFileSync(join(out, "data.json"))),
      historical_editions: editions,
      unchanged_active_deadline_values: activeValues,
      preserved_as_superseded: preservedAsHistory,
      changed_events: changedEvents,
      identity_bindings: identityBindings,
      city_queries: cities.length,
      queries: queryResults,
      semantic_content_id: semanticId,
      gate_policy_id: bundle.gate_policy_id,
      embedding_manifest: {
        schema: embedding.manifest.schema,
        runtime: embedding.manifest.runtime_version,
        keys: embedding.manifest.keys.length,
      },
      source_commit: publish.source_commit,
      data_commit: publish.data_commit,
      bundle_origin_commit: bundle.bundle_origin_commit,
      scope:
        "Historical, query, artifact-hash and bundle checks only. A clean Git source commit, complete evidence archive and publication authorization remain separate requirements.",
    },
    null,
    2,
  ),
);
