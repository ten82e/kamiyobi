import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

function 当たり列表(訪ね: string): string[] {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄()
    .filter((行) => 目(String(行.hay)) === true)
    .map((行) => String(行.hay));
}
const 当たり = (訪ね: string): number => 当たり列表(訪ね).length;

/** 家の源から二つの表を読む – 载せる語を変へても検査がその後を追ふ為。*/
function 二つの表(): { 頭: string[]; 語尾: string[] } {
  const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
  const i = 源.indexOf("function 締切の語尾に割るJa");
  expect(i).toBeGreaterThan(0);
  const 域 = 源.slice(i, 源.indexOf("\n  }", i));
  const 語尾 = /const 語尾一覧 = "([^"]+)"/.exec(域)?.[1];
  const 頭 = /const 頭一覧 = new Set\(\s*\[([\s\S]*?)\]/.exec(域)?.[1];
  expect(語尾, "語尾一覧の文字列が読められん").toBeTruthy();
  expect(頭, "頭一覧が読められん").toBeTruthy();
  return {
    頭: [...String(頭).matchAll(/"([^"\n]+)"/g)].map((m) => m[1]),
    語尾: String(語尾).split("|"),
  };
}

describe("繋げた手続きの語を割る検索", () => {
  it("繋いだ打ち手が空格で打った人と同じ行に屆く", () => {
    const 載せる與: Array<[string, string]> = [
      ["クラウド締切", "クラウド 締切"],
      ["クラウド〆切", "クラウド 締切"],
      ["組み込み投稿", "組み込み 投稿"],
      ["シンポジウム提出", "シンポジウム 提出"],
      ["スパコン投稿", "スパコン 投稿"],
      ["年次締切", "年次 締切"],
      ["AI登録", "AI 登録"],
      ["ネットワークdeadline", "ネットワーク deadline"],
      ["分散日程", "分散 日程"],
      ["抄録deadline", "抄録 deadline"],
      ["ワークショップdeadline", "ワークショップ deadline"],
      ["ロボティクス締切", "ロボティクス 締切"],
      ["特集号締切", "特集号 締切"],
      ["最終原稿締切", "最終原稿 締切"],
      ["最終稿deadline", "最終稿 deadline"],
      ["学生発表締切", "学生発表 締切"],
      ["発表締切", "発表 締切"],
      ["通知締切", "通知 締切"],
      ["情報理論提出", "情報理論 提出"],
      ["高性能計算提出", "高性能計算 提出"],
      ["研究会abstract", "研究会 abstract"],
    ];
    for (const [續ぎ, 空格] of 載せる與) {
      expect(当たり(續ぎ), `繋げた ${續ぎ} が 0 行の侬`).toBeGreaterThan(0);
      expect([...当たり列表(續ぎ)].sort().join("\n"), `${續ぎ} が ${空格} と違う行に當たつた`).toBe(
        [...当たり列表(空格)].sort().join("\n"),
      );
    }
    expect(当たり("クラウド締切"), "事実 892 行").toBe(892);
    /* 第 677 回に增やした頭の実測 – 繋いで打つ人が 0 行で黙つていた所（品書 3,250 行）。*/
    expect(当たり("特集号締切"), "事実 17 行").toBe(17);
    expect(当たり("最終原稿締切"), "事実 147 行").toBe(147);
    expect(当たり("発表締切"), "事実 13 行").toBe(13);
    expect(当たり("情報理論締切"), "事実 9 行").toBe(9);
    expect(当たり("組み込み投稿"), "事実 602 行").toBe(602);
  });

  it("載せている頭 × 語尾 – 空格で当たるのに續ぐと 0 件、が残らん（家の契約）", () => {
    const { 頭, 語尾 } = 二つの表();
    expect(頭.length, "頭の一覽が読められん").toBeGreaterThan(20);
    expect(語尾.length, "語尾の一覽が読められん").toBeGreaterThan(5);
    let 效く = 0;
    const 行き着かん: string[] = [];
    for (const a of 頭)
      for (const b of 語尾) {
        const 續ぎ = 当たり(a + b);
        const 空格 = 当たり(`${a} ${b}`);
        /* 續いだ形の方が多く当たる形はある（原文に `ポスター投稿` の語が其侭出ている – 実測 4 ≠ 2 行）
         * ので同じ数を張らん。張るのは逆の壁 – 離せば当たるのに續いだら 0 件と黙る事。*/
        if (空格 > 0 && 續ぎ === 0) 行き着かん.push(`${a}${b}(空格 ${空格}・續ぎ 0)`);
        if (續ぎ > 0) 效く++;
      }
    expect(效く, "割つて当たる續ぎ方が無かん").toBeGreaterThan(60);
    expect(
      行き着かん,
      `行き着かん續ぎ方 ${行き着かん.length} 本: ${行き着かん.slice(0, 8).join(" / ")}`,
    ).toEqual([]);
  });

  it("彈いた語を頭と語尾に混ぜて居ない（検査が教へた壁）", () => {
    const { 頭, 語尾 } = 二つの表();
    /* 寄せ表に載る語・別宅のある語は頭に混ぜられん。*/
    for (const 語 of ["可視化", "組込み", "分散システム", "システム", "期限", "応募", "募集"])
      expect(頭, `頭に彈いた語が混つた: ${語}`).not.toContain(語);
    /* 品書に行の無い語尾・打ち手に空格を含む語は尾に立てん（`論文` は寄せに乘つてしまう）。*/
    for (const 語 of ["期限", "応募", "募集", "締め切り", "論文", "camera ready"])
      expect(語尾, `語尾に彈いた語が混つた: ${語}`).not.toContain(語);
    /* 語尾の表を配列で書くと `日程",` が出來て、案内の条目を数へる検査が二度に数へる。*/
    const 成果物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(
      成果物.split('"日程",').length - 1,
      '成果物で「"日程",」が二度出た（語尾の表を配列に書き直した）',
    ).toBe(1);
  });

  it("增へて居らん處は增へていない（別宅と案内の形を崩さん）", () => {
    for (const [訪ね, 當] of [
      ["オンライン提出", 0] /* 別宅が 0 行の斷りを正しく案内する*/,
      ["分散計算締切", 0] /* 頭の語が一覽に無いので割らん*/,
      ["論文締切", 2004] /* 寄せ表が先に受ける – 割つても減らん*/,
      ["延長締切", 35] /* `延長` の名乗りは其侭*/,
      ["学生論文", 0] /* 尾に `論文` を立てんので割れん – 打ち替えの家が導く*/,
      ["セミナー締切", 0] /* 検索が落とさん語（空格でも 0 行）は載せん – 讓りが導く*/,
      [
        "情報理論締切",
        9,
      ] /* 第 677 回に載せ直した – 旧 0 行で**讓りも無言**だつた（空格 9 行 – 「讓つた所」の家は無く、黙るだけだつた）*/,
      [
        "採否通知deadline",
        240,
      ] /* 割る検索しでは拔いたが、第 678 回で**種の寄せ**が受けた（旧 0 行・讓りも無言 → 種別『採否通知』 240 行）。ここで割ると 0 行の侬（空格 3 行）なので頭のまゝには出來ん*/,
      [
        "結果締切",
        32,
      ] /* 同上 – 種の寄せ（種別『査読結果公開』 32 行）。単語 `結果` と同じ行に出る*/,
      [
        "参加登録締切",
        22,
      ] /* 同上 – 種の寄せ（種別『登録締切』 22 行 ⇔ 単語 `参加登録` は 66 行 – 別の家）*/,
      ["参加登録abstract", 0] /* 同上（空格 42 行 – 別の規則が `参加 ∧ 登録` に割る家）*/,
      [
        "参加締切",
        22,
      ] /* 頭としては彈いた侬は其侭（`参加登録` 66 行 ⇔ 空格 0 行 – 割れば減る ✗）。第 678 回で種の寄せが別路径で受け直した（種別『登録締切』 22 行）*/,
      ["原稿締切", 3] /* 彈いた頭 `原稿` – 繋いだ形の方が広いので割らん – 讓りも無く 3 行の侬*/,
      ["査読締切", 0] /* 羣の案内が受ける家– 検索は 0 行の侬を張る */,
      ["結果締切締切", 0] /* 同じ語を重ねた打ち手は寄せを經ん 0 行（種の寄せは単一の鍵 – 検査） */,
      ["原稿提出", 2004] /* 彈いた頭 – 繋いだ形の方が広い（空格 3 行）ので割らん */,
      ["ワークショップ camera ready", 20] /* 空格で打つ人は元から屆く – 割らん方の家*/,
      ["クラウド", 982],
      ["登録", 22],
    ] as Array<[string, number]>) {
      expect(当たり(訪ね), `搜の當たりを變へた: ${訪ね}`).toBe(當);
    }
    expect(收錄().length, "品書の行数").toBe(3250);
  });
});
