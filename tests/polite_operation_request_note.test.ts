import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 斷り = (文: string): string => String(Recommender.uiWordNoteJa(文, false) || "").trim();
/* 斷りの先頭は打たれた語の名指し（echo）なので、それを外して**同じ案内の家が立つているか**を見る。 */
const 後ろ = (文: string): string => 斷り(文).replace(/^「[^」]*」/, "");

describe("敬語・賴む語尾が續いても同じ斷りが立つ（第 625 回）", () => {
  /* [裸の形, 敬語で賴んだ形] – 旧來は右側が皆 空文字だつた。 */
  const 対: Array<[string, string]> = [
    ["購読", "購読したいです"],
    ["印刷", "印刷したいです"],
    ["印刷", "印刷する方法"],
    ["保存", "保存する方法"],
    ["リセット", "リセットしたいです"],
    ["並び替え", "並び替えたいです"],
    ["参加費", "参加費を知りたいです"],
    ["ビザ", "ビザを発行してほしいです"],
    ["リンクをコピー", "リンクをコピーしたいです"],
    ["使い方", "使い方を知りたいです"],
    ["書き出し", "CSVで書き出したいです"],
  ];
  it("語尾が續いても同じ案内の家に落ちる", () => {
    for (const [裸, 敬語] of 対) {
      expect(斷り(裸), `裸の形が立つ筈: ${裸}`).not.toBe("");
      expect(斷り(敬語), `敬語を續けただけで默つた: ${敬語}`).not.toBe("");
      expect(後ろ(敬語), `別々の案内を立てた: ${敬語}`).toBe(後ろ(裸));
    }
  });
  it("打ち切るだけの賴み方も受ける（昇順で・カレンダー追加）", () => {
    expect(斷り("昇順で")).toContain("列の見出し");
    expect(斷り("降順で")).toContain("列の見出し");
    expect(斷り("カレンダー追加")).toContain("カレンダーに追加");
  });
  it("品書 0 件の画面で、打ち先の名前がそのまま出る", () => {
    const 幕 = deadlineHintFunction();
    const out = 幕({
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      hiddenKindWords: [],
      hidden: { past: 1200, est: 134 },
      queryMatch: { catalog: 0, journal: 0 },
      termCounts: [{ term: "購読したいです", count: 0 }],
      urlQuery: false,
      catalogConferences: 12,
      query: "購読したいです",
      shorterHits: [],
    });
    expect(out).toContain("購読");
    expect(out, "画面の文に打ち先が書かれていない").toMatch(/カレンダーに追加|購読 URL/);
  });
});

describe("磁石 – 主題と手続を打つ文を食はせん（第 503 回）", () => {
  /* 「したいです」を通すと、他の語の頭に同じ語尾が乘る懸ひがある。実測で之等の文は
     羣の語に当たらん（検索に來た文なので、其侭黙つて打ち替えの案内に讓る）。 */
  const 讓る文 = [
    "査読したいです",
    "発表したいです",
    "投稿したいです",
    "参加したいです",
    "登録したいです",
    "セッションに登録したいです",
    "締切を知りたいです",
    "日程を知りたいです",
    "会場を知りたいです",
    "高速計算を知りたいです",
    "セキュリティの会議が見たいです",
    "採択されたいです",
    "申請したいです",
    "聴講したいです",
  ];
  it("検索の文には画面の斷りを立てん", () => {
    for (const 文 of 讓る文) {
      if (文 === "聴講したいです") continue; /* 聴講 は參加形式の羣が既に持つ（旧來からの斷り） */
      expect(斷り(文), `搜の文に斷りが乘つた: ${文}`).toBe("");
    }
  });
  it("検索の側は一字も広げて居らん（第 362 回 – 語尾の門は案内の目だけ）", () => {
    /* 敬語を續けた文は品書に行が出ん（斷りが立つのはその時だけ – app の門）。
       それに対して語その物が行を持つ事もある（`昇順` は原文に現れる） – それは検索側の話で、
       今回の直しで変はつて居らん事を張る。 */
    const 品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    );
    const 當 = (文: string) => {
      const m = Recommender.searchMatcher(文, 基準);
      return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
    };
    for (const 文 of ["昇順で", "降順で", "購読したいです", "印刷する方法", "カレンダー追加"])
      expect(當(文), `行が出て居る – 斷りを立てる場處で無い: ${文}`).toBe(0);
    expect(當("購読"), "`購読` の行の数が変はつた").toBe(0);
  });
});

