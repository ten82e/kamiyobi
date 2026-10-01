/**
 * 幅の語（今週・年内・明日…）に口語の語尾を繋いだ打ち方の導き（SPEC §7・第 614 回）。
 * 實測（2026-08-09 生成の実ビルド 868 行・固定時刻 2026-08-09T00:00:00Z・訪ね方の表 152 文）:
 * `来週のやつ` `今週中のやつ` `昨日過ぎたやつ` `今日までの締切だけ` `年内に間に合う`
 * `年末までに間に合う` `今週いつ` `明日中に終わる` はいずれも **0 行で案内も無し**だった –
 * 同じ幅の語を單體で打つと `今週` 21 行・`来週中` 53 行・`年末` 178 行が通るので、惡いのは後の方の語。
 * 「やつ」「もの」が何のことかを勝手に決めると締切の推測になるので、檢索は廣げず、
 * 通る打ち方を其の場に書く（第 362 回）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 収録(): Array<{ hay: string }> {
  const data = JSON.parse(
    readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(data) as unknown as Array<{ hay: string }>;
}
const 全 = 収録();
function 件(文: string): number {
  const 當たる = Recommender.searchMatcher(文, 基準);
  return 全.filter((row) => 當たる(String(row.hay)) === true).length;
}

describe("幅の語に口語の語尾を繋いだ打ち方", () => {
  it("八文が、打った打ち方を名指して通る形を敎ふる", () => {
    for (const 文 of [
      "来週のやつ",
      "今週中のやつ",
      "昨日過ぎたやつ",
      "今日までの締切だけ",
      "年内に間に合う",
      "年末までに間に合う",
      "今週いつ",
      "明日中に終わる",
    ]) {
      const 案内 = Recommender.uiWordNoteJa(文);
      expect(案内, `斷りが無い: ${文}`).not.toBe("");
      expect(案内, `打った形を名指さん: ${文}`).toContain(`「${文}」`); // 第 388 回
    }
  });

  it("指し名の形は、幅の語と欄の名前を並べた打ち方へ送る", () => {
    const 案内 = Recommender.uiWordNoteJa("来週のやつ");
    expect(案内).toContain("今週 締切");
    expect(案内).toContain("單體で");
    /* 「やつ」が何のことかを勝手に決めんと決める（締切の推測をせんの約束）。*/
    expect(案内).toContain("決まりません");
  });

  it("前後の判定の形は、幅を決めん事を言って『締切まで』の欄へ送る", () => {
    const 案内 = Recommender.uiWordNoteJa("年内に間に合う");
    expect(案内).toContain("幅が決まりません");
    expect(案内).toContain("「締切まで」の選択欄");
    expect(案内).toContain("年内");
  });

  it("過ぎた日の話には『過去の締切も表示』を添へ、未來の話には添へん（第 202 回）", () => {
    expect(Recommender.uiWordNoteJa("昨日過ぎたやつ")).toContain("過去の締切も表示");
    expect(Recommender.uiWordNoteJa("来週のやつ")).not.toContain("過去の締切も表示");
    expect(Recommender.uiWordNoteJa("年内に間に合う")).not.toContain("過去の締切も表示");
  });

  it("觸つてはならん形 – 單體の幅の語と、他の案内が既に立つ打ち方", () => {
    /* 幅の語その物は行を出すので何も言はんで良い（第 337 回）。之等を彈くと導きが二重になる。*/
    for (const 文 of ["今週", "来週", "来週中", "明日", "年末", "年内", "今週 締切"]) {
      expect(Recommender.uiWordNoteJa(文), `單體に喋つた: ${文}`).toBe("");
    }
    /* 近似の語・時間帯の名前・日の時間帯は其の方の斷りが立つ（第 440 回・第 418 回）。*/
    expect(Recommender.uiWordNoteJa("来週あたり")).toContain("近似の語");
    expect(Recommender.uiWordNoteJa("午後5時頃")).toContain("時刻に頃");
    expect(Recommender.uiWordNoteJa("明日夕方")).toContain("時間帯の名前");
    /* 日數の幅の話は別の斷りが立つ（第 344 回 – 同じ打ち方に二つの話をせん）。*/
    expect(Recommender.dayRangeNoteJa("3日前まで")).not.toBe("");
    expect(Recommender.uiWordNoteJa("3日前まで")).toBe("");
  });

  it("導きだけの增し物 – 檢索の道は變はらん（第 362 回）", () => {
    for (const 文 of ["来週のやつ", "今週中のやつ", "年内に間に合う", "明日中に終わる"]) {
      expect(件(文), `檢索が廣がつた: ${文}`).toBe(0);
    }
    /* 幅の語の側の行は其侭（潰して居らん）。*/
    expect(件("今週")).toBeGreaterThan(0);
    expect(件("年末")).toBeGreaterThan(0);
  });

  it("勸めが噓にならん頭だけ载せる – 單體で行が出ん語は斷らん（第 337 回）", () => {
    /* 斷りは「幅の語を單體で打ってください」と勸めるので、單體でも 0 行の語を载せたら
     * その勸めが通らん。實測（2026-08-09 生成の実ビルド・同じ固定時刻）で 0 行の六語。*/
    const 载せん六語: Array<[string, string]> = [
      ["週内", "週内のやつ"],
      ["月内", "月内のやつ"],
      ["再来年", "再来年のやつ"],
      ["去年", "去年のものだけ"],
      ["月初め", "月初めのやつ"],
      ["月初", "月初のものだけ"],
    ];
    /* 斷りの頭（幅の語の列）を源から読む – 載せ方を決めた證を源から取る（第 512 回の家）。*/
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const 頭の列 = (源.match(/const 幅の頭Ja =\n\s+"((?:[^"\\]|\\.)*)"/) || ["", ""])[1];
    expect(頭の列.length, "頭の列が読めん（書き方が變はつた）").toBeGreaterThan(40);
    for (const [頭, 文] of 载せん六語) {
      /* 件の數は品書（実ビルド 868 行）と収録（`data/snapshot.json` 3,250 行）で數へが違う語が
       * ある（實測 – 収録では `再来年` 14 行・実ビルドの品書では 0 行 – 第 611 回）。なので之は
       * 件の數でなく、**頭に载せて居らん事**其物を張る（载せたら斷りが噓になる – 第 337 回）。*/
      expect(頭の列, `頭に載せてしまつた: ${頭}`).not.toContain(頭);
      /* 他の家が喋つて良い（實測 – `去年のものだけ` は收錄の年の幅の斷りが立つ – 第 500 回）が、
       * この勸め（幅の語を單體で打つ）だけは立たん事。*/
      expect(Recommender.uiWordNoteJa(文), `この勸めを立てた: ${文}`).not.toContain("を單體で");
    }
    /* 同じ打ち方で、單體で行が出る語は斷られる（其の方の語が载つて居る證）。*/
    expect(件("今週")).toBeGreaterThan(0);
    expect(Recommender.uiWordNoteJa("今週のやつ")).not.toBe("");
  });

  it("檢索側が既に剥ぐ語を斷らん – 『のもの』は通る打ち方（第 337 回）", () => {
    for (const 文 of ["今日のもの", "明日のもの", "年内のもの"]) {
      expect(件(文), `前提 – この打ち方で行が出る: ${文}`).toBeGreaterThan(0);
      expect(Recommender.uiWordNoteJa(文), `通る打ち方に喋つた: ${文}`).toBe("");
    }
    /* 『だけ』まで続く形は檢索側が剥げないので斷る（實測 0 行）。*/
    expect(件("今日のものだけ")).toBe(0);
    expect(Recommender.uiWordNoteJa("今日のものだけ")).not.toBe("");
  });

  it("月の『終わり』は末日に解ける語なので斷らん（第 483 回）", () => {
    for (const 文 of ["来月終わり", "今月終わり", "12月終わり"]) {
      expect(件(文), `前提 – 其の方の打ち方で行が出る: ${文}`).toBeGreaterThan(0);
      expect(Recommender.uiWordNoteJa(文), `別の斷りの家に觸つた: ${文}`).toBe("");
    }
  });

  it("打たれた語が長過ぎる形は受けん（画面の斷りが行を踏み過ぎん為）", () => {
    /* 空格の無い繋げた打ち方だけ見る – 語に割れて居る打ち方は語ごとの件數案内の家（第 256 回）。*/
    expect(Recommender.uiWordNoteJa("今週 の やつ")).toBe("");
  });
});
