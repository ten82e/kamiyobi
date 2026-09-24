/**
 * ビルド成果物の検査は 1 ファイルに置ける量に上限があるので、複数の検査ファイルに分けている
 * （tests/build_golden.test.ts・tests/built_golden_2〜4.test.ts・共有部品は
 * tests/built_golden_shared.ts – 第 255 回）。その形が崩れないように、ここで番をする（SPEC §8）。
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

it("検査ファイルは作業上限（400 KB）の内側に保つ（1 MiB まで残りわずか、では守れない・SPEC §8）", () => {
  /* 2026-09-24 実測: tests/build_golden.test.ts は 1,048,272 バイトまで育って、biome の上限まで
   * 304 バイトだった。検査を 1 本足すたびに閾値へ近づくので、「越えたら分ける」では間に合わない。
   * 2026-09-24 に 4 ファイルへ分割したので（最大の場で 276,540 バイト）、そこに余裕を持った
   * 上限を置いて、また 1 ファイルに育つのをここで止める。 */
  const ceiling = 400_000;
  const over: string[] = [];
  for (const name of readdirSync(join(ROOT, "tests"))) {
    if (!name.endsWith(".test.ts")) continue;
    // バイト数で測る（日本語の語は 1 字 3 バイト – 文字数では測れない）。
    const size = readFileSync(join(ROOT, "tests", name)).length;
    if (size > ceiling) over.push(`tests/${name} = ${size} バイト`);
  }
  expect(
    over,
    "検査ファイルが大きすぎる（新しい検査ファイルに分け、共通の部品は tests/built_golden_shared.ts へ移す – 書き写すと正本とズレる）",
  ).toEqual([]);
});
