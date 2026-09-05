import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const EVIDENCE_SCHEMA_VERSION = 1;
const EVIDENCE_MAX_BODY_BYTES = 5 * 1024 * 1024;

interface EvidenceBlob {
  bytes: number;
  content_type: string;
  references: string[];
}

interface EvidenceIndex {
  schema_version: 1;
  blobs: Record<string, EvidenceBlob>;
}

interface EvidenceReport {
  index: EvidenceIndex;
  issues: string[];
  orphan_hashes: string[];
  duplicate_hashes: string[];
}

function dataRoot(root: string): string {
  return join(root, "data");
}

function blobRoots(root: string): string[] {
  return [join(dataRoot(root), "evidence", "blobs")];
}

function inside(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(".."));
}

function walk(
  dir: string,
  predicate: (path: string) => boolean,
  out: string[],
  includeMatchingDirectories = false,
): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).isDirectory()) {
        if (includeMatchingDirectories && predicate(path)) out.push(path);
        else walk(path, predicate, out, includeMatchingDirectories);
      } else if (predicate(path)) out.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function bodyFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of blobRoots(root)) walk(dir, (path) => path.endsWith(".body"), out, true);
  for (const path of out) {
    if (!lstatSync(path).isFile()) throw new Error(`body blob must be a regular file: ${path}`);
  }
  return out.sort();
}

function referenceFiles(root: string): string[] {
  const out: string[] = [];
  walk(dataRoot(root), (path) => !path.endsWith(".body") && !path.endsWith("index.json"), out);
  return out.sort();
}

function explicitBodyRefs(text: string): string[] {
  return [...text.matchAll(/(?:body_ref|bodyRef|bodyPath)\s*["']?\s*[:=]\s*["']?([^"'\s,}]+)/g)]
    .map((match) => match[1]!.replace(/["']$/, ""))
    .filter(Boolean);
}

function explicitContentHashes(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:contentHash|content_hash|body_hash|bodyHash)\s*["']?\s*[:=]\s*["']?([a-f0-9]{64})/gi,
    ),
  ].map((match) => match[1]!.toLowerCase());
}

