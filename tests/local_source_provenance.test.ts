import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCES } from "../src/build.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 自前データの正典（`src/sources/local.ts` の `localSourcePaths` が先に読む物）。 */
const 正典 = ["data/manual.yaml", "data/curated.generated.yaml"];
/** 旧データからの移行入力。正典が無い checkout でだけ読む。 */
const 舊入力 = "data/extra.yaml";

describe("自前データの出典表示", () => {
  it("配布物の出典（data.json）が正典を名指し、旧入力を出さない", () => {
    const out = builtSite();
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      sources?: Array<{ name?: string; repo?: string; license?: string }>;
    };
    const local = (data.sources ?? []).find((s) => s.name === "local");
    expect(local, "出典に local が無い").toBeTruthy();
    for (const path of 正典) expect(local?.repo, `出典が ${path} を名指していない`).toContain(path);
    /* 機械可読の出典に古い入力を書くと、索引を読む側が別のファイルを見に行く。 */
    expect(local?.repo, `出典が旧入力 ${舊入力} を名指している`).not.toContain(舊入力);
  });

  it("索引（llms.txt）の出典の節も同じ事を言う", () => {
    const out = builtSite();
    const text = readFileSync(join(out, "llms.txt"), "utf8");
    const 節 = text.slice(text.indexOf("## 出典とライセンス"));
    expect(節, "索引の出典の節が無い").not.toBe("");
    for (const path of 正典) expect(節, `索引が ${path} を名指していない`).toContain(path);
    expect(節, `索引が旧入力 ${舊入力} を名指している`).not.toContain(舊入力);
  });

  it("config.yaml と実装の既定が同じ出典を書く（どちらの経路でも同じ物を出す）", () => {
    const config = load(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as {
      sources?: Array<{ name?: string; repo?: string; license?: string }>;
    };
    const 設定 = (config.sources ?? []).map((s) => ({
      name: String(s.name ?? ""),
      repo: String(s.repo ?? ""),
      license: String(s.license ?? ""),
    }));
    expect(設定.length, "config.yaml の出典が 3 つでない").toBe(3);
    expect(
      設定,
      "config.yaml と DEFAULT_SOURCES が違う（config が勝つので既定が効かない）",
    ).toEqual(DEFAULT_SOURCES.map((s) => ({ name: s.name, repo: s.repo, license: s.license })));
  });

  it("NOTICE.md が正典を名指し、旧入力を移行入力と書く", () => {
    const notice = readFileSync(join(REPO_ROOT, "NOTICE.md"), "utf8");
    for (const path of 正典)
      expect(notice, `NOTICE.md が ${path} を名指していない`).toContain(path);
    expect(notice, "NOTICE.md が旧入力を移行入力と書いていない").toMatch(
      new RegExp(`${舊入力.replace(/[.]/g, "\\.")}.*正典ではない`),
    );
  });
});
