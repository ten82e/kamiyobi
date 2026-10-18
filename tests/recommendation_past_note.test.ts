import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");

/** 名前を付けた関数だけを切り出して動かす（画面の他の部分に依存させない）。 */
function 切り出す(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`切り出せない: ${startMarker}`);
  return stripTypeScriptTypes(source.slice(start, end));
}

const 件数の関数 = 切り出す("  function countJa(", "  /* ランク絞り込みの選択肢");
const 案内の関数 = 切り出す(
  "  function recommendationPastNoteJa(",
  "  function recommendationAvailability(",
);
const pastNote = runInNewContext(`${件数の関数}\n${案内の関数}\nrecommendationPastNoteJa;`) as (
  rows: ReadonlyArray<{ _availability?: { status?: string } }>,
) => string;

it("数えるのは締切が過ぎたと確認できた候補だけ（受付状況の未確認は数えない）", () => {
  const rows = [
    { _availability: { status: "past" } },
    { _availability: { status: "open" } },
    { _availability: { status: "past" } },
    { _availability: { status: "uncertain" } },
    { _availability: { status: "ongoing" } },
    { _availability: {} },
    {},
  ];
  const note = pastNote(rows);
  expect(note).toContain("うち 2 件は締切が過ぎた会議です");
  expect(note, "カードの札と同じ語を使う").toContain("「締切済み」");
  expect(note, "候補に載せている理由を書く").toContain("次回の開催に向けた参考");
  for (const 数 of ["3", "4", "5", "6", "7"]) {
    expect(note, `過ぎた側に数えていない: ${数}`).not.toContain(`うち ${数} 件`);
  }
});

it("締切が過ぎた候補が無いときは何も足さない", () => {
  expect(pastNote([{ _availability: { status: "open" } }, {}])).toBe("");
  expect(pastNote([])).toBe("");
});

it("件数は桁区切りで出す（4 桁以上でも読める）", () => {
  const rows = Array.from({ length: 1234 }, () => ({ _availability: { status: "past" } }));
  expect(pastNote(rows)).toContain("うち 1,234 件");
});

it("候補の件数欄に繋いでいる（切り出した関数が画面から呼ばれる）", () => {
  expect(source, "候補の件数欄に足していない").toContain(
    "const pastNote = recommendationPastNoteJa(shown);",
  );
  expect(source, "読み上げ欄にも同じ文を出していない").toContain("cntLive += pastNote;");
});

/* 「締切が過ぎた候補を除く」（`open=1`）。候補は論文との一致順なので締切が過ぎた会議も
 * 混ざる。まだ出せる所だけ見たい人に、順位を変えずに出す・出さないを選ばせる入口。 */
const 除く関数 = 切り出す(
  "  function withoutClosedCandidates(",
  "  function recommendationExcludedNoteJa(",
);
const 外した案内の関数 = 切り出す(
  "  function recommendationExcludedNoteJa(",
  "  function recommendationAvailability(",
);
const 束 = runInNewContext(
  `${件数の関数}\n${除く関数}\n${外した案内の関数}\n({ withoutClosedCandidates, recommendationExcludedNoteJa });`,
) as {
  withoutClosedCandidates: (
    rows: ReadonlyArray<{ _availability?: { status?: string } }>,
  ) => Array<unknown>;
  recommendationExcludedNoteJa: (count: number) => string;
};

it("除くのは締切が過ぎたと確認できた候補だけ（未確認は残す）", () => {
  const rows = [
    { _availability: { status: "past" } },
    { _availability: { status: "open" } },
    { _availability: { status: "uncertain" } },
    { _availability: { status: "ongoing" } },
    { _availability: {} },
    {},
  ];
  const kept = 束.withoutClosedCandidates(rows);
  expect(kept).toHaveLength(5);
  expect(kept).not.toContain(rows[0]);
  for (const 残す of rows.slice(1)) expect(kept, "分からない物を除いている").toContain(残す);
  expect(束.withoutClosedCandidates([])).toEqual([]);
});

