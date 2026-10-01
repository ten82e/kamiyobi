/**
 * 敬語が一枚續いただけで默らん（第 625 回）。
 *
 * 實測 – 2026-08-09 生成の実ビルド（品書 3,280 行）で 0 件になる自然な打ち方 42 本
 * （`/tmp/qs10.txt` – 操作と情報を敬語で賴む文）を、舊來の品書と竝べて數へると、
 * 畫面上の斷りが立つ物は **6 本 → 30 本**（開いた 24 本）。例 – `購読したいです`
 * `印刷する方法` `参加費を知りたいです` `リンクをコピーしたいです` `更新履歴を知りたいです`
 * `ビザを発行してほしいです` `並び替えたいです` `昇順で`。
 * 疵の所在は語で無く**語尾** – 羣の語（`購読` `印刷` `参加費` `並び替え`…）は語表に在り、
 * 其れ單體では斷りが出るが、後ろに「したいです」「を知りたいです」「してほしいです」
 * 「する方法」「で」「追加」が續いただけで門（`uiWordTailOk`）に彈かれて居た。
 * 直し – 敬語の尾を一枚剥がして同じ目で驗す條を足し、賴む形の語尾（ください・表示・追加）と
 * 「方法」を名詞側の條に置き、「で」を通す。羣の語列表は一字も增やして居らん
 * （第 512 回 – 同じ語を二つ目に載せると棚卸しが彈く。昇順・降順は並び順の羣に既に在り、
 * すべて・全部は表その物を指す語の家が持つ – 彈かれたのは語尾だけで良かつた）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
/* 斷りの先頭は打たれた語の名指し（echo）なので、其れを外して**同じ案内の家が立つて居るか**を見る。 */
const 後ろ = (文: string): string => 斷り(文).replace(/^「[^」]*」/, "");

describe("敬語・賴む語尾が續いても同じ斷りが立つ（第 625 回）", () => {
  /* [裸の形, 敬語で賴んだ形] – 舊來は右側が皆 空文字だつた。 */
  const 対: Array<[string, string]> = [
    ["購読", "購読したいです"],
    ["印刷", "印刷したいです"],
    ["印刷", "印刷する方法"],
    ["保存", "保存する方法"],
    ["リセット", "リセットしたいです"],
    ["並び替え", "並び替えたいです"],
    ["参加費", "参加費を知りたいです"],
    ["ビザ", "ビザを発行してほしいです"],
    ["リンクをコピー", "リンクをコピーしたいです"],
    ["使い方", "使い方を知りたいです"],
    ["書き出し", "CSVで書き出したいです"],
  ];
  it("語尾が續いても同じ案内の家に落ちる", () => {
    for (const [裸, 敬語] of 対) {
      expect(斷り(裸), `裸の形が立つ筈: ${裸}`).not.toBe("");
      expect(斷り(敬語), `敬語を續けただけで默つた: ${敬語}`).not.toBe("");
      expect(後ろ(敬語), `別々の案内を立てた: ${敬語}`).toBe(後ろ(裸));
    }
  });
  it("打ち切るだけの賴み方も受ける（昇順で・カレンダー追加）", () => {
    expect(斷り("昇順で")).toContain("列の見出し");
    expect(斷り("降順で")).toContain("列の見出し");
    expect(斷り("カレンダー追加")).toContain("カレンダーに追加");
  });
  it("品書 0 件の畫面で、打ち先の名前がそのまま出る", () => {
    const 幕 = deadlineHintFunction();
    const out = 幕({
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      hiddenKindWords: [],
      hidden: { past: 1200, est: 134 },
      queryMatch: { catalog: 0, journal: 0 },
      termCounts: [{ term: "購読したいです", count: 0 }],
      urlQuery: false,
      catalogConferences: 12,
      query: "購読したいです",
      shorterHits: [],
    });
    expect(out).toContain("購読");
    expect(out, "畫面の文に打ち先が書かれて居ん").toMatch(/カレンダーに追加|購読 URL/);
  });
});

describe("磁石 – 主題と手続を打つ文を食はせん（第 503 回）", () => {
  /* 「したいです」を通すと、他の語の頭に同じ語尾が乘る懸ひがある。實測で之等の文は
     羣の語に當たらん（搜に來た文なので、其侭默つて打ち替えの案內に讓る）。 */
  const 讓る文 = [
    "査読したいです",
    "発表したいです",
    "投稿したいです",
    "参加したいです",
    "登録したいです",
    "セッションに登録したいです",
    "締切を知りたいです",
    "日程を知りたいです",
    "会場を知りたいです",
    "高速計算を知りたいです",
    "セキュリティの会議が見たいです",
    "採択されたいです",
    "申請したいです",
    "聴講したいです",
  ];
  it("搜の文には畫面の斷りを立てん", () => {
    for (const 文 of 讓る文) {
      if (文 === "聴講したいです") continue; /* 聴講 は參加形式の羣が既に持つ（舊來からの斷り） */
      expect(斷り(文), `搜の文に斷りが乘つた: ${文}`).toBe("");
    }
  });
  it("檢索の側は一字も廣げて居らん（第 362 回 – 語尾の門は案内の目だけ）", () => {
    /* 敬語を續けた文は品書に行が出ん（斷りが立つのは其の時だけ – app の門）。
       其れに対して語その物が行を持つ事も在る（`昇順` は原文に現れる） – 其れは搜側の話で、
       今回の直しで變はつて居らん事を張る。 */
    const 品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    );
    const 當 = (文: string) => {
      const m = Recommender.searchMatcher(文, 基準);
      return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
    };
    for (const 文 of ["昇順で", "降順で", "購読したいです", "印刷する方法", "カレンダー追加"])
      expect(當(文), `行が出て居る – 斷りを立てる場處で無い: ${文}`).toBe(0);
    expect(當("購読"), "`購読` の行の數が變はつた").toBe(0);
  });
});

describe("抜き出しの檢査器が壞れん形に置く（第 341 回の罠）", () => {
  const src = readFileSync(new URL("../site/recommender.ts", import.meta.url), "utf8");
  const i = src.indexOf("function uiWordTailOk");
  const body = src.slice(i, src.indexOf("\n  }", i + 40));
  it("敬語を剥ぐ條は家の中にあり、外の定數にHandさへ讓らん", () => {
    expect(i).toBeGreaterThan(0);
    expect(body).toContain('"です", "ですか", "でしょうか"');
    expect(src.slice(0, i)).not.toMatch(/^ {2}const 敬語の尾Ja = \[/m);
  });
});
