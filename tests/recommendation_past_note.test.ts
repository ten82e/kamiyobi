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
    '"past", "openOnly"',
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

/* 候補が 0 件になった画面の文は、原因（語が重ならない / 外した）で変える。
 * カードを描く関数そのものを切り出して動かす（文を書き写すと実装とズレる）。 */
const 描く関数 = 切り出す("  function renderRecommendationCards(", "  const TABLE_SCROLL_LABEL_JA");
function 描いた文(excluded: number): string[] {
  const shown: string[] = [];
  const cards = { textContent: "", appendChild: () => {} };
  return runInNewContext(
    `let recommendationList = [], cardsDrawn = 0;
     const recommendationData = {};
     const line = (_parent, text) => shown.push(String(text));
     const makeRecommendationCard = () => ({});
     const $ = () => cards;
     const valueElement = () => ({ value: "Distributed Systems" });
     ${件数の関数}
     let recommendExcludedClosed = ${excluded};
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
function 紙に刷る文(excluded: number): string {
  const box = { textContent: "" };
  const cards = { children: [] };
  return runInNewContext(
    `let recommendationList = [], cardsDrawn = 0;
     let recommendExcludedClosed = ${excluded};
     const state = { mode: "recommend", win: "all" };
     const DATA = {};
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
      generatedAtLabel: () => "データ生成: 2026-08-09(日) 09:00 JST",
      printLegendJa: () => "この用紙の表記: 未確認。",
    },
  ) as string;
}

it("印刷物にも、外した候補の数を書く（紙だけでは理由が分からない）", () => {
  const 外した紙 = 紙に刷る文(78);
  expect(外した紙).toContain("投稿先を探す画面");
  expect(外した紙).toContain("締切が過ぎた候補 78 件は「締切が過ぎた候補を除く」で除いています");
  const 全部の紙 = 紙に刷る文(0);
  expect(全部の紙).toContain("投稿先を探す画面");
  expect(全部の紙, "外していないのに断っている").not.toContain("除いています");
});

it("0 件の画面は、外した結果なら外した数を言う（語が重ならないのと区別する）", () => {
  const 外した = 描いた文(5).join(" ");
  expect(外した, "打ち直しに走らせている").not.toContain("見つかりませんでした");
  expect(外した).toContain("締切が過ぎた会議を除くと 0 件でした");
  expect(外した).toContain("「締切が過ぎた候補を除く」を外すと 5 件出ます");
  const 重ならない = 描いた文(0).join(" ");
  expect(重ならない).toContain("この論文の語と重なる投稿先が見つかりませんでした");
  expect(重ならない).not.toContain("除くと 0 件");
});
