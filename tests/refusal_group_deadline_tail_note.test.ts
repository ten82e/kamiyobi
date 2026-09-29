/* 第 505 回 – 収録に無い物を告げる群に、締切らしい語尾だけを特別に受けさせる
 *
 * 実測（2026-11-09 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）。第 504 回の群の総洗ひで
 * 最も多かった二群 – 費用（556 語）と参加形式（156 語）– が、語尾を繋いだ瞬間に画面の四つの案内の道
 * 全てで黙つて居た（`参加費の締切` `登録費の期限` `受講料の予定` `参加費まで` `対面の締切`
 * `対面開催の締切` `筆頭著者の締切` `ピアレビューの期限`）。
 *
 * しかし第 503 回・第 504 回の `anyTail`（語尾を問わない）はこれらの群には付けられない –
 * `費用` は `費用対効果分析`（実測 0 件・主題を打つた打ち方）の頭で、`リアル` は `リアルタイム処理`
 * の頭。其れ等に「費用の欄は無いです」「参加形式の印は無い」を当てると、打つた意味を無視した
 * 案内になる（第 504 回で和暦と参加形式を避け実測した教訓）。
 *
 * 此の回合は語尾を**締切の打ち方へ限つた白一覧**（`UI_WORD_DEADLINE_TAILS_JA`）にした –
 * `締切` `の締切` `締切日` `の締切日` `締め切り` `の締め切り` `しめきり` `のしめきり` `期限`
 * `の期限` `予定` `の予定` `まで` `までに`。其の語の後に之等が来る打ち手は其の語で絞り込もうと
 * して居る事が確かなので、他の続き（`対効果分析` `タイム処理` `7年の締切`）は受けない。
 * 印を付けたのは六つの群（参加形式・費用の本隊・提出先・審査の方式・著者の役・締切の確定扱い）。
 * 第 506 回で其它の拒否群にも廣げ、現在は 34 群が持つ（外したのは二群 – 其の語が其它の群の
 * 案内と衝突する `確定` を持つ群と、頭に置く打ち方が無い `以降` の群）。
 *
 * 行は一個も動かして居ない（群 1 793 語で行の差 0 語・案内は無言→出る 658 語・消える 0 語・
 * 差し替へ 0 語）。案内の道は `uiWordNoteJa` / `uiWordAlwaysNoteJa` / `uiWordLiveNoteJa` の
 * 三つから呼ばれるだけで、検索の照合は通らない（此の回も函數の呼び出し元を數へて確かめた）。*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
/** 画面が 0 件の時に立てる案内の四つの道（site/app.ts の matchedRows === 0 の節と同じ）。*/
function 画面の案内(文: string) {
  return [
    Recommender.wholeTableQueryNoteJa(文) || "",
    Recommender.columnQueryNoteJa(文) || "",
    Recommender.uiWordNoteJa(文) || "",
    Recommender.dayRangeNoteJa(文) || "",
    ...(Recommender.relativeDayNotes(文, 基準) || []),
  ]
    .map((値) => String(値).trim())
    .filter((値) => 値)
    .join(" / ");
}