it("外した件数を、外す入口の名前そのままで言う", () => {
  const note = 束.recommendationExcludedNoteJa(60);
  expect(note).toContain("締切が過ぎた候補 60 件を除いています");
  expect(note, "外す場所を探させない").toContain("「締切が過ぎた候補を除く」を外すと出ます");
  expect(束.recommendationExcludedNoteJa(0), "外していないのに断っていない").toBe("");
  expect(束.recommendationExcludedNoteJa(1234)).toContain("1,234 件");
});

it("入口と繋がりが画面にある（チェック欄・状態・URL・候補の絞り込み）", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template, "チェック欄が無い").toContain('id="openOnly"');
  expect(template, "チェック欄が推薦モードの外にある").toMatch(
    /<div class="recommend-only"[\s\S]*id="openOnly"[\s\S]*?<textarea id="paperText"/,
  );
  expect(template, "チェック欄の名前が件数欄の案内と違う").toContain("締切が過ぎた候補を除く");
  for (const 繋がり of [
    'inputElement("openOnly").checked = state.openOnly;',
    'state.openOnly = inputElement("openOnly").checked;',
    'p.set("open", "1")',
    'p.get("open")',
    '"openOnly",',
  ])
    expect(source, `画面の繋がりが無い: ${繋がり}`).toContain(繋がり);
  expect(source, "候補を絞っていない").toContain("const kept = withoutClosedCandidates(out);");
  expect(source, "外した数を数えていない").toContain(
    "recommendExcludedClosed = out.length - kept.length;",
  );
  /* 0 件の画面の文は、下の「描いた文」で実際に動かして見る（文を書き写さない）。 */
  /* 条件の札の列（`#activeFilters`）は締切一覧の物で、推薦モードでは箱ごと隠れる。
   * 札を足しても届かないので、入口はチェック欄だけにする（届かない札を作らない）。 */
  expect(source, "届かない札を足している").not.toContain('label: "締切が過ぎた候補を除く"');
});

/* カードの残り（`あと N 日`）は、一覧の「残り」列と同じ数え方にする。
 * 時刻のある締切だけを数え、日付だけの締切（時刻未確認）は数えない。 */
const 残りの関数 = 切り出す("  function remain(", "  // Paper Text Matching Score");
const カード残りの関数 = 切り出す(
  "  function recommendationRemainingJa(",
  "  /* 外した件数を候補の数の隣で言う",
);
const DAY = 86400000;
const NOW = Date.parse("2026-10-18T05:00:00Z");
const カードの残り = (() => {
  class FixedDate extends Date {
    static now() {
      return NOW;
    }
  }
  return runInNewContext(
    `const DAY = ${DAY};\n${残りの関数}\n${カード残りの関数}\nrecommendationRemainingJa;`,
    { Date: FixedDate },
  ) as (availability: unknown) => { text: string; cls: string } | null;
})();

it("カードの残りは、時刻のある締切だけを一覧と同じ語で数える", () => {
  expect(カードの残り({ status: "open", timestamp: NOW + 3 * DAY })?.text).toBe("あと 3 日");
  expect(カードの残り({ status: "open", timestamp: NOW + 2 * 3600000 })?.text).toBe("あと 2 時間");
  expect(カードの残り({ status: "uncertain", timestamp: NOW + 40 * DAY })?.text).toBe("あと 40 日");
  expect(
    カードの残り({ status: "open", timestamp: NOW + 40 * DAY })?.cls,
    "14 日より先に「そろそろ」の印を付けている",
  ).toBe("");
  expect(カードの残り({ status: "open", timestamp: NOW + 3 * DAY })?.cls).toBe("soon");
});

it("日付だけの締切・過ぎた締切・日付の無い候補には残りを出さない", () => {
  /* 一覧の「残り」列も、日付だけの行には日数を出さず「時刻未確認」と書いている。 */
  expect(カードの残り({ status: "open", local_date: "2026-10-23", timestamp: null })).toBeNull();
  expect(カードの残り({ status: "past", timestamp: NOW - DAY })).toBeNull();
  expect(カードの残り({ status: "ongoing", timestamp: null })).toBeNull();
  expect(カードの残り({ status: "unknown" })).toBeNull();
  expect(カードの残り(undefined)).toBeNull();
  expect(カードの残り({})).toBeNull();
});

