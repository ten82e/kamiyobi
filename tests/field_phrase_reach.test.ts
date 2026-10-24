import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const ROWS = Recommender.candidateRows(
  JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as { conferences: unknown },
) as Row[];
const 品書 = ROWS.map((r) => r.hay.toLowerCase());

const 収録と品書 = (
  readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8") +
  readFileSync(join(builtSite(), "catalog.json"), "utf8")
).toLowerCase();

/** 長い形 → 同じ行に届くべき語（そのまま打つと 0 行か、桁違いに少ない行になっていた語）。 */
const 長い形: Array<[string, string]> = [
  ["情報セキュリティ", "セキュリティ"],
  ["暗号学", "暗号"],
  ["理論計算機科学", "理論"],
  ["理論コンピュータ科学", "理論"],
  ["音声認識", "音声"],
  ["統計学", "統計"],
];

function source(): string {
  return readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
}

function reached(word: string): Set<Row> {
  const m = Recommender.searchMatcher(word, AT);
  return new Set(ROWS.filter((r) => m(r.hay) === true));
}

/** 画面に出る分野名の語（絞り込みチップの分野名と主題タグの和名）。 */
function 画面に出る分野名(): Set<string> {
  const src = source();
  const labels = new Set<string>();
  for (const name of ["CATEGORY_LABELS_JA", "TAG_LABELS_JA"]) {
    const begin = src.indexOf(`const ${name}`);
    expect(begin, `${name} が見当たらない`).toBeGreaterThan(-1);
    const block = src.slice(begin, src.indexOf("\n  };", begin));
    for (const m of block.matchAll(/:\s*"([^"]+)"/g)) labels.add(String(m[1]));
  }
  expect(labels.size, "画面に出る分野名が読めない").toBeGreaterThan(20);
  return labels;
}

const 分野寄せ = (() => {
  const src = source();
  const begin = src.indexOf('["画像認識", "原文の computer vision');
  expect(begin, "分野の寄せ語の表が見当たらない").toBeGreaterThan(-1);
  const table = src.slice(begin, src.indexOf("];", begin));
  const out = new Map<string, { shown: string; terms: string[] }>();
  for (const m of table.matchAll(/\[\s*"([^"]+)",\s*"([^"]*)",\s*\[([^\]]*)\]\s*,?\s*\]/g)) {
    out.set(String(m[1]), {
      shown: String(m[2]),
      terms: String(m[3])
        .split(",")
        .map((x) => x.trim().replace(/^"|"$/g, ""))
        .filter((x) => x.length > 0),
    });
  }
  expect(out.size, "分野の寄せ語の表が読めない").toBeGreaterThan(8);
  return out;
})();

const 語として = (t: string) => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, "i");
const 品書に出る = (t: string) =>
  品書.some((h) => (/[぀-ヿ一-龯]/.test(t) ? h.includes(t) : 語として(t).test(h)));
/* 品書に無い語でも、収録に在れば寄せ先として正しい（ハーネスの品書は収録の一部）。 */
const 収録か品書に出る = (t: string) => 収録と品書.includes(t.toLowerCase()) || 品書に出る(t);

it("長い形で打っても、その語で打ったのと同じ行に出会う（第 313 回）", () => {
  for (const [word, label] of 長い形) {
    const A = reached(word);
    const B = reached(label);
    const 漏れ = [...B].filter((r) => !A.has(r)).length;
    const 余計 = [...A].filter((r) => !B.has(r)).length;
    expect(漏れ, `「${word}」だと「${label}」で当たる行が ${漏れ} 行こぼれている`).toBe(0);
    expect(余計, `「${word}」は「${label}」で当たらない行を呼んでいる`).toBe(0);
    const notes = Recommender.querySynonymNotes(word);
    expect(notes, `「${word}」の寄せを件数欄に出していない`).toHaveLength(1);
  }
});

it("件数欄に出す説明が実測と合う（分野名の寄せ – 第 313 回）", () => {
  const labels = 画面に出る分野名();
  let 分野名の主張 = 0;
  let 原文の主張 = 0;
  for (const [word, { shown }] of 分野寄せ) {
    for (const m of shown.matchAll(/分野名の\s*([^ 、]+)|原文の\s*([^ 、]+)/g)) {
      const asLabel = m[1];
      const asSource = m[2];
      if (asLabel) {
        分野名の主張 += 1;
        expect(
          labels.has(asLabel),
          `「${word}」の説明は「${asLabel}」を分野名としているが画面に出ない`,
        ).toBe(true);
      }
      if (asSource) {
        原文の主張 += 1;
        expect(
          収録か品書に出る(asSource),
          `「${word}」の説明は「${asSource}」を原文の語としているが収録にも品書にも出ない`,
        ).toBe(true);
      }
    }
  }
  expect(
    分野名の主張,
    "分野名への寄せの説明が 1 件も検査されない（書き分けの検査が空振り）",
  ).toBeGreaterThan(1);
  expect(原文の主張).toBeGreaterThan(2);
});

it("長い形の寄せ先は品書に現れる語で、長い形その物は 1 行以上に出会う（第 313 回）", () => {
  const labels = 画面に出る分野名();
  for (const [word, label] of 長い形) {
    const entry = 分野寄せ.get(word);
    expect(entry, `「${word}」の寄せが表に無い`).toBeDefined();
    for (const t of entry?.terms ?? []) {
      // 画面に出る分野名は、データにその文字列が無くても良い（その分野名自身の寄せで行に届く）。
      expect(
        収録か品書に出る(t) || labels.has(t),
        `「${word}」の寄せ先「${t}」は収録にも品書にも出ず、画面の分野名でもない（死語への寄せ）`,
      ).toBe(true);
    }
    // 品書の行にその語が現れる形だけ検査する（ハーネスの品書に無い分野は空振りになる）。
    if (品書に出る(label)) {
      expect(
        reached(word).size,
        `「${word}」で 1 行にも出会えない（寄せの配線が壊れている）`,
      ).toBeGreaterThan(0);
    }
  }
});
