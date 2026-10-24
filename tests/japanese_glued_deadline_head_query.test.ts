import fs from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(fs.readFileSync(queryReferenceSnapshotPath(), "utf8")) as never,
) as unknown as Array<{ hay: string }>;
const 畳 = (x: unknown) => String(x).normalize("NFKC").toLowerCase();
function 當る(q: string): string[] {
  const matcher = Recommender.searchMatcher(Recommender.expandRelativeMonths(q, AT), AT);
  return 品書.filter((r) => matcher(String(r.hay)) === true).map((r) => 畳(r.hay));
}
const 當 = (q: string) => 當る(q).length;
for (let i = 0; i < 170; i += 1) 當("クラウド締切"); // 初回の遅さを引くので暖める
/* 讓り – 画面が実際に並べる案内を揃へて読む（一つでも缺けると「無言」に偽りが出る）。*/
function 讓(q: string): string {
  /* 二つの案内は寄こす関数の形が違ふ – 欄の案内は「当たるか」（眞假）、重ね語の案内は「件数」。*/
  const 當有 = (x: string): boolean => 當る(x).length > 0;
  const 當數 = (x: string): number => 當る(x).length;
  return [
    Recommender.columnQueryNoteJa(q, 當有),
    Recommender.uiWordNoteJa(q, false),
    Recommender.dayRangeNoteJa(q),
    Recommender.wholeTableQueryNoteJa(q),
    ...((Recommender.relativeDayNotes(q, AT) || []) as string[]),
    ...(Recommender.querySynonymNotes(q) || []),
    Recommender.conjunctionQueryNoteJa(q, 當數),
  ]
    .filter(Boolean)
    .join(" ∥ ")
    .trim();
}
const 源 = fs.readFileSync("site/recommender.ts", "utf8");
const 塊 = (() => {
  const i = 源.indexOf("function 締切の語尾に割るJa");
  return 源.slice(i, 源.indexOf("\n  }", i));
})();
const 頭 = [
  ...String(/const 頭一覧 = new Set\(\s*\[([\s\S]*?)\]/.exec(塊)?.[1]).matchAll(/"([^"\n]+)"/g),
].map((m) => m[1]);

