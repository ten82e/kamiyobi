/**
 * 英語の正式名称（長い分野名）で打った人の検査（SPEC §4・§7・第 316 回）。
 * 検索語は語に割って AND を取るため、分野の正式名称をそのまま打つと其の語の並びを行うに
 * しか当たらなかった（2026-09-25 実測・2026-08-09 生成の実ビルドの品書 872 行 –
 * `情報セキュリティ` 152 行 / "information security" 13 行、`人工知能` 314 / "artificial
 * intelligence" 61、`データベース` 118 / "database systems" 2、`音声認識` 3 /
 * "speech recognition" 0）。検査は品書（ビルド成果の catalog.json）と収録
 * （`data/snapshot.json`）の両方に行う – 品書は収録の一部で、無い語の方が普通なので
 * 片側だけだと空振りする（第 306 回以降と同じ工夫）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

/* 正本の `collapseFieldPhraseEnglish` と同じ表（実装を呼べない検査側なのでここに書く –
 * 表その物は下の検査で正本から壊れる）。 */
const ALIASES: Array<[string[], string]> = [
  [["information", "security"], "情報セキュリティ"],
  [["cyber", "security"], "情報セキュリティ"],
  [["network", "security"], "情報セキュリティ"],
  [["computer", "networks"], "ネットワーク"],
  [["computer", "networking"], "ネットワーク"],
  [["computer", "graphics"], "グラフィックス"],
  [["high", "performance", "computing"], "高性能計算"],
  [["human", "computer", "interaction"], "人間情報処理"],
  [["theoretical", "computer", "science"], "計算理論"],
  [["artificial", "intelligence"], "人工知能"],
  [["database", "systems"], "データベース"],
  [["operating", "systems"], "システム"],
  [["speech", "recognition"], "音声認識"],
];

