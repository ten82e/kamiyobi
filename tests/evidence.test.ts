import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gcEvidence, verifyEvidence } from "../src/evidence.ts";

it("counts a body_ref-only ledger entry as a live evidence reference", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-"));
  const body = "captured official page";
  const hash = createHash("sha256").update(body).digest("hex");
  mkdirSync(join(root, "data", "evidence", "blobs"), { recursive: true });
  writeFileSync(join(root, "data", "evidence", "blobs", `${hash}.body`), body);
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    JSON.stringify({ body_ref: `evidence/blobs/${hash}.body` }),
  );

  const report = verifyEvidence(root);
  expect(report.issues).toEqual([]);
  expect(report.orphan_hashes).toEqual([]);
});

it("reports secret headers serialized as JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-secret-header-"));
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    JSON.stringify({ headers: { authorization: "Bearer secret" } }),
  );
  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: secret-like header is stored",
  );
});

it("reports legacy promotion-local bodies outside the canonical CAS", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-legacy-body-"));
  const body = "legacy promotion-local page";
  const hash = createHash("sha256").update(body).digest("hex");
  const legacy = join(root, "data", "promotions", "batch", "bodies");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, `${hash}.body`), body);

  const report = verifyEvidence(root);
  expect(report.index.blobs).toEqual({});
  expect(report.issues).toContain(
    `data/promotions/batch/bodies/${hash}.body: body blob is outside canonical evidence storage`,
  );
});

it("reports a body_ref and content_hash disagreement", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-conflict-"));
  const body = "captured official page";
  const hash = createHash("sha256").update(body).digest("hex");
  mkdirSync(join(root, "data", "evidence", "blobs"), { recursive: true });
  writeFileSync(join(root, "data", "evidence", "blobs", `${hash}.body`), body);
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    JSON.stringify({ body_ref: `evidence/blobs/${hash}.body`, content_hash: "0".repeat(64) }),
  );

  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: body_ref hash conflicts with content_hash",
  );
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    `body_ref=evidence/blobs/${hash}.body content_hash=${"0".repeat(64)}`,
  );
  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: body_ref hash conflicts with content_hash",
  );
});

it("does not cross-compare independent body references in one file", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-multiple-"));
  const bodies = ["first captured page", "second captured page"];
  const records = bodies.map((body) => {
    const hash = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(root, "data", "evidence", "blobs"), { recursive: true });
    writeFileSync(join(root, "data", "evidence", "blobs", `${hash}.body`), body);
    return { body_ref: `evidence/blobs/${hash}.body`, content_hash: hash };
  });
  writeFileSync(join(root, "data", "verification-ledger.json"), JSON.stringify({ records }));

  expect(verifyEvidence(root).issues).toEqual([]);
  records[1]!.content_hash = "0".repeat(64);
  writeFileSync(join(root, "data", "verification-ledger.json"), JSON.stringify({ records }));
  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: body_ref hash conflicts with content_hash",
  );

  records[1]!.content_hash = records[1]!.body_ref.match(/[a-f0-9]{64}/)![0];
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  expect(verifyEvidence(root).issues).toEqual([]);
  records[1]!.content_hash = "0".repeat(64);
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: body_ref hash conflicts with content_hash",
  );
  writeFileSync(
    join(root, "data", "verification-ledger.json"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n{malformed`,
  );
  expect(verifyEvidence(root).issues).toContain(
    "data/verification-ledger.json: body_ref hash conflicts with content_hash",
  );
});

it("fails closed when a potential evidence reference cannot be read", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-unreadable-"));
  const body = "captured official page";
  const hash = createHash("sha256").update(body).digest("hex");
  const data = join(root, "data");
  mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
  writeFileSync(join(data, "evidence", "blobs", `${hash}.body`), body);
  symlinkSync("missing-ledger.json", join(data, "verification-ledger.json"));

  expect(() => verifyEvidence(root)).toThrow(/verification-ledger\.json/);
  expect(() => gcEvidence(root, true)).toThrow(/verification-ledger\.json/);
});

it("fails closed when an evidence body is not a regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-linked-body-"));
  const body = "linked captured page";
  const hash = createHash("sha256").update(body).digest("hex");
  const blobs = join(root, "data", "evidence", "blobs");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(root, "outside.body"), body);
  symlinkSync(join(root, "outside.body"), join(blobs, `${hash}.body`));

  expect(() => verifyEvidence(root)).toThrow(/body blob must be a regular file/);
  expect(() => gcEvidence(root, true)).toThrow(/body blob must be a regular file/);

  const directoryRoot = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-body-directory-"));
  mkdirSync(join(directoryRoot, "data", "evidence", "blobs", `${hash}.body`), {
    recursive: true,
  });
  expect(() => verifyEvidence(directoryRoot)).toThrow(/body blob must be a regular file/);
  expect(() => gcEvidence(directoryRoot, true)).toThrow(/body blob must be a regular file/);
});

it("fails closed when an evidence reference directory cannot be traversed", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-evidence-untraversable-"));
  const data = join(root, "data");
  const references = join(data, "references");
  mkdirSync(references, { recursive: true });
  writeFileSync(join(references, "ledger.json"), "{}\n");
  chmodSync(references, 0o000);
  try {
    expect(() => verifyEvidence(root)).toThrow(/references|permission|EACCES/);
    expect(() => gcEvidence(root, true)).toThrow(/references|permission|EACCES/);
  } finally {
    chmodSync(references, 0o700);
  }
});
