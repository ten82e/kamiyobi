import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{
    hay: string;
  }>;
}

function 当たり列表(語: string): string[] {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 品書()
    .filter((行) => 当(String(行.hay)) === true)
    .map((行) => String(行.hay))
    .sort();
}

function 対称差(a: string[], b: string[]): number {
  const 左 = new Set(a);
  const 右 = new Set(b);
  return [...左].filter((行) => !右.has(行)).length + [...右].filter((行) => !左.has(行)).length;
}

function 全案内(語: string): string {
  const 入口 = [
    "columnQueryLiveNoteJa",
    "uiWordLiveNoteJa",
    "dayRangeLiveNoteJa",
    "wholeTableQueryNoteJa",
  ] as const;
  const 表 = Recommender as unknown as Record<
    (typeof 入口)[number],
    (q: string) => string | undefined
  >;
  return 入口.map((名) => String(表[名](語) || "")).join(" | ");
}

const 寄せた語: Array<[string, string]> = [
  ["ハイブリッド形式", "オンライン参加可"],
  ["再延長", "延長"],
  ["繰り下げ", "延長"],
  ["延長された", "延長"],
];
const 審査の期間 = [
  "査読期間",
  "査読の時期",
  "審査期間",
  "審査の時期",
  "レビュー期間",
  "リビュー期間",
  "査読中",
];
const 役 = [
  "筆頭著者",
  "第一著者",
  "共著者",
  "共著",
  "著者",
  "筆頭",
  "発表者",
  "登壇",
  "座長",
  "討論者",
  "パネリスト",
  "オーガナイザ",
  "司会",
];

describe("締切が延びたという言い方", () => {
  it("延びた印と参加形式の別の言い方も寄せ先の行を其侭通す", () => {
    for (const [語, 寄せ先] of 寄せた語) {
      const 正 = 当たり列表(寄せ先);
      expect(正.length, `品書に寄せ先の行が無い: ${寄せ先}`).toBeGreaterThan(0);
      expect(対称差(当たり列表(語), 正), `当たり列表が違う: ${語}`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join("・"), `寄せの案内が無い: ${語}`).toContain(
        寄せ先,
      );
    }
  });

  it("`変更` を『延長』に寄せない（早まった日まで延長で出す事になる）", () => {
    expect(当たり列表("変更"), "`変更` が当たる様になった").toEqual([]);
    expect(Recommender.querySynonymNotes("変更"), "`変更` を寄せた").toEqual([]);
    expect(当たり列表("延長").length, "『延長』の当たりが消えた").toBeGreaterThan(0);
  });
});

describe("審査の期間と著者の役", () => {
  it("審査の期間を訊かれても行を發明せず、締切の語へ導す", () => {
    for (const 語 of 審査の期間) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("審査の期間の欄はありません");
      /* 全く道が無いと言わない – 審査の段階の締切がある事を同じ案内に書く（実測 – 実ビルドで
       * 『査読』13 行・『反論期間開始』8 行・『採択通知』129 行）。 */
      expect(案内, `締切の語へ導さない: ${語}`).toContain("『査読』");
    }
  });

  it("発表者の役の群は、当たりのある催し物の名前を『収録にない』と言わない", () => {
    for (const 語 of 役) {
      expect(当たり列表(語), `当たりが出てしまった: ${語}`).toEqual([]);
      const 案内 = 全案内(語);
      expect(案内, `案内が出ない: ${語}`).toContain("役の欄はありません");
      expect(案内, `催し物の名前へ導さない: ${語}`).toContain("催し物の名前でなら当たります");
    }
    /* 名前は当たり得る（実測 – 実ビルド 126 行・ハーネスの品書 120 行）。 */
    expect(当たり列表("ワークショップ").length).toBeGreaterThan(0);
    for (const 語 of ["ワークショップ", "チュートリアル"]) {
      expect(全案内(語), `当たりが在る語に役の案内を被せた: ${語}`).not.toContain(
        "役の欄はありません",
      );
    }
  });

  it("群の案内が混じらない（審査の方式・講演の区分・審査の期間・役は別の話）", () => {
    for (const 語 of ["査読", "査読結果", "査読結果公開"]) {
      expect(全案内(語), `案内を被せた: ${語}`).not.toContain("審査の期間の欄はありません");
    }
    /* 審査の方式の群の語はその方の案内の侭（実測 – `ピアレビュー期間` は案内がでていた）。 */
    const 方式 = 全案内("ピアレビュー期間");
    expect(方式, "審査の方式の案内が消えた").toContain("審査の方式を書く欄");
    expect(方式, "審査の期間の案内に混じた").not.toContain("審査の期間の欄はありません");
    for (const 語 of 審査の期間) {
      expect(全案内(語), `審査の方式の案内に混じた: ${語}`).not.toContain("査読者数");
    }
    for (const 語 of 役) {
      expect(全案内(語), `講演の区分の案内に混じた: ${語}`).not.toContain("招待・一般");
    }
  });

  it("足した条目と案内が成果物に一度だけ入っている", () => {
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const 語 of [...寄せた語.map(([語]) => 語), ...審査の期間, ...役]) {
      expect(成果物.split(`"${語}"`).length - 1, `条目の数が違う: ${語}`).toBe(1);
    }
    /* 案内の文は note と live で書き方を変えてあるので、その方の文が一度ずつである事を張る
     * （二度書くと画面に同じ案内が並ぶ – 第 387 回）。 */
    expect(成果物.split("審査の期間の欄はありません").length - 1).toBe(1);
    expect(成果物.split("役の欄はありません").length - 1).toBe(1);
  });
});