function bodyRefHash(ref: string): string | null {
  const match = /(?:^|[/\\])([a-f0-9]{64})(?:\.body)?$/i.exec(ref.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function explicitHashRefs(text: string): string[] {
  const hashes = [
    ...explicitContentHashes(text),
    ...[...text.matchAll(/evidence\/blobs\/([a-f0-9]{64})\.body/gi)].map((match) =>
      match[1]!.toLowerCase(),
    ),
    ...explicitBodyRefs(text).flatMap((ref) => {
      const hash = bodyRefHash(ref);
      return hash ? [hash] : [];
    }),
  ];
  if (/(?:["']?path["']?\s*:\s*["']?bodies\/|bodyPath)/i.test(text))
    hashes.push(
      ...[...text.matchAll(/\b[a-f0-9]{64}\b/gi)].map((match) => match[0]!.toLowerCase()),
    );
  return [...new Set(hashes)];
}

function hasBodyHashConflict(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBodyHashConflict);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const ref = record.body_ref ?? record.bodyRef ?? record.bodyPath;
  const hash = record.content_hash ?? record.contentHash ?? record.body_hash ?? record.bodyHash;
  const referencedHash = typeof ref === "string" ? bodyRefHash(ref) : null;
  if (
    referencedHash &&
    typeof hash === "string" &&
    /^[a-f0-9]{64}$/i.test(hash) &&
    hash.toLowerCase() !== referencedHash
  )
    return true;
  return Object.values(record).some(hasBodyHashConflict);
}

function hasBodyHashConflictText(text: string): boolean {
  try {
    return hasBodyHashConflict(JSON.parse(text));
  } catch {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .some((line) => {
        try {
          return hasBodyHashConflict(JSON.parse(line));
        } catch {
          const refs = [...new Set(explicitBodyRefs(line))];
          const hashes = [...new Set(explicitContentHashes(line))];
          return refs.length === 1 && hashes.length === 1 && hashes[0] !== bodyRefHash(refs[0]!);
        }
      });
  }
}

function bodyHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relativeRef(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function evidenceIndex(root: string): EvidenceIndex {
  const files = bodyFiles(root);
  const references = new Map<string, Set<string>>();
  for (const path of referenceFiles(root)) {
    const text = readFileSync(path, "utf8");
    for (const hash of explicitHashRefs(text)) {
      const set = references.get(hash) ?? new Set<string>();
      set.add(relativeRef(root, path));
      references.set(hash, set);
    }
  }
  const grouped = new Map<string, string[]>();
  for (const path of files) {
    const name = path
      .split("/")
      .at(-1)!
      .replace(/\.body$/, "")
      .toLowerCase();
    if (/^[a-f0-9]{64}$/.test(name)) {
      grouped.set(name, [...(grouped.get(name) ?? []), path]);
      const set = references.get(name) ?? new Set<string>();
      references.set(name, set);
    }
  }
  const blobs: Record<string, EvidenceBlob> = {};
  for (const hash of [...grouped.keys()].sort()) {
    const path = grouped.get(hash)![0]!;
    const bytes = readFileSync(path);
    blobs[hash] = {
      bytes: bytes.byteLength,
      content_type: "application/octet-stream",
      references: [...(references.get(hash) ?? [])].sort(),
    };
  }
  return { schema_version: EVIDENCE_SCHEMA_VERSION, blobs };
}

export function verifyEvidence(root: string): EvidenceReport {
  const files = bodyFiles(root);
  const index = evidenceIndex(root);
  const issues: string[] = [];
  const misplaced: string[] = [];
  walk(join(dataRoot(root), "promotions"), (path) => path.endsWith(".body"), misplaced, true);
  for (const path of misplaced)
    issues.push(`${relativeRef(root, path)}: body blob is outside canonical evidence storage`);
  const byHash = new Map<string, string[]>();
  for (const path of files) {
    const name = path
      .split("/")
      .at(-1)!
      .replace(/\.body$/, "")
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(name)) {
      issues.push(`${relativeRef(root, path)}: filename is not a SHA-256 body name`);
      continue;
    }
    byHash.set(name, [...(byHash.get(name) ?? []), path]);
    const bytes = readFileSync(path);
    if (bytes.byteLength > EVIDENCE_MAX_BODY_BYTES)
      issues.push(`${relativeRef(root, path)}: body exceeds ${EVIDENCE_MAX_BODY_BYTES} bytes`);
    if (bodyHash(path) !== name) issues.push(`${relativeRef(root, path)}: body hash mismatch`);
  }
  for (const [hash, paths] of byHash) {
    if (paths.length > 1) issues.push(`${hash}: duplicate body blobs`);
  }

  const knownPaths = new Map<string, string>();
  for (const path of files) knownPaths.set(resolve(path), path);
  const hashRefs = new Map<string, Set<string>>();
  for (const path of referenceFiles(root)) {
    const text = readFileSync(path, "utf8");
    const bodyRefs = [...new Set(explicitBodyRefs(text))];
    for (const ref of bodyRefs) {
      if (ref.includes("://") || ref.startsWith("/")) {
        issues.push(`${relativeRef(root, path)}: body_ref is outside evidence storage`);
        continue;
      }
      const candidates = [resolve(dirname(path), ref), resolve(dataRoot(root), ref)];
      if (!candidates.some((candidate) => knownPaths.has(candidate)))
        issues.push(`${relativeRef(root, path)}: missing body_ref ${ref}`);
    }
    if (hasBodyHashConflictText(text))
      issues.push(`${relativeRef(root, path)}: body_ref hash conflicts with content_hash`);
    for (const hash of explicitHashRefs(text)) {
      const refs = hashRefs.get(hash) ?? new Set<string>();
      refs.add(relativeRef(root, path));
      hashRefs.set(hash, refs);
    }
    if (/(?:^|[,{\s])["']?(?:cookie|authorization|set-cookie)["']?\s*:/im.test(text))
      issues.push(`${relativeRef(root, path)}: secret-like header is stored`);
  }
  for (const hash of Object.keys(index.blobs)) {
    if (!byHash.has(hash)) issues.push(`${hash}: index entry has no body blob`);
  }
  for (const hash of byHash.keys()) {
    if (!(hashRefs.get(hash)?.size ?? 0)) issues.push(`${hash}: orphan body blob`);
  }
  const orphanHashes = [...byHash.keys()].filter((hash) => !(hashRefs.get(hash)?.size ?? 0)).sort();
  const duplicateHashes = [...byHash]
    .filter(([, paths]) => paths.length > 1)
    .map(([hash]) => hash)
    .sort();
  return {
    index,
    issues: [...new Set(issues)].sort(),
    orphan_hashes: orphanHashes,
    duplicate_hashes: duplicateHashes,
  };
}

export function writeEvidenceIndex(root: string): EvidenceIndex {
  const dir = join(dataRoot(root), "evidence");
  mkdirSync(dir, { recursive: true });
  const index = evidenceIndex(root);
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export function gcEvidence(root: string, dryRun = false): { removed: string[]; kept: string[] } {
  const report = verifyEvidence(root);
  const globalRoot = join(dataRoot(root), "evidence", "blobs");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const path of bodyFiles(root).filter((candidate) => inside(globalRoot, candidate))) {
    const hash = path
      .split("/")
      .at(-1)!
      .replace(/\.body$/, "")
      .toLowerCase();
    if (report.orphan_hashes.includes(hash)) {
      removed.push(relativeRef(root, path));
      if (!dryRun) execFileSync("trash", [path], { stdio: "ignore" });
    } else kept.push(relativeRef(root, path));
  }
  return { removed: removed.sort(), kept: kept.sort() };
}
