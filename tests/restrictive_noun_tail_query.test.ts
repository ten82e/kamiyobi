import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
/** 品書は记忆力せて読む（ループ每に JSON を解析すると一検で数分かかる – 第 656 回の教へ）。*/
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
  }
  return 品書;
}

function 当たり(訪ね: string): number {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄().filter((行) => 目(String(行.hay)) === true).length;
}

/** 直し前の当たり – 一塊の語として品書の文本にそのままある行のみ（検索は打たれた語をそのまま探す）。*/
function 塊の当たり(訪ね: string): number {
  const 片 = 訪ね.toLowerCase();
  return 收錄().filter((行) => String(行.hay).toLowerCase().includes(片)).length;
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

/** 讓りの羣がその形で立つている語（検索が觸らん筈 – 讓しが応へる）。*/
const 讓りの形々 = [
  "学生向け",
  "学生限定",
  "大学院生向け",
  "若手限定",
  "女性限定",
  "男性限定",
  "機械向け",
];

const 語名々 = ["限定", "専用", "専門", "特化", "向け", "歓迎"];

describe("限定の語名を語に繋げた打ち方", () => {
  it("その方の語と同じ行に出会ふ – 繋げた語尾が何も絞らん所以て", () => {
    for (const [繋ぎ, 離し] of [
      ["ポスター限定", "ポスター"],
      ["研究会限定", "研究会"],
      ["チュートリアル限定", "チュートリアル"],
      ["ワークショップ限定", "ワークショップ"],
      ["セキュリティ特化", "セキュリティ"],
      ["査読専門", "査読"],
      ["論文投稿向け", "論文投稿"],
      ["機械学習向け", "機械学習"],
      ["AI専門の会議", "AI 会議"],
      ["チュートリアル限定の会議", "チュートリアル 会議"],
      ["ネットワーク向け", "ネットワーク"],
    ] as Array<[string, string]>) {
      expect(当たり(離し), `前提 – 其の方の語で行が出る: ${離し}`).toBeGreaterThan(0);
      expect(当たり(繋ぎ), `『${繋ぎ}』が默つた（${離し} は ${当たり(離し)} 行）`).toBe(
        当たり(離し),
      );
    }
  });

  it("讓りの形は検索が潰さん – 讓りが応へる語は讓りが屆く", () => {
    for (const 形 of 讓りの形々) {
      expect(当たり(形), `『${形}』を剥いて行を出した（讓りが屆かん）`).toBe(0);
      expect(讓り(形), `『${形}』で讓りが默つた`).not.toBe("");
    }
    /* 讓りの形を語の間に繋げた形も讓す – `学生限定の会議` を割ると『募集対象を持たん』の讓りが
     * 消えて了ふ（讓りは 0 件の時にしか画面に出ん為）。 */
    for (const 形 of ["学生限定の会議", "学生向けの研究会", "女性限定のセッション"]) {
      expect(讓り(形), `『${形}』の讓りが默つた`).not.toBe("");
      /* 割つた形で行が出る所まで進むと讓りが消える。讓しを無視させた壊し検査では
       * 『学生限定の会議』が 4 行に広がつた（実測）。 */
      expect(当たり(形), `『${形}』を其の方の語の行に廣げた`).toBe(0);
    }
  });

  it("讓すのは讓りがその形で立つ語だけ・假名の語は同じ行・一字になる形は剥がん", () => {
    for (const 語 of ["オンライン", "ハイブリッド", "バーチャル"]) {
      expect(当たり(`${語}限定`), `『${語}限定』を印の行に廣げた`).toBe(0);
      expect(讓り(`${語}限定`), `『${語}限定』の讓りが默つた`).not.toBe("");
      expect(当たり(`${語}専用`), `『${語}専用』が默つた`).toBe(当たり(語));
    }
    expect(当たり("対面専用"), `『対面専用』を印の行に広げた`).toBe(0);
    expect(讓り("対面専用"), `『対面専用』の讓りが黙つた`).not.toBe("");

    expect(当たり("しまね向け"), "假名の語を剥いだ先が別に行になった").toBe(当たり("しまね"));
    /* 剥いだ先が一字になる形 – その方の語が一文字なので同じ行に出る（広げ方的なので数だけを張る）。 */
    expect(当たり("AI専門"), "AI専門 がその方の語に寄らん").toBe(当たり("AI"));
  });

  it("当たりは減らん – 百の繋がれた形と、觸らん筈の基", () => {
    const 語々 = [
      "学生",
      "機械学習",
      "セキュリティ",
      "関西",
      "海外",
      "国内",
      "9月",
      "12月",
      "論文",
      "抄録",
      "ポスター",
      "査読",
      "研究会",
      "ネットワーク",
      "量子",
      "ccf",
      "チュートリアル",
      "ワークショップ",
      "オンライン",
      "日本語",
    ];
    let 增 = 0;
    for (const 語 of 語々) {
      for (const 語名 of 語名々) {
        for (const 後 of ["", " 会議", "の会議", " 締切"]) {
          const 形 = `${語}${語名}${後}`;
          /* 直し前 – 一塊を文本に持つ行のみ。それより減つたら検索が打ち手を落とした事になる。 */
          const 前 = 塊の当たり(形);
          const 今 = 当たり(形);
          expect(今, `『${形}』 ${前} → ${今} 行に減つた`).toBeGreaterThanOrEqual(前);
          if (今 > 0) 增 += 1;
        }
      }
    }
    expect(增, "百の形で一件も当たらん（寄せが動いていない）").toBeGreaterThan(60);
    /* 讓しの列と羣の表がズレて居ん事（羣に語を增やして讓しを增やさないと讓りが潰れる –
     * 第 659 回が決めた守り）。 */
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );
    const 羣の語々 = new Set([...上.matchAll(/"([^"\n]{2,})"/g)].map((m) => m[1]));
    const 下 = 物.slice(物.indexOf("const 讓りの形の限定Ja"));
    const 讓しの列 = [...下.slice(0, 下.indexOf("]);")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const 羣の限定語々 = [...羣の語々].filter((語) =>
      /(?:限定|専用|専門|特化|向け|歓迎)$/.test(語),
    );
    expect(讓しの列.slice().sort(), "検索の讓し列が羣の表とズレた").toEqual(
      羣の限定語々.slice().sort(),
    );
    /* 觸らん筈の基 – 第 657・658 回と幅の語尾。 */
    expect(当たり("機械学習"), "基の語を変へた").toBe(504);
    expect(当たり("ccf"), "英文字の寄せを変へた").toBe(2819);
    expect(当たり("論文の締切"), "《の》を繋いだ元の形を潰した").toBe(2004);
    expect(当たり("学生だけの会議"), "第 658 回の割る目を潰した").toBe(4);
    expect(当たり("オンラインのみ"), "第 657 回の讓す形を広げた").toBe(1);
    expect(当たり("12月31日まで"), "幅の語尾を潰した").toBe(1031);
    expect(当たり("来週までに"), "幅の語尾を潰した").toBe(206);
    expect(收錄().length, "品書の行数").toBe(3250);
  });

  it("剥ぐ目と割る目が検索の寄せに一個所ずつある", () => {
    /* 段を增やすと案内が黙るか噓を書く – 検索の寄せの一處だけがこの形を見る。 */
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(物.split("const 限定の語名の語尾Ja = ").length - 1, "限定の語名の表が複数に成つた").toBe(
      1,
    );
    expect(
      物.split('文.replace(限定の語名の語尾Ja, "")').length - 1,
      "剥ぐ番が検索の寄せに一個所ない",
    ).toBe(1);
    expect(物.split("))の(?=").length - 1, "割る目が複数に成つた").toBe(1);
  });
});
