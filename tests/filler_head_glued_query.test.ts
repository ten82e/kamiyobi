/**
 * 搜が落とす語（單體 0 行の催し物の名）を頭に割る（第 667 回）。
 *
 * 第 528 回は「搜れん語を頭に载せても割れる先が無い」と讓がつたが、**搜は當たらん語を落とす**ので
 * 其の前提が當たらん語が在る（事實 – `会議` は單體 **0 行**なのに `会議 締切` は `締切` と同じ
 * **2,886 行**・`大会` も同じ – 一方 `セミナー 締切` は 0 行なので搜が落とさん語）。其の為、續いだ
 * 打ち手だけ 0 件で、面の三つ（搜・讓り・打ち替え）が皆默つて居た（第 665 回の洗ひで默り 20 本と數へた
 * 羣の內 7 本が此れ – 0 件の人が打ち替えの chip も見ん打ち方）。
 *
 * 直し – 頭に `会議` `大会` `国際会議` を载せ、語尾に `結果` `通知` を增した（第 666 回の家と同じ流儀）。
 * 效き – 續ぎ方 2,547 本で增 58 本・**減 0 本** ✓（面の遷移は 默 → 搜 7 本・换 → 搜 49 本・讓 → 搜 1 本）。
 *
 * 载せん語（搜が落とさん語 – 割ると 0 件の侬になる – 實測で確かめて彈いた）– `セミナー` `ソナー`
 * `トラック` `集会` `フォーラム`。語尾に立てん語 – `発表`（`ポスター発表` 4 行 ⇔ `ポスター 発表` **0 行**）、
 * `参加`（`参加登録` 66 行 ⇔ `参加 登録` 0 行）、`期限`（`登録期限` 22 行 ⇔ `登録 期限` 0 行）、`応募`
 * `募集` `論文`（第 666 回）– **續いだ形の方が多く當たる語は割ると減る**ので、その儘置く。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

function 当たり列表(訪ね: string): string[] {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄()
    .filter((行) => 目(String(行.hay)) === true)
    .map((行) => String(行.hay));
}
const 当たり = (訪ね: string): number => 当たり列表(訪ね).length;

/** 源から二つの表を読む（第 666 回と同じ流儀 – 载せ直しても檢査が後を追ふ）。*/
function 二つの表(): { 頭: string[]; 語尾: string[] } {
  const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
  const i = 源.indexOf("function 締切の語尾に割るJa");
  expect(i).toBeGreaterThan(0);
  const 域 = 源.slice(i, 源.indexOf("\n  }", i));
  const 語尾 = /const 語尾一覧 = "([^"]+)"/.exec(域)?.[1];
  const 頭 = /const 頭一覧 = new Set\(\s*\[([\s\S]*?)\]/.exec(域)?.[1];
  expect(語尾, "語尾一覧の文字列が讀められん").toBeTruthy();
  expect(頭, "頭一覧が讀められん").toBeTruthy();
  return {
    頭: [...String(頭).matchAll(/"([^"\n]+)"/g)].map((m) => m[1]),
    語尾: String(語尾).split("|"),
  };
}

