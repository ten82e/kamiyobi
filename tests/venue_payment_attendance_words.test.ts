import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 収録(): Array<{ hay: string }> {
  const data = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")) as unknown as never;
  return Recommender.candidateRows(data) as unknown as Array<{ hay: string }>;
}

function 件數(語: string): number {
  const 當 = Recommender.searchMatcher(語, 基準);
  return 収録().filter((row) => 當(String(row.hay)) === true).length;
}

function 導き(文: string): string {
  return String(Recommender.uiWordNoteJa(文) || "");
}
function 讀み上げ(文: string): string {
  return String(Recommender.uiWordLiveNoteJa(文) || "");
}

/* 打ち方 → その羣の斷りが持つ言葉（噓にならん家を名指す – 第 388 回）。 */
const 九文: Array<[string, string]> = [
  ["車で行ける", "開催地"],
  ["宿の紹介がある", "開催地"],
  ["完全オンラインか", "オンライン参加可"],
  ["オンライン聴講", "オンライン参加可"],
  ["聴講だけできる", "オンライン参加可"],
  ["クレジット決済できる", "費用の欄はありません"],
  ["インボイス対応している", "費用の欄はありません"],
  ["録画を後で見る", "収録するのは締切日"],
  ["単位として認定される", "所属"],
];

describe("往き方・泊まり先・払ひ方・聽きに行く形の導き（第 617 回）", () => {
  it("黙つていた九文に、その羣の斷りがその場に出る", () => {
    for (const [文, 家の言葉] of 九文) {
      expect(件數(文), `絞り込まん: ${文}`).toBe(0);
      const 畫 = 導き(文);
      expect(畫, `導きが出る: ${文}`).not.toBe("");
      expect(畫, `斷りの家が打ち方に見合ふ: ${文}`).toContain(家の言葉);
      expect(畫, `打つた語を名指す: ${文}`).toContain(文.slice(0, 2));
      const 聲 = 讀み上げ(文);
      expect(聲, `読み上げも出る: ${文}`).not.toBe("");
      expect([...聲].length, `読み上げは 60 字以內: ${文}`).toBeLessThanOrEqual(60);
    }
  });

  it("载せた語は単体で 0 行（行が出る語を斷り先に载せぬ – 第 337 回）", () => {
    for (const 語 of [
      "車で",
      "車に",
      "宿の",
      "宿に",
      "車",
      "宿",
      "民宿",
      "旅館",
      "宿泊先",
      "交通アクセス",
      "電車",
      "最寄り駅",
      "マイカー",
      "完全オンライン",
      "オンライン聴講",
      "聴講だけ",
      "聴講",
      "決済",
      "クレジット決済",
      "クレジットカード",
      "銀行振込",
      "支払方法",
      "単位",
      "単位が立つ",
    ]) {
      expect(件數(語), `0 行で無い: ${語}`).toBe(0);
      expect(導き(語), `導きが出る: ${語}`).not.toBe("");
    }
  });

  it("その語で絞れる語は载せん（`オンライン参加` `交通` `アクセス` `採択` は行が出る – 第 337 回）", () => {
    for (const 語 of ["オンライン参加", "交通", "採択"]) {
      expect(件數(語), `行が出ると假定した語: ${語}`).toBeGreaterThan(0);
      expect(導き(語), `導きを被せん: ${語}`).toBe("");
    }
    /* `アクセス` は品書で 1 行通る（こちらの検査は収録で数へる為 0 行に見える）ので、
     * 羣の語に無い事を源で張る。*/
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    expect(源, "`アクセス` を羣に载せた").not.toContain('"アクセス",');
  });

  it("`ホテル` は旧來の門どほり羣に载せん（開催地に実在 – 第 516 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    expect(源, "`ホテル` を羣に载せた").not.toContain('"ホテル",');

    expect(導き("ホテル予約"), "`ホテル予約` の導きがない").toContain("泊まる所");
    expect(導き("ホテル手配"), "`ホテル手配` の導きがない").toContain("泊まる所");
    /* その外の形は費用の羣が受ける（旧來どほり）。*/
    expect(導き("ホテル代")).toContain("費用の欄はありません");
    expect(導き("宿代")).toContain("費用の欄はありません");
  });

  it("語の長い方が勝つ讓り（`聴講料` は費用・`単位互換` はその羣 – 第 505 回）", () => {
    expect(導き("聴講料はいくら")).toContain("費用の欄はありません");
    expect(導き("聴講費"), "聽講費は額の話").toContain("費用の欄はありません");
    expect(導き("単位互換")).not.toContain("所属の大学");
    expect(導き("宿泊費")).toContain("費用の欄はありません");
  });

  it("動詞で終る訪ねを受けん儘、広い助動詞は载せん（第 505 回の磁石）", () => {
    /* 载せたのは打ち方に現れる**句**だけ – 広い助動詞（「している」等）を载せると
     * その方の羣の語を乘取る。その門を源の表で張る。*/
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = 源.indexOf("const UI_WORD_TAILS_JA = [");
    const 尾 = 源.slice(i, 源.indexOf("];", i));
    for (const 句 of ["を後で見る", "対応している", "として認定される"]) {
      expect(尾, `載せた語尾が減つと導きが默る: ${句}`).toContain(`"${句}"`);
    }
    for (const 廣 of ["している", "られる", "もらう", "なる"]) {
      expect(尾, `廣すぎる語尾を足さん: ${廣}`).not.toContain(`"${廣}"`);
    }
  });

  it("検索の道は変はらん（羣の語と導きの語尾は行を作らん – 第 362 回）", () => {
    expect(件數("オンライン参加可")).toBe(109);
    expect(件數("査読")).toBe(32);
    expect(件數("採択")).toBe(240);
    expect(件數("車")).toBe(0);
    expect(件數("宿")).toBe(0);
  });
});