describe("収録に無い物を告げる群が、締切らしい語尾を受ける（第 505 回）", () => {
  it("費用の本隊 – `参加費の締切` `登録費の期限` `受講料の予定`", () => {
    for (const [語, 文] of [
      ["参加費", "参加費の締切"],
      ["参加費", "参加費まで"],
      ["登録費", "登録費の期限"],
      ["受講料", "受講料の予定"],
      ["参加費用", "参加費用の締切"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内が費用の欄の話をしない`).toContain("この表が持っていません");
      expect(説, `「${文}」の案内が語を名乗つて居ない`).toContain(`「${語}」`);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
  });
  it("参加形式・著者の役・審査の方式・提出先・締切の確定扱いも同じ", () => {
    for (const [語, 文] of [
      ["対面", "対面の締切"],
      ["対面開催", "対面開催の締切"],
      ["オフライン", "オフラインまで"],
      ["筆頭著者", "筆頭著者の締切"],
      ["共著者", "共著者の締切"],
      ["ピアレビュー", "ピアレビューの締切"],
      ["査読方式", "査読方式の期限"],
      ["提出方法", "提出方法の締切"],
      ["未確定", "未確定の期限"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた`).toBe(true);
      expect(説, `「${文}」の案内が語を名乗つて居ない`).toContain(`「${語}」`);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
  });
  it("白一覧に無い続きは受けない（其の語が他の語の頭に成れる磁石の実測）", () => {
    /* `費用対効果分析` は主題、`リアルタイム処理` も主題 – 費用・参加形式の群に語尾を問わない印を
     * 付けられない理由その物。白一覧なので默つた侭（第 504 回の教訓を検査にする）。*/
    for (const 文 of ["費用対効果分析", "リアルタイム処理", "対面について", "筆頭著者について"]) {
      expect(列(文).size).toBe(0);
      expect(画面の案内(文), `「${文}」に案内が乘つた（强奪）`).toBe("");
    }
    /* 和暦の群は此の印を付けて居ない – 既に解ける打ち方に「和暦は書いていません」を疊まない。*/
    expect(画面の案内("令和7年の締切")).toContain("2025年の締切");
    expect(画面の案内("令和7年の締切")).not.toContain("和暦");
    /* 第 513 回で「連体の `の`」だけを受けるやうにした – 其の名前が其の表に無い話は、
       「の+名詞」で繋がれても同じなので、`オフラインの会議` `参加費の安い会議` は導く方を応じる。
       語をまたぐ形（値を並べた打ち手 – `過去の締切 関西`）は舊の決まりが勝つて默る。*/
    expect(画面の案内("オフラインの会議")).toContain("オフライン");
    expect(画面の案内("参加費の安い会議")).toContain("参加費");
    expect(画面の案内("過去の締切 関西")).toBe("");
  });
  it("其の方で解ける打ち方を塞いで居ない（行の出る物は案内を立てない）", () => {
    /* `オンラインの締切` は行が出る（実測 – 検査用ビルドで 20 件）ので、案内は出ない。*/
    expect(列("オンラインの締切").size).toBe(20);
    expect(画面の案内("オンラインの締切")).toBe("");
  });
  it("印を持つ群の数（第 503 回〜第 506 回で増えた順路を張る）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 第 516 回で二つ增える（採否の数の群・当日の様子の群）。*/
    expect(物.split("deadlineTail: true").length - 1).toBe(37);
    expect(物.split("anyTail: true").length - 1).toBe(5);
    /* 白一覧は十四の形だけ。語尾を問わない印の群（第 503 回・第 504 回）は其侭通る。*/
    expect(物).toContain('"の締切日"');
    expect(物).toContain('"のしめきり"');
    expect(画面の案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(画面の案内("祝日の期限")).toContain("祝日・休日");
  });
  it("長い語が勝つ – `travel grantの締切` の名乗りが直つた（第 248 回）", () => {
    /* 実測（実ビルド）で、舊は此の打ち方が「「travel」はこの表が…」と**切れた語を名乘つて**居た
     *（`travel` が先に當かつて居た）。印を付けた群の照合が長い語を選ぶやうになつたので、
     * 打たれた語その物を名乘るやうに成つた。案内の本文は同じ群の物。*/
    expect(列("travel grantの締切").size).toBe(0);
    expect(画面の案内("travel grantの締切")).toContain("「travel grant」");
    expect(画面の案内("travel grantの締切")).not.toContain("「travel」は");
  });
  it("第 470 回〜第 504 回の実測は此の回で変へて居ない", () => {
    expect(列("年内").size).toBe(424);
    expect(列("今年内").size).toBe(426);
    expect(列("再来週内").size).toBe(18);
    expect(列("年末中").size).toBe(84);
    expect(列("年初1月").size).toBe(23);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(145);
    expect(列("締切時刻").size).toBe(180);
    expect(列("ml から").size).toBe(0);
    expect(列("半 年後").size).toBe(2);
    expect(列("一 週間後").size).toBe(13);
    expect(画面の案内("前期")).toContain("という区分はこの表が持っていません");
  });
});
