import { queryReferenceSnapshotPath } from "./query_reference.ts";
/**
 * 日をまたぐ重なりを數へる打ち方と、費用・査読の形・後から觀る形の別の名前（第 648 回）。
 * 實測（2026-08-09 生成の品書 3,250 行・固定時刻 2026-08-09T00:00:00Z）–
 *  · **日をまたぐ聽き方**は十語すべて 0 行で**案内も無し**（`同じ日` `同日` `同じ週` `同じ月`
 *    `同時期` `重なる` `重複` `被る` `競合` `衝突` `比較`）。文で打たれると同じ（
 *    `同じ日に締切が来る` `同じ週に重なる締切`）。
 *  · **費用**の羣に當たらん名前（`オーバースページ` `過剰ページ` `ページ超過` `謝礼` …）が默り、
 *  · **査読の形**（`匿名査読` `二段階審査` `プログラム委員` …）、
 *  · **後から觀る形**（`録画視聴` `アーカイブ公開` `期間限定公開`）も默つた。
 * 此處では
 *  ① 新しい語が**一つも收錄に行を持たん**事（噓の門 – 第 337 回）、
 *  ② 其れらが各羣の斷りを受ける事（文で打たれた形も含む）、
 *  ③ 祝日・休日の羣が**先に勝つ**事（`祝日と重なる締切` は祝日の方が正しい – 第 511 回）、
 *  ④ 空格で並べた打ち手にも開く事（第 354 回）、
 *  ⑤ 磁石の行數が舊來の侬である事
 * を張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

/* 新し語の一覽 – 羣の語表から讀み出す（寫すと二處出來てズレる – 第 392 回）。*/
const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
const 塊 = (印: string): string[] => {
  const i = 源.indexOf(印);
  const 先 = 源.lastIndexOf("words: [", i);
  const 後 = 源.indexOf("]", i);
  return 源
    .slice(先, 後)
    .split("\n")
    .map((行) => (行.match(/^\s*"([^"]+)",$/) || [])[1] || "")
    .filter((語) => 語);
};
const 重なりの語 = 塊("並べて比べる");
const 費用の新語 = 塊('"謝礼"').filter((語) => /ページ|謝礼|負担|会員/.test(語));
const 査読の新語 = 塊('"採点基準"').filter((語) => /査読|審査|委員|項目|基準/.test(語));
const 記録の新語 = 塊('"ポスター印刷"').filter((語) =>
  /録画|アーカイブ|期間限定|技術報告|印刷/.test(語),
);

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): number {
  const match = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, AT), AT);
  return rows.filter((r) => match(String(r.hay)) === true).length;
}

function 斷り(文: string): string {
  return String(Recommender.uiWordNoteJa(文, false) || "").trim();
}

