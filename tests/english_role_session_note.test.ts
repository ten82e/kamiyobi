/** 役・發表の形・料金の名を**英語や外来語で**打つ人の讓りの檢査（SPEC §7・第 669 回）。
 *
 * 實測（2026-08-09 生成の実ビルド・品書 3,250 行）で、和名は羣の斷りを受けるのに、同じ意味の
 * 英語の打ち手だけ搜 0 行・讓り無し・打ち替え無しで面の三つが皆默つて居た語を並べる
 *（`基調講演` は通る・`keynote` は默る – `座長` と `session chair` も同じ）。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（3,250 行）で張る – fixtures の小さな品書だと金庫の數が別物になる為。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8")),
  ) as Row[];
}
const rows = 品書();
function 當(文: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return rows.filter((r) => m(String(r.hay)) === true).length;
}
/** 畫麵と同じ順で讓りを再現する（site/app.ts – 欄の名前 → 語の斷り → 日の幅 → 寄せ表 → 助詞）。 */
function 讓り(文: string): string {
  return String(
    Recommender.columnQueryNoteJa(文, (語) => 當(語) > 0) ||
      Recommender.uiWordNoteJa(文, false) ||
      Recommender.dayRangeNoteJa(文) ||
      Recommender.wholeTableQueryNoteJa(文) ||
      Recommender.conjunctionQueryNoteJa(文, 當) ||
      "",
  ).trim();
}

/** 此の回に羣へ载せた英語・外来語の打ち手（實測 搜 0 行・讓り無しだつた語）。 */
const 役 = [
  "ゲストエディタ",
  "領域エディタ",
  "編集長",
  "査読者割り当て",
  "guest editor",
  "area editor",
  "session chair",
  "program chair",
  "general chair",
  "proceedings chair",
  "editor in chief",
  "reviewer assignment",
  "PC member",
];
const 發表 = [
  "keynote",
  "invited talk",
  "plenary",
  "プレナリー",
  "oral presentation",
  "poster session",
  "tutorial session",
];
const 料金 = ["page charge"];
/* 細目の羣は空格入りの語を載せん（网址に當たる – 第 534 回）で、和名だけ張る。*/
const 細目 = ["発表番号"];

/** 同じ羣の和名（既に斷りを持つて居た打ち手）と英語の打ち手の組。 */
const 日英の對 = [
  ["基調講演", "keynote", "區別"],
  ["口頭発表", "oral presentation", "區別"],
  ["招待講演", "invited talk", "區別"],
  ["口頭", "oral presentation", "區別"],
  ["座長", "session chair", "役"],
  ["オーガナイザ", "program chair", "役"],
  ["登壇", "guest editor", "役"],
  ["掲載料", "page charge", "費用"],
  ["参加費", "page charge", "費用"],
  ["研究発表", "発表番号", "細目"],
] as const;

describe("英語で打たれる役・發表の形・料金名", () => {
  it("載せた語は搜 0 行の侬で斷りを受ける（噓の案内を立たん – 第 337 回）", () => {
    for (const 語 of [...役, ...發表, ...料金, ...細目]) {
      expect(當(語), `"${語}" が行を持つやうに廣がつた`).toBe(0);
      expect(讓り(語).length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
    }
  });

  it("和名と同じ斷りの後ろを受け取る（言葉の違いで行が割れん – 第 669 回）", () => {
    for (const [和, 英, 語彙] of 日英の對) {
      const a = 讓り(和);
      const b = 讓り(英);
      expect(a.length, `和名 "${和}" が默つて居る`).toBeGreaterThan(0);
      expect(b.length, `英語 "${英}" が默つて居る`).toBeGreaterThan(0);
      /* 斷りは打ち手を先頭に復唱する（echo）で、其の後ろは同じ羣の文 – 復唱の後を較べる。*/
      const 後 = (文: string) => 文.slice(文.indexOf("」") + 1);
      expect(後(b), `"${和}" と "${英}" の斷りが別の羣`).toBe(後(a));
      const 印 = { 區別: "区別", 役: "役", 費用: "持っていません", 細目: "細目の主題" }[
        語彙
      ] as string;
      expect(b, `"${英}" の斷りに「${印}」が無い`).toContain(印);
    }
  });

  it("寄せた語は搜の土臺を廣げん – 収録の『延長』に行くのは伸びた締切だけ（第 669 回）", () => {
    /* `extension` を打つ人は『延長』と書かれた行を求めて居る（収録は延伸した締切に『延長』と
     * 書く – 第 388 回）。寄せは搜 0 行の打ち手だけ廣げる仕組みだが、實數で張る。*/
    expect(當("extension")).toBe(當("延長"));
    expect(當("extension")).toBeGreaterThan(0);
    /* 讓りは其の方で行が出るので立たん（0 件の人にだけ喋る – 第 332 回）。*/
    expect(讓り("extension")).toBe("");
    /* 他の語と繋いだ時は交はりの分だけ減る（AND なので廣げ過ぎの證左にはならん – 0 行の侬）。*/
    expect(當("extension reviewer")).toBeLessThanOrEqual(當("extension"));
  });

  it("搜の当たり數は此の回、一つも減つて居らん（實測の金庫 – 第 669 回）", () => {
    /* 羣の語を增す直しは讓りOnlyだが、寄せ表に一行足したので搜の側も振ふ。
     * 值は第 668 回の実ビルドで測った金庫（減があつたら此處で落ちる）。*/
    const 金庫: Record<string, number> = {
      延長: 36,
      締切延長: 36,
      来年の延長: 8,
      学会: 14,
      人工知能: 1072,
      査読: 32,
      クラウド: 982,
      チュートリアル: 6,
      招待講演: 0,
      招待: 0,
      口頭: 0,
      座長: 0,
      研究発表: 0,
      ポスター賞: 0,
      掲載料: 0,
      参加費: 0,
      HPCまで: 0,
      来月まで: 330,
      "8月": 600,
      締切: 2886,
    };
    for (const [文, 數] of Object.entries(金庫)) {
      expect(當(文), `搜の当たり數が變た: ${文}`).toBe(數);
    }
  });

  it("品書は 3,250 行 – 搜の土臺を壞して居ん", () => {
    expect(rows.length).toBe(3250);
  });
});
