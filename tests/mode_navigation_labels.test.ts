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
      "results",
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
  type HelpNode = {
    tagName: string;
    hidden: boolean;
    textContent: string;
    children: HelpNode[];
    hasAttribute(name: string): boolean;
  };
  const element = (tagName: string, shared = false, children: HelpNode[] = []): HelpNode => ({
    tagName,
    hidden: true,
    textContent: "",
    children,
    hasAttribute: (name) => shared && name === "data-recommend-help",
  });
  const summary = element("SUMMARY");
  const topics = [element("DIV", true), element("DIV"), element("DIV", true), element("DIV")];
  const sections = [summary, element("H3"), element("DL", true, topics), element("DL")];
  const help = Object.assign(nodes.helpPanel, {
    open: false,
    children: sections,
    querySelector: (selector: string) => (selector === "summary" ? summary : null),
  });
  help.hidden = true;
  const siblings = [nodes.results, help];
  Object.assign(nodes.results, {
    before(node: typeof help) {
      expect(node).toBe(help);
      siblings.splice(siblings.indexOf(node), 1);
      siblings.splice(siblings.indexOf(nodes.results), 0, node);
    },
    after(node: typeof help) {
      expect(node).toBe(help);
      siblings.splice(siblings.indexOf(node), 1);
      siblings.splice(siblings.indexOf(nodes.results) + 1, 0, node);
    },
  });
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
    `${jsFunction(app, "updateHelpMode")}\n${jsFunction(app, "updateModeUi")}\n${jsFunction(app, "setMode")}\nreturn {updateModeUi, setMode};`,
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
  ) as { updateModeUi(): void; setMode(mode: "recommend" | "deadlines"): void };
  return { state, nodes, skip, calls, help, summary, sections, topics, siblings, ...actions };
}
function check(h: ReturnType<typeof harness>, mode: "recommend" | "deadlines") {
  const recommend = mode === "recommend";
  const label = recommend ? "投稿先の候補" : "締切の一覧";
  expect(h.nodes.resultsHeading.textContent).toBe(label);
  expect(h.skip.textContent).toBe(`${label}へ進む`);
  expect(h.skip.href).toBe("#results");
  expect(h.nodes.deadlineResultHint.hidden).toBe(recommend);
  expect(h.nodes.recommendResultHint.hidden).toBe(!recommend);
  expect(h.nodes.helpPanel.hidden).toBe(false);
  expect(h.summary.hidden).toBe(false);
  expect(h.summary.textContent).toBe(
    recommend
      ? "投稿先候補の見方・意味検索が使えないとき"
      : /<summary>([^<]+)<\/summary>/.exec(html.slice(html.indexOf('id="helpPanel"')))![1],
  );
  expect(h.sections.map((section) => section.hidden)).toEqual(
    recommend ? [false, true, false, true] : [false, false, false, false],
  );
  expect(h.topics.map((topic) => topic.hidden)).toEqual(
    recommend ? [false, true, false, true] : [false, false, false, false],
  );
  expect(h.siblings).toEqual(recommend ? [h.help, h.nodes.results] : [h.nodes.results, h.help]);
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

it("retains the chosen disclosure state when switching modes repeatedly", () => {
  const h = harness("deadlines");
  for (const open of [true, false, true]) {
    h.help.open = open;
    for (const mode of ["recommend", "deadlines"] as const) {
      h.setMode(mode);
      check(h, mode);
      expect(h.help.open).toBe(open);
    }
  }
});

it("marks only the existing fit and semantic-failure topics for recommendation mode", () => {
  const lists = [...html.matchAll(/<dl data-recommend-help>([\s\S]*?)<\/dl>/g)];
  expect(lists).toHaveLength(1);
  const topics = [...lists[0][1].matchAll(/<div data-recommend-help>([\s\S]*?)<\/div>/g)];
  expect(topics.map((topic) => /<dt>([^<]+)<\/dt>/.exec(topic[1])![1])).toEqual([
    "一致評価の出し方（投稿先を探す）",
    "意味検索が使えないとき",
  ]);
  expect(html.match(/id="helpPanel"/g) || []).toHaveLength(1);
});
