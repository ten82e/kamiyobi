import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = () => siteRuntime("app.js");

function boundaryFilterHarness(now: number, past: boolean, win = "all", sortAsc = true) {
  const state = {
    mode: "deadlines",
    q: "",
    cats: [],
    kind: "",
    rank: "",
    win,
    est: false,
    domestic: false,
    online: false,
    past,
  };
  const run = new Function(
    "Recommender",
    "rows",
    "state",
    "Date",
    "sortAsc",
    `
      const DAY = 86400000;
      const sortKey = "rem";
      const $ = () => null;
      let searchQuery, venueLookupMiss, hiddenCounts, catFacetCounts;
      const semQuery = null, semEmbeddings = null;
      const conferenceNameCell = row => row.conf.key;
      const kindSortIndex = () => 0;
      ${[
        "windowLimitMs",
        "windowFloorMs",
        "rowShownDayMs",
        "rowAfter",
        "compareDeadlineRows",
        "filter",
      ]
        .map((name) => jsFunction(app(), name))
        .join("\n")}
      return filter();
    `,
  );
  return (rows: unknown[]) => run(Recommender, rows, state, { now: () => now }, sortAsc);
}

it("keeps uncertain-time deadlines outside the past block until their last possible instant", () => {
  const rows = Recommender.candidateRows({
    conferences: [
      {
        key: "demo",
        editions: [
          {
            year: 2026,
            deadlines: [
              { kind: "abstract", precision: "date-only", local_date: "2026-10-02" },
              { kind: "paper", utc: "2026-10-04T00:00:00Z" },
              { kind: "paper", utc: "2026-10-01T00:00:00Z" },
            ],
          },
        ],
      },
    ],
  });
  const uncertain = rows.find((row) => row.dateOnly);
  expect(uncertain).toBeDefined();
  if (!uncertain) throw new Error("date-only fixture missing");
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(now).toBeGreaterThan(uncertain.t);
  expect(now).toBeLessThan(uncertain.tLast);
  for (const asc of [true, false]) {
    const got = boundaryFilterHarness(now, true, "all", asc)(rows);
    expect(got.at(-1).dl.utc).toBe("2026-10-01T00:00:00Z");
    expect(got.find((row: typeof uncertain) => row.dateOnly)._pastBlock).toBe(0);
  }
  expect(boundaryFilterHarness(uncertain.tLast, false)(rows)).toContain(uncertain);
  expect(boundaryFilterHarness(uncertain.tLast + 1, false)(rows)).not.toContain(uncertain);
  expect(
    boundaryFilterHarness(
      uncertain.tLast + 1,
      true,
    )(rows).find((row: typeof uncertain) => row.dateOnly)._pastBlock,
  ).toBe(1);
});

it("excludes midnight of the next JST day from a seven-day deadline window", () => {
  const rows = Recommender.candidateRows({
    conferences: [
      {
        key: "demo",
        editions: [
          {
            year: 2026,
            deadlines: [
              { kind: "paper", utc: "2026-10-09T14:59:59Z" },
              { kind: "paper", utc: "2026-10-09T15:00:00Z" },
              { kind: "abstract", precision: "date-only", local_date: "2026-10-09" },
              { kind: "abstract", precision: "date-only", local_date: "2026-10-10" },
            ],
          },
        ],
      },
    ],
  });
  const got = boundaryFilterHarness(Date.parse("2026-10-02T12:00:00Z"), false, "7d")(rows);
  expect(
    got.map(
      (row: { dl: { utc?: string; local_date?: string } }) => row.dl.utc || row.dl.local_date,
    ),
  ).toEqual(["2026-10-09", "2026-10-09T14:59:59Z"]);
});

