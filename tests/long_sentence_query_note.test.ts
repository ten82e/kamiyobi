/**
 * 敬體の長い文をそのまま打つた人への打ち直し（第 621 回）。
 *
 * 實測（2026-08-09 生成の実ビルド・固定時刻 2026-08-09T00:00:00Z・品書 868 行）で、
 * 十七〜卅字の自然な問ひ文 16 本の内 **14 本が 0 件かつ畫面の導線が何も立たない**だつた。
 * 語の門（`uiWordContain`）が十六字で切れ、其の先は形の家的な導線も無かつた為 –
 * 門を廿四字に上げても（語尾の門が續き十五字までしか受けん）殘つたので、
 * `uiWordShapeNoteJa`（第 615 回の家）に「長い文の打ち直し」の形を増やした。
 * 語の門が先に走る故、斷れる語を持つ文は舊來の精しき斷りが勝つ – 其を下の檢査で張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 収録(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  );
}
function 件数(語: string): number {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 収録().filter((r) => 当(String(r.hay)) === true).length;
}
const 打ち直しJa = "長い文のままでは絞れません";

describe("第 621 回 – 長い文のまま打つた人へ、語を並べ直す形を書く", () => {
  it("十七字を越える問ひ文が、導線を一つ立てる", () => {
    const 文 = [
      "査読付きの国際会議で日本で開催される物はありますか",
      "ポスター発表onlyのワークショップに参加費はかかりますか",
      "採択通知がいつ頃届くのか知りたいです",
      "この一覧からオンライン参加できるものだけを表示できますか",
      "筆頭著者じゃなくて共著での投稿も認められている会議は？",
      "ワークショップのオーガナイザを募集しているものはありますか",
      "学生だけのセッションがある国際会議はどこですか",
      "自分の分野がセキュリティ以外でも応募できるワークショップは",
      "この表のデータを自分のページに載せたいのですがどうしますか",
    ];
    for (const q of 文) {
      expect([...q].length >= 17, `"${q}" は十七字に屆かん`).toBe(true);
      const 注 = String(Recommender.uiWordNoteJa(q) || "");
      expect(注, `"${q}" が默つたまま`).not.toBe("");
      /* 案内は打ち方を名指す（第 388 回） – 短い斷りの時も打たれた文其のままを書く。 */
      expect(注, `"${q}" の斷りが打ち方を名指して居らん`).toContain(q.slice(0, 6));
    }
  });

  it("斷れない文は舊來の精しき斷りが勝つ（形の文に讓らん）", () => {
    /* 十七字 – 羣の語と既知の語尾が揃ふので語の門が受ける（第 620 回で廿四字に上げた効き）。 */
    const 精 = "プレプリントを出しても大丈夫ですか";
    const 注 = String(Recommender.uiWordNoteJa(精) || "");
    expect(注).not.toBe("");
    expect(注, "形の方の文が先に立つた").not.toContain(打ち直しJa);
    expect(注).toContain("プレプリント");
    /* 十三字 – 舊來から語の門が受けて居た形。 */
    expect(String(Recommender.uiWordNoteJa("招待状は発行してもらえますか") || "")).toContain(
      "招待状",
    );
  });

  it("打ち直しの形は、値の並び・問ひで無い文・ひらがなの無い文を彈く", () => {
    for (const q of [
      "過去の締切 関西", // 値を並べた打ち手（第 250・354 回）
      "会場 京都 オンライン参加可 のやつ一覧", // 同上
      "関西で開かれる情報処理の学会を開催する", // 問ひで無い
      "2027年関西HPC情報処理学会一覧表", // ひらがなを含まん
      "査読付き国際会議日本開催", // 問ひの尾が無く十五字
    ]) {
      const 注 = String(Recommender.uiWordNoteJa(q) || "");
      expect(注.includes(打ち直しJa), `"${q}" に打ち直しを被せた`).toBe(false);
    }
  });

  it("長い文の導線は讀み上げの短さを越えん（第 247 回 – 六十字）", () => {
    const q = "ベストペーパー賞はあるんですか、そういう情報は載っていますか";
    const 短 = String(Recommender.uiWordLiveNoteJa(q) || "");
    expect(短).not.toBe("");
    expect([...短].length, `讀み上げが ${[...短].length} 字あつた`).toBeLessThanOrEqual(60);
    expect(短).toContain("長い文");
  });

  it("檢索の側は一字も廣げて居らん（第 362 回 – 案内だけ直した）", () => {
    expect(収録().length, "収録の行總數が動いた").toBe(3250);
    for (const [語, 行] of [
      ["査読", 32],
      ["採択", 240],
      ["カメラレディ", 147],
      ["オンライン参加可", 109],
    ] as const) {
      expect(件数(語), `"${語}" の行數が動いた`).toBe(行);
    }
  });
});
