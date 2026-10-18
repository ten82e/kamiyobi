import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ICS_VIEW_CAL_NAME_JA,
  ICS_VIEW_CANDIDATE_CAL_NAME_JA,
  icsViewText,
  jstParts,
} from "../site/ics.ts";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const render = jsFunction(app, "render");
const start = render.indexOf("const icsExportCount =");
const end = render.indexOf("const showHistoryStatus =", start);
expect(start).toBeGreaterThan(0);
expect(end).toBeGreaterThan(start);
const controlsSource = render.slice(start, end);
function dated(key: string, date = "2030-01-02T20:00:00Z") {
  return {
    conf: { key, title: key, categories: ["systems"] },
    ed: { id: `${key}-2030`, year: 2030 },
    dl: { kind: "paper", utc: date },
    kind: "paper",
    t: Date.parse(date),
    est: false,
    dateOnly: false,
    localDate: "",
  };
}
const ongoing = { ...dated("ongoing"), kind: "journal", dl: { kind: "journal", utc: "" } };
const undated = { ...dated("unknown"), kind: "venue", dl: { kind: "venue", utc: "" }, t: NaN };
const invalidDay = { ...dated("invalid-day"), dateOnly: true, localDate: "未確認" };
type Row = ReturnType<typeof dated>;
function harness(initial: Row[], mode: "recommend" | "deadlines" = "deadlines") {
  const shown = [...initial];
  const state = { mode };
  let candidates = mode === "recommend";
  const attrs: Record<string, string> = {};
  const button = {
    textContent: "",
    title: "",
    hidden: true,
    disabled: false,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
  };
  const note = { textContent: "", hidden: true };
  const controls = new Function(
    "shown",
    "state",
    "$",
    "Recommender",
    "jstParts",
    "icsViewText",
    "DATA",
    "candidateScopeOnScreen",
    /* 書き出しの暦の名は画面の正本から取る（候補と一覧で分ける）。 */
    "ICS_VIEW_CAL_NAME_JA",
    "ICS_VIEW_CANDIDATE_CAL_NAME_JA",
    [
      jsFunction(app, "countJa"),
      jsFunction(app, "exportIcsLabelJa"),
      /* 1 行分の組み立ては切り出してある（一覧と行の詳細が同じ物を使う）。 */
      jsFunction(app, "icsInputForRow"),
      jsFunction(app, "shownIcsInput"),
      jsFunction(app, "shownIcsText"),
      `function refresh(){const recMode=state.mode==="recommend";const 候補を書き出す=candidateScopeOnScreen();${controlsSource}}`,
      "return {refresh,text:()=>shownIcsText(candidateScopeOnScreen()), input:shownIcsInput};",
    ].join("\n"),
  )(
    shown,
    state,
    (id: string) => {
      if (id === "exportIcs") return button;
      if (id === "exportIcsNote") return note;
      throw new Error(`unexpected element ${id}`);
    },
    Recommender,
    jstParts,
    icsViewText,
    { generated_at: "2029-12-31T00:00:00Z" },
    () => candidates,
    ICS_VIEW_CAL_NAME_JA,
    ICS_VIEW_CANDIDATE_CAL_NAME_JA,
  );
  function replace(rows: Row[]) {
    shown.splice(0, shown.length, ...rows);
    controls.refresh();
  }
  replace(initial);
  return {
    button,
    note,
    attrs,
    state,
    replace,
    text: controls.text as () => string,
    input: controls.input as () => Array<{ key: string; day: string }>,
    setCandidates(value: boolean) {
      candidates = value;
      controls.refresh();
    },
  };
}
const eventCount = (text: string) => (text.match(/^BEGIN:VEVENT\r?$/gm) ?? []).length;

