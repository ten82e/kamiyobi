import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): string[] {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((row) => match(String(row.hay)) === true).map((row) => String(row.hay));
}

function 案内(語: string): string {
  return [
    Recommender.uiWordNoteJa(語, false),
    Recommender.wholeTableQueryNoteJa(語),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ")
    .trim();
}

/** 採否通知に寄せる語（行が出る – 内訳は件数欄に出る）。 */
const 寄せ = ["受理", "通知結果"];
/** 収録に無い物だと告げる羣に載せた語（0 件の侬 – 打ち直しを敎える）。 */
const 斷り: Array<[string, string]> = [
  ["投稿料", "費用"],
  ["審査料", "費用"],
  ["配信", "欄"],
  ["ライブ配信", "欄"],
  ["差し替え", "欄"],
  ["再提出", "欄"],
  ["発表形態", "区別"],
  ["特別発表", "区別"],
  ["学生論文", "区別"],
];

describe("費用・配信・發表の形・受理を短く打つ人（第 644 回）", () => {
  it("寄せた語が同じ行集合を出す – 件数欄が寄せ先を名乘る", () => {
    const rows = 收錄();
    const 本家 = 当たり(rows, "合否");
    expect(本家.length, "前提 – 種別『採否通知』の行が減つた").toBe(240);
    for (const 語 of 寄せ) {
      const 件 = 当たり(rows, 語);
      expect([...件].sort(), `"${語}" が本家と同じ行を出さん`).toEqual([...本家].sort());
      expect(案内(語), `"${語}" の件數欄が寄せ先を隱した`).toContain("採否通知");
    }
  });

  it("九語が黙らず、帰屬先の families の斷りを受け取る", () => {
    for (const [語, 筋] of 斷り) {
      const 案 = 案内(語);
      expect(案, `"${語}" が無言に逆戻りした`).not.toBe("");
      if (筋 === "費用") {
        expect(案, `"${語}" が費用の欄の無い事を言つて居ん`).toContain("費用");
        expect(案, `"${語}" が公式ページへ導さん`).toContain("公式ページ");
      } else if (筋 === "欄") {
        expect(案, `"${語}" が欄の名前では無い事を言つて居ん`).toContain("欄");
        expect(案, `"${語}" が公式ページへ導さん`).toContain("公式ページ");
      } else {
        expect(案, `"${語}" が區別の話をして居ん`).toContain("区別");
      }
    }
  });

  it("噓の門を開けん – 斷りの九語は 0 件の侬（寄せにして居らん）", () => {
    const rows = 收錄();
    for (const [語] of 斷り) {
      expect(当たり(rows, 語).length, `"${語}" に行が届いた（羣の斷りが噓になつた）`).toBe(0);
    }

    expect(当たり(rows, "student").length, "student の行数が変はつたら寄せ直す価値を測り直す").toBe(
      4,
    );
  });

  it("磁石は狹まつて居らん – 通つている打ち手の行数は旧來の侬", () => {
    const rows = 收錄();
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
    ] as Array<[string, number]>) {
      expect(当たり(rows, 語).length, `"${語}" の行數が減つた（羣の增設が搜しを狹めた）`).toBe(
        見當,
      );
    }
  });

  it("同じ語を二處に載めん（第 511 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    for (const 語 of [...寄せ, ...斷り.map(([語]) => 語)]) {
      expect(源.split(`"${語}"`).length - 1, `"${語}" が源に二度並んで居る`).toBe(1);
    }
  });
});
