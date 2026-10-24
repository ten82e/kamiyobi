/**
 * Shared fixtures and helpers for the vitest suite.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Conference,
  type Deadline,
  type DeadlineKind,
  type Edition,
  type ExactDeadline,
  isExactDeadline,
} from "../src/model.ts";

export const REPO_ROOT = join(import.meta.dirname, "..");
export const FIXTURES = join(import.meta.dirname, "fixtures");

// Deterministic "now" used by every build in the test suite.
export const NOW = new Date("2026-08-09T00:00:00Z");
export const NOW_ARG = "2026-08-09T00:00:00Z";

// public/ contents required by SPEC.md section 4. embeddings.json は golden テストが
// --no-embeddings で走るためここには含めない。
export const PUBLIC_FILES = [
  "index.html",
  "data.json",
  "health.json",
  "health.md",
  "publish.json",
  "catalog.json",
  "recommendation-index.json",
  "app.js",
  "data.csv",
  "upcoming.md",
  "llms.txt",
  ".nojekyll",
];

/** 'YYYY-MM-DDTHH:MM:SSZ' の UTC 時刻を作る。 */
export function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// --- factories ----------------------------------------------------------------

export function makeDeadline(
  kind: DeadlineKind,
  label: string,
  atUtc: Date,
  tzRaw = "AoE",
  round = 1,
  comment: string | null = null,
): ExactDeadline {
  return { kind, label, at_utc: atUtc, tz_raw: tzRaw, round, comment };
}

export function exactAt(deadline: Deadline): Date {
  if (!isExactDeadline(deadline)) throw new Error("expected exact deadline");
  return deadline.at_utc;
}

export function makeEdition(overrides: Partial<Edition> & { year: number }): Edition {
  return {
    edition_id: "",
    link: "https://example.org/",
    place: "Somewhere",
    date_text: "",
    event_start: null,
    event_end: null,
    deadlines: [],
    estimated: false,
    source: "ccfddl",
    ...overrides,
  };
}

export function makeConference(
  overrides: Partial<Conference> & { key: string; title: string },
): Conference {
  return {
    full_name: overrides.title,
    link: "https://example.org/",
    rank: {},
    dblp: null,
    upstream_sub: null,
    tags: [],
    categories: [],
    editions: [],
    sources: ["ccfddl"],
    ...overrides,
  };
}

// --- offline fixture cache -----------------------------------------------------

const REPOS: Array<[string, string, string, string]> = [
  ["ccfddl/ccf-deadlines", "ccf-deadlines-main", "ccfddl", "conference"],
  ["huggingface/ai-deadlines", "ai-deadlines-main", "aideadlines", "src"],
];

/** An offline cache directory whose only data source is tests/fixtures/. */
export function makeFixtureCache(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const [repo, top, fixtureDir, payload] of REPOS) {
    const slot = join(dir, `${repo.replace("/", "__")}__main`);
    mkdirSync(join(slot, top), { recursive: true });
    cpSync(join(FIXTURES, fixtureDir, payload), join(slot, top, payload), {
      recursive: true,
    });
  }
  return dir;
}

/**
 * 名前に埋めた PID が生きているかを見る（読め無い名は null）。
 *
 * `scripts/clean_tmp.ts` と同じ判じ方 – 死んでいる PID の目録は誰も使つて居ないので、時間を
 * 待たずに消して良い。生存を見るので、同時に走る検査は壊さない。
 */
function 生きて居る(目録名: string): boolean | null {
  const マッチ = /p(\d+)-/.exec(目録名);
  if (!マッチ) return null;
  try {
    process.kill(Number(マッチ[1]), 0); // 何も送らずに存在だけ見る
    return true;
  } catch (誤) {
    return (誤 as NodeJS.ErrnoException).code === "EPERM"; // あるが触れぬ → 生きている
  }
}

export function 古い一時目録を掃く(): void {
  const 猶予 = 60 * 60 * 1000;
  const 今 = Date.now();
  let 名前々: string[];
  try {
    名前々 = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const 名前 of 名前々) {
    if (!/^(kamiyobi|cfp|build-now-test|tracked-test|aideadlines-shape|ccfddl-shape)-/.test(名前))
      continue;
    const 道 = join(tmpdir(), 名前);
    try {
      const 状態 = 生きて居る(名前);
      if (状態 === true) continue; // 走つている検査の目録
      const 期限 = 状態 === false ? 0 : 猶予; // PID が死んで居れば直ぐに消す
      if (今 - statSync(道).mtimeMs <= 期限) continue;
      rmSync(道, { recursive: true, force: true });
    } catch {
      /* 掃けなければ見送る – 検査の結果を変へない */
    }
  }
}

const 作った一時目録 = new Set<string>();
let 退出の用意有り = false;
let 掃除の用意有り = false;

export function tempWork(prefix: string): string {
  if (!掃除の用意有り) {
    掃除の用意有り = true;
    古い一時目録を掃く();
  }

  const dir = mkdtempSync(join(tmpdir(), `${prefix}p${process.pid}-`));
  作った一時目録.add(dir);
  if (!退出の用意有り) {
    退出の用意有り = true;
    const 掃除 = () => {
      for (const 目録 of 作った一時目録) {
        try {
          rmSync(目録, { recursive: true, force: true });
        } catch {
          /* 片付けは最善を尽くす – 落ちても検査の結果を変へない */
        }
      }
      作った一時目録.clear();
    };
    process.on("exit", 掃除);
    process.on("beforeExit", 掃除);
  }
  return dir;
}

export function tempCache(): string {
  return makeFixtureCache(tempWork("cfp-cache-"));
}

// --- run the CLI ---------------------------------------------------------------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `node src/cli.ts build` offline against the fixture cache. */
export function runCli(
  outdir: string,
  options: { now?: string; cache?: string; extra?: string[]; root?: string } = {},
): RunResult {
  let 使い捨てのキャッシュ = "";
  let cache = options.cache ?? "";
  if (cache === "") {
    使い捨てのキャッシュ = makeFixtureCache(mkdtempSync(join(tmpdir(), "cfp-cache-")));
    cache = 使い捨てのキャッシュ;
  }
  const cmd = [
    "node",
    join(REPO_ROOT, "src", "cli.ts"),
    "build",
    "--out",
    outdir,
    "--offline",
    "--cache",
    cache,
    "--now",
    options.now ?? NOW_ARG,
    ...(options.extra ?? []),
  ];
  if (options.root) {
    cmd.splice(
      1,
      1,
      "--input-type=module",
      "-e",
      `import { main, setRoot } from ${JSON.stringify(join(REPO_ROOT, "src/cli.ts"))}; setRoot(process.argv[1]); process.exitCode = await main(process.argv.slice(2));`,
      options.root,
    );
  }
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (使い捨てのキャッシュ) {
    try {
      rmSync(使い捨てのキャッシュ, { recursive: true, force: true });
    } catch {
      /* 片付けは最善を尽くす – 検査の結果を変へない */
    }
  }
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}
