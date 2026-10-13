import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 形の斷りが立つ打ち方（上の各家から拾つた見本）。 */
const 形の文々 = [
  "来週あたり",
  "再来週頃",
  "17時頃",
  "正午ごろ",
  "明日夕方",
  "来週月曜夜",
  "夕方",
  "深夜",
  "一時",
  "来週前半",
  "今週後半",
  "3月の初め",
  "来月頭",
  "12月最初",
  "来週終わり",
  "今週最初",
  "8月前半",
  "来月前半",
  "来週のやつ",
  "今週中のやつ",
  "今日までの締切だけ",
  "年内に間に合う",
  "昨日過ぎたやつ",
];

describe("形の斷りの読み上げ", () => {
  it("二十三種の打ち方すべて、読み上げに打ち直しが傳はる", () => {
    for (const 文 of 形の文々) {
      const 畫 = Recommender.uiWordNoteJa(文);
      const 讀 = Recommender.uiWordLiveNoteJa(文);
      expect(畫, `畫面の斷りが無い: ${文}`).not.toBe("");
      expect(讀, `讀み上げが缺いて居る: ${文}`).not.toBe("");
      expect(讀, `打った形を名指さん: ${文}`).toContain(`「${文}」`); // 第 388 回
      expect(讀, `打ち直しを置いて居らん: ${讀}`).toContain("で");
    }
  });

  it("読み上げは目の字より短く、一打鍵每に読める長さ（第 247 回の約束）", () => {
    for (const 文 of 形の文々) {
      const 畫 = Recommender.uiWordNoteJa(文);
      const 讀 = Recommender.uiWordLiveNoteJa(文);
      expect(
        讀.length,
        `讀み上げが目の字より長い: ${文}（${讀.length} / ${畫.length}）`,
      ).toBeLessThan(畫.length);
      expect(讀.length, `讀み上げが長い（${文} ${讀.length} 字）`).toBeLessThanOrEqual(60);
    }
  });

  it("目の字の文は一字も変はらん – 家をまとめた證（第 615 回の據へ替へ）", () => {
    /* 形ごとの斷りの核となる句を張る。之が崩れたら、家を移す時に文を書き換へた事になる
     * （斷りの文を張つている検査は他にもあるが、ここで一つの家であることを確かめる）。*/
    const 見本: Array<[string, string]> = [
      ["来週あたり", "幅の語だけで"],
      ["17時頃", "17時台"],
      ["明日夕方", "時間帯の名前"],
      ["夕方", "公用の決まり"],
      ["一時", "しばらく"],
      ["来週前半", "公用の決まり"],
      ["3月の初め", "上旬"],
      ["来週終わり", "其の週すべてで見る"],
      ["8月前半", "上旬"],
      ["来週のやつ", "「今週 締切」"],
      ["年内に間に合う", "「締切まで」"],
    ];
    for (const [文, 斷片] of 見本) {
      expect(Recommender.uiWordNoteJa(文), `${文} の斷りが變はつた: ${斷片}`).toContain(斷片);
    }
  });

  it("判斷の家は一つ – 形の検定は `uiWordShapeNoteJa` に集めてある（第 392 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const 始 = 源.indexOf("function uiWordShapeNoteJa");
    const 終 = 源.indexOf("\n  function ", 始 + 10);
    expect(始).toBeGreaterThan(0);
    const 家 = 源.slice(始, 終);
    for (const 形 of [
      "週の位のかたちJa",
      "時間帯の名前Ja",
      "幅の語の近似Ja",
      "月の頭尾のかたちJa",
      "週の頭尾のかたちJa",
      "月の前半のかたちJa",
      "指し名のかたちJa",
      "判定のかたちJa",
    ]) {
      /* 宣言が一度きりで、それがこの家にある事 – 二箇所に同じ检定を書くと片方だけ直る。*/
      expect(源.split(`const ${形} =`).length - 1, `${形} の宣言が二箇所ある`).toBe(1);
      expect(家, `${形} が此の家の中にある`).toContain(`const ${形} =`);
    }
    /* 呼び出しは二箇所（画面の導きと読み上げ）+ 定義 1 – 三家目に増えて居らん事。*/
    expect(源.split("uiWordShapeNoteJa(").length - 1).toBe(3);
  });

  it("他の家が喋る打ち方と、何も言はんで良い打ち方を奪はん", () => {
    /* 行が出る打ち方に読み上げは立てん（画面と同じ – 第 337 回）。*/
    for (const 文 of ["来週", "今週", "明日", "年内", "8月上旬"]) {
      expect(Recommender.uiWordLiveNoteJa(文), `行が出る語に喋つた: ${文}`).toBe("");
    }
    /* 語その物が収録に無い話は別の家が持つ（`猫` – 0 件の理由の読み上げは app 側で立つ）。*/
    expect(Recommender.uiWordLiveNoteJa("猫")).toBe("");
    /* 羣の語の読み上げはその侭（形の家の側へ落ちて居らん）。*/
    expect(Recommender.uiWordLiveNoteJa("リマインド")).not.toBe("");
    expect(Recommender.uiWordLiveNoteJa("リマインド")).toContain("リマインド");
  });
});
