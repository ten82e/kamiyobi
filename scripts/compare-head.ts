/**
 * ワークツリーの data ファイルと HEAD 版を「実質的な差」で比較する。
 * 生成日時やコメントなどの運用メタデータを除外し、内容の変更だけを判定する。
 *
 * 使い方:
 *   node scripts/compare-head.ts data/snapshot.json
 *   実質変更あり => 1 / なし（または読めない）=> 0 を stdout に出す。
 *
 * 「実質」の定義 (path-specific):
 *   - source-observation-baseline.json: top-level `observed_at` だけ無視
 *   - snapshot.json: `generated_at` と `_comment` だけ無視
 *   - primary_overrides.yaml: `_comment` だけ無視
 *   - discovered_candidates.yaml: `_comment` だけ無視
 *   - その他: `generated_at` / `observed_at` / `_comment` を無視 (後方互換)
 *
 * キーの並び順・YAML/JSON の形式差は正規化して無視する。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";

/** オブジェクトのキーを深さ優先でソートする（配列は順序を保つ）。 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sortKeys(rec[k])]),
    );
  }
  return v;
}

/**
 * Path-specific churn key stripping.
 *
 * - `baseline`: only top-level `observed_at` (no recursive stripping)
 * - `overrides`: recursive `_comment` only
 * - `snapshot`: recursive `generated_at` / `_comment` (but NOT evidence timestamps)
 * - `default`: recursive `generated_at` / `observed_at` / `_comment` (legacy compat)
 */
type ChurnMode = "baseline" | "overrides" | "snapshot" | "default";

function churnMode(path: string): ChurnMode {
  if (path.endsWith("source-observation-baseline.json")) return "baseline";
  if (path.endsWith("primary_overrides.yaml") || path.endsWith("discovered_candidates.yaml"))
    return "overrides";
  if (path.endsWith("snapshot.json")) return "snapshot";
  return "default";
}

/** 再帰的に churn key を除去する (path に応じたモード)。 */
function stripChurn(v: unknown, mode: ChurnMode): unknown {
  if (mode === "baseline") return v; // top-level only, handled in normalizeDataForPath
  if (Array.isArray(v)) return v.map((item) => stripChurn(item, mode));
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) {
      if (mode === "overrides") {
        // overrides: only skip _comment
        if (k === "_comment") continue;
      } else if (mode === "snapshot") {
        // snapshot: skip generated_at and _comment, and the entire
        // snapshot_metadata block (build-time metadata: generated_at /
        // fetchedAt / source revisions change on every build regardless of
        // content). Evidence timestamps inside conferences are kept.
        // `verification` blocks are build-time-derived scheduling metadata
        // (last_attempt_at / last_verified_at / next_check_at) — they change
        // on every build and may be absent in older committed snapshots, so
        // they are not content either.
        if (
          k === "generated_at" ||
          k === "_comment" ||
          k === "snapshot_metadata" ||
          k === "verification"
        )
          continue;
      } else {
        // default (legacy): skip generated_at, observed_at, _comment
        if (k === "generated_at" || k === "observed_at" || k === "_comment") continue;
      }
      out[k] = stripChurn(val, mode);
    }
    return out;
  }
  return v;
}

/**
 * 文字列を JSON / YAML として解釈し、path に応じて正規化した文字列を返す。
 * 読めなければ null。
 */
export function normalizeData(data: unknown, path?: string): string | null {
  if (data === null || typeof data !== "object") return null;
  const mode = path ? churnMode(path) : "default";
  let normalized: unknown;
  if (mode === "baseline") {
    // baseline: only strip top-level observed_at, then recursively sort keys
    const rec = data as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) {
      if (k === "observed_at") continue;
      filtered[k] = val;
    }
    normalized = sortKeys(filtered);
  } else {
    normalized = sortKeys(stripChurn(data, mode));
  }
  try {
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
}

/** ファイルの内容を JSON 優先・YAML フォールバックでパースする。 */
function parseFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return loadYaml(text);
    } catch {
      return null;
    }
  }
}

/** HEAD 版を読む。snapshot.json は Node の既定 1 MiB バッファを超える。 */
export function readFromHead(path: string): unknown {
  try {
    return parseFile(
      execFileSync("git", ["show", `HEAD:${path}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * ワークツリーの path と HEAD 版を実質比較する。
 * 1 = 実質変更あり / 0 = 変更なし・どちらかが読めない（コミットしない）。
 */
export function compareToHead(path: string): 0 | 1 {
  let next: unknown = null;
  try {
    next = parseFile(readFileSync(path, "utf8"));
  } catch {
    next = null;
  }
  const prev = readFromHead(path);
  const prevNorm = normalizeData(prev, path);
  const nextNorm = normalizeData(next, path);
  // 読めない側は書きかけとみなし、コミット対象にしない。
  if (prevNorm === null || nextNorm === null) return 0;
  return prevNorm === nextNorm ? 0 : 1;
}

const isMain = process.argv[1]?.endsWith("compare-head.ts");
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node scripts/compare-head.ts <path>\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${compareToHead(path)}\n`);
  }
}
