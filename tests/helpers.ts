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
 * 検査が使う一時目録を作る（第 482 回の片付け）。
 *
 * 此處で作る目録は此のままだと残り續けた – 実測（2026-11-08）で、検査用ディレクトリの
 * 使い捨て先（`$TMPDIR`）に `kamiyobi-*` が **139 546 個・約 40 GB** 積まつて居た（内訳は
 * `kamiyobi-reverify-*` 76 271 個など – 一個の検査が一個の目録を作り、誰も消さなかつた）。
 * なので此處で作った物は**プロセスの終了時に消す**（最善を尽くす – 消えぬ場合は OS の
 * 一時ディレクトリ掃除に任せる）。目録其物が必要ならば、自分で中身を移すか読む事。
 */
/**
 * 名前に埋めた PID が生きて居るかを見る（読め無い名は null）。
 *
 * `scripts/clean_tmp.ts` と同じ判じ方 – 死んで居る PID の目録は誰も使つて居ないので、時間を
 * 待たずに消して良い。生存を見るので、同時に走る検査は壊さない。
 */
function 生きて居る(目録名: string): boolean | null {
  const マッチ = /p(\d+)-/.exec(目録名);
  if (!マッチ) return null;
  try {
    process.kill(Number(マッチ[1]), 0); // 何も送らずに存在だけ見る
    return true;
  } catch (誤) {
    return (誤 as NodeJS.ErrnoException).code === "EPERM"; // 有るが触れぬ → 生きて居る
  }
}

/**
 * 検査が残して行つた一時目録を掃く（第 482 回・第 486 回）。
 *
 * 二つの道が在る。**PID を持つ物**（`tempWork` が作る `…p<PID>-…`）は、其のプロセスが終はつて
 * 居れば何時でも消す – 実測（2026-11-08）で、時間でだけ見ると、長く走つた検査の使用中の目録を
 * 消して了ひ、ビルドの決定性が割れた（84 本の失敗・品書のサイズが 1.37 MB ⇔ 0.80 MB）。
 * **PID を持たぬ物**は時刻で守る – 同時に走る検査が使つて居るかも知れぬ為、最終更新から
 * 一時間以内の物は触らない。
 *
 * vitest のワーカーは殺される事が在つて、其の場合 `exit` の用意が走らない。実測（2026-09-28）で
 * 一回答の検査に就き 443 個（内訳は `cfp-split-*` 175 個・`cfp-site-*` 35 個など）・約 18 MB が
 * 殘り、PID は總て死んで居た。なので `tempWork` が**最初に呼ばれた時に一度だけ**此れを走らせる。
 */
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
      if (状態 === true) continue; // 走つて居る検査の目録
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
  /* 此のプロセスの最初の一回だけ、前に殘つた目録を掃く（第 486 回 – ワーカーが殺されると
   * `exit` の用意が走らず、一回答の検査に就き 443 個・約 18 MB が殘つた）。PID の死んだ物
   * だけを消すので、同時に走つて居る検査の目録は触らない。*/
  if (!掃除の用意有り) {
    掃除の用意有り = true;
    古い一時目録を掃く();
  }
  /* 名前に此のプロセスの PID を残す – 掃除の側が「生きて居るプロセスの目録」を判別出来るやうに
   * （第 482 回 – 時間で判別すると、長く走つた検査の目録を消してビルドの決定性が割れた実測が
   * ある。PID で見るので、同時に走る検査は壊さない）。*/
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
  options: { now?: string; cache?: string; extra?: string[] } = {},
): RunResult {
  /* 其の方が持つキャッシュを渡さ無い時は使い捨てを作る – 実測（2026-11-08）で其れが一個
   * 約 2.5 MB あつて、呼ぶ度に増へて TMPDIR に 12 GB（4 897 個）を積ませた主因だつた（第 482 回）。
   * ビルドした子プロセスが終へば其処で用が済むので、**其の場で消す**（プロセス終り待ちだと
   * ワーカーが殺された時に残る）。明示的に渡されたキャッシュは消さない（其它の検査が読む為）。*/
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
