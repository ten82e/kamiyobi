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
const 件 = (文: string) =>
  全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true).length;
/** 画面が 0 件の時に立てる案内の四つの道（site/app.ts の matchedRows === 0 の節と同じ）。*/
function 画面の案内(文: string) {
  return [
    Recommender.columnQueryNoteJa(文) || "",
    Recommender.uiWordNoteJa(文) || "",
    Recommender.dayRangeNoteJa(文) || "",
    Recommender.wholeTableQueryNoteJa(文) || "",
    ...(Recommender.relativeDayNotes(文, 基準) || []),
  ]
    .map((値) => String(値).trim())
    .filter((値) => 値)
    .join(" ∥ ");
}

describe("訪ねて打つ形がその群の打ち直し方を出す（第 510 回）", () => {
  it("金額・時期・所在を尋ねる打ち方 – 打たれた語を名乘る", () => {
    for (const [語, 文, 断片] of [
      ["参加費", "参加費はいくら", "この表が持っていません"],
      ["参加費", "参加費はいくら？", "この表が持っていません"],
      ["費用", "費用はいくらですか", "この表が持っていません"],
      ["査読期間", "査読期間はいつ", "審査をいつからいつまで"],
      ["ビザ", "ビザはいくら", "この表が持っていません"],
      ["未確定", "未確定はいくら", "という扱いはこの表にありません"],
      ["オフライン", "オフラインはいつ", "参加形式の言い方ですが"],
      ["使い方", "使い方は？", "見方のてびき"],
      ["ヘルプ", "ヘルプはどこ", "見方のてびき"],
      ["travel grant", "travel grantはいくら", "この表が持っていません"],
      ["数日以内", "数日以内は", "曖昧な幅では絞り込めません"],
      ["印刷", "印刷はいくら", "ブラウザの印刷"],
      ["書き出し", "書き出しはいくら", "検索欄では絞り込めません"],
    ] as Array<[string, string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説, `「${文}」の案内が其の群の話をしない`).toContain(断片);
      expect(説, `「${文}」の案内が其の語を名乗つて居ない`).toContain(`「${語}」`);
      expect(件(文), `「${文}」で行が出た`).toBe(0);
    }
  });
  it("長く訪ねる形も受ける（実測で黙つていた打ち方）", () => {
    for (const [語, 文] of [
      ["参加費", "参加費はいくらかかりますか"],
      ["費用", "費用はいくら位"],
      ["査読期間", "査読期間はいつですか"],
      ["参加費", "参加費っていくら"],
      ["登録費", "登録費はいくらぐらい"],
      ["費用", "費用は"],
      ["使い方", "使い方は"],
    ] as Array<[string, string]>) {
      const 説 = 画面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた`).toBe(true);
      expect(説, `「${文}」の案内が其の語を名乗つて居ない`).toContain(`「${語}」`);
      expect(件(文), `「${文}」で行が出た`).toBe(0);
    }
  });
  it("語尾は**打ちの終り**にある時だけ見る – 語の途中に助詞があるだけの打ち方は拾はぬ", () => {
    for (const 文 of [
      "参加費はがき代",
      "ビザはどこでも必要",
      "費用はがきの請求",
      "査読期間はねも",
    ]) {
      expect(件(文), `「${文}」で行が出た`).toBe(0);
      expect(画面の案内(文), `「${文}」に案内が乘つた（含み照合に緩んだ）`).toBe("");
    }
  });
  it("値を並べた打ち方に案内を被せない旧の決まりは其侭（第 250 回・第 354 回）", () => {
    /* 今回の語尾は「そこで打ちが終る」形だけ見る – 並べ打ち（`印刷 関西`）は旧の侭黙る。*/
    for (const 文 of ["印刷 関西", "書き出し HPC", "使い方 関西", "更新頻度 2026"]) {
      expect(件(文)).toBe(0);
      expect(画面の案内(文), `「${文}」に案内が乘つた（並べ打ちの決まりを破つた）`).toBe("");
    }
    /* その語が他のの語の頭に成れる磁石も黙つた侭。*/
    expect(件("費用対効果分析")).toBe(0);
    expect(画面の案内("費用対効果分析")).toBe("");
    expect(画面の案内("リアルタイム処理")).toBe("");
  });
  it("行が出る打ち手には何も被せない", () => {
    expect(件("関西")).toBe(6);
    expect(件("国内")).toBe(38);
    expect(件("オンライン参加可")).toBe(20);
    expect(件("セキュリティ")).toBe(68);
    expect(件("ランクA")).toBe(3);
    for (const 文 of ["関西", "国内", "オンライン参加可", "セキュリティ", "ランクA"]) {
      expect(画面の案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
    /* `締切はいつ` は行が出る（締切の語が当たる）ので案内は立たない。*/
    expect(件("締切はいつ")).toBe(21);
    expect(画面の案内("締切はいつ")).toBe("");
  });
  it("第 503 回〜第 509 回の道は其侭通る", () => {
    expect(画面の案内("対面の締切")).toContain("参加形式の言い方ですが");
    expect(画面の案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(画面の案内("祝日の期限")).toContain("祝日・休日");
    expect(画面の案内("前期")).toContain("という区分はこの表が持っていません");
    expect(画面の案内("三連休明け")).toContain("のように祝日・休日の名前で");
    expect(画面の案内("週明け頃")).toContain("「週明け頃」");
    expect(画面の案内("和暦 2026年")).toContain("和暦");
    expect(画面の案内("カテゴリ HPC")).toContain("欄の名前の言い方ですが");
    expect(画面の案内("費用対効果分析")).toBe("");
    expect((Recommender.columnQueryNoteJa("分野 セキュリティ") || "").trim()).toContain(
      "「分野」は",
    );
    expect(件("年内")).toBe(425);
    expect(件("年末中")).toBe(84);
    expect(件("再来週内")).toBe(18);
    expect(件("来月 末日")).toBe(178);
    expect(件("週 末")).toBe(146);
    expect(件("締切時刻")).toBe(181);
    expect(件("ml から")).toBe(0);
  });
});

describe("ビルド成果物に語尾がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("訪ねる語尾が現れ、値の並べ打ちを受け入れる語尾は增えて居ない", () => {
    const 表 = 物.slice(
      物.indexOf("const UI_WORD_TAILS_JA"),
      物.indexOf("const UI_WORD_DEADLINE_TAILS_JA"),
    );
    for (const 尾 of [
      '"はいくら"',
      '"いくらですか"',
      '"はいつ"',
      '"いくらかかりますか"',
      '"どうなっている"',
    ]) {
      expect(表, `問いの語尾 ${尾} が表に無い`).toContain(尾);
    }
    /* 並べ打ち（空格 + 値）を語尾として載せて居ない事 – 旧の決まりの證。*/
    expect(表).not.toContain('" 関西"');
    expect(表).not.toContain('"関西"');
  });
});
