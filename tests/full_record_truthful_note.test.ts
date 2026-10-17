import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const render = jsFunction(app, "render");
const start = render.indexOf("const showFullRecordOffer =");
const end = render.indexOf("if (recMode) {", start);
if (start < 0 || end < start) throw new Error("full-record render block missing");
const source =
  ["countJa", "bytesJa", "farthestRowDayJa", "fullRecordNoteJa"]
    .map((name) => jsFunction(app, name))
    .join("\n") + render.slice(start, end);
const execute = new Function(
  "$",
  "DATA",
  "rows",
  "recMode",
  "showHistoryStatus",
  "activeData",
  "resolveHistoryRef",
  source,
);
function renderOffer({
  days = 180,
  calendar = "2027-02-04",
  bytes = 2048,
  last = "2027-02-04",
  history = true,
  mode = false,
  loading = false,
  loaded = false,
} = {}) {
  const data = {
    window: { upcoming_days: days },
    calendar: calendar ? { last_day: calendar } : undefined,
    history_bytes: bytes,
  };
  const elements: Record<string, { hidden: boolean; textContent: string }> = {
    fullRecord: { hidden: true, textContent: "" },
    dataScope: { hidden: false, textContent: "" },
    fullRecordText: { hidden: false, textContent: "" },
  };
  execute(
    (id: string) => elements[id],
    data,
    last ? [{ t: Date.parse(`${last}T00:00:00Z`) }] : [],
    mode,
    loading,
    loaded ? {} : data,
    () => (history ? "data.json" : ""),
  );
  return {
    hidden: elements.fullRecord.hidden,
    text: elements.fullRecordText.textContent,
    scopeHidden: elements.dataScope.hidden,
  };
}

it("reports loaded dates and download scope without inventing later deadlines or a truncation cause", () => {
  for (const [days, calendar, bytes, last] of [
    [180, "2027-02-04", 2048, "2027-02-04"],
    [30, "2028-06-05", 3 * 1024 * 1024, "2027-03-14"],
    [0, "", 0, "2027-04-23"],
  ] as const) {
    const result = renderOffer({ days, calendar, bytes, last });
    expect(result.hidden).toBe(false);
    expect(result.text).toContain(`読み込み済みのデータで一番先の締切は ${last} です`);
    expect(result.text).toContain("過去の締切も含めて収録全体を確認するには");
    expect(result.text).toContain("収録の全体を読み込む");
    expect(result.text).not.toMatch(
      /これより先の締切もあります|切れているため|一番遠い締切は.*ため/,
    );
    if (days) expect(result.text).toContain(`生成から ${days} 日先まで`);
    else expect(result.text).not.toMatch(/生成から \d+ 日|undefined|NaN/);
    if (calendar) expect(result.text).toContain(`カレンダー（.ics）には ${calendar} まで`);
    else expect(result.text).not.toContain("カレンダー（.ics）には");
    if (bytes) expect(result.text).toContain(bytes === 2048 ? "約 2 KB" : "約 3.0 MB");
    else expect(result.text).toContain("一覧より大きめのデータ");
  }
});
it("hides the offer when the full data is active, unavailable, loading, or has no dated rows", () => {
  for (const options of [
    { loaded: true },
    { history: false },
    { loading: true },
    { mode: true },
    { last: "" },
  ])
    expect(renderOffer(options).hidden).toBe(true);
});

it("hides an empty data-scope panel while preserving calendar content and load status", () => {
  expect(renderOffer({ calendar: "", loaded: true }).scopeHidden).toBe(true);
  expect(renderOffer({ calendar: "", history: false }).scopeHidden).toBe(true);
  expect(renderOffer({ calendar: "" }).scopeHidden).toBe(false);
  expect(renderOffer({ loaded: true }).scopeHidden).toBe(false);
  expect(renderOffer({ calendar: "", loading: true }).scopeHidden).toBe(false);
});