/** 正本が語の組に載せる綴りの形（スペース・ハイフン・無し + 末尾の語の単数形）。 */
function formsOf(words: string[]): string[] {
  const last = words[words.length - 1];
  const stem =
    last.length >= 4 && last.endsWith("s") && !/(ss|us|is)$/.test(last) ? last.slice(0, -1) : last;
  const out: string[] = [];
  [words, [...words.slice(0, -1), stem]].forEach((ws) => {
    [ws.join(" "), ws.join("-")].forEach((form) => {
      if (out.indexOf(form) < 0) out.push(form);
    });
    if (ws.length > 1 && out.indexOf(ws.join("")) < 0) out.push(ws.join(""));
  });
  return out;
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

/** 綴りが「語として」書かれている行（語頭で探す – 文中の一部分では寄せない）。 */
function writingAny(row: Row, forms: string[]): boolean {
  const folded = String(row.hay);
  return forms.some((form) => {
    let at = folded.indexOf(form);
    while (at >= 0) {
      const before = at === 0 ? "" : folded[at - 1];
      if (!/[a-z0-9]/.test(before)) return true;
      at = folded.indexOf(form, at + 1);
    }
    return false;
  });
}

describe("英語の正式名称で打った人", () => {
  it("和名で打った人が会う行に、そのまま会える", () => {
    let 調べた熟語 = 0;
    let 当たった行数 = 0;
    corpora().forEach(({ label, rows }) => {
      ALIASES.forEach(([words, ja]) => {
        const phrase = words.join(" ");
        const 和名 = reaching(rows, ja);
        const 英語 = reaching(rows, phrase);
        調べた熟語 += 1;
        当たった行数 += 英語.size;
        和名.forEach((row) => {
          expect(英語.has(row), `${label}: "${phrase}" が「${ja}」の行を落としている`).toBe(true);
        });
        /* 増えて当たる分は、其の綴りを行うに持つ行だけ（別語の寄せ込みを許さない）。 */
        const forms = formsOf(words);
        英語.forEach((row) => {
          if (和名.has(row)) return;
          expect(
            writingAny(row, forms),
            `${label}: "${phrase}" が綴りを行に持たない行を拾った: ${String(row.hay).slice(0, 56)}`,
          ).toBe(true);
        });
      });
    });
    expect(調べた熟語).toBeGreaterThan(10);
    expect(当たった行数).toBeGreaterThan(200);
  });

  it("其の綴りを行うに持つ行を、打ち直し前より落とさない", () => {
    let 調べた行数 = 0;
    corpora().forEach(({ label, rows }) => {
      ALIASES.forEach(([words]) => {
        const phrase = words.join(" ");
        const forms = formsOf(words);
        const 綴りを持つ行 = rows.filter((row) => writingAny(row, forms));
        const 当たる = reaching(rows, phrase);
        綴りを持つ行.forEach((row) => {
          expect(
            当たる.has(row),
            `${label}: "${phrase}" を打つ人が綴りを行うに持つ行に会えない: ${String(row.hay).slice(0, 56)}`,
          ).toBe(true);
        });
        調べた行数 += 綴りを持つ行.length;
      });
    });
    /* 品書に綴りが無ければ空振りになるので、調べた行数を Lower bound で見る。 */
    expect(調べた行数).toBeGreaterThan(20);
  });

  it("形が違う打ち方（ハイフン・詰め・単数）は同じ組に載る", () => {
    corpora().forEach(({ label, rows }) => {
      [
        ["high performance computing", "high-performance computing", "highperformancecomputing"],
        ["cyber security", "cyber-security", "cybersecurity"],
        ["information security", "information-security"],
      ].forEach(([base, ...variants]) => {
        const 基準 = reaching(rows, base);
        variants.forEach((variant) => {
          const 別 = reaching(rows, variant);
          expect(別.size, `${label}: "${variant}" と "${base}" で件数が違う`).toBe(基準.size);
          別.forEach((row) => {
            expect(基準.has(row), `${label}: "${variant}" で "${base}" の行が落ちた`).toBe(true);
          });
        });
      });
      /* 単数で書かれた正式名称も、複数の形と同じ組に載る（NOSSDAV は単数で書く – 実測）。 */
      const 複数 = reaching(rows, "operating systems");
      reaching(rows, "operating system").forEach((row) => {
        expect(複数.has(row), `${label}: 単数で打つ人が "operating systems" の行に会えない`).toBe(
          true,
        );
      });
    });
  });

  it("表に無い語は今までどおり語を割った当たり（寄せを一般化しない）", () => {
    corpora().forEach(({ label, rows }) => {
      ["quantum computing", "machine learning", "network monitoring"].forEach((phrase) => {
        const 熟的 = reaching(rows, phrase);
        /* 照合関数は語ごとに一度だけ作る（行の数だけ作り直さない – 同じ結果で速い）。 */
        const 語の照合 = (Recommender.queryTokens(phrase) as string[]).map((word) =>
          Recommender.searchMatcher(word, AT),
        );
        const 語を割 = new Set(
          rows.filter((row) => 語の照合.every((matches) => matches(row.hay) === true)),
        );
        expect(熟的.size, `${label}: "${phrase}" が寄せられている`).toBe(語を割.size);
        熟的.forEach((row) => {
          expect(語を割.has(row), `${label}: "${phrase}" の寄せ込み`).toBe(true);
        });
      });
    });
  });

  it("英文字が接着した語は寄せない", () => {
    const 述語 = Recommender.searchMatcher("information security", AT);
    const 分野を書く行 = "人工知能 セキュリティ 2026年9月8日";
    expect(述語(分野を書く行), "寄せが効いていない").toBe(true);
    ["preinformation security", "postinformation-security", "informationsecurity2026"].forEach(
      (query) => {
        expect(
          Recommender.searchMatcher(query, AT)(分野を書く行),
          `"${query}" が寄せられている（別語の一部）`,
        ).toBe(false);
      },
    );
  });
});
