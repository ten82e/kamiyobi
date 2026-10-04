/**
 * 地名・時期の語に `開催` を直に続けた打ち方と、參加の申込みの別の名前（第 684 回）。
 *
 * 事實（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）– `アジア開催` `パリ開催`
 * `韓国開催` `欧州開催` `夏開催` `秋開催` `ワークショップ開催` `参加申込` `参加申込締切`
 * `参加申込み締切` は**搜 0 行で案内も無し**（行き止まりの受皿に落ちて居た）。其の内 `アジア`
 * 511 行・`パリ` 8 行・`夏` 273 行・`ワークショップ` 174 行・`登録締切` 22 行が通る – 語尾が
 * 一語に續いた為だけ通らん形。第 678 回までは `参加申込締切` を「申込が論文か登錄か分らん」で
 * 彈いたが、品書の `申込` を含む 10 行は全て「発表申込締切」（實測）なので、頭に `参加` が
 * 續いた形は助詞の割りで空の交わりになつて居た。
 *
 * 振ひ – 語尾の `開催` を落とした形は**行增やす側にしか効かん**（照合は部分一致なので、落とした
 * 語は元の語の行集合を含む）。寄せ表に其の侬の鍵が在る語は其の方に讓る（件の欄の說明が落ちる為）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
);
const hays = 品書.map((行) => String(行.hay));

function 當る(文: string): string[] {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return hays.filter((行) => 照合(行) === true).sort();
}
const 當 = (文: string): number => 當る(文).length;
const 讓 = (文: string): string =>
  String(Recommender.uiWordNoteJa(文, false) || Recommender.uiWordLiveNoteJa(文) || "");
const おしらせ = (文: string): string => (Recommender.querySynonymNotes(文) || []).join(" ");

describe("地名・時期に `開催` を續けた打ち方と參加の申込み（第 684 回）", () => {
  it("品書は 3,250 行", () => {
    expect(品書.length).toBe(3250);
  });

  it("開催を續けた形が、其の方の語を打つのと同じ行に出会う", () => {
    for (const 頭 of [
      "アジア",
      "パリ",
      "韓国",
      "欧州",
      "東京",
      "シンガポール",
      "ワークショップ",
      "チュートリアル",
    ]) {
      expect(當(`${頭}開催`), `『${頭}開催』の行數が別の家`).toBe(當(頭));
      expect(當(頭), `『${頭}自体が 0 行`).toBeGreaterThan(0);
    }
  });

  it("一文字の頭の季節の語も受ける（`夏開催` `秋開催`）", () => {
    for (const 頭 of ["春", "夏", "秋", "冬"]) {
      expect(當(`${頭}開催`), `『${頭}開催』が默つた侬`).toBe(當(頭));
      expect(當(頭), `季節の語『${頭}自体が 0 行`).toBeGreaterThan(0);
    }
    // 助詞は一文字の頭に數へん（`の` 單體は品書 2,669 行に當る語 – 落とした形は絞り込みにならん）。
    expect(當("の開催"), "`の開催` を `の` に落とした").toBe(0);
    expect(當("ものの開催"), "`ものの開催` を `もの` に落とした").toBe(0);
  });

  it("寄せ表が其の侬を受ける語は其の方に讓る（件の欄の說明を落とさん）", () => {
    expect(當("国内開催")).toBe(當("国内"));
    expect(おしらせ("国内開催")).toContain("「国内」のつく行");
    expect(當("オンライン開催")).toBe(當("オンライン参加可"));
    expect(おしらせ("オンライン開催")).toContain("オンライン参加可");
    expect(當("バーチャル開催")).toBeGreaterThan(0);
    expect(おしらせ("いつ開催")).toContain("会期");
  });

  it("參加の申込みは種別『登録締切』に屆く – 論文の申込みは動かさん", () => {
    for (const 文 of ["参加申込", "参加申込み", "参加申込締切", "参加申込み締切"]) {
      expect(當(文), `『${文}』が 0 行の侬`).toBe(22);
      expect(當る(文)).toEqual(當る("登録締切"));
      expect(おしらせ(文), `『${文}』のおしらせが無い`).toContain("登録締切");
    }
    // 発表の申込み（`申込締切` 10 行）は其の侬 – 寄せを擴げ過ぎて了うと間違った種を出す。
    expect(當("申込締切")).toBe(10);
    expect(當("発表申込締切")).toBe(10);
  });

  it("搜 0 行の形にも讓りは殘る（`対面開催` は参加形式の斷り）", () => {
    expect(當("対面開催")).toBe(0);
    expect(讓("対面開催")).toContain("オンライン");
    expect(當("オフライン開催")).toBe(0);
    expect(讓("オフライン開催").length).toBeGreaterThan(0);
  });

  it("割りの他家は無傷 – 日の語と種の語の複合は舊來通り", () => {
    const 金型: Array<[string, number]> = [
      ["8月10日から8月20日", 122],
      ["締切まで30日", 689],
      ["採否通知締切", 240],
      ["参加登録締切", 22],
      ["最終原稿締切", 147],
      ["デモ締切", 7],
      ["結果締切締切", 0],
    ];
    for (const [文, 行] of 金型) {
      expect(當(文), `『${文}』の行數が變はつた`).toBe(行);
    }
  });
});
