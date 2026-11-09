import { expect, it } from "vitest";
import { siteRuntime } from "./runtime_extract.ts";

it("候補領域の読み込み状態を、成功・失敗・締切モードで解除する", () => {
  const app = siteRuntime();
  const start = app.indexOf('$("results").setAttribute(');
  const end = app.indexOf("if (recMode && !recommendationData", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const run = new Function(
    "$",
    "recMode",
    "recommendationData",
    "recommendationError",
    app.slice(start, end),
  );
  for (const [recMode, data, error, expected] of [
    [true, null, false, "true"],
    [true, null, true, "false"],
    [true, {}, false, "false"],
    [true, {}, true, "false"],
    [false, null, false, "false"],
  ]) {
    let busy: string | undefined;
    run(
      (id: string) => {
        expect(id).toBe("results");
        return {
          setAttribute(name: string, value: string) {
            expect(name).toBe("aria-busy");
            busy = value;
          },
        };
      },
      recMode,
      data,
      error,
    );
    expect(busy).toBe(expected);
  }
});

it("推薦の取得状態と検索済み0件を、見える件数・読み上げの両方で区別する", () => {
  const app = siteRuntime();
  const render = app.slice(app.indexOf("function render()"));
  const baseStart = render.indexOf('const paperText = valueElement("paperText").value;');
  const baseEnd = render.indexOf("countSemanticReason = null;", baseStart);
  const notesStart = render.indexOf("if (paperMode && recommendationData)");
  const notesEnd = render.indexOf("// 「来月」で検索", notesStart);
  expect(baseStart).toBeGreaterThan(-1);
  expect(notesStart).toBeGreaterThan(baseEnd);
  const run = new Function(
    "recommendationData",
    "recommendationError",
    "recMode",
    "shown",
    "paperTextValue",
    "semState",
    `
      const countJa = String;
      const rows = Array(10), RECOMMENDATION_PAGE = 50, venueLookupMiss = [], 截つた行 = 0;
      const valueElement = () => ({value: paperTextValue});
      const Recommender = {
        venueLookupNoticeJa: () => "",
        parsePaperLines: () => [{title: paperTextValue}],
        autoDetectCats: () => ["systems"],
        semanticReasonJa: () => "モデル未取得"
      };
      const state = {cats: [], rank: "", order: ""};
      const catLabel = () => "システム";
      const semanticReason = "model_unavailable";
      let countSemanticReason;
      const recommendationPastNoteJa = () => "";
      const recommendationExcludedNoteJa = () => "";
      const recommendationRankExcludedNoteJa = () => "";
      const recommendationOrderNoteJa = () => "";
      const recommendExcludedClosed = 0, recommendExcludedRank = 0, recommendExcludedWorkshop = 0;
      ${render.slice(baseStart, baseEnd)}
      countSemanticReason = null;
      ${render.slice(notesStart, notesEnd)}
      return {visible: cnt, live: cntLive, reason: countSemanticReason};
    `,
  );
  for (const input of ["", "CXL distributed database"]) {
    for (const semanticState of ["loading", "error"]) {
      expect(run(null, false, true, [], input, semanticState)).toEqual({
        visible: "推薦データを読み込み中…",
        live: "推薦データを読み込み中…",
        reason: null,
      });
      expect(run(null, true, true, [], input, semanticState)).toEqual({
        visible: "推薦データを読み込めませんでした。",
        live: "推薦データを読み込めませんでした。",
        reason: null,
      });
    }
  }
  const zero = run({}, false, true, [], "CXL distributed database", "error");
  expect(zero.visible).toContain("あなたの論文に合う投稿先 0 件");
  expect(zero.visible).toContain("分野自動判定: システム");
  expect(zero.visible).toContain("語彙検索のみ");
  expect(zero.live).toBe(zero.visible);
  expect(zero.reason).toBe("model_unavailable");
  expect(run({}, false, true, Array(3), "CXL distributed database", "loading").visible).toContain(
    "投稿先 3 件",
  );
  expect(run({}, false, true, [], "", "error").visible).toBe(
    "投稿先を探すには論文情報を入力してください",
  );
  expect(run(null, true, false, Array(2), "CXL distributed database", "error").visible).toBe(
    "2 件 / 全 10 件",
  );
});
