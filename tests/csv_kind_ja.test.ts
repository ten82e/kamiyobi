/**
 * 生の CSV（`data.csv`）の種別欄の検査（SPEC §7・第 270 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - `data.csv` は 3,253 行・25 欄。種別は `kind`（上流の英語キー 10 種）と
 *     `label`（上流の自由文）だけで、**日本語の種別欄は 0 本**だった。
 *     同じ内容を出す `upcoming.md`（種別欄あり）と `deadlines.ics`（DESCRIPTION に種別）は
 *     最初から日本語だったので、この表だけ並べ替え・絞り込みが英語に頼る形になっていた。
 *   - `label` はつづりが揺れる（'Paper submission' 1,483 行 / 'Paper Submission' 48 行 /
 *     'Paper submission deadline' 54 行が同じ物）。ここに依存させるのは危ない。
 *   - 直し方は `kind_ja` を**末尾に**足す（列の順序で読む下流を壊さない）。語は画面と同じ
 *     正本 `KIND_LABEL_JA`（`site/recommender.ts`）から引く。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { japaneseStringLiterals, site } from "./built_golden_shared.ts";

/* ------------------------------------------------------------------ 読み出し */

/** 引用符とカンマを守る最小の CSV 読み出し（`data.csv` は BOM 無し・LF）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvRows(): { header: string[]; body: string[][] } {
  const rows = parseCsv(readFileSync(join(site, "data.csv"), "utf8"));
  return { header: rows[0], body: rows.slice(1).filter((r) => r.length > 1) };
}

function column(name: string): { header: string[]; values: string[] } {
  const { header, body } = csvRows();
  const i = header.indexOf(name);
  expect(i, `欄 ${name} が無い`).toBeGreaterThanOrEqual(0);
  return { header, values: body.map((r) => r[i] ?? "") };
}

/**
 * マークダウンの表から、指定の欄だけを取り出す。
 * `|` で始まる行を無条件に拾うと、同じ文書の中の別な表（凡例など）まで拾ってしまう
 * （第 270 回の実発生: 縮約カタログのビルドで、種別の欄に別表の「R1」「R2」が現れた）。
 */
function markdownColumn(text: string, columnJa: string): string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("|")) continue;
    const head = lines[i]
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const k = head.indexOf(columnJa);
    if (k < 0) continue;
    const out: string[] = [];
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j += 1) {
      const cells = lines[j]
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (cells[k]) out.push(cells[k]);
    }
    expect(out.length, `マークダウンの ${columnJa} 欄に行が無い`).toBeGreaterThan(0);
    return out;
  }
  throw new Error(`マークダウンに ${columnJa} 欄を持つ表が無い`);
}

/**
 * ビルド成果物に並ぶ日本語の語をそのまま拾う（検査側に語を書き写さない）。
 * ビルドでは関数名が付け替わることがあるので、関数を抜き出すのではなく、成果物に実際に
 * 含まれる日本語の文字列その物を正しく使う（第 270 回の実測で `kindLabelTable` が
 * その名で見つからなかった）。
 */
function builtJapaneseWords(): Set<string> {
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  return new Set(japaneseStringLiterals(rec));
}

/* ---------------------------------------------------------------------- 検査 */

