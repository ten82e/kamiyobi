import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    out.set(part.slice(0, newline).trim(), part.slice(newline + 1));
  }
  return out;
}

it("points every llms.txt shortcut at a file and a section that exist", () => {
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  const all = sections(text);
  const shortcuts = all.get("用途別の近道");
  expect(shortcuts, "索引に近道の節が無い").toBeDefined();
  const headings = [...all.keys()];
  // 近道は索引の先頭に置く（全体を読まずに済ませるための節）。
  expect(headings[0]).toBe("用途別の近道");

  const files = [...String(shortcuts).matchAll(/`([\w.-]+\.(?:md|json|csv|ics|html|txt))`/g)].map(
    (m) => m[1],
  );
  expect(files.length, "近道がファイルを名指していない（検査が空振り）").toBeGreaterThanOrEqual(4);
  const listed = String(all.get("出力一覧"));
  for (const name of files) {
    expect(listed, `近道の ${name} が出力一覧に無い`).toContain(`- ${name}：`);
  }

  const named = [...String(shortcuts).matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  expect(named.length, "近道が節を名指していない（検査が空振り）").toBeGreaterThanOrEqual(3);
  for (const heading of named) {
    expect(headings, `近道の「${heading}」という節が索引に無い`).toContain(heading);
  }

  // 人に渡す URL の名前は、サイトの節が説明している物だけを挙げる。
  const siteSection = String(all.get("サイト（index.html）の日本語での引き方"));
  for (const param of ["q", "cats", "row"]) {
    expect(shortcuts).toContain(`\`${param}\``);
    expect(siteSection, `近道の URL の名前 ${param} がサイトの節に無い`).toContain(`\`${param}\``);
  }
});
