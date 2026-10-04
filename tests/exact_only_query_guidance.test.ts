/**
 * 訪ねの語を**その物の打ち方**の時だけ受ける路（第 682 回）。
 *
 * 事實（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）– `いつ頃` `いつ締まる？`
 * `いつになる？` `間に合う会議` `手数料` `いくら` は 0 行で案内も無く、行き止まりの受皿に
 * 落ちて居た。第 681 回でこれらの語を案内の羣に載せると**七本の檢べが壞れた** – 羣の語は
 * 打ち方の頭から又ぎ側にも通る（`uiWordContain`）ので、先の尖つた案内を短い語が塞いだ為。
 * そこで `exactOnly` の印を設け、**打ち方その物と完全一致した時だけ**羣の斷りを出すやうにした。
 * 此處はその二面 – 默つて居た物が開き、開いて居た物が塞がれん – を張る。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
);
const hays = 品書.map((行) => String(行.hay));

const 搜 = (文: unknown): number => {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(String(文), AT), AT);
  return hays.filter((行) => 照合(行) === true).length;
};
const 案内 = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "");

describe("訪ねの語を打ち方その物の時だけ受ける路（第 682 回）", () => {
  it("品書は 3,250 行", () => {
    expect(品書.length).toBe(3250);
  });

  it("默つて居た十本が、其の羣の斷りを受ける", () => {
    for (const 文 of [
      "いつ頃",
      "いつ締まる",
      "いつ締まる？",
      "いつになる",
      "いつになる？",
      "何時ですか",
    ]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("聞き方では絞り込めません");
    }
    for (const 文 of ["間に合う", "間に合うか", "間に合う会議", "いつまでに"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("曖昧な幅では絞り込めません");
    }
    for (const 文 of ["手数料", "いくら"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("費用の欄");
    }
  });

  it("先の尖つた案内は短い訪ねの語に食はれん（第 681 回に壞れた七本の内、此の路に関はる物）", () => {
    // 第 621 回 – 十七字を越える問ひ文は、打ち方を名指す斷りが勝つ。
    expect(案内("採択通知がいつ頃届くのか知りたいです")).toContain(
      "採択通知がいつ頃届くのか知りたいです",
    );
    // 第 344・614 回 – 幅の語に語尾を繋いだ形は、其の形を名指す文が勝つ。
    expect(案内("年内に間に合う")).toContain("年内に間に合う");
    // 第 510 回 – 行が出る打ち手に案内を被せん。
    expect(搜("今週")).toBe(37);
    // 第 623 回 – 二語を打った人は「外した殘りも 0 件」の道へ讓る（羣の斷りを乘せん）。
    expect(案内("手数料 締切")).toBe("");
    expect(案内("間に合う 締切")).toBe("");
    // 第 653 回 – 默つて居る內譯を事實として張る條（此の語足しで立つてはならん）。
    expect(案内("いつ締切られますか")).toBe("");
  });

  it("印は完全一致の路でだけ讀まれる（又ぎ側を廣げん配線）", () => {
    const 本 = readFileSync(`${process.cwd()}/site/recommender.ts`, "utf8");
    const 使 = 本.indexOf("(group.exactOnly || []).find(");
    expect(使, "完全一致の路が印を讀んで居らん").toBeGreaterThan(0);
    // 又ぎ側（語の頭から続く形）と助詞の連体の道は其の後に在るので、印より前に在らん限り
    // その二つは讀まん（第 681 回に壞れた檢べが通るかの內譯）。
    expect(使).toBeLessThan(本.indexOf("const 含み = uiWordContain(q);"));
    // 又ぎ側の道の**中身**（語の頭から続く形を見る所）に印が現れん事 – 現れたら又ぎ側でも
    // 受ける事になり、上の實測（第 621・344・623・653 回）が壞れる。
    const 道 = 本.slice(本.indexOf("function uiWordContain("), 本.indexOf("function uiWordMatch("));
    expect(道.length).toBeGreaterThan(200);
    expect(道).not.toContain("exactOnly");
  });

  it("行き止まりの畫面文にも載る（受皿だけに落ちん）", () => {
    const 欄 = deadlineHintFunction();
    const 文 = String(
      欄({
        window: "all",
        past: false,
        cats: 0,
        domestic: false,
        online: false,
        rank: "all",
        kind: "",
        est: false,
        clearable: true,
        pastShown: false,
        hidden: { past: 1200, est: 134 },
        hiddenKindWords: [],
        queryMatch: { catalog: 0, journal: 0 },
        catalogConferences: 700,
        urlQuery: false,
        termCounts: [{ term: "間に合う会議", count: 0 }],
        shorterHits: Recommender.shorterHitWordsJa("間に合う会議", hays, AT, 4) || [],
        query: "間に合う会議",
        categoryNames: ["人工知能", "データベース"],
      }),
    );
    expect(文).toContain("曖昧な幅では絞り込めません");
  });

  it("敬體・疑問の語尾を續けた形も、同じ打ち方として受ける", () => {
    // `いつ締まる` の敬體 – 連用形「り」を元の「る」に直す崩しまで見る（第 326 回と同じ）。
    for (const 文 of ["いつ締まりますか", "いつ締まります", "いつになる？", "いつ頃ですか"]) {
      expect(案内(文), `『${文}』が默つた侬`).toContain("聞き方では絞り込めません");
    }
    expect(案内("手数料ですか")).toContain("費用の欄");
    // 其の崩しは `exactOnly` にだけ效く – `何時まで` のやうに又ぎ側の道が既に讓る形は舊通り。
    expect(案内("何時まで")).toContain("聞き方では絞り込めません");
  });

  it("搜しは案内の羣と無關係（載せ替へで行數は變はらん – 第 681 回實測の侬）", () => {
    // 案内の語は斷りを出すだけで、搜しの照合式を作らんと內譯（羣と `searchMatcher` は別物 –
    // 全体のスウィープでも增 0・減 0 を確かめた）。
    expect(搜("いつ頃")).toBe(376);
    for (const 文 of [
      "間に合う",
      "間に合う会議",
      "手数料",
      "いくら",
      "いつ締まる？",
      "いつまでに",
    ]) {
      expect(搜(文), `『${文}』の行數が變はつた`).toBe(0);
    }
  });
});
