import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { REPO_ROOT, tempWork } from "./helpers.ts";

/** Immutable ee942cd inputs for assertions about measured 2026-08-09 counts.
 * Live production coverage must keep reading data/snapshot.json directly.
 */
export function queryReferenceData(): Record<string, string> {
  const bytes = gunzipSync(
    Buffer.from(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/query-reference-data.json.gz.base64"),
        "utf8",
      ).trim(),
      "base64",
    ),
  );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "2470087cb424863c6f51b769ae206ea20af535908adba941d5db00554d2a8f40"
  )
    throw new Error("fixed query input changed without review");
  return JSON.parse(bytes.toString("utf8"));
}

let snapshot: string | undefined;
export function queryReferenceSnapshotPath(): string {
  if (!snapshot) {
    snapshot = join(tempWork("cfp-query-snapshot-"), "snapshot.json");
    writeFileSync(snapshot, queryReferenceData()["snapshot.json"]);
  }
  return snapshot;
}