/* カードのランクの札。一覧の「ランク」列と同じ札を出し、収録に無い会議は
 * 「ランク未確認」を 1 つ返す（空欄にしない）。 */
const ランク札の関数 = 切り出す(
  "  function recommendationRankTagsJa(",
  "  /* 推薦のカードに出す残り",
);
const ランク札 = (() => {
  const 呼び出し = runInNewContext(`${ランク札の関数}\nrecommendationRankTagsJa;`, {
    fieldReasonsJa: {
      rank: (r: { rankPairs?: string[] }) => (r.rankPairs?.length ? "" : "収録に無い"),
    },
    Recommender: { rankPairLabelJa: (pair: string) => pair.replace(":", " ") },
  }) as (r: { rankPairs?: string[] }) => Array<{ text: string; title: string }>;
  return 呼び出し;
})();

it("カードのランクは一覧と同じ札で、無い会議は「ランク未確認」1 つにする", () => {
  expect(ランク札({ rankPairs: ["ccf:A", "core:A*"] })).toEqual([
    { text: "ccf A", title: "" },
    { text: "core A*", title: "" },
  ]);
  expect(ランク札({ rankPairs: [] })).toEqual([{ text: "ランク未確認", title: "収録に無い" }]);
  expect(ランク札({})).toEqual([{ text: "ランク未確認", title: "収録に無い" }]);
});

it("カードが会期と開催地を一覧と同じ語で出し、てびきが説明している", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  const カード = source.slice(source.indexOf("  function makeRecommendationCard("));
  expect(カード, "カードが会期を出していない").toContain("Recommender.eventCellJa(r)");
  expect(カード, "カードが開催地を出していない").toContain("Recommender.placeJa(r.ed.place)");
  expect(カード, "会期と開催地が別の行に割れている").toMatch(/会期: [\s\S]{0,40}／ 開催地:/);
  expect(カード, "値の無い会議に「該当なし」「未確認」を出していない").toContain(
    "value || (Recommender.fieldNotApplicableJa(r) ? NOT_APPLICABLE_JA : UNCONFIRMED_JA)",
  );
  expect(template, "てびきがカードの会期・開催地を書いていない").toContain("会期と開催地");
  /* 分野も同じ行に出す（会議名だけで当たった候補は、これが無いと分野を確かめられない）。 */
  expect(カード, "カードが分野を出していない").toContain("分野の札");
  expect(カード, "分野の語が一覧の札と別の入口").toContain("catLabel(key)");
  expect(カード, "分野の無い会議に「未確認」を出していない").toContain(
    '分野の札.length ? 分野の札.join("・") : UNCONFIRMED_JA',
  );
  expect(template, "てびきがカードの分野を書いていない").toContain("<strong>分野</strong>");
});

it("カードがランクの札を出し、てびきが同じ語で説明している", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template, "てびきがランク未確認を説明していない").toContain("ランク未確認");
  expect(source, "カードがランクの札を出していない").toContain(
    "for (const rank of recommendationRankTagsJa(r)) {",
  );
});

it("カードが残りを一致評価の隣に出す（一覧と同じく残りを先に読む）", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  for (const 色 of [".tag.soon {", ".tag.today {"])
    expect(template, `残りの色が無い: ${色}`).toContain(色);
  const カード = source.slice(source.indexOf("  function makeRecommendationCard("));
  expect(カード, "カードが残りを出していない").toContain(
    "const remaining = recommendationRemainingJa(r._availability);",
  );
  expect(カード, "残りが一致評価の札より後ろにある").toMatch(
    /recommendationRemainingJa\(r\._availability\)[\s\S]*?meta\.appendChild\(left\)[\s\S]*?availability\.className = "tag";/,
  );
});

/* 候補が 0 件になった画面の文は、原因（語が重ならない / 外した）で変える。
 * カードを描く関数そのものを切り出して動かす（文を書き写すと実装とズレる）。 */
