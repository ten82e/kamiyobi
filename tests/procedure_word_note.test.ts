/**
 * 手続きと賞の名で訪ねる人が 0 件の侭默つて居た壁を（第 663 回）。
 *
 * 讓りの語の列に手続き・運営・賞の名が缺けて居た。實測（2026-08-09T00:00:00Z 生成の実ビルド・
 * 品書 3,250 行）で、研究者が打ちそうな言い方 79 本の內 22 本が当たり 0 件で導きも無し。そのうち
 * 十六本は**頭になる語がどの羣にも無い**為だつた（第 662 回は語尾側の缺けを直した – 語尾を増やしても
 * 頭の語が缺けて居れば通らんと言ふ事實が其處で殘つた）。
 *
 * 讓りは当たり 0 件の時にしか畫面に出ん（site/app.ts の `matchedRows === 0` の門）ので、载せた語が
 * 搜れる打ち手の取り分は減らん – 其れを此處で張る。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

function 当たり(訪ね: string): number {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄().filter((行) => 目(String(行.hay)) === true).length;
}

function 讓り(訪ね: string): string {
  return String(
    Recommender.columnQueryNoteJa(訪ね, (語) => 当たり(語) > 0) ||
      Recommender.uiWordNoteJa(訪ね, false) ||
      Recommender.dayRangeNoteJa(訪ね) ||
      Recommender.wholeTableQueryNoteJa(訪ね) ||
      "",
  ).trim();
}

/** 名指す語 → 住む羣（第 663 回で载せた二十六語）。*/
const 载せた語々: Array<[string, string]> = [
  ["取消し規約", "運営"],
  ["取消規約", "運営"],
  ["参加規約", "運営"],
  ["利用規約", "運営"],
  ["日程の変更", "運営"],
  ["繰上げ", "運営"],
  ["繰下げ", "運営"],
  ["エントリー", "運営"],
  ["口頭セッション", "運営"],
  ["発表集録", "運営"],
  ["学会集録", "運営"],
  ["記録", "運営"],
  ["転投", "投稿"],
  ["追加実験", "投稿"],
  ["リバットル", "投稿"],
  ["速報", "投稿"],
  ["論文特集", "投稿"],
  ["特集論文", "投稿"],
  ["投稿規程", "投稿"],
  ["校正", "投稿"],
  ["日本語で投稿", "投稿"],
  ["日本語投稿", "投稿"],
  ["和文投稿", "投稿"],
  ["授賞", "賞"],
  ["優秀賞", "賞"],
  ["若手優秀賞", "賞"],
];

/** 讓りの羣を源から讀む – 語が何處に载つたかを確かめる為。*/
function 羣の住み處(): Map<string, string> {
  const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
  const 上 = 物.slice(物.indexOf("const UI_WORD_GROUPS_JA"), 物.indexOf("const UI_WORD_TAILS_JA"));
  const 住 = new Map<string, string>();
  /* 羣の目印は其の羣に舊來從つて居る語（斷りの文は似通つて居て區別出来ん）。*/
  const 印: Array<[string, string]> = [
    ["科研費", "運営"],
    ["arXiv投稿", "投稿"],
    ["ベストペーパー", "賞"],
  ];
  for (const 羣 of 上.split("\n    {\n")) {
    let 名 = "他";
    for (const [語, 羣名] of 印) if (羣.includes(`"${語}",`)) 名 = 羣名;
    for (const m of 羣.matchAll(/^\s+"([^"\n]+)",$/gm)) {
      if (!住.has(m[1])) 住.set(m[1], 名);
    }
  }
  return 住;
}