describe("抜き出しの検査器が壊れん形に置く（第 341 回の罠）", () => {
  const src = readFileSync(new URL("../site/recommender.ts", import.meta.url), "utf8");
  const i = src.indexOf("function uiWordTailOk");
  const body = src.slice(i, src.indexOf("\n  }", i + 40));
  it("敬語を剥ぐ条は家の中にあり、外の定数にHandさへ讓らん", () => {
    expect(i).toBeGreaterThan(0);
    expect(body).toContain('"です", "ですか", "でしょうか"');
    expect(src.slice(0, i)).not.toMatch(/^ {2}const 敬語の尾Ja = \[/m);
  });
});

describe("助詞と限定語が續いた打ち方（第 626 回）", () => {
  it("助詞が一枚續いても同じ斷りの家に落ちる", () => {
    const 対: Array<[string, string]> = [
      ["データ源", "データ源が見たいです"],
      ["出典", "出典が見たいです"],
      ["降順", "降順で見たい"],
    ];
    for (const [裸, 續き] of 対) {
      expect(斷り(續き), `默つた: ${續き}`).not.toBe("");
      expect(後ろ(續き), `別の案内に變はつた: ${續き}`).toContain(後ろ(裸).slice(0, 12));
    }
  });
  it("一つに絞る賴み方（だけ・のみ・しか）を受ける", () => {
    const out = 斷り("口頭発表だけ");
    expect(out).toContain("口頭発表");
    expect(out, "區別の有無を言はん斷りが乘つた").toContain("この表が持っていません");
  });
  it("曖昧な幅の假名形と異体字の並び替えも受ける", () => {
    expect(斷り("まもなく")).toContain("曖昧な幅");
    expect(斷り("まもなく締切の物")).toContain("曖昧な幅");
    /* 并（異体字）で打たれた形 – 語その物を足したので、打ち切る形（并べ替えて）の
       助詞「て」だけは今も黙つている。 */
    expect(斷り("并べ替える")).toContain("列の見出し");
    expect(斷り("并べ替えたいです")).toContain("列の見出し");
  });
  it("検索の文には乘らん（第 503 回 – 生形の語尾を足した為の点検）", () => {
    for (const 文 of [
      "発表見たい",
      "oral発表だけ",
      "査読が見たいです",
      "採択を知りたいです",
      "セッションだけ",
      "投稿だけしたいです",
    ])
      expect(斷り(文), `搜の文に斷りが乘つた: ${文}`).toBe("");
  });
  it("検索の側は一字も広げて居らん（第 362 回 – 開いた文は皆 0 件の侬）", () => {
    const 品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    );
    for (const 文 of ["データ源が見たいです", "口頭発表だけ", "并べ替えて", "まもなく締切の物"]) {
      const m = Recommender.searchMatcher(文, 基準);
      const 行 = 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true);
      expect(行.length, `行が出て居る: ${文}`).toBe(0);
    }
  });
});

describe("道しるべの注を縮めても指先は変はらん（第 626 回）", () => {
  /* `site/recommender.ts` は 1 MiB の契約（`tests/lint_budget.test.ts`）で広げられん所まで
     來ていた（実測 – 残り 212 バイト）。羣に添へていた道しるべの注 89 本（合計 10,527 バイト）
     を「SPEC 第 N 回」だけの形の注に縮めて 7,992 バイトを戻した – 回数の指先は其侭残している。
     この検査は「證跡としての回数が消えた」事と、家その物が壊れて居ん事を張る。 */
  const s = readFileSync(new URL("../site/recommender.ts", import.meta.url), "utf8");
  it("SPEC の回数指先は羣に残つている", () => {
    /* 縮めた形の注の数を数ふる（正規表現にせず字面で見 – 注の記號を検査の中に持つと
       それ自身が注になる – 第 626 回の実發生）。 */
    expect(s.split("SPEC 第 ").length - 1).toBeGreaterThanOrEqual(80);
    expect(s).not.toContain("立てた譯と實測は SPEC");
  });
  it("語表の家は其侭読める（注を縮めた後に斷りが立つか）", () => {
    expect(Recommender.uiWordNoteJa("使い方", false)).toContain("見方のてびき");
    expect(Recommender.uiWordNoteJa("条件クリア", false)).toContain("条件クリア");
  });
});

describe("望み形と敬語一枚の語尾（第 627 回）", () => {
  it("動詞の語幹が續く望み形で、打ち先が名指される", () => {
    const 見當: Array<[string, string]> = [
      ["条件を消したいです", "条件クリア"],
      ["フィルタを外したいです", "条件クリア"],
      ["カレンダーに入れたい", "カレンダーに追加"],
      ["てびきを読みたいです", "見方のてびき"],
      ["近い順に並べたいです", "列の見出し"],
      ["締切順に並べたいです", "列の見出し"],
    ];
    for (const [文, 先] of 見當) expect(斷り(文), `默つた: ${文}`).toContain(先);
  });
  it("羣の語の後ろが敬語一枚だけでも斷る", () => {
    expect(斷り("知りたいです")).toContain("知りたい");
    expect(斷り("購読です")).toContain("カレンダーに追加");
  });
  it("訪ねた物が言ひ終へられている文には『決まりません』を表示しない", () => {
    /* 助詞で繋がれた形（`締切を知りたいです`）は前の語が訪ねた物なので、羣の語の道を
       通すと同じ噓が出る – 讓りの門（打ち頭の道だけ敬語一枚を通す）を張る。 */
    for (const 文 of ["締切を知りたいです", "高速計算を知りたいです", "採択を知りたいです"])
      expect(斷り(文), `羣の斷りが乘つた: ${文}`).toBe("");
  });
  it("収録してない欄を望み形で賴まれても、その方を正直に言う", () => {
    expect(斷り("日本語で発表したい")).toContain("使用言語");
    expect(斷り("旅費支援が出たい")).toContain("費用");
  });
  it("言い変への語 – いつ迄・見方・新しさ・コピー", () => {
    expect(斷り("いつ迄？")).toContain("この表は");
    expect(斷り("見方てびき")).toContain("見方のてびき");
    expect(斷り("どの位の新しさ")).toContain("データ生成");
    expect(斷り("コピー")).toContain("印刷");
  });
  it("締切らしい語の後ろにもう一枚語尾が續けば通す（過去締切表示）", () => {
    expect(斷り("過去締切表示")).toContain("過去");
  });
  it("開いた文は皆、品書では 0 件の侬（検索の側は広げて居らん – 第 362 回）", () => {
    const 品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
    );
    for (const 文 of [
      "条件を消したいです",
      "カレンダーに入れたい",
      "知りたいです",
      "いつ迄？",
      "過去締切表示",
      "てびきを読みたいです",
    ]) {
      const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
      expect(
        品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length,
        `行が出た: $文`,
      ).toBe(0);
    }
  });
});