const 描く関数 = 切り出す("  function renderRecommendationCards(", "  const TABLE_SCROLL_LABEL_JA");
function 描いた文(excluded: number, excludedRank = 0): string[] {
  const shown: string[] = [];
  const cards = { textContent: "", appendChild: () => {} };
  return runInNewContext(
    `let recommendationList = [], cardsDrawn = 0;
     let recommendExcludedRank = ${excludedRank};
     const state = { rank: ${JSON.stringify(excludedRank ? "A*" : "")} };
     const recommendationData = {};
     const rankFilterLabelJa = (grade) => grade;
     const line = (_parent, text) => shown.push(String(text));
     const makeRecommendationCard = () => ({});
     const $ = () => cards;
     const valueElement = () => ({ value: "Distributed Systems" });
     ${件数の関数}
     let recommendExcludedClosed = ${excluded};
     let recommendFitMatches = 0;
     ${描く関数}
     renderRecommendationCards([], 0);
     shown;`,
    {
      shown,
      cards,
      countJa: (n: number) => String(n),
      RECOMMENDATION_PAGE: 20,
      Recommender: { parsePaperLines: () => [{ title: "Distributed Systems" }] },
    },
  ) as string[];
}

/* 紙には候補を全部載せるが、外した物は載らない。紙だけを受け取った人に
 * 「これが候補の全部」と読ませないよう、外した数も紙に書く。 */
const 印刷の関数 = 切り出す("  function fillPrintMeta(", '  window.addEventListener("beforeprint"');
function 紙に刷る文(excluded: number, order = "fit", paper = "", rank = ""): string {
  const box = { textContent: "" };
  const cards = { children: [] };
  return runInNewContext(
    `let recommendationList = [], cardsDrawn = 0;
     let recommendExcludedClosed = ${excluded};
     let recommendFitMatches = 0;
     const state = { mode: "recommend", win: "all", order: ${JSON.stringify(order)}, rank: ${JSON.stringify(rank)} };
     const DATA = {};
     /* 用紙の見出しは論文の題名も読む（どの論文の候補かを紙に残す – 2026-10-18）。 */
     const readPaperInput = () => ({ title: ${JSON.stringify(paper)}, abstract: "", keywords: "", references: "" });
     const $ = (id) => (id === "printMeta" ? box : id === "recommendationCards" ? cards : null);
     const valueElement = () => ({ options: [], selectedIndex: -1 });
     ${件数の関数}
     ${印刷の関数}
     fillPrintMeta();
     box.textContent;`,
    {
      box,
      cards,
      fmtJst: () => "2026-10-18 15:00 JST",
      /* ランクの語は画面と同じ入口（この検査は値をそのまま返す）。 */
      rankFilterLabelJa: (grade: string) => (grade === "N" ? "評価なし" : grade),
      generatedAtLabel: () => "データ生成: 2026-08-09(日) 09:00 JST",
      printLegendJa: () => "この用紙の表記: 未確認。",
    },
  ) as string;
}

it("印刷物にも、外した候補の数と並び順を書く（紙だけでは理由が分からない）", () => {
  const 外した紙 = 紙に刷る文(78);
  expect(外した紙).toContain("投稿先を探す画面");
  expect(外した紙).toContain("締切が過ぎた候補 78 件は「締切が過ぎた候補を除く」で除いています");
  const 全部の紙 = 紙に刷る文(0);
  expect(全部の紙).toContain("投稿先を探す画面");
  expect(全部の紙, "外していないのに断っている").not.toContain("除いています");
  const 並べた紙 = 紙に刷る文(0, "deadline");
  expect(並べた紙, "紙に並び順が残っていない").toContain("並び順: 締切が近い順");
  expect(全部の紙, "既定の並びなのに断っている").not.toContain("並び順:");
  /* どの論文の候補か、どのランクで絞ったかも紙に残す（2 枚刷ると見分けが付かない）。 */
  const 題付きの紙 = 紙に刷る文(0, "fit", "低遅延ミドルウェアの設計と評価", "A*");
  expect(題付きの紙, "論文の題名が紙に残っていない").toContain(
    "論文「低遅延ミドルウェアの設計と評価」",
  );
  expect(題付きの紙, "ランクの絞り込みが紙に残っていない").toContain("ランク: A*");
  expect(全部の紙, "題名が無いのに欄を作った").not.toContain("論文「");
});

