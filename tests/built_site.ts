/**
 * 検査用のビルド済みサイトを 1 プロセスに 1 回だけ作る（SPEC §8）。
 *
 * `tests/build_golden.test.ts` は 1 ファイルに全検査を並べていて、そのファイルが
 * biome の既定の上限（1 MiB）にぶつかった（`tests/lint_budget.test.ts` が番をしている）。
 * 新しい検査は、ビルド済みサイトを共有するこの入口を使って別のファイルに置く。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers.ts";

let built: string | null = null;

/** 固定時計（2026-08-09）でビルドしたサイトのディレクトリ（fixture キャッシュを使う）。 */
export function builtSite(): string {
  if (built === null) {
    const outdir = join(mkdtempSync(join(tmpdir(), "cfp-split-")), "public");
    // 埋め込み生成は数秒かかるので、この検査群では作らない。
    const run = runCli(outdir, { extra: ["--no-embeddings"] });
    if (run.status !== 0) {
      throw new Error(
        `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
      );
    }
    built = outdir;
  }
  return built;
}
