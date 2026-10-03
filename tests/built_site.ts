import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import { REPO_ROOT, runCli, tempWork } from "./helpers.ts";

let built: string | null = null;

/** 固定時計（2026-08-09）でビルドしたサイトのディレクトリ（fixture キャッシュを使う）。 */
export function builtSite(): string {
  if (built === null) {
    const outdir = join(tempWork("cfp-split-"), "public");
    // 埋め込み生成は数秒かかるので、この検査群では作らない。
    // 2026-08-09 の件数回帰は、従来の公式訂正前の入力で測る。
    // 最新の公式訂正は researcher_deadline_flow と本番ビルドで別途検証する。
    const root = tempWork("cfp-query-reference-");
    for (const name of readdirSync(REPO_ROOT)) {
      if (name !== "data") symlinkSync(join(REPO_ROOT, name), join(root, name));
    }
    mkdirSync(join(root, "data"));
    for (const name of readdirSync(join(REPO_ROOT, "data"))) {
      if (name !== "overrides.yaml")
        symlinkSync(join(REPO_ROOT, "data", name), join(root, "data", name));
    }
    const overrides = load(readFileSync(join(REPO_ROOT, "data/overrides.yaml"), "utf8")) as {
      conferences: Record<string, unknown>;
    };
    const reference = load(
      readFileSync(join(REPO_ROOT, "tests/fixtures/query-reference-overrides.yaml"), "utf8"),
    ) as Record<string, unknown>;
    Object.assign(overrides.conferences, reference);
    writeFileSync(join(root, "data/overrides.yaml"), dump(overrides));
    const run = runCli(outdir, { root, extra: ["--no-embeddings"] });
    if (run.status !== 0) {
      throw new Error(
        `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
      );
    }
    built = outdir;
  }
  return built;
}