/* 「並び順: 締切が近い順」（`order=deadline`）。締切の段取りを立てる人向けの並べ替え。
 * 日付の無い候補（常時受付・締切未確認）は後ろ、締切が過ぎた候補は最後、
 * 同じ群の中は論文との一致順のまま（順位そのものは変えない）。 */
const 並べる関数 = 切り出す(
  "  function orderCandidatesByDeadline(",
  "  /* 外した件数を候補の数の隣で言う",
);
const 締切比較の関数 = 切り出す("  function compareDeadlineRows(", "  /** 会期順の比較。");
const 並べた結果 = runInNewContext(`${締切比較の関数}\n${並べる関数}\norderCandidatesByDeadline;`, {
  conferenceNameCell: (r: { name?: string }) => r.name ?? "",
  kindSortIndex: () => 0,
}) as (rows: ReadonlyArray<Record<string, unknown>>) => Array<Record<string, unknown>>;

function 候補(status: string | null, tShown: number, name: string) {
  return { _availability: status ? { status } : undefined, tShown, name, kind: "paper" };
}

it("締切が近い順は、日付のある候補を近い順に、日付の無い候補をその後ろに置く", () => {
  const 遠い = 候補("open", 3000, "Far");
  const 近い = 候補("open", 1000, "Near");
  const 日付なし = 候補("ongoing", 999, "Journal");
  const 未確認 = 候補(null, 888, "Unknown");
  const 過ぎた = 候補("past", 500, "Closed");
  const 並び = 並べた結果([遠い, 近い, 日付なし, 未確認, 過ぎた]);
  expect(並び.map((r) => r.name)).toEqual(["Near", "Far", "Journal", "Unknown", "Closed"]);
  expect(並び, "元の配列を書き換えている").not.toBe(undefined);
});

it("同じ日付・同じ群の中では、論文との一致順のままにする（安定）", () => {
  const 甲 = 候補("open", 2000, "A");
  const 乙 = 候補("open", 2000, "B");
  const 丙 = 候補("open", 2000, "C");
  const 並び = 並べた結果([甲, 乙, 丙]);
  expect(並び.map((r) => r.name)).toEqual(["A", "B", "C"]);
  const 群 = [候補("ongoing", 5, "J1"), 候補(null, 6, "U1"), 候補("past", 7, "P1")];
  expect(並べた結果(群).map((r) => r.name)).toEqual(["J1", "U1", "P1"]);
  expect(並べた結果([])).toEqual([]);
});

it("時刻未確認の候補も「日付のある側」に置く（終了済みの可能性は残るが、日付は在る）", () => {
  const 未確認の日付 = 候補("uncertain", 1500, "Dated");
  const 常時受付 = 候補("ongoing", 1, "Journal");
  expect(並べた結果([常時受付, 未確認の日付]).map((r) => r.name)).toEqual(["Dated", "Journal"]);
});

const 並びの案内の関数 = 切り出す(
  "  function recommendationOrderNoteJa(",
  "  /* 外した件数を候補の数の隣で言う",
);
const 並びの案内 = runInNewContext(`${並びの案内の関数}\nrecommendationOrderNoteJa;`) as (
  order: string,
) => string;

it("既定の並びでは何も足さず、締切が近い順のときだけ件数欄で言う", () => {
  expect(並びの案内("fit")).toBe("");
  const note = 並びの案内("deadline");
  expect(note).toContain("並び順: 締切が近い順");
  expect(note, "日付の無い候補の行き先を書く").toContain("日付の無い候補は後ろ");
});

/* 推薦モードのランクの絞り込み（`state.rank` を共用）。 */
const ランク外し案内の関数 = 切り出す(
  "  function recommendationRankExcludedNoteJa(",
  "  /* 外した件数を候補の数の隣で言う",
);
const ランク外し案内 = runInNewContext(
  `${件数の関数}\n${ランク外し案内の関数}\nrecommendationRankExcludedNoteJa;`,
  { rankFilterLabelJa: (grade: string) => (grade === "N" ? "評価なし" : grade) },
) as (count: number, rank: string) => string;

