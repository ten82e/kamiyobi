/**
 * ハイフン打ち（`paper-submission`）をした人の検査（SPEC §4・§7・第 317 回）。
 * CFP を写す語と URL のスラッグは語をハイフンで繋ぐので、其の形で打つ人は其の並びを行うに
 * 書く行にしか当たらなかった（2026-09-25 実測 – 品書に頻出の 171 並びのうち 166 並びで件数が
 * 違い、減った行の延べ 5,007 行 – `paper-submission` 0 行 / `paper submission` 245 行、
 * `international-conference` 3 行 / 341 行、`CCF-B` 0 行 / `ccf b` と隣り合わせに書く 159 行）。
 * 検査は品書（ビルド成果の catalog.json）と収録（`data/snapshot.json`）の両方に行う –
 * ビルドに使う品書は収録の一部で、片側だけだと並びが集まらず空振りする。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

/** 行の検索用文字列は既に畳まれているが、検査側も念のため同じ形に寄せる。 */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function corpora(): { label: string; rows: Row[] }[] {
  const built = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"));
  return [
    { label: "品書", rows: Recommender.candidateRows(built) as Row[] },
    { label: "収録", rows: Recommender.candidateRows(snapshot) as Row[] },
  ];
}

function reaching(rows: Row[], query: string): Set<Row> {
  const match = Recommender.searchMatcher(query, AT);
  return new Set(rows.filter((row) => match(row.hay) === true));
}

/** 語の境界に立つ並びとして書かれているか（左側が英文字・数字の並びは別語の一部）。
 * 寄せた形も照合の語の境界規則を守る – 行に `aidcworkshop github` のように語が接着して
 * 書かれている 1 行は救われない（2026-09-25 実測 – 品書の該当 25 行のうち 24 行が救われた）。 */
function writing(row: Row, phrase: string): boolean {
  const text = fold(String(row.hay));
  let at = text.indexOf(phrase);
  while (at >= 0) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true;
    at = text.indexOf(phrase, at + 1);
  }
  return false;
}

/** 行の文字列に隣り合って並ぶ英字語の並び（出現回数つき・多い順）。 */
function adjacentPairs(rows: Row[], 最低回数: number, 上限: number): string[] {
  const freq = new Map<string, number>();
  rows.forEach((row) => {
    /* 2 文字以下の語は両側の境界を要求する規則（第 252 回）があるので、並びの抽出は
     * 3 文字以上で行う（`17th international` の `th` のような語頭は、規則どおり寄せても
     * 境界が通らない – 其れは欠陥ではない）。 */
    for (const hit of fold(String(row.hay)).matchAll(/([a-z]{3,}) ([a-z]{3,})/g)) {
      const pair = `${hit[1]} ${hit[2]}`;
      freq.set(pair, (freq.get(pair) || 0) + 1);
    }
  });
  return [...freq.entries()]
    .filter(([, n]) => n >= 最低回数)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 上限)
    .map(([pair]) => pair);
}

describe("ハイフンで繋いで打った人", () => {
  it("スペースで繋いだ形で行に書かれている行に、会える", () => {
    let 調べた並び = 0;
    let 救われた行 = 0;
    corpora().forEach(({ label, rows }) => {
      adjacentPairs(rows, 8, 200).forEach((spaced) => {
        const hyphen = spaced.replace(" ", "-");
        const 当たる = reaching(rows, hyphen);
        調べた並び += 1;
        rows.forEach((row) => {
          if (!writing(row, spaced)) return;
          救われた行 += 1;
          expect(
            当たる.has(row),
            `${label}: "${hyphen}" を打つ人が "${spaced}" と書く行に会えない`,
          ).toBe(true);
        });
      });
    });
    expect(調べた並び, "並びが集まらず空振り").toBeGreaterThan(50);
    expect(救われた行, "救う行が無く空振り").toBeGreaterThan(500);
  });

  it("ハイフンの並びを行うに持つ行を、今まで通り残す", () => {
    corpora().forEach(({ label, rows }) => {
      adjacentPairs(rows, 2, 120).forEach((spaced) => {
        const hyphen = spaced.replace(" ", "-");
        const 当たる = reaching(rows, hyphen);
        rows.forEach((row) => {
          if (!writing(row, hyphen)) return;
          expect(当たる.has(row), `${label}: "${hyphen}" の元の当たりが落ちた`).toBe(true);
        });
      });
    });
  });

  it("語に割って AND を取った当たりより広くならない", () => {
    /* 語をばらして OR にすると `ccf-b` が `b` だけの行を拾う – 寄せは 1 語の組に
     * スペースの形を足すだけ、という契約をここに置く。 */
    corpora().forEach(({ label, rows }) => {
      adjacentPairs(rows, 4, 80).forEach((spaced) => {
        const hyphen = spaced.replace(" ", "-");
        const 語を割 = reaching(rows, spaced);
        reaching(rows, hyphen).forEach((row) => {
          expect(語を割.has(row), `${label}: "${hyphen}" が語を割った当たりより広い`).toBe(true);
        });
      });
    });
  });

  it("数字だけの語（日付・暦月）は寄せない", () => {
    const 述語 = (query: string) => Recommender.searchMatcher(query, AT);
    /* `2026 13` と書く行を、ありえない日付の打ち方で拾わないこと。 */
    const 数字を書く行 = "会議 2026 13 章 2026年13章";
    expect(述語("2026-13")(数字を書く行), "数字の語にスペース形が載っている").toBe(false);
    expect(述語("2026-13-45")(数字を書く行), "数字の語にスペース形が載っている").toBe(false);
    /* 英文字を含む語は寄せる（寄せが効いていることの対照）。 */
    expect(述語("ai4s-2026")("ai4s 2026 workshop")).toBe(true);
  });

  it("短い語の境界規則を壊さない", () => {
    /* 1 文字の語は両側の境界を要求する規則（第 252 回）が、寄せた形にもそのまま効くこと。 */
    expect(Recommender.searchMatcher("a-b", AT)("ab cd")).toBe(false);
    expect(Recommender.searchMatcher("a-b", AT)("a b c")).toBe(true);
  });
});