describe("搜が落とす語を頭に割る", () => {
  it("單體 0 行の催し物の名を頭に繋いでも語尾單體と同じ行に屆く", () => {
    const 载せる與: Array<[string, string]> = [
      ["会議締切", "締切"],
      ["会議〆切", "締切"],
      ["会議結果", "結果"],
      ["会議通知", "通知"],
      ["大会締切", "締切"],
      ["大会日程", "日程"],
      ["大会通知", "通知"],
    ];
    for (const [續ぎ, 語尾] of 载せる與) {
      expect(当たり(續ぎ), `繋げた ${續ぎ} が 0 行の侬`).toBeGreaterThan(0);
      expect(
        [...当たり列表(續ぎ)].sort().join("\n"),
        `${續ぎ} が ${語尾} だけと違う行に當たつた`,
      ).toBe([...当たり列表(語尾)].sort().join("\n"));
    }
    /* 單體で行を持つ頭（`国際会議` 1,668 行）は絞つた形で屆く – 空格の人と同じ。*/
    expect(当たり("国際会議")).toBe(1668);
    expect(当たり("国際会議締切"), "事實 1,520 行").toBe(1520);
    expect(当たり("国際会議 締切")).toBe(1520);
    expect(当たり("会議結果"), "搜が落とす語の形は語尾と同じ 32 行").toBe(32);
  });

  it("續いだ方が多く當たる語は割らん（割ると減る – 事實で彈いた）", () => {
    for (const [續ぎ, 當, 空格] of [
      ["ポスター発表", 4, 0] /* `発表` を語尾に立てば 4 行 → 0 行に落ちる*/,
      ["参加登録", 66, 0] /* `参加` を頭に立てば同じ壁*/,
      ["登録期限", 22, 0] /* `期限` は品書に行の無い語尾（第 517 回）*/,
      ["採択通知", 240, 240] /* こつちは同じなので割つても害なし*/,
      ["査読結果", 32, 32],
    ] as Array<[string, number, number]>) {
      expect(当たり(續ぎ), `續いだ形の行が減つた: ${續ぎ}`).toBe(當);
      if (空格 === 0)
        expect(
          当たり(續ぎ.replace(/(発表|登録|期限)$/, " $1")),
          `空格側が 0 行でない: ${續ぎ}`,
        ).toBe(0);
    }
    const { 語尾 } = 二つの表();
    for (const 語 of ["発表", "参加", "期限", "応募", "募集", "論文", "camera ready"])
      expect(語尾, `割ると減る語を語尾に立てた: ${語}`).not.toContain(語);
  });

  it("搜が落とす語と落とさん語の境を事實で張る（载せる頭の條件）", () => {
    /* 搜が落とす語 – 單體 0 行なのに、語尾と同じ數になる。此れが载せる條件（第 667 回）。*/
    for (const 語 of ["会議", "大会"]) {
      expect(当たり(語), `${語} が單體で行を持つやうになつた（載せ直す要なし）`).toBe(0);
      expect(当たり(`${語} 締切`), `${語} を落としても締切と同じにならん`).toBe(当たり("締切"));
    }
    /* 搜が落とさん語 – 空格でも 0 行。载せても 0 件の侬なので彈く（第 528 回が生きる側）。*/
    for (const 語 of ["セミナー", "ソナー", "トラック", "集会", "フォーラム"]) {
      expect(当たり(`${語} 締切`), `搜が落とすやうになつた: ${語}（載せ直す價值がある）`).toBe(0);
      const { 頭 } = 二つの表();
      expect(頭, `搜が落とさん語を頭に载せた: ${語}`).not.toContain(語);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
  });

  it("增へた語尾 `結果` `通知` が他の案内と喧嘩せんの張る", () => {
    const { 語尾, 頭 } = 二つの表();
    for (const 語 of ["結果", "通知"]) expect(語尾, `語尾から落ちた: ${語}`).toContain(語);
    for (const 語 of ["会議", "大会", "国際会議"]) expect(頭, `頭から落ちた: ${語}`).toContain(語);
    /* 增へた語尾は欄の名前では無い（事實 – `結果` `通知` は欄名の案内が出ん）ので、欄側の家
     * （第 508 回）に乘つ取らん。欄の名前の案内は其の儘立つ。*/
    const 値が當たるか = (語: string): boolean => 当たり(語) > 0;
    for (const 訪ね of ["結果", "通知"])
      expect(
        Recommender.columnQueryNoteJa(訪ね, 値が當たるか),
        `欄名でない語に欄名の案内が出た: ${訪ね}`,
      ).toBe("");
    for (const 訪ね of ["分野", "種別"])
      expect(
        Recommender.columnQueryNoteJa(訪ね, 値が當たるか),
        `欄の名前の案内が消えた: ${訪ね}`,
      ).not.toBe("");
    /* 搜れん語の續ぎ手は仍 0 行 – 讓りの家が導く（第 665 回）。此處では嘘を張らん。*/
    for (const 訪ね of ["セミナー締切", "ソナー論文", "トラック締切"])
      expect(当たり(訪ね), `行き着かん筈の續ぎ手が當たつた: ${訪ね}`).toBe(0);
  });
});
