import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
/** 0 件の画面に出る導きの本体（`site/app.ts` の順番を隨ふ – 羣の斷り → 全行の語）。 */
const 畫面 = (文: string): string =>
  String(Recommender.uiWordNoteJa(文, false) || Recommender.wholeTableQueryNoteJa(文) || "").trim();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};

const 鍵の打ち手 = ["キーボード", "ショートカット", "キー操作", "キーボード操作", "キーバインド"];
const 全行の頼み = [
  "すべて表示",
  "全部出してください",
  "全件見たい",
  "全て表示して",
  "すべて出して",
];

describe("キーボード操作を訪ねる打ち手（第 631 回）", () => {
  it("黙らん – 項の名前と鍵の名を書く", () => {
    for (const 文 of 鍵の打ち手) {
      const out = 畫面(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `てびきの項の名前が書かれて居ん: ${文}`).toContain("キーボードで一覧を動かす");
      for (const 鍵 of ["j", "k", "Enter", "d"])
        expect(out, `${鍵} の鍵が書かれて居ん: ${文}`).toContain(鍵);
      expect(out, `モードの話が書かれて居ん: ${文}`).toContain("投稿先を探すモード");
    }
  });
  it("当たり行の出る打ち手に乘らん（第 337 回）", () => {
    for (const 文 of 鍵の打ち手) expect(当たり(文), `行が出た: ${文}`).toBe(0);
  });
  it("画面の項に実際にある鍵だけを案内に書くん（第 466 回）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(頁).toContain("キーボードで一覧を動かす");
    expect(頁).toContain("見出しもキーボードで押せます");
    /* 案内が寫し氣いた鍵が、画面の項に <code> としてある事を一つずつ見る。 */
    for (const 鍵 of ["j", "k", "d", "/", "Enter", "Tab", "Esc"])
      expect(頁, `畫面の項に鍵が在らん: ${鍵}`).toContain(`<code>${鍵}</code>`);
  });

  describe("全行の語に頼みを継いだ打ち方（第 631 回）", () => {
    it("頼みを継いだだけで無言に成らん", () => {
      for (const 文 of 全行の頼み) {
        const out = 畫面(文);
        expect(out, `默つた: ${文}`).not.toBe("");
        expect(out, `打ち直しが書かれて居ん: ${文}`).toContain("検索では絞り込めません");
        expect(out, `検索語を消す話が書かれて居ん: ${文}`).toContain("検索語を消してください");
        expect(out, `過ぎた締切の切替が書かれて居ん: ${文}`).toContain("過去の締切も表示");
      }
    });
    it("頼みの語を広げ過ぎん – 欄の値に継いだ打ち方は黙つた侬（第 362 回）", () => {
      /* 「表示」を語尾に通すのは全行の語の後だけ。検索の語に継いだ打ち方に
       「絞り込めません」と言へば噓になる（当たりが出る可能性がある）。 */
      for (const 文 of ["セキュリティ表示", "日程表示", "分野を表示", "表を表示"])
        expect(Recommender.wholeTableQueryNoteJa(文), `全行の語と判じた: ${文}`).toBe("");
    });
    it("検索の側は変はらん（第 362 回 – 頼みを継いだ打ち方も 0 件の侬）", () => {
      for (const 文 of 全行の頼み) expect(当たり(文), `行が出た: ${文}`).toBe(0);
    });
  });

  describe("消えた行を戻したい人（第 631 回）", () => {
    it("`非表示` `表示されない` `表示されん` は『条件クリア』へ導す", () => {
      for (const 文 of ["非表示", "表示されない", "表示されん"]) {
        const out = 畫面(文);
        expect(out, `默つた: ${文}`).not.toBe("");
        expect(out, `押すボタンの名が書かれて居ん: ${文}`).toContain("条件クリア");
        expect(当たり(文), `行が出た: ${文}`).toBe(0);
      }
    });
    it("てびきの語を画面共有の打ち手は旧來の羣が受ける", () => {
      expect(畫面("画面共有する")).toContain("共有");
      expect(畫面("画面共有")).toContain("URL");
    });
    it("新しい羣の読み上げは 60 字以内（第 247 回 – 自分側の決まり）", () => {
      for (const 文 of 鍵の打ち手.concat([
        "非表示",
        "表示されない",
        "表示されん",
        "すべて表示",
        "全件見たい",
      ])) {
        const 字 = [...String(Recommender.uiWordLiveNoteJa(文) || "").trim()];
        expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
      }
    });
  });
});