describe("生の CSV の日本語の種別欄（第 270 回）", () => {
  it("欄が末尾に有り、既存の列順を変えていない", () => {
    const { header } = csvRows();
    expect(header[header.length - 1], "日本語の種別欄が末尾に無い").toBe("kind_ja");
    expect(header.indexOf("kind"), "英語のキーの欄が消えた").toBeGreaterThanOrEqual(0);
    expect(header.filter((h) => h === "kind_ja").length, "同じ欄が 2 本有る").toBe(1);
    // 末尾に足したので、従来いちばん後ろだった欄はそのまま残る。
    expect(header[header.length - 2], "列の並びが変わっている").toBe("link");
  });

  it("全行の欄数が揃っており、日本語の種別が空欄の行が無い", () => {
    const { header, body } = csvRows();
    const wrong = body.filter((r) => r.length !== header.length);
    expect(wrong.length, `欄数が合わない行が ${wrong.length} 本有る`).toBe(0);
    const { values } = column("kind_ja");
    const blank = values.filter((v) => !v.trim());
    expect(blank.length, `種別が空欄の行が ${blank.length} 本有る`).toBe(0);
    // 行数は生成時刻とカタログで動く（共有ハーネスは縮約カタログで 510 行、実カタログの
    // 2026-08-09 生成で 3,253 行を実測）。ここは「全行」を見ることが目的なので下限は緩くする。
    expect(values.length, "行数が読めない").toBeGreaterThan(100);
  });

  it("値はサイト自身が持つ語だけで、英語のキーとの対応も割れていない", () => {
    const words = builtJapaneseWords();
    expect(words.size, "ビルド成果物から日本語の語が読めない").toBeGreaterThan(50);
    const { header, body } = csvRows();
    const ki = header.indexOf("kind");
    const ji = header.indexOf("kind_ja");
    const bad: string[] = [];
    body.forEach((r) => {
      const ja = r[ji] ?? "";
      // 同じ年に同じ種別が複数ある行だけは、区別のため ': ' + 上流のラベルを続ける（画面と同じ）。
      const base = ja.split(": ")[0];
      if (!words.has(base)) bad.push(`${r[ki]} -> ${ja}`);
    });
    expect(bad.slice(0, 4), `サイトの語彙に無い種別が出ている: ${bad.length} 件`).toEqual([]);
    // 英語のキーと同じ行に乗り、キーごとに日本語が 1 語に決まっている（対応が 2 通りに割れない）。
    const byKind = new Map<string, Set<string>>();
    body.forEach((r) => {
      const key = r[ki] ?? "";
      const set = byKind.get(key) ?? new Set<string>();
      set.add((r[ji] ?? "").split(": ")[0]);
      byKind.set(key, set);
    });
    expect(byKind.size, "英語のキーが読めない").toBeGreaterThanOrEqual(8);
    const doubled = [...byKind].filter(([, set]) => set.size !== 1).map(([k]) => k);
    expect(
      doubled,
      `1 つのキーに日本語が 2 つ以上割り当てられている: ${doubled.join(", ")}`,
    ).toEqual([]);
  });

  it("マークダウンとカレンダーが出す種別と同じ語を指している（成果物間で語彙が割れない）", () => {
    const { values } = column("kind_ja");
    // 同じ年に同じ種別が複数ある行だけは ': ' + 上流のラベルを続けるので、語だけ揃えて比べる。
    const inCsv = new Set(values.map((v) => v.split(": ")[0].trim()));
    const md = readFileSync(join(site, "upcoming.md"), "utf8");
    const mdWords = new Set(
      markdownColumn(md, "種別")
        .map((v) => v.split(":")[0].trim())
        .filter((w) => w && w !== "種別"),
    );
    expect(mdWords.size, "マークダウンの種別が読めない").toBeGreaterThanOrEqual(2);
    // 「開催」行は 1 行 1 締切のこの表には入らない（`type` が deadline の行だけ書く）ので外す。
    // マークダウンは 180 日の窓しか出さないので、語の数はこちらの方が多い側になる。
    const missing = [...mdWords].filter((w) => w !== "開催" && !inCsv.has(w));
    expect(missing, `マークダウンに出る種別が CSV の日本語欄に無い: ${missing.join(", ")}`).toEqual(
      [],
    );

    // カレンダーも同じ語。75 オクテットで折られた行は戻して読み、語だけ取り出す。
    const ics = readFileSync(join(site, "deadlines.ics"), "utf8").replace(/\r\n /g, "");
    const icsWords = new Set(
      [...ics.matchAll(/種別:([^|\\]+)/g)].map((m) => m[1].trim().split(": ")[0].trim()),
    );
    expect(icsWords.size, "カレンダーから種別が読めない").toBeGreaterThanOrEqual(2);
    const missing2 = [...icsWords].filter((w) => w !== "開催" && !inCsv.has(w));
    expect(missing2, `カレンダーに出る種別が CSV の日本語欄に無い: ${missing2.join(", ")}`).toEqual(
      [],
    );
  });

  it("索引は CSV の全欄の意味を持っている（欄を足して説明を忘れない）", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const from = txt.indexOf("## data.csv の列");
    expect(from, "欄の説明の節が無い").toBeGreaterThan(-1);
    const next = txt.indexOf("\n## ", from + 10);
    const section = txt.slice(from, next < 0 ? txt.length : next);
    const { header } = csvRows();
    /* 名前が並んでいるだけ検査だと、説明が空欄の欄（`- kind_ja：` だけ）を通してしまう
     * （第 270 回の改ざんで実発生: 説明側をリネームしても落ちなかった）。
     * 「名前の後ろに何か書いてある」まで見る。 */
    const undocumented = header.filter((name) => !new RegExp(`^- ${name}：\\S`, "m").test(section));
    expect(undocumented, `説明の無い欄がある: ${undocumented.join(", ")}`).toEqual([]);
    expect(header.length, "欄の数が読めない").toBeGreaterThanOrEqual(25);
  });

  it("索引は「日本語の値を書かない」という契約を例外込みで正直に書いている", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const from = txt.indexOf("## data.csv の列");
    expect(from, "欄の説明の節が無い").toBeGreaterThan(-1);
    const next = txt.indexOf("\n## ", from + 10);
    const section = txt.slice(from, next < 0 ? txt.length : next);
    const contract = /日本語は書かない/.exec(section);
    expect(contract, "契約の文が消えた（実物が決まったときに気づけなくなる）").toBeTruthy();
    expect(
      section.slice(contract!.index, contract!.index + 500),
      "日本語を書く例外を宣言していない（索引が噓をついている）",
    ).toContain("kind_ja");
  });

  it("案内が、生の CSVに日本語の欄が有ると正直に言っている（てびきと JavaScript 無効の案内）", () => {
    const page = readFileSync(join(site, "index.html"), "utf8");
    const ns = /<noscript>([\s\S]*?)<\/noscript>/.exec(page);
    expect(ns, "JavaScript 無効の案内が無い").toBeTruthy();
    const nsText = ns![1].replace(/\s+/g, "");
    expect(nsText, "生の CSV の案内が種別を言わない").toContain("種別");
    expect(nsText, "生の CSV の案内が日本語の欄があることを隠している").toContain("2欄");
    const guide = [...page.matchAll(/<details[\s\S]*?<\/details>/g)]
      .map((m) => m[0])
      .sort((a, b) => b.length - a.length)[0];
    expect(guide, "てびきが data.csv の日本語の欄を置いていない").toContain("kind_ja");
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const line = txt.split("\n").find((l) => l.startsWith("- data.csv："));
    expect(line, "索引の CSV の説明が種別欄を言わない").toContain("kind_ja");
  });
});