describe("催し物の名と締切を繋いだ打ち方（第 677 回）", () => {
  it("增やした八語が繋いだまま屆き、空格を打つ人と同じ行に出る", () => {
    const 與: Array<[string, string, string, number]> = [
      ["特集号締切", "特集号 締切", "特集号", 17],
      ["特集号〆切", "特集号 締切", "特集号", 17],
      ["特集号deadline", "特集号 deadline", "特集号", 3],
      ["最終原稿締切", "最終原稿 締切", "最終原稿", 147],
      ["最終稿締切", "最終稿 締切", "最終稿", 147],
      ["学生発表締切", "学生発表 締切", "学生発表", 4],
      ["発表締切", "発表 締切", "発表", 13],
      ["通知締切", "通知 締切", "通知", 4],
      ["情報理論締切", "情報理論 締切", "情報理論", 9],
      ["高性能計算提出", "高性能計算 提出", "高性能計算", 130],
    ];
    for (const [續, 空, 和名, 數] of 與) {
      expect(當(續), `繋いだ ${續} が 0 行の侬`).toBe(數);
      expect(當(空), `空格の ${空} が動いた`).toBe(數);
      // 增えた行が噓で無い證 – 空格の打ち手（既に契約の通つた經路）と**同じ行**に出る事。
      // 頭の組の語列その物で行を絞らん（`情報理論` の寄せは語ごとに当てる – 第 675 回 – なので、
      // その方で「頭の語が無いか」を見ると当たりを彈み誤る）。
      const 列 = (a: string[]) => [...new Set(a)].sort().join("\n");
      expect(列(當る(續)), `${續} が ${空} と違う行に當たつた`).toBe(列(當る(空)));
      expect(畳(續).includes(畳(和名)), `${和名} が繋がれた語に含まん`).toBe(true);
    }
  });

  it("行き止まり（検索 0 行・讓りも無言）が減つた実測を張る", () => {
    const 羣 = [
      "特集号締切",
      "特集号〆切",
      "特集号deadline",
      "最終原稿締切",
      "最終原稿deadline",
      "最終稿締切",
      "学生発表締切",
      "発表締切",
      "通知締切",
      "情報理論締切",
      "高性能計算deadline",
      "高性能計算提出",
    ];
    for (const q of 羣) {
      expect(當(q), `${q} が 0 行に戻つた`).toBeGreaterThan(0);
    }
    /* まだ黙つている打ち手（次の宿題 – 讓りの家で導くべき物）。ここに並ぶ本数が減つたら検査が追ひ付く。*/
    const 默 = ["参加締切", "参加登録締切", "結果締切", "ソナー締切", "分散計算締切"].filter(
      (q) => 當(q) === 0 && !讓(q),
    );

    expect(默, `默りの内譯が變はつた: ${默.join(" ")}`).toEqual(["ソナー締切", "分散計算締切"]);

    expect(默).toContain("ソナー締切");
    expect(讓("セミナー締切"), "讓りの家が導いている語").toContain("絞りません");
  });

  it("彈いた頭の事実 – 割れば減る語・別の規則の受け先が要る語", () => {
    // 彈いた頭は一覧に混ぜられん（検査が教へた壁）。
    for (const 語 of ["参加", "原稿", "システム", "採否通知", "参加登録", "期限", "応募", "募集"])
      expect(頭, `彈いた頭が混つた: ${語}`).not.toContain(語);
    // `参加` を頭にすると `参加登録` が割れて 66 行 → 0 行に減る ✗
    expect(當("参加登録"), "`参加登録` の行が動いた").toBe(66);
    expect(當("参加 登録"), "空格の方は 0 行のまま（割れば減る證）").toBe(0);
    // `原稿` を頭にすると `原稿提出` が 2,004 行 → 3 行に減る ✗
    expect(當("原稿提出"), "`原稿提出` の行が動いた").toBe(2004);
    expect(當("原稿 提出"), "空格は 3 行 – 繋いだ人の方が広いので割らん").toBe(3);
    // ここで割ると種の寄せを経ん語は拔いた – 第 678 回から種の寄せの家が受ける（黙らん）。
    expect(當("採否通知deadline"), "種の寄せが受けていない").toBe(240);
    expect(讓("採否通知deadline"), "寄せた事を隱して並べた").toContain("種別「採否通知」");
    expect(當("参加登録abstract"), "まだ黙つている打ち手（宿題）").toBe(0);
  });

  it("〆切の書き方の契約は崩していない（第 344 回）", () => {
    // 裸の `締め切り` は『締切』へ寄せん – 表その物の語なので打ち直し方を言う。
    expect(當("締め切り"), "`締め切り` 単体に行が出た").toBe(0);
    expect(讓("締め切り"), "打ち直しを言う契約が消えた").toContain("絞り");
    expect(當("〆切"), "〆切 は 2,886 行の侬").toBe(2886);
    // 繋がれた形は別の規則が既に受ける – 語尾の表を擴げんでも屆く（載せん – 検査が彈く）。
    expect(當("特集号締め切り"), "空格無しの〆切の書き方が屆かん").toBe(17);
  });

  it("検索の振ひは無傷 – 単語と別の家の数字は今まで通り", () => {
    const 金型: Array<[string, number]> = [
      ["クラウド締切", 892],
      ["投稿締切", 2004],
      ["早期締切", 22],
      ["延長締切", 35],
      ["オンライン提出", 0],
      ["8月締切", 546],
      ["明日締切", 25],
      ["システム締切", 0],
      ["ワークショップ締切", 147],
      ["登録〆切", 22],
      ["カメラレディ締切", 147],
      ["機械学習", 504],
      ["IoT", 9],
      ["暗号", 117],
    ];
    for (const [q, n] of 金型) expect(當(q), `搜 ${q}`).toBe(n);
    expect(品書.length, "品書の行数その物が動いた").toBe(3250);
    expect(當("査読締切"), "讓りの家が受ける形は 0 行の侬").toBe(0);
    expect(讓("査読締切")).toContain("繋ぎ方");
  });
});