it.each(["deadlines", "recommend"] as const)(
  "%s export label matches actual events, omitting undated rows without inventing dates",
  (mode) => {
    const dateOnly = { ...dated("date-only"), dateOnly: true, localDate: "2030-02-03" };
    const pastEstimated = { ...dated("past-estimated", "2020-01-01T00:00:00Z"), est: true };
    const h = harness(
      [ongoing, dated("future"), undated, dateOnly, invalidDay, pastEstimated],
      mode,
    );
    expect(h.input().map((row) => [row.key, row.day])).toEqual([
      ["future", "20300103"],
      ["date-only", "20300203"],
      ["past-estimated", "20200101"],
    ]);
    const text = h.text();
    expect(eventCount(text)).toBe(3);
    expect(h.button.textContent).toBe(
      mode === "recommend"
        ? "この候補の締切 3 件をカレンダー（.ics）でダウンロード"
        : "この一覧の 3 件をカレンダー（.ics）でダウンロード",
    );
    expect(h.button.title).toContain("3 件");
    expect(h.button.disabled).toBe(false);
    expect(h.button.hidden).toBe(false);
    expect(h.note.hidden).toBe(false);
    expect(h.note.textContent).toBe(
      "日付未確認・常時受付の 3 件はカレンダーに含みません。CSVには全 6 件を書き出せます。",
    );
    expect(h.attrs["aria-describedby"]).toBe("exportIcsNote");
    expect(text).not.toMatch(/SUMMARY:.*(?:ongoing|unknown|invalid-day)/);
    expect(text).toContain("SUMMARY:past-estimated");
    expect(text).toContain("推定");
  },
);

it("disables empty calendar exports while keeping the undated result list available", () => {
  const h = harness([ongoing, undated, invalidDay]);
  expect(h.button.hidden).toBe(false);
  expect(h.button.disabled).toBe(true);
  expect(h.button.textContent).toBe("カレンダーに書き出せる日付がありません");
  expect(eventCount(h.text())).toBe(0);
  expect(h.note.textContent).toContain("CSVには全 3 件");
  h.replace([dated("now-dated"), ongoing]);
  expect(eventCount(h.text())).toBe(1);
  expect(h.button.textContent).toContain("1 件");
  expect(h.button.disabled).toBe(false);
  expect(h.note.textContent).toContain("常時受付の 1 件");
  h.replace([dated("first"), dated("second")]);
  expect(eventCount(h.text())).toBe(2);
  expect(h.button.textContent).toContain("2 件");
  expect(h.note.hidden).toBe(true);
  expect(h.note.textContent).toBe("");
  expect(h.attrs["aria-describedby"]).toBeUndefined();
  h.replace([]);
  expect(h.button.hidden).toBe(true);
  expect(h.button.disabled).toBe(true);
  expect(h.note.hidden).toBe(true);
});

it("counts every exportable row rather than only the first visible page", () => {
  const rows = Array.from({ length: 1001 }, (_, i) => dated(`dated-${i}`));
  const h = harness([...rows, ...Array.from({ length: 22 }, () => ongoing)], "recommend");
  expect(eventCount(h.text())).toBe(1001);
  expect(h.button.textContent).toContain("1,001 件");
  expect(h.note.textContent).toContain("常時受付の 22 件");
  expect(h.note.textContent).toContain("CSVには全 1,023 件");
});

it("hides export guidance when recommendation input has no candidates", () => {
  const h = harness([dated("old-result"), ongoing], "recommend");
  h.setCandidates(false);
  expect(h.button.hidden).toBe(true);
  expect(h.note.hidden).toBe(true);
  expect(h.note.textContent).toBe("");
  expect(h.attrs["aria-describedby"]).toBeUndefined();
  h.setCandidates(true);
  expect(h.button.hidden).toBe(false);
  expect(h.note.hidden).toBe(false);
  expect(h.button.textContent).toContain("この候補の締切 1 件");
});

it("provides a visible explanation beside the calendar control", () => {
  const template = readFileSync(join(REPO_ROOT, "site/template.html"), "utf8");
  expect(template).toMatch(
    /<button\b[^>]*id="exportIcs"[\s\S]*?<\/button>\s*<span\b[^>]*id="exportIcsNote"[^>]*hidden/,
  );
});
