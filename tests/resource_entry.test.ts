import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

it("通常画面から静的一覧とAI向けの案内を直接開ける", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  const nav = html.match(/<nav class="resource-links"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  expect(nav).toBeDefined();
  for (const file of ["upcoming.html", "upcoming.md", "llms.txt"]) {
    expect(nav).toContain(`href="${file}"`);
    expect(existsSync(join(site, file))).toBe(true);
  }
  expect(html).toContain('aria-describedby="modeGuide"');
  expect(html).toContain('id="modeGuide"');
});