it("shows every recorded date of the selected edition, including a past abstract and another round", () => {
  const edition = {
    year: 2027,
    event_start: "2027-06-01",
    deadlines: [
      { kind: "paper", utc: "2026-10-09T11:59:59Z", round: 1, label: "Main track" },
      { kind: "abstract", utc: "2026-10-01T11:59:59Z", round: 1 },
      { kind: "paper", utc: "2026-12-01T11:59:59Z", round: 2, label: "Round 2" },
      { kind: "notification", utc: "2027-02-01T00:00:00Z" },
    ],
  };
  const otherEdition = {
    ...edition,
    event_start: "2027-09-01",
    deadlines: [{ kind: "abstract", utc: "2026-11-01T00:00:00Z", label: "Different meeting" }],
  };
  const conf = { key: "demo", title: "DEMO", editions: [edition, otherEdition] };
  const selected = Recommender.candidateRows({ conferences: [conf] })[0];
  const schedule = new Function(
    "Recommender",
    `${jsFunction(app(), "editionScheduleRows")}; return editionScheduleRows;`,
  )(Recommender);
  const got = schedule(selected);
  expect(got.map((row: typeof selected) => row.kind)).toEqual([
    "abstract",
    "paper",
    "paper",
    "notification",
  ]);
  expect(got.every((row: typeof selected) => row.ed === edition)).toBe(true);
  expect(got[1].dl).toBe(selected.dl);
  expect(got[2].dl.round).toBe(2);
});

it("retains unknown-time precision and sorts by displayed calendar day", () => {
  const edition = {
    year: 2026,
    deadlines: [
      { kind: "abstract", precision: "date-only", local_date: "2026-10-04" },
      { kind: "paper", utc: "2026-10-02T11:59:59Z", tz_raw: "AoE" },
    ],
  };
  const conf = { key: "demo", editions: [edition] };
  const selected = Recommender.candidateRows({ conferences: [conf] })[0];
  const schedule = new Function(
    "Recommender",
    `${jsFunction(app(), "editionScheduleRows")}; return editionScheduleRows;`,
  )(Recommender);
  const got = schedule(selected);
  expect(got[0].kind).toBe("paper");
  expect(got[1].dateOnly).toBe(true);
  expect(got[1].localDate).toBe("2026-10-04");
  expect(got[1].dl.utc).toBeUndefined();
});

function navigationHarness(restoring = false) {
  let url = new URL("https://example.org/kamiyobi/#results");
  const entries: Array<{ url: string; state: unknown }> = [];
  const history = {
    state: null as null | { kamiyobiDrawer: boolean },
    backs: 0,
    pushState(state: { kamiyobiDrawer: boolean }, _title: string, href: string) {
      entries.push({ url: href, state });
      this.state = state;
      url = new URL(href, url);
    },
    replaceState(state: { kamiyobiDrawer: boolean }, _title: string, href: string) {
      this.state = state;
      url = new URL(href, url);
    },
    back() {
      this.backs++;
    },
  };
  const state = {
    mode: "deadlines",
    q: "",
    cats: [],
    kind: "",
    rank: "",
    win: "all",
    est: false,
    domestic: false,
    online: false,
    past: false,
  };
  const api = new Function(
    "state",
    "history",
    "window",
    "$",
    "restoringNavigation",
    "rowShareKeyJa",
    `
    let drawerRow = null;
    let drawerOriginKey = "";
    let pendingDrawerReturnKey = "";
    const sortKey = 'rem', DEFAULT_SORT_KEY = 'rem', sortAsc = true;
    ${jsFunction(app(), "writeUrl")}
    return { writeUrl, returnKey: () => pendingDrawerReturnKey, setDrawer: (value) => { drawerRow = value; if (value && !drawerOriginKey) drawerOriginKey = value.key; } };
  `,
  )(
    state,
    history,
    {
      get location() {
        return url;
      },
    },
    () => ({ open: false }),
    restoring,
    (row: { key: string }) => row.key,
  );
  return { api, state, history, entries, url: () => url };
}

it("records filter changes, coalesces typing, and preserves the results anchor", () => {
  const nav = navigationHarness();
  nav.state.q = "I";
  nav.api.writeUrl("push");
  nav.state.q = "IPDPS";
  nav.api.writeUrl("replace");
  nav.api.writeUrl("push");
  expect(nav.entries).toHaveLength(1);
  expect(nav.url().searchParams.get("q")).toBe("IPDPS");
  expect(nav.url().hash).toBe("#results");
  nav.state.rank = "A";
  nav.api.writeUrl("push");
  expect(nav.entries).toHaveLength(2);
  expect(nav.url().searchParams.get("rank")).toBe("A");
});

it("closes a locally opened detail by going back, without adding entries while switching dates", () => {
  const nav = navigationHarness();
  nav.api.writeUrl("replace");
  nav.api.setDrawer({ key: "abstract" });
  nav.api.writeUrl("push");
  nav.api.setDrawer({ key: "paper" });
  nav.api.writeUrl("replace");
  expect(nav.entries).toHaveLength(1);
  expect(nav.history.state).toMatchObject({ kamiyobiOrigin: "abstract" });
  expect(nav.url().searchParams.get("row")).toBe("paper");
  nav.api.setDrawer(null);
  nav.api.writeUrl("close");
  expect(nav.history.backs).toBe(1);
  expect(nav.api.returnKey()).toBe("abstract");
});

