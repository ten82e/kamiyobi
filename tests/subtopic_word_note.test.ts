/** 細目の主題と募集対象を打つ人の斷りの檢査（SPEC §7・第 535 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 件(rows: Row[], 文: string): number {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).length;
}

/** 細目の主題の群に立てた打ち方（實測で 0 件・無言だつた語 – 數字は SPEC §8）。 */
const 細目 = [
  "GPU",
  "CUDA",
  "Kubernetes",
  "OpenMP",
  "PGAS",
  "サーバーレス",
  "連合学習",
  "分散台帳",
  "暗号通貨",
  "省電力",
  "サステナビリティ",
  "ウェブ技術",
  "オントロジー",
  "産学セッション",
  "学生向け",
  "博士課程",
];
/** 群に混ぜん語（名簿の語・他の檢査が引き取る語 – 第 294 回・第 534 回の実測）。 */
const 彈いた = ["MPI", "ACL", "CTF", "推薦システム", "ハッキングコンテスト"];

describe("細目の主題と募集対象の斷り", () => {
  it("默らずに、この表が持つ物を敎うる", () => {
    細目.forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      /* 噓の案内を立たん – 分野・種別・開催地・参加形式は実際にこの表の欄の名前。 */
      ["分野", "種別", "開催地", "参加形式"].forEach((欄) => {
        expect(
          案内.includes(欄) || 案内.includes("公式ページ"),
          `"${語}" の案内に欄の名前が無い`,
        ).toBe(true);
      });
    });
  });

  it("寄せはして居らん（0 件の侭 – 正直な 0 件）", () => {
    const rows = 品書();
    ["GPU", "CUDA", "Kubernetes", "OpenMP", "連合学習"].forEach((語) => {
      expect(件(rows, 語), `"${語}" が行を持つやうに廣がつた`).toBe(0);
    });
  });

  it("語が頭に續く打ち方（`科研費の申請` `証明書の発行`）も斷りを受け取る（第 538 回）", () => {
    /* 印（`anyTail`）を付けた群は、語の後ろに何が續いても受ける。其の方で行が出る打ち方には
     * 畫面上には立たないので噓にはならん（第 337 回）。實測で 0 件だつた打ち方を並べる。 */
    const rows = 品書();
    [
      ["領収書 が欲しい", "領収書"],
      ["特許 の出願", "特許"],
      ["科研費の申請", "科研費"],
      ["証明書の発行", "証明書"],
      ["学生向け の枠", "学生向け"],
      ["産学連携の会議", "産学連携"],
      ["出展要項", "出展"],
    ].forEach(([文, 名指し]) => {
      expect(件(rows, 文), `"${文}" は其の方で行が出る（斷つたら噓）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(文);
      expect(案内.includes(`「${名指し}」`), `"${文}" が "${名指し}" を名指さん`).toBe(true);
    });
  });

  it("弹いた語と空白を含む語を、群の一覽に混ぜん", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('        "GPU",');
    expect(i).toBeGreaterThan(0);
    const 群 = b.slice(i, b.indexOf('note: "はこの表の行に書かれて居らん', i));
    彈いた.forEach((語) => {
      expect(群.includes(`"${語}"`), `"${語}" を群に混ぜた（彈いた理由が崩れる）`).toBe(false);
    });
    /* 空白を含む語は網址の中に當たる（第 534 回の実測）。 */
    [...群.matchAll(/"([^"\n]+)"/g)].forEach((m) => {
      expect(/\s/.test(m[1]), `空白を含む語 "${m[1]}" を入れた`).toBe(false);
    });
  });

  it("運営・手続きと学会の出版物を訪ねる人も、默らずに受け取る（第 536 回）", () => {
    const rows = 品書();
    [
      "特集セッション",
      "企業展示",
      "出展",
      "ポスターサイズ",
      "遅延申請",
      "録画配信",
      "領収書",
      "謝金",
      "当日参加",
      "直前",
      "キャンセル",
      "学会誌",
      "速報誌",
      "紀要",
      // 第 537 回 – 運営・手續きと細目の別の言い方（實測で 0 件・無言だつた語）。
      "科研費",
      "出願",
      "特許",
      "客員研究員",
      "単位互換",
      "滞在費",
      "発表料",
      "原稿料",
      "論文費",
      "ページチャージ",
      "印刷費",
      "遅延登録",
      "延長登録",
      "再登録",
      "証明書",
      "参加証明",
      "出席証明",
      "発表証明",
      "最終告知",
      "校了",
      "組版",
      "産学連携",
      "共同研究",
      "技術移転",
      "研究発表",
      "成果発表",
    ].forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      /* 斷りは実際に 0 件の語にだけ立つ – 行を持つ語に「出て居ません」と言わん（第 337 回）。 */
      expect(件(rows, 語), `"${語}" は行を持つので彈くべき語だつた`).toBe(0);
    });
  });

  it("行を持つ語を学会誌の群に混ぜん（實測で行を持つ語 – 5 件・1 件・6 件・5 件・2 件・1 件）", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('      words: ["学会誌"');
    expect(i).toBeGreaterThan(0);
    const 群 = b.slice(i, b.indexOf("live:", i));
    [
      "論文誌",
      "ジャーナル",
      "ポスターセッション",
      "チュートリアル",
      "プロシーディングス",
      "学生セッション",
    ].forEach((語) => {
      expect(群.includes(`"${語}"`), `"${語}" を混ぜた（行を持つ – 噓の斷りになる）`).toBe(false);
    });
  });

  it("案内は「持って居らん」と言う所を數へて居る（無い欄の名前を在るかやうに書かん）", () => {
    expect(Recommender.uiWordNoteJa("学生向け")).toContain("公式ページ");
    /* この表に費用の欄は無い – 旅費を訪ねる人を在る欄に誤導せん。 */
    expect(Recommender.uiWordNoteJa("学生向け")).not.toContain("参加費の欄");
  });
});
