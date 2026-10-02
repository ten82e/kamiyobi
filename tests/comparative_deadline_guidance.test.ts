/**
 * 比べる語で締切を訊いた人への案内（第 681 回）。
 *
 * 事實（2026-08-09T00:00:00Z 生成の実ビルド・`Recommender.candidateRows` の品書 3,250 行）–
 * `早い締切` `遅い締切` `一番早い締切` `最も近い締切` `一番遠い締切` はいずれも搜 0 行。
 * 案内も出ず、打ち直しの候補には**送り假名を切り殘した切れ端**『い締切』（147 件 – 誰も打たん）
 * だけが出て居た。研究計画は「一番早い締切はどれ？」と訊くので、幅の案内（近いの幅は決めん –
 * 締切の推測をしない決まり）と**畫面の既定の並びが残り日数の昇順**である事を說く。
 *
 * 同じ回で、費用・曖昧な幅の群に欠けて居た言ひ方（`手数料` `出場料` `間に合う` `締まる`）も载せ、
 * 送り假名が残る切れ端を打ち手から落す門を入れた（搜しは變へて居ない – 案内と打ち手だけ）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(`${process.cwd()}/data/snapshot.json`, "utf8")),
);
const hays = 品書.map((行) => String(行.hay));

const 搜 = (文: unknown): number => {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(String(文), AT), AT);
  return hays.filter((行) => 照合(行) === true).length;
};
const 案内 = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "");
const 札 = (文: string) => Recommender.shorterHitWordsJa(文, hays, AT, 4) || [];

describe("比べる語で締切を訊いた人への案内（第 681 回）", () => {
  it("品書は 3,250 行", () => {
    expect(品書.length).toBe(3250);
  });

  it("比較級・最上級の訊き方に「近い・早い」の案内が出る", () => {
    for (const 文 of [
      "早い",
      "速い",
      "遅い",
      "遠い",
      "早い締切",
      "遅い締切",
      "遠い締切",
      "一番早い締切",
      "最も近い締切",
      "一番遅い締切",
      "一番遠い締切",
    ]) {
      const 文2 = 案内(文);
      expect(文2, `『${文}』に案内が出ん`).toContain("では絞りません");
      expect(文2, `『${文}』の案内が幅を決めると言つて居る`).toContain("勝手に決めません");
      expect(文2, `『${文}』の案内が畫面上の順を說かん`).toContain("残り日数の昇順");
    }
  });

  it("送り假名を切り殘した切れ端は打ち手に出さん", () => {
    for (const 文 of ["早い締切", "一番早い締切", "遅い締切", "今週中に終わる", "来週中に終わる"]) {
      const 列 = 札(文);
      for (const 見 of 列) {
        expect(
          /^[ぁ-ん]/.test(String(見.word)),
          `『${文}』に假名から始まる切れ端『${見.word}』が出る`,
        ).toBe(false);
      }
    }
    expect(札("早い締切").map((見) => 見.word)).not.toContain("い締切");
    expect(札("今週中に終わる").map((見) => 見.word)).not.toContain("わる");
    // 切れ端を落しても語が残る邊は正しく打てる（實測 – 『今週中』37 件）。
    expect(
      札("今週中に終わる").some((見) => 見.word === "今週中" && Number(見.count) === 37),
      "『今週中に終わる』から『今週中』の打ち手が消えた",
    ).toBe(true);
  });

  it("漢字で始まる正常的な打ち手は門に掛からん", () => {
    const 見 = 札("ネットワーク分野").find((h) => h.word === "ネットワーク");
    expect(見, "『ネットワーク分野』から『ネットワーク』が消えた").toBeDefined();
    expect(Number(見!.count)).toBe(257);
    const 系 = 札("セキュリティ系").find((h) => h.word === "セキュリティ");
    expect(系, "『セキュリティ系』から『セキュリティ』が消えた").toBeDefined();
    expect(Number(系!.count)).toBe(527);
  });

  it("費用の言ひ方の欠けを载せた（载せん物も張る）", () => {
    for (const 文 of ["出場料", "聴講料"]) {
      expect(案内(文), `『${文}』に費用の案内が出ん`).toContain("費用の欄はありません");
    }
    // `発表料` は費用の群より上流の「運営と手続きのこと」の群が受ける（重複を避ける – 棚卸し檢べ②）。
    expect(案内("発表料")).toContain("各催し物の公式ページ");
    // `手数料` は**敢えて载せん** – multiword の打ち方が先なので、語を足すと第 623 回の
    // 「外した殘りも 0 件の侭です」の文を上書きしてしまう（羣の照合は先勝ち – 實測で壞れた）。
    expect(案内("手数料")).toBe("");
  });

  it("曖昧な幅の羣に bare な語を足さぬ事と、搜しが廣がらん事を張る", () => {
    // 先の尖つた羣が既に受ける形（羣の照合は先勝ち – `いつ` `何時` `間に合う` を曖昧な幅の羣に
    // 足すと、これらの案内が壞れる實測があった。第 681 回）。
    expect(案内("年内に間に合う")).toContain("年内に間に合う");
    expect(案内("何時まで")).toContain("聞き方では絞り込めません");
    expect(案内("何日")).toContain("聞き方では絞り込めません");
    // 案内の為の語足しで搜しが廣がつて居らん（實測 – 舊も新も 0 行）。
    for (const 文 of [
      "早い締切",
      "一番早い締切",
      "間に合う会議",
      "いつ締まる？",
      "手数料",
      "出場料",
    ]) {
      expect(搜(文), `『${文}』が行を出すやうになつた`).toBe(0);
    }
    expect(搜("今週")).toBe(37);
  });

  it("行き止まりの畫面文にも案内が乘る（受皿だけに落ちん）", () => {
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
        termCounts: [{ term: "一番早い締切", count: 0 }],
        shorterHits: 札("一番早い締切"),
        query: "一番早い締切",
        categoryNames: ["人工知能", "データベース"],
      }),
    );
    expect(文).toContain("残り日数の昇順");
    expect(文).not.toContain("い締切");
  });

  it("畫面の既定の並びが残り日数の昇順である內譯が崩れて居らん", () => {
    // 案内の文が「既定の並びは締切が近い順（残り日数の昇順）」と言うので、其の內譯を張る。
    const 本 = readFileSync(`${process.cwd()}/site/app.ts`, "utf8");
    expect(本).toContain('const DEFAULT_SORT_KEY = "rem"');
  });
});
