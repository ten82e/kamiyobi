import { queryReferenceSnapshotPath } from "./query_reference.ts";
/**
 * 「どこから持来たの？」「第二次締切は？」を別の語で打つ人（第 645 回）。
 * 實測（品書 3,250 行・固定時刻 2026-08-09T00:00:00Z – 2026-08-09 生成）で、
 * `出典` `データ源` `収録範囲` `更新` は通るのに、同じ話の別の言い方 –
 * `情報源` `ソース` `提供元` `出所` `出自` `一次資料`（出典の羣）、
 * `カバレッジ` `カバー範囲` `網羅` `収録内容` `対象分野`（収録範囲の羣）、
 * `最終締切` `二次締切` `第二次締切` `追加締切`（締切の回数の羣）、
 * `連名`（著者の羣）、`締切変更` `日程変更`（延伸の羣） – は 0 件で完全に無言だった。
 * 語の形變えだけで默る家なので、同じ答えを據へる。寄せ（行を出す物）は置いていない –
 * 收錄にその値が無く、出せば噓の門になる（第 337 回）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((row) => match(String(row.hay)) === true).length;
}

function 案内(語: string): string {
  return [
    Recommender.uiWordNoteJa(語, false),
    Recommender.wholeTableQueryNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ")
    .trim();
}

/** 打ち手 → 受け取る斷りに在る筈の語（歸屬先が變はつたら落ちる）。 */
const 斷り: Array<[string, string]> = [
  ["情報源", "データ源"],
  ["ソース", "データ源"],
  ["提供元", "データ源"],
  ["出所", "データ源"],
  ["出自", "データ源"],
  ["一次資料", "データ源"],
  ["カバレッジ", "見方のてびき"],
  ["カバー範囲", "見方のてびき"],
  ["網羅", "見方のてびき"],
  ["収録内容", "件数欄"],
  ["対象分野", "件数欄"],
  ["最終締切", "種別"],
  ["二次締切", "種別"],
  ["第二次締切", "種別"],
  ["追加締切", "種別"],
  ["連名", "著者"],
  ["締切変更", "締切延長"],
  ["日程変更", "締切延長"],
];

describe("出所・收錄の幅・締切の回数を別の語で打つ人（第 645 回）", () => {
  it("十八の打ち手が默らず、歸屬先の斷りを受け取る", () => {
    for (const [語, 筋] of 斷り) {
      const 案 = 案内(語);
      expect(案, `"${語}" が無言に逆戻りした`).not.toBe("");
      expect(案, `"${語}" が歸屬先の話（${筋}）をして居ん`).toContain(筋);
    }
  });

  it("一句の中に埋まつても受ける（`データの出所` `このデータの出自`）", () => {
    for (const 文 of ["データの出所", "このデータの出自", "どこから取った情報？の出自"]) {
      expect(案内(文), `"${文}" が默つた（語が割れて落ちる）`).toContain("データ源");
    }
    /* `どこから` `何が含まれる` のやうに動詞に落ちる形は此の回も讓す – 搜しの側の檢討
     * （第 585 回に記錄）。`いつのデータ` は行が出るので案内を據へん（16 行 – 實測）。*/
    expect(当たり(收錄(), "いつのデータ"), "`いつのデータ` の行數が變はつた").toBe(16);
  });

  it("噓の門を開けん – 十八語は 0 件の侬（收錄にその値は無い）", () => {
    const rows = 收錄();
    for (const [語] of 斷り) {
      expect(当たり(rows, 語), `"${語}" に行が届いた（斷りが噓になつた）`).toBe(0);
    }
  });

  it("收錄の締切の種別は回數を持たん – 斷りの理由が實物と合う", () => {
    const データ = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8"));
    const 型 = new Set<string>();
    const walk = (o: unknown) => {
      if (Array.isArray(o)) {
        for (const x of o) walk(x);
      } else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          /* 收錄の締切每件の種別は `kind` の鍵に在る（`type` ではない – 實測）。 */
          if (k === "kind" && typeof v === "string") 型.add(v);
          walk(v);
        }
      }
    };
    walk(データ);
    const 在る = [...型].filter((t) =>
      ["paper", "abstract", "notification", "camera_ready"].includes(t),
    );
    expect(在る.sort(), "收錄の種別が減つた（斷りに並べる語を見直す）").toEqual([
      "abstract",
      "camera_ready",
      "notification",
      "paper",
    ]);
    const 回数 = [...型].filter((t) => /final|second|round|late|extended/i.test(t));
    expect(回数, `締切の回數の種別が出てきた（${回数.join()}）– 寄せに直して良くて居る`).toEqual(
      [],
    );
  });

  it("磁石は狹まつて居らん – 通つて居る打ち手の行數は舊來の侬", () => {
    const rows = 收錄();
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
    ] as Array<[string, number]>) {
      expect(当たり(rows, 語), `"${語}" の行數が減つた`).toBe(見當);
    }
  });

  it("同じ語を二處に載めん（第 511 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    for (const [語] of 斷り) {
      expect(源.split(`"${語}"`).length - 1, `"${語}" が源に二度並んで居る`).toBe(1);
    }
  });
});
