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

describe("他のの拒否群も締切らしい語尾を受ける（第 506 回）", () => {
  it("催し物の種類・招待状・言語・共催・規模・査読・和暦・欄の名前", () => {
    for (const [文, 断片] of [
      ["キーノートの締切", "「キーノート」"],
      ["招待講演の期限", "「招待講演」"],
      ["ビザの締切", "「ビザ」"],
      ["英語の締切", "「英語」"],
      ["日本語での発表まで", "「日本語での発表」"],
      ["共催の締切", "「共催の締切」"],
      ["スポンサーの予定", "「スポンサー」"],
      ["小規模会議の締切", "「小規模会議」"],
      ["メジャーの締切", "「メジャー」"],
      ["査読期間の期限", "「査読期間」"],
      ["和暦の締切", "「和暦」"],
      ["カテゴリの締切", "欄の名前の言い方ですが"],
      ["過去の締切の予定", "「過去の締切」"],
      ["締切間近まで", "「締切間近」"],
      ["月前半の期限", "「月前半」"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内が本文を変へた`).toContain(断片);
    }
  });

  it("`確定の締切` は締切の確定扱いの群が受ける（見方のてびきに化けない）", () => {
    /* 群 0 に印を付けてゐたら、ここは「`確定` は画面の語ではなく…」になつた（実測）。*/
    expect(画面の案内("確定の締切")).toContain("締切の延伸や確定の印");
    expect(画面の案内("確定の締切")).not.toContain("見方のてびき");

    expect(画面の案内("確定")).toContain("延伸や確定の印");
    expect(画面の案内("確定")).not.toContain("見方のてびき");
  });
  it("磁石の語は今まで通り黙つている（白一覧が効いている証拠）", () => {
    for (const 文 of ["費用対効果分析", "リアルタイム処理", "対面について", "メジャーな学会"]) {
      expect(画面の案内(文), `「${文}」に案内が乘つた（强奪）`).toBe("");
    }

    for (const [文, 語] of [
      ["参加費の安い会議", "参加費"],
      ["小規模な会議の会場", "小規模な会議"],
      ["査読期間の長さ", "査読期間"],
      ["オフラインの会議", "オフライン"],
    ] as Array<[string, string]>) {
      expect(画面の案内(文), `「${文}」が默つて居る`).toContain(`「${語}」`);
    }

    for (const 文 of ["過去の締切 関西", "書き出し HPC", "印刷 関西"]) {
      expect(画面の案内(文), `「${文}」に案内が乘つた（并べ打ちの決まり）`).toBe("");
    }
    /* 和暦の群を付けたが、解ける打ち方までは塞いで居ない。*/
    expect(画面の案内("令和7年の締切")).toContain("2025年の締切");
    expect(画面の案内("令和7年の締切")).not.toContain("和暦");
  });
  it("今も外している群と、第 511 回で開いた群（利得のない所を広げて居ない）", () => {
    expect(画面の案内("使い方の締切")).toContain("見方のてびき");
    expect(画面の案内("使い方 関西")).toBe("");
    /* 群 38 – `以降` を頭に置く打ち方は無いので印を付けて居ない。*/
    expect(画面の案内("以降の締切")).toBe("");
    /* その方に解ける打ち方はその方の侭。*/
    expect(画面の案内("2026年以降")).not.toBe("");
  });
  it("印の数と、足場の新しさ（第 466 回・第 504 回 – 成果物だけの検査）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 第 516 回で二つ增える（採否の数の群・当日の様子の群）。*/
    /* 第 516 回で二つ增えて 37、第 517 回で『催し物の名前＋締切の言い方』の群が增えて 38。*/
    /* 第 685 回で募集・応募の群が增えて 42（`応募締切` `募集期限` `募集の締切` を同じ群で受ける）。*/
    expect(物.split("deadlineTail: true").length - 1).toBe(42);
    /* 第 648 回で日をまたぐ重なりを数へる羣（祝日級の次に置いた）を增やしたので 14 → 15。*/
    /* 第 649 回で分野の一覽の羣（語尾を問わん印を開いた）を增やしたので 15 → 16。*/
    /* 2026-10-18 に『締切が無い・未確認』の群（カードの「締切未確認」「締切なし」）を増やしたので 16 → 17。*/
    expect(物.split("anyTail: true").length - 1).toBe(17);
    expect(物).toContain("UI_WORD_DEADLINE_TAILS_JA");
    /* 足場（tests/runtime_extract.ts）が新しい一覧を注入している事 – 第 504 回で四十一本落ちた
     * 落とし穴の再発防止。*/
    const 足場 = readFileSync(join(import.meta.dirname, "runtime_extract.ts"), "utf8");
    expect(足場).toContain("UI_WORD_DEADLINE_TAILS_JA");
  });
  it("第 470 回〜第 505 回の実測はこの回で変へて居ない", () => {
    expect(列("年内").size).toBe(425);
    expect(列("今年内").size).toBe(427);
    expect(列("再来週内").size).toBe(18);
    expect(列("年末中").size).toBe(84);
    expect(列("年初1月").size).toBe(23);
    expect(列("来月 末日").size).toBe(178);
    expect(列("週 末").size).toBe(146);
    expect(列("締切時刻").size).toBe(181);
    expect(列("ml から").size).toBe(0);
    expect(列("オンラインの締切").size).toBe(20);
    expect(画面の案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(画面の案内("祝日の期限")).toContain("祝日・休日");
    expect(画面の案内("前期")).toContain("という区分はこの表が持っていません");
    expect(画面の案内("三連休明け")).toContain("のように祝日・休日の名前で");
    expect(画面の案内("週明け頃")).toContain("「週明け頃」");
    expect(画面の案内("月初の締切")).toContain("月の初めという言い方は");
  });
});
