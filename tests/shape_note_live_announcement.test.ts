/**
 * 形の斷りの讀み上げ（aria-live）– 目の字と話し言葉を一つの家にする（SPEC §7・第 615 回）。
 * 羣の語には `note:` と `live:` の二つが有るが、打ち方の**形**で斷る家（週の位・時間帯の名前・
 * 近似の語・月の頭・週の頭尾・月の前半・幅の語の指し名と判定 – 第 416 回・第 418 回・第 431 回・
 * 第 440 回・第 483 回・第 614 回）は、讀み上げ側が空でした（實測 2026-08-09 生成の実ビルド –
 * `来週あたり` `17時頃` `明日夕方` `夕方` `一時` `来週前半` `3月の初め` `来週終わり` `8月前半`
 * `来週のやつ` `今日までの締切だけ` `年内に間に合う` `昨日過ぎたやつ` の読み上げが**すべて無**。
 * 讀み上げを使う人には「0 件」だけが傳はり、打ち直しが傳はらん（目の字には有る）。
 * 判斷の家を二つに割らず、`uiWordShapeNoteJa` 一の家に長い文と短い文を並べた（第 392 回）。
 */
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

describe("形の斷りの讀み上げ", () => {
  it("二十三種の打ち方すべて、讀み上げに打ち直しが傳はる", () => {
    for (const 文 of 形の文々) {
      const 畫 = Recommender.uiWordNoteJa(文);
      const 讀 = Recommender.uiWordLiveNoteJa(文);
      expect(畫, `畫面の斷りが無い: ${文}`).not.toBe("");
      expect(讀, `讀み上げが缺いて居る: ${文}`).not.toBe("");
      expect(讀, `打った形を名指さん: ${文}`).toContain(`「${文}」`); // 第 388 回
      expect(讀, `打ち直しを置いて居らん: ${讀}`).toContain("で");
    }
  });

  it("讀み上げは目の字より短く、一打鍵每に読める長さ（第 247 回の約束）", () => {
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

  it("目の字の文は一字も變はらん – 家をまとめた證（第 615 回の據へ替へ）", () => {
    /* 形ごとの斷りの核となる句を張る。之が崩れたら、家を移す時に文を書き換へた事になる
     * （斷りの文を張つて居る檢査は他にも有るが、此處で一つの家であることを確かめる）。*/
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

  it("判斷の家は一つ – 形の檢定は `uiWordShapeNoteJa` に集めてある（第 392 回）", () => {
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
      /* 宣言が一度きりで、其れが此の家に在る事 – 二箇所に同じ检定を書くと片方だけ直る（第 512 回）。*/
      expect(源.split(`const ${形} =`).length - 1, `${形} の宣言が二箇所ある`).toBe(1);
      expect(家, `${形} が此の家の中にある`).toContain(`const ${形} =`);
    }
    /* 呼び出しは二箇所（畫面の導きと讀み上げ）+ 定義 1 – 三家目に増えて居らん事。*/
    expect(源.split("uiWordShapeNoteJa(").length - 1).toBe(3);
  });

  it("他の家が喋る打ち方と、何も言はんで良い打ち方を奪はん", () => {
    /* 行が出る打ち方に讀み上げは立てん（畫面と同じ – 第 337 回）。*/
    for (const 文 of ["来週", "今週", "明日", "年内", "8月上旬"]) {
      expect(Recommender.uiWordLiveNoteJa(文), `行が出る語に喋つた: ${文}`).toBe("");
    }
    /* 語その物が收錄に無い話は別の家が持つ（`猫` – 0 件の理由の讀み上げは app 側で立つ）。*/
    expect(Recommender.uiWordLiveNoteJa("猫")).toBe("");
    /* 羣の語の讀み上げは其の侭（形の家の側へ落ちて居らん）。*/
    expect(Recommender.uiWordLiveNoteJa("リマインド")).not.toBe("");
    expect(Recommender.uiWordLiveNoteJa("リマインド")).toContain("リマインド");
  });
});
