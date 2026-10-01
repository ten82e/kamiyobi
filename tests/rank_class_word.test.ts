/**
 * 等級を「A クラス」と呼ぶ人も搜える（第 640 回）。
 *
 * 品書 3,250 行で實測した打ち分 – `Aランク`・`A評価`・`A類` はいずれも 1,721 行で通るのに、
 * **`Aクラス`・`クラスA`・`CCFのAクラス` は 0 行で案内も無し**だつた。行の等級の語を組み立てる
 * `rankSearchTerms`（第 194 回・第 235 回）が三語しか持つて居なかつた為。
 *
 * 同じ所で決まる事 – 件數欄の「だけでは等級を絞れていません」の判定は、照合で使う **かなに畳んだ
 * 形**で見なければならない（第 194 回の枝は片假名のまま書いてあり、`Aランク` 等に一度も當たら
 * ずに空振りして居た – 實測で `ランク Aクラス` に絞れて居る人へ注意が出て居た）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
) as unknown as Array<{ hay: string; rankPairs?: string[] }>;
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r) => m(r.hay) === true).length;
};

describe("等級の別の呼び方（第 640 回）", () => {
  it("『A クラス』は『A ランク』と同じ行に出会う", () => {
    for (const [逆, 正] of [
      ["Aクラス", "Aランク"],
      ["Bクラス", "Bランク"],
      ["Cクラス", "Cランク"],
      ["A*クラス", "A*ランク"],
    ] as const) {
      expect(当たり(正), `基準の方が行を出さん: ${正}`).toBeGreaterThan(0);
      expect(当たり(逆), `${逆} が ${正} と違う數になる`).toBe(当たり(正));
    }
    // 助詞で繋がれた打ち方も同じ（`の` は語の区切り – 第 245 回）。
    expect(当たり("CCFのAクラス"), "助詞を挟んだ打ち方が屆かん").toBe(当たり("Aランク"));
  });
  it("語順を逆に打つ形も受ける – `クラスA`（實測で A と A* を併せて読む）", () => {
    /* `クラスA` は接頭で當てる為、等級が `A*` の行も併せて読む（實測 1,822 / 1,721 件 –
     * 差は A* だけの行）。だから「減らない」事だけを張る（逆順の形が空振りして居ない事も見る）。*/
    expect(当たり("クラスA"), "語順を逆にした形が屆かん").toBeGreaterThanOrEqual(当たり("Aクラス"));
    expect(当たり("クラスA"), "逆順の形が 0 行（表に語が載つて居ない）").toBeGreaterThan(0);
    // 併せて読む内譯はてびきに書いてある – 默つて數を変へない。
    const guide = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
    expect(guide, "てびきに語順を逆にした形の讀み方が無い").toContain("1,822");
  });
  it("等級の無い行を `クラス` で出さん – 足す語は其の行の等級の名前だけ", () => {
    const m = Recommender.searchMatcher(Recommender.expandRelativeMonths("クラス", 基準), 基準);
    const 當 = 品書.filter((r) => m(r.hay) === true);
    expect(當.length, "品書に等級の語が組み立てられて居ない（此の檢査が空振り）").toBeGreaterThan(
      100,
    );
    expect(當.filter((r) => !(r.rankPairs || []).length).length, "等級の無い行が混んだ").toBe(0);
  });
  it("單獨の『クラス』は絞れて居ないと書く – 『ランク』と同じ約束", () => {
    const 案 = Recommender.querySynonymNotes("クラス").join(" ");
    expect(案, "單獨では絞れん事を件數欄が言わん").toContain("だけでは等級を絞れていません");
  });
  it("等級の語が一緒に在れば注意を出さん – かなに畳んだ形で見る（第 194 回の空振り）", () => {
    for (const 文 of ["ランク Aクラス", "ランク Aランク", "評価 B類", "ランク A*クラス"]) {
      expect(Recommender.querySynonymNotes(文).join(" "), `${文} に噓の注意が出た`).not.toContain(
        "だけでは等級を絞れていません",
      );
    }
    // 逆も同じ – 等級の語の無い打ち手には出る。
    for (const 文 of ["ランク", "評価", "類", "クラス"]) {
      expect(Recommender.querySynonymNotes(文).join(" "), `${文} の注意が消えた`).toContain(
        "だけでは等級を絞れていません",
      );
    }
  });
  it("搜の語の表にも `クラス` が並ぶ（画面の語と組み立てを揃へる）", () => {
    const 語 = Recommender.rankSearchTerms(["ccf:A"]);
    for (const 形 of ["aランク", "a評価", "a類", "aクラス", "クラスa"]) {
      expect(語, `等級の語に ${形} が無い`).toContain(形);
    }
    expect(Recommender.rankSearchTerms(["core:A*"]), "A* に `クラス` の形が無い").toContain(
      "a*クラス",
    );
  });
});
