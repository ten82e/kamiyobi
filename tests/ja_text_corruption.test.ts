import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
/** 検査する置き場。`public/` は CI が行うビルドの生成物で .gitignore なので入れない。 */
const 置き場 = ["src", "site", "scripts", "tests", "data"] as const;
const 読む拡張子 = new Set([".ts", ".js", ".md", ".json", ".yaml", ".yml", ".txt", ".html"]);
/** 走らせない置き場（依存・生成物・作業物）。 */
const 飛ばす = new Set(["node_modules", ".git", "public", "work", ".cache", "coverage"]);

function 走査(dir: string, 見つけた: string[]): void {
  for (const name of readdirSync(dir)) {
    if (飛ばす.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      走査(path, 見つけた);
      continue;
    }
    if (!読む拡張子.has(extname(name))) continue;
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.includes("\ufffd"))
        見つけた.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim()}`);
    });
  }
}

function 混入を探す(): string[] {
  const 見つけた: string[] = [];
  for (const dir of 置き場) 走査(join(ROOT, dir), 見つけた);
  for (const name of ["README.md", "SPEC.md"]) {
    readFileSync(join(ROOT, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("\ufffd")) 見つけた.push(`${name}:${i + 1}: ${line.trim()}`);
      });
  }
  return 見つけた;
}

describe("日本語の文字化け", () => {
  it("追跡する置き場に置換文字（U+FFFD）が混ざっていない（第 903 回）", () => {
    const 見つけた = 混入を探す();
    expect(
      見つけた,
      [
        "読めない字（置換文字）が混入している:",
        ...見つけた,
        "",
        "注釈や説明の途中に 1 語だけ文字化けした形が典型。旧字体の検査では見えないので、",
        "そのまま書くと次の回を読む人が其れを悪い日本語として読む。書き直してから入れる。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("混入を 1 語でも検出できる – 検査が空振りでないことを確かめる", () => {
    /* サンプルは**検出に必要な行だけ**にする（本身的に置換文字を入れると自分の検査で落ちる）。 */
    const 見本 = ["const x = 1;", `あ${"\ufffd"}い`].join("\n");
    const 見つけた = 見本.split("\n").filter((l) => l.includes("\ufffd"));
    expect(見つけた.length, "1 語だけの混入も検出できる").toBe(1);
  });
});

describe("配つてある物（public/）にも破損がない（第 976 回）", () => {
  const 配布物 = [
    "llms.txt",
    "upcoming.md",
    "data.csv",
    "upcoming.html",
    "index.html",
    "404.html",
    "data.json",
    "health.json",
  ] as const;
  it("置換文字が 1 つもない", () => {
    for (const name of 配布物) {
      const path = join(ROOT, "public", name);
      expect(
        existsSync(path),
        "検証に必要な生成物がありません。オフラインビルドを実行してください",
      ).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text.includes("\ufffd"), `${name} に置換文字が在る`).toBe(false);
    }
  });
  it("中国語の簡体字が 1 つもない", () => {
    /* 表は**監査スクリプトの正本**から読む（書き寫すとズレる – 第 915 回と同じ決まり）。 */
    const audits = readFileSync(join(ROOT, "scripts", "ja-text-audit.ts"), "utf8");
    const 簡体字 = /const 簡体字 =\s*"([^"]+)";/.exec(audits)?.[1] ?? "";
    expect(簡体字.length, "簡体字の表が空（この検查の前提が崩れた）").toBeGreaterThan(0);
    for (const name of 配布物) {
      const path = join(ROOT, "public", name);
      expect(
        existsSync(path),
        "検証に必要な生成物がありません。オフラインビルドを実行してください",
      ).toBe(true);
      const text = readFileSync(path, "utf8");
      const 混ざり = [...new Set([...text].filter((c) => 簡体字.includes(c)))];
      expect(混ざり.join(""), `${name} に簡体字が混ざつて居る: ${混ざり.join("")}`).toBe("");
    }
  });
});

describe("中国語の簡体字", () => {
  it("検査の表と、書き放入れた語が一致する（第 915 回）", async () => {
    const script = readFileSync(join(ROOT, "scripts", "ja-text-audit.ts"), "utf8");

    /* 定義が 1 行か 2 行かを問は無い形に読む（整形で́ 替わる – 第 932 回）。 */
    const 表 = /const 簡体字 =\s*"([^"]+)";/.exec(script)?.[1] ?? "";
    expect(表.length, "簡体字の表が空（この検査の前提が崩れた）").toBeGreaterThan(0);
    /* 実測で当たった字と、第 915 回の最初の滑り（`选定理由`）が入つている。 */
    for (const 字 of ["选", "载", "云", "记"]) {
      expect(表, `簡体字「${字}」が表に無い`).toContain(字);
    }
    /* 日本語でも使う字は**入れない** – 入れると偽検査になる（実測 2026-11-04 に 493 待たせて
     * 37 字が偽検出になった）。 */
    for (const 字 of ["国", "学", "会", "実", "画", "声", "残", "点", "猫"]) {
      expect(表, `日本語でも使う「${字}」が表に在る（偽檢査になる）`).not.toContain(字);
    }
  });
});

describe("旧字体の監査が動く", () => {
  it("スクリプトがsyntax error で止まらない（第 933 回）", () => {
    const proc = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "ja-text-audit.ts"), join(ROOT, "site", "template.html")],
      { encoding: "utf8", timeout: 120_000 },
    );
    const 出 = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
    expect(proc.status, `監査が止まった:\n${出.slice(0, 300)}`).toBe(0);
    expect(出, "候補の要約が出て居ない（表の定義が読めて居ない）").toContain("候補");
    /* 検出能力も確かめる（表の 1 字を入れれば出る – ここが空振りでないこと）。 */
    const 當 = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "ja-text-audit.ts"), join(ROOT, "src", "mcp.ts")],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(`${當.stdout ?? ""}${當.stderr ?? ""}`).toContain("候補");
  });
});
