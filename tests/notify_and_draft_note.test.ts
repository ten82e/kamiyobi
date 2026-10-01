/**
 * 通知のくれんかと、打ちかけの論文の入力を氣にする人（第 630 回）。
 *
 * 實測 – 2026-08-09T00:00:00Z 生成の実ビルド（品書 3,280 行・収録 4,744 行）で 0 件になる
 * 打ち手 831 本を讀み直した處、此の二類が默つて居た – `通知設定` `メール通知` `アラート`
 * `通知を受け取る設定` `下書き` `ドラフト` `草稿は殘る`。別に「収録に無い欄」の道を
 * 通らん物が在つた（`査読のコメントが見たい` `採否の理由` `shepherdingがある` `案内状が要る`
 * `審査委員は誰` `不合格の連絡`）。
 * 效き – 同じ手の十七本で羣の斷り **2 → 16 本**、九本の打ち手集合（831 本）では
 * **306 → 310 本**（狹まつた 0 本）。
 * 讓した物 – `RSS` は**羣に載せん**（収録に 13 行在る語なので、斷りを乘せると第 337 回の
 * 「当たりが在る文に斷りを乘せん」に觸れる – 檢査が其の數を張る）。`フィード`
 * `リマインダー` `リマインド` は他の羣が既に持つて、其の斷りも正しいので足さなんだ。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
const 短い = (文: string): string => String(Recommender.uiWordLiveNoteJa(文) || "").trim();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 収録 = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};

const 通知の打ち手 = ["通知設定", "メール通知", "アラート", "通知を受け取る設定", "通知が欲しい"];
const 下書しの打ち手 = ["下書き", "ドラフト", "草稿", "草稿は殘る"];
const 欄に無い打ち手 = [
  "査読のコメントが見たい",
  "採否の理由",
  "shepherdingがある",
  "案内状が要る",
  "審査委員は誰",
  "不合格の連絡",
];

describe("通知を訪ねる打ち手（第 630 回）", () => {
  it("默らん – 渡せる所が一覧の下の二つだと書く", () => {
    for (const 文 of 通知の打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `カレンダーへの言及が無い: ${文}`).toContain("カレンダーに追加（.ics）");
      expect(out, `購読 URL への言及が無い: ${文}`).toContain("購読 URL をコピー");
      expect(out, `毎日更新されるとは言つて居ん: ${文}`).toContain("毎日更新");
    }
  });
  it("メール配信が在らんと言ふ根拠を、畫面の字面で張る", () => {
    /* 斷りが「この頁からのメール配信は在りません」と言つて居るのだから、畫面にその
       機能が無い事を字面で見る – 将来 配信を足したら、この條が落ちて斷りを直す事を知る。 */
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(頁.includes("メール"), "畫面に『メール』の字が現れた – 斷りの見直し").toBe(false);
    for (const 文 of 通知の打ち手) expect(斷り(文)).toContain("メール配信");
  });
  it("`RSS` は羣に載せん（収録に行が在る語 – 第 337 回の噓の門）", () => {
    expect(収録("RSS"), "RSS は収録に 13 行在る語").toBe(13);
    for (const 文 of ["RSS", "RSSはある", "RSSフィード"])
      expect(斷り(文), `斷りを乘せた: ${文}`).toBe("");
  });
});

describe("打ちかけの論文の入力（第 630 回）", () => {
  it("殘る範囲と戻し方を、畫面の字面で書く", () => {
    for (const 文 of 下書しの打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `殘る範囲が書かれて居ん: ${文}`).toContain("このタブの間");
      expect(out, `URL に乗らん事が書かれて居ん: ${文}`).toContain("共有 URL");
      expect(out, `戻し方が書かれて居ん: ${文}`).toContain("直前の入力に戻す");
    }
  });
});

describe("収録に無い欄の道を、助詞と語尾で通す（第 630 回）", () => {
  it("打ち手を名指して『収録して居ん』を言ふ", () => {
    for (const 文 of 欄に無い打ち手) {
      const out = 斷り(文);
      expect(out, `默つた: ${文}`).not.toBe("");
      expect(out, `欄に無い事が書かれて居ん: ${文}`).toContain("欄の名前ではありません");
      expect(収録(文), `行が出て居る: ${文}`).toBe(0);
    }
  });
  it("語尾に「設定」と殘存の問ひを通す", () => {
    expect(斷り("購読の設定")).toContain("カレンダーに追加");
    expect(斷り("通知を受け取る設定")).toContain("購読 URL をコピー");
    expect(斷り("草稿は殘る")).toContain("このタブの間");
  });
});

describe("磁石と長さの點檢（第 503 回・第 247 回）", () => {
  it("当たり行の出る語は羣に載つて居ん", () => {
    /* 「通知」は品書に 129 行出る語（採択通知等の種別の語）なので、單體では默つて居る。 */
    expect(収録("通知")).toBeGreaterThan(0);
    expect(斷り("通知")).toBe("");
    expect(斷り("採択通知")).not.toContain("メール配信は在りません");
  });
  it("讀み上げは 60 字以内", () => {
    for (const 文 of 通知の打ち手.concat(下書しの打ち手)) {
      const 字 = [...短い(文)];
      expect(字.length, `讀み上げが ${字.length} 字: ${文}`).toBeLessThanOrEqual(60);
    }
  });
  it("斷りが名指す物は畫面に在る（第 466 回・第 628 回の流儀）", () => {
    const 頁 = readFileSync(join(builtSite(), "index.html"), "utf8");
    for (const 字 of [
      "カレンダーに追加（.ics）",
      "購読 URL をコピー",
      "論文の入力を消す",
      "直前の入力に戻す",
    ])
      expect(頁, `畫面に無い名前を案内が言った: ${字}`).toContain(字);
  });
});
