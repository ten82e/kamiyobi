/**
 * Source protocol and tarball fetching (Node built-ins only, no HTTP dep).
 * Ported from scripts/sources/base.py.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warn } from "../model.ts";

export const USER_AGENT = "kamiyobi/1.0 (+https://github.com/ten82e/kamiyobi; node)";
export const CODELOAD = "https://codeload.github.com/{repo}/tar.gz/refs/heads/{ref}";

export interface FetchMetadata {
  status: "fresh" | "cache-fallback";
  revision: string | null;
  fetchedAt: string | null;
  contentHash: string | null;
  cacheAgeSeconds: number | null;
}
const fetchMetadata = new Map<string, FetchMetadata>();
const metadataKey = (repo: string, ref: string): string => `${repo}@${ref}`;
const CACHE_METADATA = ".kamiyobi-source.json";

type CachedFetchMetadata = Pick<FetchMetadata, "revision" | "fetchedAt" | "contentHash">;

function cacheMetadataPath(slot: string): string {
  return join(slot, CACHE_METADATA);
}

/** Read only explicit cache provenance; legacy caches remain honestly unknown. */
export function cacheMetadata(slot: string): CachedFetchMetadata | null {
  try {
    const value = JSON.parse(readFileSync(cacheMetadataPath(slot), "utf8")) as CachedFetchMetadata;
    if (
      (value.revision !== null && typeof value.revision !== "string") ||
      (value.fetchedAt !== null && typeof value.fetchedAt !== "string") ||
      (value.contentHash !== null && typeof value.contentHash !== "string")
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeCacheMetadata(slot: string, value: CachedFetchMetadata): void {
  writeFileSync(cacheMetadataPath(slot), `${JSON.stringify(value)}\n`, "utf8");
}

function cacheAgeSeconds(root: string, fetchedAt: string | null, now: Date): number | null {
  const fetched = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  const origin = Number.isFinite(fetched) ? fetched : statSync(root).mtimeMs;
  return Math.max(0, Math.floor((now.getTime() - origin) / 1000));
}

function setMetadata(
  repo: string,
  ref: string,
  root: string,
  status: FetchMetadata["status"],
  now: Date,
): void {
  const saved = cacheMetadata(join(root, ".."));
  fetchMetadata.set(metadataKey(repo, ref), {
    status,
    revision: saved?.revision ?? null,
    fetchedAt: saved?.fetchedAt ?? null,
    contentHash: saved?.contentHash ?? null,
    cacheAgeSeconds: cacheAgeSeconds(root, saved?.fetchedAt ?? null, now),
  });
}

/** Metadata is build-scoped; never carry one command's cache state into the next. */
export function resetFetchMetadata(): void {
  fetchMetadata.clear();
}

export function fetchMetadataFor(repo: string, ref: string): FetchMetadata | null {
  return fetchMetadata.get(metadataKey(repo, ref)) ?? null;
}

export function cacheSlot(
  cacheDir: string | null | undefined,
  repo: string | null | undefined,
  ref: string | null | undefined,
): string {
  const safeRepo = String(repo ?? "").replace(/\//g, "__");
  const safeRef = String(ref ?? "").replace(/\//g, "__");
  return join(String(cacheDir ?? ".cache"), `${safeRepo}__${safeRef}`);
}

/** The single top-level directory inside an extracted tarball, or null. */
export function extractedRoot(slot: string | null | undefined): string | null {
  if (!slot || typeof slot !== "string") return null;
  if (!existsSync(slot)) return null;
  try {
    if (!statSync(slot).isDirectory()) return null;
    const children = readdirSync(slot).filter((p) => {
      try {
        return statSync(join(slot, p)).isDirectory();
      } catch {
        return false;
      }
    });
    return children.length === 1 ? join(slot, children[0]) : null;
  } catch {
    return null;
  }
}

export function archiveMetadata(
  bytes: Uint8Array,
  etag: string | null = null,
  now: Date = new Date(),
): CachedFetchMetadata {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return {
    revision: etag ?? `sha256:${contentHash}`,
    fetchedAt: now.toISOString(),
    contentHash,
  };
}

async function download(url: string, dest: string, now: Date): Promise<CachedFetchMetadata> {
  // codeload.github.com は一時的な 5xx / タイムアウトを返すことがある
  // (2026-08-26〜08-29 の update-data で runner から 3 日連続 fetch 失敗が発生。
  // ローカルからは同一 URL が成功していた = 一時的なインフラ変動)。
  // 単発 fetch では degraded (snapshot fallback) に落ちるため、短期リトライで吸収する。
  // 恒久的な失敗 (404 等) は即 abort し、retry しない。
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      process.stderr.write(`warning: fetch of ${url} failed; retrying (${attempt}/${maxAttempts})\n`);
    }
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        continue; // 一時的と見做して再試行
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`); // 恒久的: 即失敗
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(dest, buffer);
      // GitHub's ETag is a stable response revision where offered; archive bytes
      // are the deterministic identity when it is not.
      return archiveMetadata(buffer, response.headers.get("etag"), now);
    } catch (exc) {
      if (attempt < maxAttempts && isRetryable(exc)) {
        lastError = exc;
        continue;
      }
      throw exc;
    }
  }
  throw lastError ?? new Error(`unreachable: download retries exhausted for ${url}`);
}

/** ネットワーク層の一時的失敗 (fetch failed / ECONNRESET / タイムアウト等) のみリトライ対象。
 *  HTTP 4xx は Error として投げられるので retry されない (fetch 失敗時 TypeError になる)。 */
function isRetryable(exc: unknown): boolean {
  if (exc instanceof Error && exc.name === "AbortError") return true;
  if (exc instanceof TypeError) return true; // undici fetch failed (network)
  return false;
}

/**
 * Download and extract `repo` at `ref`; return the extracted root.
 * `offline` uses the cache only and throws when it is missing.  A network
 * failure falls back to an existing cache with a warning.
 */
export async function fetchTarball(
  repo: string,
  ref: string,
  cacheDir: string,
  options: { offline?: boolean; now?: Date } = {},
): Promise<string> {
  const offline = Boolean(options.offline);
  const now =
    options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const slot = cacheSlot(cacheDir, repo, ref);
  const cached = extractedRoot(slot);

  if (offline) {
    if (cached === null) {
      throw new Error(`no cached copy of ${repo}@${ref} under ${cacheDir}`);
    }
    setMetadata(repo, ref, cached, "cache-fallback", now);
    return cached;
  }

  mkdirSync(cacheDir, { recursive: true });
  const url = CODELOAD.replace("{repo}", repo).replace("{ref}", ref);
  const tmp = mkdtempSync(join(cacheDir, ".fetch-"));
  try {
    const archive = join(tmp, "archive.tar.gz");
    const metadata = await download(url, archive, now);
    const staging = join(tmp, "x");
    mkdirSync(staging);
    // system tar is guaranteed on ubuntu-latest and macOS runners.
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    if (extractedRoot(staging) === null) {
      throw new Error(`unexpected tarball layout for ${repo}@${ref}`);
    }
    if (existsSync(slot)) rmSync(slot, { recursive: true });
    renameSync(staging, slot);
    writeCacheMetadata(slot, metadata);
  } catch (exc) {
    if (cached !== null) {
      warn(`fetch of ${repo}@${ref} failed (${String(exc)}); using cached copy`);
      setMetadata(repo, ref, cached, "cache-fallback", now);
      return cached;
    }
    throw exc;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const root = extractedRoot(slot);
  if (root === null) {
    throw new Error(`unexpected tarball layout for ${repo}@${ref}`);
  }
  setMetadata(repo, ref, root, "fresh", now);
  return root;
}

export { tmpdir };