describe("日をまたぐ重なりと、費用・査読・視聴の別の名前（第 648 回）", () => {
  it("語表が讀めて居る（源の書き變へに檢査が氣付くやうに）", () => {
    expect(重なり語().length).toBeGreaterThanOrEqual(15);
    expect(費用の新語.length).toBeGreaterThanOrEqual(6);
    expect(査読の新語.length).toBeGreaterThanOrEqual(6);
    expect(記録の新語.length).toBeGreaterThanOrEqual(4);
  });

  it("新しい語は一つも收錄に行を持たん（噓の門 – 第 337 回）", () => {
    const rows = 收錄();
    for (const 語 of [...重なり語(), ...費用の新語, ...査読の新語, ...記録の新語]) {
      expect(当たり(rows, 語), `"${語}" に行が出るやうになつた（羣の斷りが噓になつた）`).toBe(0);
    }
  });

  it("日をまたぐ聽き方が斷りを受ける（語だけ・文で打たれた形・空格で並べた形）", () => {
    const 打ち手 = [
      "同じ日",
      "同日",
      "同じ週",
      "同じ月",
      "同時期",
      "重なる",
      "重複",
      "被る",
      "競合",
      "衝突",
      "比較",
      "同じ日に締切が来る",
      "同じ週に重なる締切",
      "締切が被る",
      "二つを比べる",
      "同じ日 締切",
      "重複 査読",
    ];
    for (const 文 of 打ち手) {
      const 答 = 斷り(文);
      expect(答, `「${文}」が默つた`).not.toBe("");
      expect(答, `「${文}」の答えが日をまたぐ話をして居ない`).toContain("日");
    }
    /* 同じ日に重なる事が無いとは言はない – 數へられないと言ふ（收錄の欄の話を變へん – 第 420 回）。*/
    expect(斷り("同じ日")).toContain("範囲");
    expect(斷り("同じ日")).not.toContain("在りません");
  });

  it("祝日・休日の羣が先に勝つ（同じ日に重なる話より祝日の話が正しい – 第 511 回）", () => {
    expect(斷り("祝日と重なる締切")).toContain("祝日");
    expect(斷り("祝日と重なる締切")).not.toContain("日の順に並びます");
    expect(斷り("三連休の締切")).toContain("祝日");
  });

  it("費用・査読・視聴の別の名前が各羣の斷りを受ける", () => {
    for (const 語 of 費用の新語) {
      const 答 = 斷り(語);
      expect(答, `費用の「${語}」が默つた`).not.toBe("");
      expect(答, `費用の「${語}」が費用の話をして居ん`).toMatch(/費用|公式ページ/);
    }
    for (const 語 of 査読の新語) {
      const 答 = 斷り(語);
      expect(答, `査読の「${語}」が默つた`).not.toBe("");
      expect(答, `査読の「${語}」が審査の話をして居ん`).toMatch(/審査|査読/);
    }
    for (const 語 of 記録の新語) {
      const 答 = 斷り(語);
      expect(答, `視聴の「${語}」が默つた`).not.toBe("");
      expect(答, `視聴の「${語}」が公式ページの話をして居ん`).toContain("公式ページ");
    }
    /* 語の後に語が続く形 – 敬語・助詞で閉じる物は開く（第 344 回の語尾の門）。*/
    expect(斷り("謝礼はいくら")).toContain("収録");
    expect(斷り("匿名査読です")).toContain("審査");
    expect(斷り("録画視聴できますか")).toContain("公式ページ");
    expect(斷り("期間限定公開はいつまで")).toContain("公式ページ");
    expect(斷り("プログラム委員の構成が知りたい")).toContain("区別");
    /* 明かない穴を此處に張る – 「料金はいつ決まる」のやうに**別の語が續く**形は語尾の門が
     * 彈く（費用の羣は anyTail を開いて居らん – 磁石の決まり – 第 337 回）。開くのは次の回の話。*/
    expect(斷り("ページ超過はいくらか")).toBe("");
  });

  it("磁石は狹まつて居らん – 通つて居る打ち手の行數は舊來の侬", () => {
    const rows = 收錄();
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
      ["概要締切", 660],
      ["採否通知", 240],
      ["カメラレディ", 147],
      ["延長", 36],
      ["学生割引", 0],
    ] as Array<[string, number]>) {
      expect(当たり(rows, 語), `"${語}" の行數が變はつた`).toBe(見當);
    }
  });

  it("讀み上げも同じ判斷を出す（六十字に納まる – 第 392 回）", () => {
    const 聲 = String(Recommender.uiWordLiveNoteJa("同じ日に締切が来る", false) || "").trim();
    expect(聲, "讀み上げが默つた").not.toBe("");
    expect(聲.length, `讀み上げが長すぎる（${聲.length} 字）`).toBeLessThanOrEqual(60);
  });
});

/* 源から讀んだ語を整へる（羣の語表の寫しを檢査側に置かん – 第 392 回）。*/
function 重なり語(): string[] {
  return 重なりの語;
}