it("closes a received shared detail without navigating away from the site", () => {
  const nav = navigationHarness();
  nav.api.setDrawer({ key: "paper" });
  nav.api.writeUrl("replace");
  nav.api.setDrawer(null);
  nav.api.writeUrl("close");
  expect(nav.history.backs).toBe(0);
  expect(nav.url().searchParams.has("row")).toBe(false);
});

it("restoring history does not rewrite it", () => {
  const nav = navigationHarness(true);
  nav.state.q = "IPDPS";
  nav.api.writeUrl("push");
  expect(nav.entries).toHaveLength(0);
  expect(nav.url().search).toBe("");
});

it("source freshness uses the actual fetch time and never substitutes the build date", () => {
  const note = new Function(
    "fmtJst",
    `${jsFunction(app(), "sourceUpdateNoteJa")}; return sourceUpdateNoteJa;`,
  )((date: Date) => date.toISOString());
  expect(
    note([{ name: "upstream", status: "cache-fallback", fetched_at: "2026-09-26T09:21:30Z" }]),
  ).toContain("保存済みデータ（2026-09-26T09:21:30.000Z）");
  expect(note([{ name: "upstream", status: "snapshot-fallback", fetched_at: null }])).toContain(
    "取得日時未確認",
  );
});

it("keeps fetch metadata when parsing the page catalog, without accepting malformed entries", () => {
  const parse = new Function(
    "isRecord",
    "isConferenceRecord",
    "sourceRecord",
    "calendarSpan",
    "catalogWindow",
    `${jsFunction(app(), "catalogFrom")}; return catalogFrom;`,
  )(
    (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
    () => true,
    () => null,
    () => undefined,
    () => undefined,
  );
  const source = { name: "ccfddl", status: "cache-fallback", fetched_at: "2026-09-26T09:21:30Z" };
  expect(
    parse({ conferences: [], source_updates: [source, null, { name: "invalid" }] }).source_updates,
  ).toEqual([source]);
  expect(parse({ conferences: [] }).source_updates).toEqual([]);
});

it("opens period-excluded schedules repeatedly and resolves their URLs without mixing editions", () => {
  const paper = { kind: "paper", utc: "2026-10-18T12:00:00Z", round: 2 };
  const abstract = { kind: "abstract", utc: "2026-07-01T12:00:00Z", round: 1 };
  const later = { kind: "paper", utc: "2027-05-01T12:00:00Z", round: 3 };
  const edition = { year: 2027, deadlines: [paper], schedule_deadlines: [abstract, later] };
  const other = {
    year: 2027,
    deadlines: [],
    schedule_deadlines: [{ kind: "abstract", utc: "2026-08-01T12:00:00Z", round: 1 }],
  };
  const conf = { key: "demo", editions: [edition, other] };
  const catalog = { conferences: [conf] };
  const functions = new Function(
    "Recommender",
    `
    ${jsFunction(app(), "editionScheduleRows")}
    ${jsFunction(app(), "rowShareKeyJa")}
    ${jsFunction(app(), "findEditionScheduleRow")}
    return { editionScheduleRows, rowShareKeyJa, findEditionScheduleRow };
  `,
  )(Recommender);
  const selected = Recommender.candidateRows(catalog)[0];
  const dates = functions.editionScheduleRows(selected);
  expect(dates.map((row: typeof selected) => row.dl)).toEqual([abstract, paper, later]);
  expect(dates.every((row: typeof selected) => row.ed === edition && row.conf === conf)).toBe(true);
  const past = dates[0];
  expect(functions.editionScheduleRows(past).map((row: typeof selected) => row.dl)).toEqual([
    abstract,
    paper,
    later,
  ]);
  const restored = functions.findEditionScheduleRow(catalog, functions.rowShareKeyJa(past));
  expect(restored.ed).toBe(edition);
  expect(restored.dl).toBe(abstract);
  expect(functions.findEditionScheduleRow(catalog, "missing")).toBeNull();
  expect(functions.findEditionScheduleRow(catalog, functions.rowShareKeyJa(selected))).toBeNull();
  expect(Recommender.candidateRows(catalog)).toHaveLength(1);
});

it("keeps upcoming dates visible and expands past dates when a past deadline is selected", () => {
  const past = { dl: {}, kind: "abstract", t: 1, tShown: 1, dateOnly: false };
  const future = { dl: {}, kind: "paper", t: 3, tShown: 3, dateOnly: false };
  const makeElement = (tag: string) => ({
    tag,
    children: [] as any[],
    open: false,
    textContent: "",
    attributes: {} as Record<string, string>,
    appendChild(child: any) {
      this.children.push(child);
    },
    insertBefore(child: any) {
      this.children.push(child);
    },
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    },
    addEventListener() {},
  });
  function render(selected: typeof past) {
    const body = makeElement("body");
    const fn = new Function(
      "document",
      "$",
      "editionScheduleRows",
      "KIND_LABEL",
      "fmtJst",
      "kindDetailJa",
      "rowIsPast",
      "openDrawer",
      `${jsFunction(app(), "renderEditionSchedule")}; return renderEditionSchedule;`,
    )(
      { createElement: makeElement },
      () => body,
      () => [past, future],
      { abstract: "概要", paper: "論文" },
      String,
      () => "",
      (row: typeof past) => row === past,
      () => {},
    );
    fn(selected);
    return body.children[0];
  }
  const active = render(future);
  const history = active.children.find((child: any) => child.tag === "details");
  const visible = active.children.find((child: any) => child.tag === "ul");
  expect(visible.children).toHaveLength(1);
  expect(visible.children[0].children[0].textContent).toContain("論文");
  expect(history.open).toBe(false);
  expect(history.children[0].textContent).toBe("終了済みの日程（1件）");
  expect(history.children[1].children[0].children[0].textContent).toContain("終了済み");
  const restored = render(past).children.find((child: any) => child.tag === "details");
  expect(restored.open).toBe(true);
  expect(restored.children[1].children[0].children[0].attributes["aria-current"]).toBe("true");
});