describe("手続きと賞の名で訪ねる人", () => {
  it("载せた二十六語は 0 件で讓りが應へる（默りは零）", () => {
    const 變 = [];
    for (const [語] of 载せた語々) {
      const 當 = 当たり(語);
      if (當 !== 0) 變.push(`${語} = ${當} 行`);
      else if (!讓り(語)) 變.push(`${語} = 默り`);
    }
    expect(變, `變な內譯 ${變.length} 本: ${變.slice(0, 10).join(" ")}`).toEqual([]);
    /* 羣の住み處も張る（宛先を間違へると噓の案内になる – 第 484 回）。*/
    const 住 = 羣の住み處();
    for (const [語, 羣] of 载せた語々) expect(住.get(語), `『${語}』が想定外の羣に居る`).toBe(羣);
  });

  it("言ひ切らずに續けた打ち方が宛先に屆く", () => {
    for (const [訪ね, 名指す] of [
      ["日本語で投稿できる会議", "日本語で投稿"],
      ["和文投稿できる学会", "和文投稿"],
      ["取消し規約はどこ", "取消し規約"],
      ["若手優秀賞たいです", "若手優秀賞"],
      ["速報の締切", "速報"],
      ["記録の締切", "記録"],
    ] as Array<[string, string]>) {
      expect(当たり(訪ね), `${訪ね} は搜れる筈ではない`).toBe(0);
      expect(讓り(訪ね), `${訪ね} が名指す語`).toContain(`「${名指す}」`);
    }
    /* 搜れる側に居る語は讓りの羣に载せん（第 588 回）– 此處の四本は其侪搜へる。*/
    for (const [訪ね, 當] of [
      ["査読", 32],
      ["特集号", 17],
      ["受賞", 0],
      ["校了", 0],
    ] as Array<[string, number]>)
      expect(当たり(訪ね), `搜の當たりを變へた: ${訪ね}`).toBe(當);
  });

  it("搜れる打ち手は一通も動かん", () => {
    for (const [形, 當] of [
      ["機械学習", 504],
      ["ccf", 2819],
      ["オンライン", 109],
      ["オンラインのみ", 1],
      ["論文の締切", 2004],
      ["来週までに", 206],
      ["12月31日まで", 1031],
      ["学生だけの会議", 4],
      ["学生", 4],
      ["初心者向け", 0],
      ["ダブルブラインド査読", 0],
    ] as Array<[string, number]>) {
      expect(当たり(形), `搜の當たりを變へた: ${形}`).toBe(當);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
    /* 讓りの文が搜れる打ち手に乘つて噓になる形がゼロ（總當たり – 载せた語 × 續き方の形）。*/
    const 噓 = [];
    for (const [語] of 载せた語々) {
      for (const 續き of ["", "の締切", "できる会議", "が知りたい", "の一覧", "の書類"]) {
        const 訪ね = 語 + 續き;
        if (当たり(訪ね) > 0 && 讓り(訪ね).includes("持っていません")) 噓.push(訪ね);
      }
    }
    expect(
      噓,
      `搜れるのに「持っていません」を並べた形 ${噓.length} 本: ${噓.slice(0, 8).join(" ")}`,
    ).toEqual([]);
  });

  it("载せた語は一個所だけ・乘り變はりは語の長い方が勝つ（第 505 回）", () => {
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );
    const 全 = [...上.matchAll(/^\s+"([^"\n]+)",$/gm)].map((m) => m[1]);
    for (const [語] of 载せた語々)
      expect(
        全.filter((w) => w === 語).length,
        `『${語}』が重複して居る（同じ語を二つの羣に载せず – 第 512 回）`,
      ).toBe(1);
    /* 载せた語が前の羣の語より長いために宛先が変わつた形は、悉く長い方が當つて居る筈。*/
    for (const [訪ね, 名指す] of [
      ["日本語で投稿たいです", "日本語で投稿"],
      ["論文特集提案規約", "論文特集"],
      ["若手優秀賞の記録", "若手優秀賞"],
    ] as Array<[string, string]>)
      expect(讓り(訪ね), `${訪ね} は頭の長い方を名指す`).toContain(`「${名指す}」`);
  });
});
