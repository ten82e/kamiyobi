/**
 * 限定の助詞を語と語の間に繋げた打ち方（`学生だけの会議`）– 第 658 回。
 *
 * 實測（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）で、「語 + だけ/のみ/しか + の + 語」の
 * 繋げ方は**悉く 0 行で讓りも立たなかつた** – 其の一塊は品書のどの行にも書かれん語だから
 * （「だけの・のみの・しかの」の塊を持つ行は 3,250 行にゼロ）。其の侭空格で離して打った人は
 * 屆いて居た（`学生 会議` 4 行・`国内 研究会` 13 行・`日本 会議` 74 行・`9月 締切` 602 行）。
 *
 * 直しは搜の寄せ – 繋げた形を離した形に寄せる。割る二片は元の塊の部分列なので、当たりは減らん
 * （其の方の理屈は此の檢査の三本目が品書その物で張る）。讓す所 – 第 657 回と同じ參加形式の四語、
 * 割つた後に仮名だけの一片が残る形、後ろに語の續かん形。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
let 品書: Row[] | null = null;
/** 品書は记忆力せて讀む（ループ每に JSON を解析すると一檢で數分かかる – 第 656 回の教へ）。*/
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

/** 直し前の当たり – 一塊の語として品書に含まれる行だけ（搜は打たれた語をそのまま探す）。*/
function 塊の当たり(訪ね: string): number {
  return 收錄().filter((行) => String(行.hay).includes(訪ね)).length;
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

const 助々 = ["だけの", "のみの", "しかの"];
const 次々 = ["会議", "研究会", "締切", "セッション", "公募"];

describe("限定の助詞を語の間に繋げた打ち方", () => {
  it("六つの繋げ形が離して打った人と同じ行に出會ふ", () => {
    for (const [繋ぎ, 離し] of [
      ["学生だけの会議", "学生 会議"],
      ["国内のみの研究会", "国内 研究会"],
      ["日本だけの会議", "日本 会議"],
      ["9月だけの締切", "9月 締切"],
      ["ポスターのみの会議", "ポスター 会議"],
      ["抄録だけの締切", "抄録 締切"],
      ["セキュリティだけの会議", "セキュリティ 会議"],
    ] as Array<[string, string]>) {
      expect(当たり(離し), `前提 – 離した形で行が出る: ${離し}`).toBeGreaterThan(0);
      expect(当たり(繋ぎ), `『${繋ぎ}』が默つた（${離し} は ${当たり(離し)} 行）`).toBe(
        当たり(離し),
      );
    }
  });

  it("讓る所 – 參加形式の語は廣げん・假名だけの一片が残る形は割らん・語が続かん形は割らん", () => {
    /* 參加形式 – 『オンラインのみ』は印の行に寄せるので、割って `オンライン 會議` 全體に廣げん
     * （噓の門の第 337 回・讓す表は第 657 回と一つ）。 */
    for (const 語 of ["オンライン", "ハイブリッド", "バーチャル", "対面"]) {
      for (const 助 of 助々) {
        const 形 = `${語}${助}会議`;
        /* 割れば `オンライン 会議` = 109 行（バーチャルは 88 行）に廣がる – 其れは『オンライン參加可』の
         * 印を「それだけ」と言つた事になる（噓の門の第 337 回）。讓す形は 0 行の侭 – 讓し表を無視させた
         * 壞し檢査では 109 行に廣がつて此の條が落ちる（實測）。 */
        expect(当たり(形), `『${形}』を『${語} 会議』全体に廣げた`).toBe(0);
      }
    }
    /* 假名だけの語を續ける形は割らん – 割ると假名だけの一片が残つて何も出ん（實測で減つた形）。 */
    for (const 語 of ["学生", "機械学習", "査読"]) {
      for (const 助 of 助々) {
        expect(当たり(`${語}${助}だけ`), `『${語}${助}だけ』を割つて行を減らした`).toBeGreaterThan(
          0,
        );
      }
    }
    /* 後ろに語が續かん形は第 657 回の剥ぐ番が受ける（此の番は觸らん）。 */
    expect(当たり("学生だけ"), "『学生だけ』が 0 行に成つた").toBe(当たり("学生"));
  });

  it("当たりが減らん事 – 百の繋げ形は直し前（一塊で探す）以下にならん", () => {
    const 語々 = [
      "学生",
      "機械学習",
      "セキュリティ",
      "関西",
      "海外",
      "国内",
      "9月",
      "12月",
      "来年",
      "論文",
      "抄録",
      "ポスター",
      "招待",
      "査読",
      "研究会",
      "人工知能",
      "ネットワーク",
      "量子",
      "医療",
      "ccf",
    ];
    let 屆いた = 0;
    for (const 語 of 語々) {
      for (const 助 of 助々) {
        for (const 次 of 次々) {
          const 形 = `${語}${助}${次}`;
          const 今 = 当たり(形);
          /* 直し前 – 一塊の語として品書に其のまま在る行のみが出會ふ（實測で其の塊はゼロなので 0 行）。*/
          expect(今, `『${形}』が直し前より減つた`).toBeGreaterThanOrEqual(塊の当たり(形));
          if (今 > 0) 屆いた += 1;
        }
      }
    }
    expect(屆いた, "繋げ形が一つも行に出會はなんだ – 割る目が効いてない").toBeGreaterThan(50);
    /* 品書の窓と基の語は無傷 – 搜の寄せを行ひ換へても行の數は變はらん。 */
    expect(收錄().length, "品書の行数が変わつた").toBe(3250);
    expect(当たり("機械学習"), "基の語を潰した").toBe(504);
    expect(当たり("ccf"), "基の語を潰した").toBe(2819);
    expect(当たり("論文の締切"), "《の》を繋いだ元の形を潰した").toBe(2004);
    expect(当たり("12月31日まで"), "幅の語尾を潰した").toBe(1031);
    expect(当たり("来週までに"), "幅の語尾を潰した").toBe(206);
  });

  it("割る目が搜の寄せに一つだけ在つて、讓す表を同じ目が見る", () => {
    const 物 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(
      物.split("))の(?=").length - 1,
      "割る目が複數に成つた（段が増えると案内が黙るか噓を書く – 第 464 回）",
    ).toBe(1);
    expect(物.split("限定を讓る語Ja.has(頭)").length - 1, "割る番が讓す表を見る眼").toBe(1);
    expect(
      物.split("限定を讓る語Ja.has(限定を剥いだ)").length - 1,
      "剥ぐ番の讓し（第 657 回）",
    ).toBe(1);
    /* 讓りの文が割つた形で噓にならん事を、此の場で一度見る。 */
    expect(讓り("ハイブリッドのみの会議"), "讓す形が默つた").not.toBe("");
    expect(讓り("学生だけの会議"), "行の出る打ち方に讓りが立つた").toBe("");
  });
});
