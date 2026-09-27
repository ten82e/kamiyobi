import { join } from "node:path";
import { runCli, tempWork } from "./helpers.ts";

let built: string | null = null;

/** 固定時計（2026-08-09）でビルドしたサイトのディレクトリ（fixture キャッシュを使う）。 */
export function builtSite(): string {
  if (built === null) {
    const outdir = join(tempWork("cfp-split-"), "public");
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
