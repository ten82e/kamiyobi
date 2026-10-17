/**
 * README（研究者が最初に読む文書）の一覧が、実装と合っている事を見る。
 *
 * README は「何ができるか」「どこからデータを取っているか」を一往復で伝える文書である。
 * 道具を足して表を書き忘れれば**その道具は README からは見えず**、データ源が増えて
 * 書き忘れれば**出典が伝わらない**（第 55・59 回に、README だけが古い説明を殘していた型がある）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

const readme = (): string => readFileSync(join(REPO_ROOT, "README.md"), "utf8");

it("README の道具の一覧が、実装の道具と一致する", () => {
  const mcp = readFileSync(join(REPO_ROOT, "src", "mcp.ts"), "utf8");
  const 実装 = [...new Set([...mcp.matchAll(/\n {4}name: "([a-z_]+)",/g)].map((m) => m[1]))].sort();
  expect(実装.length, "道具が 5 つ未満（前提が崩れた）").toBeGreaterThan(5);

  const 節 = readme().split("### MCP サーバとして使う")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "README に MCP の節が無い").toBeGreaterThan(200);
  const 書いた = [...new Set([...節.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]))].sort();
  expect(書いた, "README の道具の表が実装と違う").toEqual(実装);
});

it("README のデータ源の一覧が、収録の出典と一致する", () => {
  const d = JSON.parse(readFileSync(join(REPO_ROOT, "public", "data.json"), "utf8")) as {
    sources?: Array<{ name?: string; license?: string }>;
  };
  const 出典 = (d.sources ?? []).filter((s) => s.name);
  expect(出典.length, "出典が 2 つ未満（前提が崩れた）").toBeGreaterThan(1);

  const 節 = readme().split("## データ源とライセンス")[1]?.split("\n## ")[0] ?? "";
  expect(節.length, "README にデータ源の節が無い").toBeGreaterThan(100);
  const 表 = [...節.matchAll(/^\| `([a-z]+)` \|.*\| ([^|]+) \|$/gm)].map((m) => ({
    name: m[1],
    license: m[2].trim(),
  }));
  const 名 = 表.map((x) => x.name).sort();
  expect(名, "README のデータ源が収録の出典と違う").toEqual(出典.map((s) => s.name).sort());
  /* ライセンスの語も合ふ（片方だけ直すと、出典の條件を誤って伝へる）。 */
  for (const s of 出典) {
    const 行 = 表.find((x) => x.name === s.name);
    expect(行?.license ?? "", `${s.name} のライセンスが README と違う`).toContain(
      String(s.license ?? ""),
    );
  }
});
