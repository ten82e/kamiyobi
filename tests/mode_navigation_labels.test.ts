import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const html = readFileSync(join(REPO_ROOT, "site/template.html"), "utf8");
const app = siteRuntime();
function harness(mode: "recommend" | "deadlines") {
  const state = { mode };
  const nodes = Object.fromEntries(
    [
      "controlsPanel",
      "modeRecommend",
      "modeDeadlines",
      "helpPanel",
      "resultsHeading",
      "deadlineResultHint",
      "recommendResultHint",
    ].map((id) => {
      const attributes: Record<string, string> = {};
      const classes = new Set<string>();
      return [
        id,
        {
          textContent: id === "resultsHeading" ? "締切の一覧" : "",
          hidden: id === "recommendResultHint",
          attributes,
          classes,
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
          classList: {
            toggle: (name: string, enabled: boolean) =>
              enabled ? classes.add(name) : classes.delete(name),
          },
        },
      ];
    }),
  );
  const initialSkip = /<a class="skip-link" href="([^"]+)">([^<]+)<\/a>/.exec(html);
  expect(initialSkip).not.toBeNull();
  const skip = { textContent: initialSkip![2], href: initialSkip![1] };
  const calls: string[] = [];
  const actions = new Function(
    "state",
    "document",
    "$",
    "window",
    "drawerRow",
    "closeDrawer",
    "writeUrl",
    "stopHistoryLoad",
    "recommendationData",
    "setRecommendationProfile",
    "loadRecommendationData",
    "fullRecordNeeded",
    "fullRecordRequested",
    "loadHistoryData",
    "setDeadlineProfile",
    "DATA",
    "render",
    `${jsFunction(app, "updateModeUi")}\n${jsFunction(app, "setMode")}\nreturn {updateModeUi, setMode};`,
  )(
    state,
    { querySelector: (selector: string) => (selector === ".skip-link" ? skip : null) },
    (id: string) => {
      if (!nodes[id]) throw new Error(`unexpected element ${id}`);
      return nodes[id];
    },
    {},
    null,
    () => {},
    (method: string) => calls.push(`history:${method}`),
    () => {},
    {},
    () => {},
    () => {},
    () => false,
    false,
    () => {},
    () => {},
    {},
    () => calls.push("render"),
  );
  return { state, nodes, skip, calls, ...actions };
}
function check(h: ReturnType<typeof harness>, mode: "recommend" | "deadlines") {
  const recommend = mode === "recommend";
  const label = recommend ? "投稿先の候補" : "締切の一覧";
  expect(h.nodes.resultsHeading.textContent).toBe(label);
  expect(h.skip.textContent).toBe(`${label}へ進む`);
  expect(h.skip.href).toBe("#results");
  expect(h.nodes.deadlineResultHint.hidden).toBe(recommend);
  expect(h.nodes.recommendResultHint.hidden).toBe(!recommend);
  expect(h.nodes.helpPanel.hidden).toBe(recommend);
  expect(h.nodes.modeRecommend.attributes["aria-pressed"]).toBe(String(recommend));
  expect(h.nodes.modeDeadlines.attributes["aria-pressed"]).toBe(String(!recommend));
  expect([...h.nodes.controlsPanel.classes]).toEqual([
    recommend ? "mode-recommend" : "mode-deadlines",
  ]);
}

it("labels the results and their skip link for either initial mode", () => {
  for (const mode of ["deadlines", "recommend"] as const) {
    const h = harness(mode);
    h.updateModeUi();
    check(h, mode);
  }
});

it("updates headings, shortcut guidance and pressed states on repeated real mode changes", () => {
  const h = harness("deadlines");
  for (const mode of ["recommend", "deadlines", "recommend", "deadlines"] as const) {
    h.setMode(mode);
    expect(h.state.mode).toBe(mode);
    check(h, mode);
  }
  expect(h.calls).toEqual(Array.from({ length: 4 }, () => ["history:push", "render"]).flat());
});

it("has one visible default guide and describes only the shortcuts available in that mode", () => {
  const deadline = /<span\b[^>]*id="deadlineResultHint"[^>]*>[\s\S]*?<\/span><\/span>/.exec(html);
  const recommend = /<span\b[^>]*id="recommendResultHint"[^>]*>[\s\S]*?<\/span><\/span>/.exec(html);
  expect(deadline).not.toBeNull();
  expect(recommend).not.toBeNull();
  expect(deadline![0].split(">")[0]).not.toContain("hidden");
  expect(recommend![0].split(">")[0]).toContain("hidden");
  expect(deadline![0]).toContain("詳細・投稿日程");
  expect(deadline![0]).toContain("<kbd>d</kbd> 詳細");
  expect(deadline![0]).toContain("<kbd>/</kbd> 検索");
  expect(recommend![0]).toContain("会議名");
  expect(recommend![0]).toContain("公式サイト");
  expect(recommend![0]).toContain("<kbd>/</kbd> 論文入力");
  expect(recommend![0]).toContain("<kbd>Tab</kbd> 次の項目へ");
  expect(recommend![0]).toContain("<kbd>Enter</kbd> 開く");
  expect(recommend![0]).not.toMatch(/詳細・投稿日程|<kbd>[jdk↑↓]<\/kbd>/);
  expect(html).toMatch(
    /<main\b[^>]*id="results"[^>]*tabindex="-1"[^>]*aria-labelledby="resultsHeading"/,
  );
  expect(html).toMatch(/id="resultsHeading">締切の一覧<\/h2>/);
});
