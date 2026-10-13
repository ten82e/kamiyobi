import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
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
/** 基の語に讓りがある所。*/
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
  it("讓りの基 × 六語尾 – 黙つたままの形が零になった", () => {
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
    /* 直前に黙つていたのは 78 本（実測）。讓りで応へる形がそれだけ增えた事を張る。*/
    expect(讓, "讓りで応へた形が少なすぎる（語尾が受かつていない）").toBeGreaterThanOrEqual(70);
    expect(讓 + 行, "洗つた本数").toBe(基の語々.length * 語名々.length);
  });

  it("検索が讓す參加形式の三語 – 印の行に広げず讓りが応へる", () => {
    expect(当たり("オンライン"), "前提 – オンライン単体は検索れる").toBe(109);
    for (const 語 of ["オンライン", "ハイブリッド", "バーチャル"]) {
      /* 讓りの羣が「X限定」を語に持つ三語は 0 行の侭讓りが応へる。*/
      expect(当たり(`${語}限定`), `『${語}限定』を印の行に廣げた`).toBe(0);
      expect(讓り(`${語}限定`), `『${語}限定』で讓りが默つた`).not.toBe("");
      /* 讓りがその形を持たん「専用」は検索れる語に寄せる。*/
      expect(当たり(`${語}専用`), `『${語}専用』が默つた`).toBe(当たり(語));
    }
    /* 対面は検索れん語なので「専用」でも讓りが応へる（語尾の白一覧を载せた效き – 第 660 回）。*/
    expect(当たり("対面専用"), `『対面専用』を他の行に広げた`).toBe(0);
    expect(讓り("対面専用"), `『対面専用』で讓りが黙つた`).not.toBe("");
    /* 讓りの文も噓を言はん – 參加形式の印は『オンライン參加可』だけだと言つている筈。*/
    expect(讓り("オンライン限定"), "讓りの文が印の名前を言つていない").toContain(
      "オンライン参加可",
    );
  });

  it("検索れる形は讓りで潰さぬ – 語尾を载せても行は其侭", () => {
    /* 白一覧に語尾を增やしても、讓りは 0 件の時にしか画面に出んので検索の当たりは動かん。*/
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
    expect(收錄().length, "品書の行数").toBe(3250);
    /* 讓りの羣の語（1,525 本 – 羣の表から数へる）で、讓りの文が一通も動いて居ん事。*/
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 上 = 物.slice(
      物.indexOf("const UI_WORD_GROUPS_JA"),
      物.indexOf("const UI_WORD_TAILS_JA"),
    );
    const 羣の語々 = [...new Set([...上.matchAll(/"([^"\n]{2,})"/g)].map((m) => m[1]))];
    expect(羣の語々.length, "羣の語の数が変はつた（この検査の前提）").toBeGreaterThan(1400);
    let 讓り立つ = 0;
    for (const 語 of 羣の語々) if (讓り(語)) 讓り立つ += 1;
    expect(讓り立つ, "讓りの羣の語が黙り始めた").toBeGreaterThan(1000);
  });

  it("語尾の白一覧に六本が一個所ずつある", () => {
    /* 讓りの門は白一覧を一處しか見ん。*/
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    const 表 = 物.slice(物.indexOf("const UI_WORD_TAILS_JA = ["), 物.indexOf("uiWordTailOk"));
    for (const 語名 of 語名々)
      expect(表.split(`"${語名}",`).length - 1, `語尾の白一覧に『${語名}』が一個所無い`).toBe(1);
    expect(物.split("const UI_WORD_TAILS_JA = [").length - 1, "語尾の白一覧が複数に成つた").toBe(1);
  });
});
