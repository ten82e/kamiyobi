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
/** 画面が 0 件の時に立てる案内の道（site/app.ts の matchedRows === 0 の節と同じ）。*/
function 畫面の案内(文: string) {
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

describe("欄の名前を値と並べても打ち直し方が出る（第 507 回）", () => {
  it("欄の名前 ＋ 値 – 単体と同じ案内が出る", () => {
    for (const 文 of [
      "分野 セキュリティ",
      "種別 論文締切",
      "会場 関西",
      "テーマ HPC",
      "地域 関西",
      "分類 機械学習",
      "参加形式 オンライン",
      "ステータス 未確定",
      "分野：セキュリティ",
      "分野、関西",
      "種別:論文締切",
    ]) {
      const 説 = Recommender.columnQueryNoteJa(文);
      expect(説 !== "", `「${文}」に欄の名前の案内が出なかつた`).toBe(true);
      expect(説).toContain("値で検索してください");
      expect(説).toContain("例:");
      /* 値の例は収録に実在する語だけ。*/
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
    /* 単体の名乗りは旧の侭。*/
    expect(Recommender.columnQueryNoteJa("分野")).toContain("「分野」は");
    expect(Recommender.columnQueryNoteJa("会場")).toContain("「会場」は");
  });
  it("値だけで打つ人は今まで通り（案内を被せない）", () => {
    expect(列("セキュリティ").size).toBe(68);
    expect(列("関西").size).toBe(6);
    expect(列("オンライン参加可").size).toBe(20);
    for (const 文 of ["セキュリティ", "関西", "オンライン参加可"]) {
      expect(畫面の案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
  });
  it("並べて打つと案内が消える旧の決まり（第 250 回・第 354 回）は其侭", () => {
    /* 画面操作の語は複合の絞り込みとして打たれる事があるので、並べた時に案内を被せない。*/
    for (const 文 of ["印刷 関西", "更新頻度 2026", "使い方 関西", "書き出し HPC"]) {
      expect(列(文).size).toBe(0);
      expect(畫面の案内(文), `「${文}」に案内が乘つた（舊の決まりを破つた）`).toBe("");
    }
  });
  it("群の multiword を五つ足した – 欄の名前・並び順・絞り込み・和暦", () => {
    for (const [文, 断片] of [
      ["カテゴリ HPC", "欄の名前の言い方ですが"],
      ["ラベル 関西", "欄の名前の言い方ですが"],
      ["人気順 穴場", "という順はこの表にありません"],
      ["絞り込み オンライン参加可", "この表の語ではなく"],
      ["和暦 2026年", "和暦"],
    ] as Array<[string, string]>) {
      const 説 = 畫面の案内(文);
      expect(説 !== "", `「${文}」は無言だつた`).toBe(true);
      expect(説).toContain(断片);
      expect(列(文).size, `「${文}」で行が出た`).toBe(0);
    }
    /* 和暦はその方が解ける打ち方を塞いで居ない（年の幅の案内は後ろに残る）。*/
    expect(畫面の案内("和暦 2026年")).toContain("2026年の締切");
  });
  it("二つの語が並んだ時は長い語の案内が勝つ（第 354 回）– 差し替はりを残す", () => {
    /* 「カテゴリ 未確定」は旧は `未確定` の案内だつた。両語が並べるやうになつたので長い語
       （カテゴリ）が勝つ – 両方とも正しい话なので、これを張り替へとして記録する。*/
    expect(畫面の案内("カテゴリ 未確定")).toContain("欄の名前の言い方ですが");
    expect(畫面の案内("人気順 未確定")).toContain("という順はこの表にありません");
    /* 単体では旧の群が応える（消えて居ない）。*/
    expect(畫面の案内("未確定")).toContain("という扱いはこの表にありません");
  });
  it("separator のない繋がれた形は、問答を渡さない呼び出しでは黙る（第 508 回に道を譲つた）", () => {
    for (const 文 of ["分野セキュリティ", "種別9月", "会場関西"]) {
      expect(列(文).size).toBe(0);
      expect(畫面の案内(文), `「${文}」に案内が乘つた`).toBe("");
    }
  });
  it("第 470 回〜第 506 回の実測はこの回で変へて居ない", () => {
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
    expect(畫面の案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(畫面の案内("キーノートの締切")).toContain("キーノート");
    expect(畫面の案内("確定の締切")).toContain("延伸や確定の印");
    expect(畫面の案内("祝日の期限")).toContain("祝日・休日");
    expect(畫面の案内("週明け頃")).toContain("「週明け頃」");
    expect(畫面の案内("三連休明け")).toContain("のように祝日・休日の名前で");
    expect(畫面の案内("費用対効果分析")).toBe("");
    expect(畫面の案内("リアルタイム処理")).toBe("");
  });
});

describe("ビルド成果物に目がある事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("欄の名前の照合が語に分けて当たれ、區切りにコロンがある", () => {
    expect(物).toContain("q.split(/[\\s、，,・：:]+/)");
    expect(物).toContain("const 語々 = q.split(");

    // 第 525 回で会場バリアフリーの群を一つ增やしたので 32 → 33（この数は群の總数の見張り）。
    // 第 527 回で「日付の欄」「訪ね方だけ」の二群を增やしたので 33 → 35（この数は群の總数の見張り）。
    // 第 586 回で交歓と懇親の群を一つ增やしたので 35 → 36（この数は群の總数の見張り）。
    // 第 587 回で所屬先で決まる話の群を一つ增やしたので 36 → 37（この数は群の總数の見張り）。
    // 第 590 回で和文・英文の別の群を一つ增やしたので 37 → 38（この数は群の總数の見張り）。
    // 第 601 回で問い合わせと相談の窓口の群を一つ增やしたので 38 → 39（この数は群の總数の見張り）。
    // 第 613 回で運営の委員とメールの配達の羣を二つ增やしたので 39 → 41。
    // 第 648 回で日をまたぐ重なりを数へる羣を一つ增やしたので 41 → 42（この数は羣の總数の見張り）。
    // 第 649 回で分野の一覽の羣を一つ增やしたので 42 → 43（この数は羣の總数の見張り）。
    expect(物.split("multiword: true").length - 1).toBe(43);
  });
});
