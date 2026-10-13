import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

const 頭 = [
  "ポスター",
  "デモ",
  "チュートリアル",
  "ワークショップ",
  "セッション",
  "トラック",
  "パネル",
  "講演",
  "招待講演",
  "招待セッション",
  "特別セッション",
  "一般講演",
  "抄録",
  "アブストラクト",
  "論文",
  "短文",
  "レター",
  "査読",
  "報告",
  "記録",
  "特集号",
  "研究発表会",
  "シンポジウム",
  "研究会",
  "会議",
];

/* 収録が語として持たん段取りの名前だけ（`募集` `提出` `投稿` `締切` は行の原文に出る語 –
 * 下の「噓の門」の検査がそこを張る）。*/
const 尾 = [
  "期限",
  "応募",
  "募集要項",
  "案内",
  "要項",
  "提出物",
  "原稿",
  "作成",
  "準備",
  "執筆",
  "規格",
  "サイズ",
  "フォーマット",
  "テンプレート",
  "規約",
  "規定",
];

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((row) => match(String(row.hay)) === true).length;
}

function 案内(文: string): string {
  return String(Recommender.uiWordNoteJa(文, false) || "").trim();
}

describe("催し物の名に手続きを繋げた打ち方（第 646 回）", () => {
  it("頭の語 × 手続きの尾の組み合わせが黙らん", () => {
    const rows = 收錄();
    const 默り: string[] = [];
    let 数 = 0;
    for (const a of 頭) {
      for (const b of 尾) {
        const 文 = a + b;
        数 += 1;
        /* 画面は当たりが行与其它きの案内を立てん（site/app.ts の門 – 0 件の時だけ）。
         * 同じ理由で打ち替えがある時も讓すので、ここではそれをたてて数へる。*/
        if (当たり(rows, 文) === 0 && 案内(文) === "") 默り.push(文);
      }
    }
    expect(数, "組み合わせの總てが数えられていない").toBe(頭.length * 尾.length);
    expect(数).toBeGreaterThanOrEqual(400);
    expect(默り.slice(0, 10), `${默り.length} 通りが無言に逆戻りした`).toEqual([]);
  });

  it("噓の門を開けん – 段取りの尾を繋げた物は収録に行が出ん（第 337・358 回）", () => {
    const rows = 收錄();
    for (const a of 頭) {
      for (const b of 尾) {
        expect(当たり(rows, a + b), `「${a + b}」が行を出す語になった（斷りが噓になつた）`).toBe(0);
      }
    }
  });

  it("讓す決まり – 値を並べた人と二つ聞いた人を乘取らん", () => {
    const 手続きの文 = "この表は催し物ごとの手続き";
    /* 空格で値を並べた人（第 250・354 回）は「語ごとの件数」の家が答える。*/
    expect(案内("セッション 登録")).not.toContain(手続きの文);
    expect(案内("論文 執筆")).not.toContain(手続きの文);
    /* 「と・や」で二つ聞いた人は接続の家が答える（数へる側の情報が必要なので
     * 検査の組み立て品では黙る – 家の斷りだけを立てない事を張る）。*/
    expect(案内("論文投稿と登録")).not.toContain(手続きの文);
    expect(案内("セッションやトラック")).not.toContain(手続きの文);
    /* 助詞で繋がれた物も乘取らん（その方の形は羣の連体の門が受け取る – 第 513 回）。*/
    expect(案内("採否通知の時期")).not.toContain(手続きの文);
  });

  it("羣の答えが先に勝つ（組み立ての家が旧來の斷りを食はん）", () => {
    expect(案内("ポスターサイズ")).toContain("欄");
    expect(案内("抄録期限")).toContain("繋ぎ方");
    expect(案内("査読締切")).not.toBe("");
    expect(案内("チュートリアル応募")).toContain("繋ぎ方");
  });

  it("打ち直しとして名乘る種別の語が実物に行を持つ（噓の門 – 第 337 回）", () => {
    const rows = 收錄();
    const 文 = 案内("ポスター原稿");
    expect(文).not.toBe("");
    const 名 = [...文.matchAll(/『([^』]+?)』/g)].map((m) => m[1]);
    expect(名.length, "打ち直しの種別を一つも数えていない").toBeGreaterThanOrEqual(3);
    for (const 語 of 名) {
      expect(当たり(rows, 語), `打ち直しに數へた「${語}」に行が届かん`).toBeGreaterThan(0);
    }
  });

  it("読み上げも同じ判斷を出す（六十字に納まる – 第 392 回）", () => {
    const 文 = "デモ提出物";
    expect(案内(文)).not.toBe("");
    const 聲 = String(Recommender.uiWordLiveNoteJa(文, false) || "").trim();
    expect(聲, "読み上げが黙つた").not.toBe("");
    expect(聲.length, `讀み上げが長すぎる（${聲.length} 字）`).toBeLessThanOrEqual(60);
  });

  it("斷りの家は一處だけ（羣に寫すと読み上げとズレる – 第 392 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    /* 組み立ての目（頭の語・手続きの尾）と斷りの文が、それぞれ一處にしか在らん事。
     * 二處目に寫られたら、画面上の文と読み上げが別の事を言い出す。*/
    expect(源.split("\n    const 催し物の頭Ja =").length - 1, "頭の目が二處出來た").toBe(1);
    expect(源.split("\n    const 手続きの尾Ja =").length - 1, "尾の目が二處出來た").toBe(1);
    expect(源.split("この表は催し物ごとの手続き").length - 1, "斷りの文が二處書かれた").toBe(1);

    expect(案内("チュートリアルテンプレート")).not.toBe("");
  });
});