it("ランクで外した候補の件数を、外す入口の名前そのままで言う", () => {
  const note = ランク外し案内(12, "A*");
  expect(note).toContain("ランク「A*」の候補 12 件を除いています");
  expect(note, "戻し方を書いていない").toContain("「ランク」を「すべて」に戻すと出ます");
  expect(ランク外し案内(12, "N")).toContain("ランク「評価なし」");
  expect(ランク外し案内(0, "A*"), "外していないのに断っている").toBe("");
  expect(ランク外し案内(12, ""), "ランクが無いのに断っている").toBe("");
});

it("ランクの絞り込みが、画面と URL に繋がっている", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template, "推薦モードにランクの欄が無い").toContain('id="recRank"');
  expect(template, "ランクの欄が推薦モードの外にある").toMatch(
    /<div class="recommend-only"[\s\S]*id="recRank"[\s\S]*?<textarea id="paperText"/,
  );
  for (const 繋がり of [
    "if (recRankSel) recRankSel.value = state.rank;",
    'state.mode === "recommend" && recRankSel',
    '"recRank",',
    "Rec.rankMatches(row.rankPairs, state.rank)",
    "recommendExcludedRank = out.length - kept.length;",
    "recommendationRankExcludedNoteJa(",
  ])
    expect(source, `画面の繋がりが無い: ${繋がり}`).toContain(繋がり);
  /* 0 件の案内はランクの絞り込みも見る（文言その物ではなく、外した件数を読む式で見る）。 */
  const 零件の案内 = source.slice(source.indexOf("if (recommendExcludedRank) {"));
  expect(零件の案内, "0 件の案内がランクの絞り込みを無視している").toContain(
    "countJa(recommendExcludedRank)",
  );
});

it("並び順の入口が画面と URL に繋がっている", () => {
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template, "並び順の選択欄が無い").toContain('id="recOrder"');
  expect(template, "並び順が推薦モードの外にある").toMatch(
    /<div class="recommend-only"[\s\S]*id="recOrder"[\s\S]*?<textarea id="paperText"/,
  );
  for (const 選択肢 of ['value="fit"', 'value="deadline"'])
    expect(template, `選択肢が無い: ${選択肢}`).toContain(選択肢);
  for (const 繋がり of [
    'valueElement("recOrder").value = state.order;',
    'state.order = valueElement("recOrder").value === "deadline" ? "deadline" : "fit";',
    'p.set("order", "deadline")',
    'p.get("order")',
    '"openOnly",',
    '"recOrder",',
    'if (state.order === "deadline") out = orderCandidatesByDeadline(out);',
    "const orderNote = recommendationOrderNoteJa(state.order);",
  ])
    expect(source, `画面の繋がりが無い: ${繋がり}`).toContain(繋がり);
  expect(source, "知らない並び順を黙って落としている").toContain(
    'urlNotices.push(urlValueNoticeJa("並び順", orderRaw, "論文との一致順に戻しました"));',
  );
});

it("0 件の画面は、外した結果なら外した数を言う（語が重ならないのと区別する）", () => {
  const 外した = 描いた文(5).join(" ");
  expect(外した, "打ち直しに走らせている").not.toContain("見つかりませんでした");
  expect(外した).toContain("締切が過ぎた会議を除くと 0 件でした");
  expect(外した).toContain("「締切が過ぎた候補を除く」を外すと 5 件出ます");
  const 重ならない = 描いた文(0).join(" ");
  expect(重ならない).toContain("この論文の語と重なる投稿先が見つかりませんでした");
  expect(重ならない).not.toContain("除くと 0 件");
  /* ランクだけで 0 件になったときは、ランクの欄を名指す。 */
  const ランクだけ = 描いた文(0, 7).join(" ");
  expect(ランクだけ).toContain("ランク「A*」では 0 件でした");
  expect(ランクだけ).toContain("「ランク」を「すべて」に戻すと 7 件出ます");
  expect(ランクだけ, "締切の方を名指している").not.toContain("締切が過ぎた候補を除く");
  /* 両方で 0 件なら、両方を名指す（片方だけ直しても出ない）。 */
  const 両方 = 描いた文(5, 7).join(" ");
  expect(両方).toContain("ランク「A*」の候補 7 件");
  expect(両方).toContain("締切が過ぎた会議 5 件");
  expect(両方).toContain("「ランク」を「すべて」に戻すか「締切が過ぎた候補を除く」を外すと出ます");
});
