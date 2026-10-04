import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Recommender from "../../site/recommender.ts";
import {
  assignShareIdentities,
  consolidateReviewedSubmissions,
} from "../../site/submission-identity.ts";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
fs.mkdirSync(root + "/work/agent-verification", { recursive: true });
const key = (r) => `${r.conf.key}|${r.ed.year}|${r.kind}|${Math.trunc(r.t)}`;
const slot = (r) =>
  `${r.conf.key}|${r.ed.id}|${r.ed.year}|${r.kind}|${r.dl.round}|${r.dl.track || r.dl.label || ""}|${r.localDate || r.dl.utc}`;
const summaries = [];
for (const file of ["data.json", "catalog.json"]) {
  const data = JSON.parse(fs.readFileSync(`${root}/public/${file}`));
  const rows = Recommender.candidateRows(data),
    before = JSON.stringify(data),
    shown = consolidateReviewedSubmissions(rows, key);
  const shared = assignShareIdentities(shown, key);
  const canonicalKeys = shared.map(
    (row) => key(row) + (row.shareDiscriminator ? "|slot=" + row.shareDiscriminator : ""),
  );
  assert.equal(new Set(canonicalKeys).size, shared.length);
  assert.equal(shared.length, shown.length);
  const grouped = shown.filter((r) => r.submission),
    untouched = rows.filter((r) => !["jip-compsac2027-si", "ipsj-27-r26"].includes(r.ed.id));
  assert.equal(grouped.length, 1);
  assert.equal(shown.length, rows.length - 1);
  assert(untouched.every((r) => shown.includes(r)));
  assert.equal(JSON.stringify(data), before);
  const shareGroups = new Map(),
    cfpGroups = new Map();
  for (const r of rows) {
    const k = key(r);
    shareGroups.set(k, [...(shareGroups.get(k) || []), r]);
  }
  for (const c of data.conferences)
    for (const e of c.editions) {
      const url = e.link || c.link;
      if (url)
        cfpGroups.set(url, [
          ...(cfpGroups.get(url) || []),
          { key: c.key, id: e.id, year: e.year, call: e.call_identity || null },
        ]);
    }
  const ambiguous = [...shareGroups.entries()]
    .filter(([, rr]) => rr.length > 1)
    .map(([shareKey, rr]) => ({
      shareKey,
      rows: rr.map((r) => ({
        key: r.conf.key,
        id: r.ed.id,
        year: r.ed.year,
        kind: r.kind,
        round: r.dl.round,
        track: r.dl.track,
        label: r.dl.label,
        date: r.localDate || r.dl.utc,
      })),
    }));
  const sharedCfPs = [...cfpGroups.entries()]
    .filter(([, ee]) => ee.length > 1)
    .map(([url, entries]) => ({ url, entries }));
  const specials = rows.filter((r) => r.tags.includes("special-issue")),
    rolling = rows.filter((r) => r.kind === "journal");
  const editions = new Map();
  for (const r of rows) {
    const k = r.conf.key + "|" + r.ed.id;
    editions.set(k, [...(editions.get(k) || []), r]);
  }
  const multiple = [...editions.values()].filter(
    (rr) =>
      new Set(rr.filter((r) => ["paper", "abstract"].includes(r.kind)).map((r) => r.dl.round))
        .size > 1,
  );
  summaries.push({
    file,
    conferences: data.conferences.length,
    rows: rows.length,
    shown: shown.length,
    only_reviewed_pair_consolidated: true,
    canonical_share_keys_unique: true,
    untouched_identity_rows: untouched.length,
    special_issue_rows: specials.length,
    rolling_rows: rolling.length,
    continuous_journal_rows: Recommender.journalRows(
      data.conferences,
      Date.parse("2026-10-03T06:00:00Z"),
    ).length,
    shared_key_collision_groups: ambiguous.length,
    multiple_round_editions: multiple.length,
    multiple_round_examples: multiple.map((rr) => ({
      key: rr[0].conf.key,
      id: rr[0].ed.id,
      rounds: [...new Set(rr.map((r) => r.dl.round))],
      rows: rr.length,
    })),
    ambiguous_share_keys: ambiguous,
    shared_cfp_groups: sharedCfPs,
  });
}
fs.writeFileSync(
  root + "/work/agent-verification/identity-audit.json",
  JSON.stringify(summaries, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    summaries.map((s) => ({
      ...s,
      multiple_round_examples: s.multiple_round_examples.slice(-4),
      ambiguous_share_keys: s.ambiguous_share_keys.slice(0, 5),
      shared_cfp_groups: s.shared_cfp_groups.length,
    })),
    null,
    2,
  ),
);
const data = JSON.parse(fs.readFileSync(root + "/public/data.json"));
const pair = Recommender.candidateRows(data).filter((r) =>
  ["jip-compsac2027-si", "ipsj-27-r26"].includes(r.ed.id),
);
for (const change of ["edition-year", "label-only-track"]) {
  const extra = {
    ...pair.find((r) => r.conf.key === "jip"),
    ed: { ...pair.find((r) => r.conf.key === "jip").ed },
    dl: { ...pair.find((r) => r.conf.key === "jip").dl },
  };
  if (change === "edition-year") extra.ed.year = 2028;
  else extra.dl.label = "Industrial papers";
  const result = consolidateReviewedSubmissions([...pair, extra], key);
  console.log(
    change,
    "source rows",
    3,
    "display rows",
    result.length,
    "distinct preserved",
    result.includes(extra),
  );
}
