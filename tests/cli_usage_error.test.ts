import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

/* 引数の打ち間違いは、スタックではなく 1 行で伝える（2026-10-24 實測: 直す前は
 * `Error: unparsable --now: "garbage"` のあとに `    at …` が続いていた）。内部の不具合は
 * 従来どおりスタックごと出す（`UsageError` の時だけ短くする）。 */
it("--now の打ち間違いは、スタックを出さずに 1 行で伝える", () => {
  let stderr = "";
  let code: number | null = null;
  try {
    execFileSync(
      process.execPath,
      [
        "src/cli.ts",
        "build",
        "--out",
        "/tmp/kamiyobi-usage-test",
        "--offline",
        "--no-embeddings",
        "--cache",
        ".cache",
        "--now",
        "garbage",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" },
    );
  } catch (err) {
    stderr = String((err as { stderr?: string }).stderr || "");
    code = (err as { status?: number }).status ?? null;
  }
  expect(code, "失敗していない（0 で終わった）").toBe(1);
  expect(stderr, "理由を書いていない").toContain('unparsable --now: "garbage"');
  expect(stderr, "スタックを出している").not.toMatch(/\n\s+at /);
});
