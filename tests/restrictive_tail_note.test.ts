/**
 * 讓りの語尾の白一覧に限定の語名を载せた件 – 第 660 回。
 *
 * 搜の側は「語 + 限定/専用/専門/特化/向け/歓迎」を其の方の語に寄せる（第 659 回）が、**讓す形**
 * （讓りの羣が其の形で立つて居る語・參加形式の四語）は 0 行の侭默つて居た。讓りの門
 * （`uiWordTailOk`）が此の語尾を白一覧に持たなんだ為である。實測（2026-08-09T00:00:00Z 生成の
 * 実ビルド・品書 3,250 行）で、基の語に讓りが在る形 96 本の內 **78 本が完全に無言**（`対面専用`
 * `日本語限定` `聴講向け` `オンライン限定` …）。
 *
 * 讓りは当たり 0 件の時にしか畫面に出ん（app.ts の `matchedRows === 0` の門）ので、語尾を载せても
 * 搜れる打ち手の取り分は減らん – 其れを此の檢査が張る（搜の当たりは一通も動かん筈）。
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

const 語名々 = ["限定", "専用", "専門", "特化", "向け", "歓迎"];
/** 基の語に讓りが在る所（第 659 回で搜が讓す事决めた語も含む）。*/
const 基の語々 = [
  "オンライン",
  "ハイブリッド",
  "バーチャル",
  "対面",
  "オフライン",
  "オンサイト",
  "リアル",
  "日本語",
  "英語",
  "傍聴",
  "聴講",
  "参加費",
  "登録費",
  "費用",
  "旅費",
  "学生",
  "教員",
  "招待",
  "録画",
  "配信",
  "アーカイブ",
  "交通費",
  "宿泊",
  "日程",
];

describe("限定の語名を讓りの語尾に载せた", () => {
  it("讓りの基 × 六語尾 – 默つたままの形が零になった", () => {
    let 讓 = 0;
    let 行 = 0;
    const 默 = [];
    for (const 基 of 基の語々) {
      for (const 語名 of 語名々) {
        const 形 = `${基}${語名}`;
        const 當 = 当たり(形);
        if (當 > 0) {
          行 += 1;
          continue;
        }
        if (讓り(形)) 讓 += 1;
        else 默.push(形);
      }
    }
    expect(默, `默つたまま ${默.length} 本: ${默.slice(0, 8).join(" ")}`).toEqual([]);
    /* 直前に默つて居たのは 78 本（實測）。讓りで應へる形が其れだけ增えた事を張る。*/
    expect(讓, "讓りで應へた形が少なすぎる（語尾が受かつて居ん）").toBeGreaterThanOrEqual(70);
    expect(讓 + 行, "洗つた本數").toBe(基の語々.length * 語名々.length);
  });

  it("搜が讓す參加形式の三語 – 印の行に廣げず讓りが應へる", () => {
    /* `オンライン` 單體は 109 行通る（搜れる語）ので讓りは出んが、`オンライン限定` を 109 行に
     * 廣げると「オンライン限定かどうかは分からん」のに限定のやうに出る（噓の門の第 337 回）。*/
    expect(当たり("オンライン"), "前提 – オンライン單體は搜れる").toBe(109);
    for (const 語 of ["オンライン", "ハイブリッド", "バーチャル"]) {
      /* 讓りの羣が「X限定」を語に持つ三語は 0 行の侭讓りが應へる。*/
      expect(当たり(`${語}限定`), `『${語}限定』を印の行に廣げた`).toBe(0);
      expect(讓り(`${語}限定`), `『${語}限定』で讓りが默つた`).not.toBe("");
      /* 讓りが其の形を持たん「専用」は搜れる語に寄せる（第 660 回 – 默るより印の行が出ん）。*/
      expect(当たり(`${語}専用`), `『${語}専用』が默つた`).toBe(当たり(語));
    }
    /* 對面は搜れん語なので「専用」でも讓りが應へる（語尾の白一覧を载せた效き – 第 660 回）。*/
    expect(当たり("対面専用"), `『対面専用』を他の行に廣げた`).toBe(0);
    expect(讓り("対面専用"), `『対面専用』で讓りが默つた`).not.toBe("");
    /* 讓りの文も噓を言はん – 參加形式の印は『オンライン參加可』だけだと言つて居る筈。*/
    expect(讓り("オンライン限定"), "讓りの文が印の名前を言つて居ん").toContain("オンライン参加可");
  });

  it("搜れる形は讓りで潰さぬ – 語尾を载せても行は其侭", () => {
    /* 白一覧に語尾を增やしても、讓りは 0 件の時にしか畫面に出んので搜の當たりは動かん（第 659 回
     * の基と、第 657・658 回の讓す形・幅の語尾）。*/
    for (const [形, 當] of [
      ["AI専門", 1090],
      ["ネットワーク向け", 257],
      ["セキュリティ特化", 527],
      ["ワークショップ限定", 174],
      ["機械学習向け", 504],
      ["機械学習", 504],
      ["ccf", 2819],
      ["論文の締切", 2004],
      ["学生だけの会議", 4],
      ["オンラインのみ", 1],
      ["12月31日まで", 1031],
      ["来週までに", 206],
    ] as Array<[string, number]>) {
      expect(当たり(形), `搜の當たりを變へた: ${形}`).toBe(當);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
    /* 讓りの羣の語（1,525 本 – 羣の表から數へる）で、讓りの文が一通も動いて居ん事。*/
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );
    const 羣の語々 = [...new Set([...上.matchAll(/"([^"\n]{2,})"/g)].map((m) => m[1]))];
    expect(羣の語々.length, "羣の語の數が變はつた（此の檢査の前提）").toBeGreaterThan(1400);
    let 讓り立つ = 0;
    for (const 語 of 羣の語々) if (讓り(語)) 讓り立つ += 1;
    expect(讓り立つ, "讓りの羣の語が默り始めた").toBeGreaterThan(1000);
  });

  it("語尾の白一覧に六本が一個所ずつ在る", () => {
    /* 讓りの門は白一覧を一處しか見ん（第 464 回 – 段を增やすと讓りが默るか噓を書く）。*/
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 表 = 物.slice(物.indexOf("const UI_WORD_TAILS_JA = ["), 物.indexOf("uiWordTailOk"));
    for (const 語名 of 語名々)
      expect(表.split(`"${語名}",`).length - 1, `語尾の白一覧に『${語名}』が一個所無い`).toBe(1);
    expect(物.split("const UI_WORD_TAILS_JA = [").length - 1, "語尾の白一覧が複數に成つた").toBe(1);
  });
});
