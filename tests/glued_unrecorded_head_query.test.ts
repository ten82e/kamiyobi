import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

const 頭 = [
  "講演",
  "報告",
  "記録",
  "短文",
  "レター",
  "パネル",
  "トラック",
  "研究発表会",
  "特別講演",
  "一般討論",
];

const 尾 = [
  "募集",
  "提出",
  "投稿",
  "締切",
  "締切り",
  "デッドライン",
  "期限",
  "登録",
  "案内",
  "応募",
];

function 收錄(): { rows: Row[]; hays: string[] } {
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
  return { rows, hays: [...new Set(rows.map((row) => String(row.hay)))] };
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((row) => match(String(row.hay)) === true).length;
}

function 打ち替え(hays: string[], 文: string): number {
  return (Recommender.shorterHitWordsJa(文, hays, AT) || []).length;
}

function 斷り(文: string): string {
  return String(Recommender.uiWordNoteJa(文, false) || "").trim();
}

/* 長い文は例を插むので「離す」と「離して」で割れる – 両方に共通する尾で家を見る（短い声は同じ文で終る）。*/
const この家の印 = "と同じ意味で広く当たります";

describe("語を繋げて打ち、その上に行にない名前を打つ人（第 647 回）", () => {
  it("百通りが二つの家の何れかで受かる", () => {
    const { rows, hays } = 收錄();
    const 默: string[] = [];
    let 數 = 0;
    for (const a of 頭) {
      for (const b of 尾) {
        const 文 = `${a}${b}`;
        數 += 1;
        if (当たり(rows, 文) !== 0) continue; /* 行が出る打ち手は案内を立てん（画面の門）。*/
        if (斷り(文) === "" && 打ち替え(hays, 文) === 0) 默.push(文);
      }
    }
    expect(數).toBe(頭.length * 尾.length);
    expect(默.slice(0, 10), `${默.length} 通りが無言に逆戻りした`).toEqual([]);
  });

  it("斷りのデータ関聯 – 「その名前は行に書かれていない」が実物と合う（噓の門 – 第 337 回）", () => {
    const { rows } = 收錄();

    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const 源の頭 = (源.match(/const 行に書かれん催し物の頭Ja =\s*\n\s*\/\^\(([^)]*)\)\//) || [
      "",
      "",
    ])[1]
      .split("|")
      .map((x) => x.trim())
      .filter((x) => x);
    expect(源の頭.length, "源の頭が読めなかった（目の書き方が変はつた）").toBeGreaterThanOrEqual(8);
    for (const a of 源の頭) {
      expect(当たり(rows, a), `源の頭の語「${a}」が行を出すやうになつた（斷りが噓になつた）`).toBe(
        0,
      );
    }
    for (const a of 頭) {
      expect(当たり(rows, a), `頭の語「${a}」が行を出すやうになつた（斷りが噓になつた）`).toBe(0);
    }
    /* `パネル` は運營の羣の語 – 繋げた形でもその羣が先に答へる（家は順番で決まる – 第 511 回）。*/
    expect(斷り("パネル募集")).toContain("欄");
    expect(斷り("パネル募集")).not.toContain(この家の印);
  });

  it("打ち直しの勸めが狹まつた advice にならん – 語を離した方が広い（全通り）", () => {
    const { rows } = 收錄();
    for (const a of 頭) {
      for (const b of 尾) {
        const 繋いだ = 当たり(rows, a + b);
        const 離した = 当たり(rows, `${a} ${b}`);
        expect(離した, `「${a} ${b}」が「${a + b}」より狹かつて居る`).toBeGreaterThanOrEqual(
          繋いだ,
        );
      }
    }
  });

  it("讓す決まり – 頭が行に出る語はこの家が乘取らん（打ち替えの家が数える）", () => {
    const { rows, hays } = 收錄();
    for (const 文 of ["抄録提出", "セッション登録", "論文投稿", "ポスター募集"]) {
      if (当たり(rows, 文) !== 0) continue; /* 行が出る物は打ち直しを勸めん – その侬で当たる。*/
      expect(斷り(文), `「${文}」を此の家が乘取つた`).not.toContain(この家の印);
      expect(打ち替え(hays, 文), `「${文}」がどの家でも打ち直されん`).toBeGreaterThan(0);
    }
    /* 繋いだ形で行が出る人は打ち直しその物が要らん（`特集号締切り` 17 行 – 実測）。*/
    expect(当たり(rows, "特集号締切り")).toBeGreaterThan(0);
    expect(斷り("特集号締切り")).not.toContain(この家の印);
  });

  it("磁石は狹まつて居らん – 通つている打ち手の行数は旧來の侬", () => {
    const { rows } = 收錄();
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

  it("読み上げも同じ判斷を出す（六十字に納まる – 第 392 回）", () => {
    /* `トラック` `パネル` は運營の羣の語 – その方の繋がれた形も羣が先に答へる（家は順番で
     * 決まる – 第 511 回）ので、この家の例には羣に当たらん語を当てる。*/
    const 文 = "講演締切";
    expect(斷り(文)).toContain(この家の印);
    expect(斷り("トラック投稿")).not.toContain(この家の印);
    const 聲 = String(Recommender.uiWordLiveNoteJa(文, false) || "").trim();
    expect(聲, "読み上げが黙つた").not.toBe("");
    expect(聲.length, `讀み上げが長すぎる（${聲.length} 字）`).toBeLessThanOrEqual(60);
  });

  it("この家の文は一處だけ（羣に寫すと読み上げとズレる – 第 392 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    expect(源.split("行に書かれん催し物の頭Ja =").length - 1, "頭の目が二處出來た").toBe(1);
    expect(源.split("繋がれた尾Ja =").length - 1, "尾の目が二處出來た").toBe(1);
    expect(
      源.split("その繋ぎ方で行の原文に書かれている物だけになります").length - 1,
      "斷りが二處書かれた",
    ).toBe(1);
  });
});
