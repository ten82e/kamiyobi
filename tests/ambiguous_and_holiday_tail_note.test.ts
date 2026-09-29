/* 第 504 回 – 曖昧な幅と祝日級に語尾を繋げた形（`当面の締切` `数日以内の締切` `祝日の期限` `連休の締切`）
 *
 * 実測（2026-11-09 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、案内の群を洗つた
 *（四十九群・四百九十語 × 語尾六種・画面が 0 件の時に立てる四つの道を総べて調べた）。
 * **単体では画面が何か書くのに、語尾を繋いだ瞬間に 0 件で完全に無言になる打ち方が 2 622 語**あつた
 *（内訳: 費用の群 556 語・画面操作の群 234 語・曖昧な幅の群 173 語・祝日級 165 語・参加形式 156 語 …）。
 * 其の内、研究者が実際に打ちさうな二つの群（**曖昧な幅**・**祝日級**）に第 503 回の印を付けた。
 *
 * 二つに絞つた理由（実測で確かめた强奪の危險）:
 * - 参加形式の群は付けられない – `リアル` が `リアルタイム処理`（実測 0 件）の頭なので、
 *   「`リアル` は参加形式の言い方ですが」が**主題**を打つた人に當つ（検査に張つた）。
 * - 和暦の群は付けられない – `令和` が `令和7年の締切` の頭で、其の方は既に「2025年の締切」と
 *   解けて居るのに「和暦は書いていません」が重なる（其の方の解き方が正しい）。
 *
 * 印を付けた為に**第 434 回の祝日級の表が食はれた**（`三連休明け` の名乗りが「三連休」に落ち、
 * 十三本落ちた実測）。其の表を群の引より前へ移し、**群の語その物を食はせない門戸**（`uiWordExact`）を
 * 付けた – `盆` `祝日` `大型連休` は単体の案内が其の侭残る（実測で前后同じ事を確かめた）。
 *
 * 行は一個も動かして居ない（群 1 077 語で行の差 0 語・減 0 語・案内 687 語が増え、消えた案内 0 語）。*/
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

describe("曖昧な幅・祝日級に語尾を繋いだ形が画面上で何か書く（第 504 回）", () => {
  it("曖昧な幅の群 – 単体と同じ話が出る", () => {
    for (const [語, 文] of [
      ["当面", "当面の締切"],
      ["当面", "当面まで"],
      ["当面", "当面の予定"],
      ["数日以内", "数日以内の締切"],
      ["いつまで", "いつまでの締切"],
      ["数か月", "数か月の間に"],
      ["しばらく", "しばらくの締切"],
      ["近日中", "近日中の締切"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内が曖昧な幅の話をしない`).toContain("曖昧な幅では絞り込めません");
      expect(説, `「${文}」の案内が語を名乗つて居ない`).toContain(`「${語}」`);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
      /* 案内が導す欄が実在する（第 353 回）。*/
      expect(説).toContain("締切まで");
    }
  });
  it("曖昧な幅の群は語を離して打たれた形も受ける（第 354 回と同じ道）", () => {
    /* 旧は「当面 締切」も無言だつた – 語尾一覧が spaces を含む尾を彈いて居た為。印を付けてからは
     * 繋いだ形と同じに解れる。*/
    expect(画面の案内("当面 締切")).toContain("曖昧な幅では絞り込めません");
    expect(画面の案内("当面 締切")).toBe(画面の案内("当面の締切"));
  });
  it("祝日級の群 – 同じ斷りが打ち方の數だけ出る", () => {
    for (const [語, 文] of [
      ["祝日", "祝日の期限"],
      ["祝日", "祝日まで"],
      ["連休", "連休の締切"],
      ["お盆", "お盆の予定"],
      ["夏休み", "夏休み中の締切"],
      ["休暇", "休暇中の締切"],
      ["年末年始", "年末年始の期限"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた`).toBe(true);
      expect(説, `「${文}」の案内が祝日の話をしない`).toContain("祝日・休日");
      expect(説, `「${文}」の案内が語を名乗つて居ない`).toContain(`「${語}」`);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
  });
  it("第 434 回の祝日級の表が勝つ（名乗りは打たれた侭）– 群の語その物は旧の侭", () => {
    /* 群に印を付けた為、この表が後ろに抑される形に成つた（十三本が落ちた実測）。前に移して直した。*/
    for (const 文 of ["三連休明け", "連休中日", "GW明け", "お盆前", "祝日明け"]) {
      expect(画面の案内(文), `「${文}」の名乗りが落ちた`).toContain(`「${文}」`);
      expect(画面の案内(文)).toContain("のように祝日・休日の名前で打たれても絞り込めません");
    }
    /* 門戸 – 群の語その物は群の案内が残る（第 434 回の表に食はせない）。*/
    for (const 文 of ["祝日", "大型連休", "お盆", "連休"]) {
      expect(画面の案内(文), `「${文}」が表に食はれた`).toContain("では絞れません");
      expect(画面の案内(文)).not.toContain("のように祝日・休日の名前で");
    }
    /* `盆` `正月` は群の語に無いので旧からこの表が受ける – 此の回も同じ文面（前のビルドと実測で一致）。*/
    for (const 文 of ["盆", "正月"]) {
      expect(画面の案内(文), `「${文}」の文面が動いた`).toContain("のように祝日・休日の名前で");
    }
  });
  it("强奪しない事に決めた二つの群（実測で裏を取つた）", () => {
    /* 参加形式の群に印を付けると、主題で打つた人が参加形式の斷りを讀む事になる。*/
    expect(列("リアルタイム処理").size).toBe(0);
    expect(画面の案内("リアルタイム処理")).not.toContain("参加形式".replace("参", "参"));
    /* 和暦の群に印を付けると、解けて居る打ち方に「和暦は書いていません」が重なる。*/
    expect(画面の案内("令和7年の締切")).toContain("2025年の締切");
    expect(画面の案内("令和7年の締切")).not.toContain("和暦");
  });
  it("第 470 回〜第 503 回の実測は此の回で変へて居ない", () => {
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
    expect(画面の案内("祝日の締切")).toContain("祝日");
    expect(画面の案内("前期")).toContain("という区分はこの表が持っていません");
    expect(画面の案内("月初の締切")).toContain("月の初めという言い方は");
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("祝日級の表が群の引より前に在り、門戸が其の前に付く", () => {
    const 前 = 物.indexOf("のように祝日・休日の名前で打たれても");
    const 後 = 物.indexOf("const hit = uiWordEntry(query);");
    expect(前).toBeGreaterThan(0);
    expect(後).toBeGreaterThan(0);
    expect(前 < 後, "祝日級の表が群の引より後ろに居る").toBe(true);
    expect(物).toContain("if (!uiWordExact(文)) {");
    /* 印の數は五つ（第 503 回の三つ + 第 504 回の二つ）– その他の頁でも張つて居る。*/
    expect(物.split("anyTail: true").length - 1).toBe(9);
  });
});