it("restores a list-window deadline excluded by kind without loosening URL filters", () => {
  const edition = {
    year: 2026,
    deadlines: [
      { kind: "abstract", precision: "date-only", local_date: "2026-10-25" },
      { kind: "paper", precision: "date-only", local_date: "2026-10-30" },
    ],
  };
  const catalog = {
    window: { lookback_days: 30, upcoming_days: 180 },
    conferences: [{ key: "demo", editions: [edition] }],
  };
  const rows = Recommender.candidateRows(catalog);
  const hidden = rows.find((row) => row.kind === "paper");
  if (!hidden) throw new Error("paper fixture missing");
  const state = { mode: "deadlines", q: "demo", kind: "abstract", past: false, est: false };
  const opened: unknown[] = [];
  const notices: string[] = [];
  const shareKey = new Function(`${jsFunction(app(), "rowShareKeyJa")}; return rowShareKeyJa;`)();
  new Function(
    "Recommender",
    "DATA",
    "rows",
    "shown",
    "state",
    "pendingDrawerKey",
    "openDrawer",
    "sharedRowNotice",
    `
    ${jsFunction(app(), "editionScheduleRows")}
    ${jsFunction(app(), "rowShareKeyJa")}
    ${jsFunction(app(), "findEditionScheduleRow")}
    const sharedRowState = () => "other";
    const SELECTABLE_KINDS = ["abstract", "paper"];
    const toForm = () => {};
    const render = () => {};
    const ensureRowsDrawn = () => {};
    const updateRowSelection = () => {};
    const loosenSharedRowConditions = () => {
      state.q = ""; state.kind = ""; return ["検索", "種別"];
    };
    let selectedIndex = -1;
    ${jsFunction(app(), "restoreDrawerFromUrl")}
    restoreDrawerFromUrl();
  `,
  )(
    Recommender,
    catalog,
    rows,
    rows.filter((row) => row.kind === "abstract"),
    state,
    shareKey(hidden),
    (row: typeof hidden) => opened.push(row),
    (text: string) => notices.push(text),
  );
  expect(opened).toHaveLength(1);
  expect((opened[0] as typeof hidden).dl).toBe(hidden.dl);
  expect(state).toEqual({
    mode: "deadlines",
    q: "demo",
    kind: "abstract",
    past: false,
    est: false,
  });
  expect(notices[0]).toContain("検索や絞り込み条件は保持");
});
