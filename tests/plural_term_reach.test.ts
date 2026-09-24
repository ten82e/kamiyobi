/**
 * 英字語を複数形で打った人の検査（SPEC §4・§7・第 314 回）。
 * 語頭一致の規則は「打たれた語が原文の語の左端に並ぶ」ときだけ通すので、語尾に `s` を
 * 足した瞬間に単数形で当たる行が外れていた（実測 – `abstracts` 5 行 / `abstract` 146 行、
 * `deadlines` 0 行 / `deadline` 231 行）。検査は品書（ビルド成果の catalog.json）と
 * 収録（`data/snapshot.json`）の両方に行う – ビルドに使う品書は収録の一部で、無い語の方が
 * 普通なので、片側だけだと語が集まらず空振りする（第 306 回以降と同じ工夫）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

/* 正本の `pluralStems` と同じ畳み方（実装を呼べない検査側なので、規則をここに書く –
 * 規則その物は下の 3 本の検査で正本から壊れる）。 */
function pluralStems(term: string): string[] {
  if (!/^[a-z]{4,}s$/.test(term) || /(ss|us|is)$/.test(term)) return [];
  const out = [term.slice(0, -1)];
  if (/(xes|ses|zes|ches|shes)$/.test(term)) out.push(term.slice(0, -2));
  return out;
}

/* 品書 + 収録の行（重複は行の検索用文字列で畳む）。 */
function corpora(): { label: string; rows: Row[] }[] {
  const built = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"));
  return [
    { label: "品書", rows: Recommender.candidateRows(built) as Row[] },
    { label: "収録", rows: Recommender.candidateRows(snapshot) as Row[] },
  ];
}

/** 語の集合（行の検索用文字列を語に割ったもの）。 */
function wordsOf(rows: Row[]): Set<string> {
  const out = new Set<string>();
  rows.forEach((row) => {
    (Recommender.queryTokens(row.hay) as string[]).forEach((word) => {
      out.add(word);
    });
  });
  return out;
}

function reaching(rows: Row[], query: string): Set<Row> {
  const match = Recommender.searchMatcher(query, AT);
  return new Set(rows.filter((row) => match(row.hay) === true));
}

/** 語が語頭（英数字の直前に来ない位置）で現れる行。 */
function writing(rows: Row[], word: string): Set<Row> {
  const out = new Set<Row>();
  rows.forEach((row) => {
    const text = String(row.hay).toLowerCase();
    let at = -1;
    for (;;) {
      at = text.indexOf(word, at + 1);
      if (at < 0) break;
      const before = at > 0 ? text.charAt(at - 1) : "";
      if (!/[a-z0-9]/.test(before)) {
        out.add(row);
        break;
      }
    }
  });
  return out;
}

describe("英字語の複数形で打った人", () => {
  it("単数形で当たる行は、複数形を打っても落ちない", () => {
    let 調べた語 = 0;
    let 救われた行 = 0;
    for (const { label, rows } of corpora()) {
      const 語 = wordsOf(rows);
      const plurals = [...語].filter((word) => pluralStems(word).length > 0);
      調べた語 += plurals.length;
      for (const plural of plurals) {
        const 複数形 = reaching(rows, plural);
        /* 単数形も行に現れる語だけを照らす – 現れない語の当たり集合は空で、
         * 検査は何も言わない（其の語で全行を走らせる無駄も減らす）。 */
        for (const stem of pluralStems(plural).filter((stem) => 語.has(stem))) {
          for (const row of reaching(rows, stem)) {
            expect(
              複数形.has(row),
              `${label}で「${plural}」を打つと「${stem}」で当たる行が落ちている`,
            ).toBe(true);
          }
        }
        /* 畳み方が効いていること – 其の綴りで行に当たる行だけでは足りない
           （畳まなかった rows を数えて、寄せが実際に働いている語を確認する）。 */
        const 原綴り = writing(rows, plural);
        if (複数形.size > 原綴り.size) 救われた行 += 複数形.size - 原綴り.size;
      }
    }
    expect(調べた語, "複数形の語が集まっておらず空振り").toBeGreaterThan(50);
    expect(救われた行, "寄せが 1 行も救っておらず空振り").toBeGreaterThan(100);
  });

  it("寄せは単数形と原綴りの外には広がらない", () => {
    for (const { label, rows } of corpora()) {
      const plurals = [...wordsOf(rows)].filter((word) => pluralStems(word).length > 0);
      for (const plural of plurals) {
        const 許す = writing(rows, plural);
        pluralStems(plural).forEach((stem) => {
          reaching(rows, stem).forEach((row) => {
            許す.add(row);
          });
        });
        for (const row of reaching(rows, plural)) {
          expect(
            許す.has(row),
            `${label}で「${plural}」が単数形にも其の綴りにも出ない行を拾っている`,
          ).toBe(true);
        }
      }
    }
  });

  it("語尾が ss・us・is の語は単数形その物なので畳まない", () => {
    /* 畳んだ形（`busines` `campu` `analysi`）だけを行うに持つ行に当たってはならない。 */
    const 検査: [string, string][] = [
      ["business", "the busines model 2026"],
      ["campus", "campu 2026 kyoto"],
      ["status", "statu of the art 2026"],
      ["access", "acces control 2026"],
    ];
    検査.forEach(([query, text]) => {
      const match = Recommender.searchMatcher(query, AT);
      expect(match(text), `「${query}」が畳み過ぎた形（"${text}"）に当たっている`).toBe(false);
    });
    /* 同じ行で、複数形を打った人が単数形で当たる行に会えること（画面の照合式その物 –
       収録の語に依存しない検査なので、品書が入れ替わっても空振りしない）。 */
    const 単数 = Recommender.searchMatcher("abstract", AT);
    const 複数 = Recommender.searchMatcher("abstracts", AT);
    ["call for abstracts 2026", "abstract deadline 2026"].forEach((text) => {
      expect(単数(text), `「abstract」が "${text}" に当たらない`).toBe(true);
      expect(複数(text), `「abstracts」が "${text}" に当たらない`).toBe(true);
    });
    /* 語尾が `s` でない語は畳まない – `cryptography` を `cryptograph` に畳むと、
       `cryptographic` を書く行まで拾ってしまう（2026-09-25 実測 – 10 行 → 22 行に化けた）。 */
    const 語尾不一致 = Recommender.searchMatcher("cryptography", AT);
    expect(語尾不一致("ieee cryptographic theory 2026")).toBe(false);
  });
});
