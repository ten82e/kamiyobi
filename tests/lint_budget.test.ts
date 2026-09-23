/**
 * ビルド成果物の検査（tests/build_golden.test.ts）は 1 ファイルに全検査を並べている。
 * そのやり方が lint の運用と衝突するので、ここで番をする（SPEC §8）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("biome が読める大きさの内に保つ（越えると lint は黙ってそのファイルを追わなくなる・SPEC §8）", () => {
  /* 2026-09-24 実測: tests/build_golden.test.ts が 1,048,895 バイトになって、biome の既定の
   * 上限（1 MiB = 1,048,576 バイト）を 319 バイト越えた。biome はエラーも警告も出さず、
   * そのファイルを丸ごと飛ばした（`npm run check`: `Checked 76 files` → `75 files`、
   * 警告 35 件 → 6 件）。19,000 行の検査が、lint を通したつもりで無検査を通る。
   * 越えそうになったら検査を新しいファイルに分ける（この検査が理由を名指す）。 */
  const limit = 1048576;
  const over: string[] = [];
  for (const dir of ["src", "scripts", "site", "tests"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(".ts")) continue;
      // バイト数で測る（日本語の語は 1 字 3 バイト – 文字数では測れない）。
      const size = readFileSync(join(ROOT, dir, name)).length;
      if (size >= limit) over.push(`${dir}/${name} = ${size} バイト`);
    }
  }
  expect(over, "biome の上限（1 MiB）を越えたファイルがある（検査を別のファイルに分ける）").toEqual(
    [],
  );
});
