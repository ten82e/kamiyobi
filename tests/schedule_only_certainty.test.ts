import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

function venue(key: string, start: string, end: string, precision = "exact-range", extra = {}) {
  return {
    key,
    title: key,
    categories: ["systems"],
    rank: { ccf: "B" },
    tags: [],
    editions: [
      {
        id: key,
        year: 2028,
        event_start: start,
        event_end: end,
        event_date_precision: precision,
        place: "Tokyo, Japan",
        deadlines: [],
        ...extra,
      },
    ],
  };
}
const data = {
  conferences: [
    venue("today", "2028-02-20", "2028-02-20"),
    venue("running", "2028-02-19", "2028-02-21"),
    venue("month", "2028-02-02", "2028-02-04", "month-only"),
    venue("unverified", "2028-02-22", "2028-02-23", "unverified"),
    venue("unannounced", "2028-02-22", "2028-02-24", "not-announced"),
    venue("split", "2028-02-01", "2028-02-28", "split-dates", {
      event_segments: [
        { start: "2028-02-01", end: "2028-02-01", label: "オンライン" },
        { start: "2028-02-28", end: "2028-02-28", label: "現地開催" },
      ],
    }),
    venue("estimated", "2028-02-22", "2028-02-24", "exact-range", { estimated: true }),
    venue("finished", "2028-02-19", "2028-02-19"),
    {
      ...venue("domestic", "2028-02-22", "2028-02-24"),
      tags: ["domestic-jp"],
      rank: { core: "A*" },
    },
    venue("online", "2028-02-22", "2028-02-24", "exact-range", { place: "Online" }),
    venue("has-deadline", "2028-02-22", "2028-02-24", "exact-range", {
      deadlines: [{ kind: "paper", utc: "2028-01-15T00:00:00Z" }],
    }),
  ],
};
const runtime = siteRuntime();
const at = "2028-02-20T03:00:00Z";
const options = { window: "all", cats: [] as string[], domestic: false, online: false, rank: "" };
function matches(input: unknown = data, now = at, q = "", filters = {}) {
  class Clock extends Date {
    static now() {
      return Date.parse(now);
    }
  }
  const run = new Function(
    "Recommender",
    "DATA",
    "searchQuery",
    "Date",
    "DAY",
    `
    ${jsFunction(runtime, "windowLimitMs")}
    return (${jsFunction(runtime, "scheduleOnlyMatches")});
  `,
  )(Recommender, input, q, Clock, 86400000);
  return run({ ...options, ...filters }) as ReturnType<typeof Recommender.scheduleOnlyEditions>;
}
const names = (rows: ReturnType<typeof matches>) => rows.map((m) => m.name).sort();
class Node {
  children: Node[] = [];
  textContent = "";
  hidden = true;
  href = "";
  title = "";
  appendChild(child: Node) {
    this.children.push(child);
  }
  text(): string {
    return this.textContent + this.children.map((n) => n.text()).join("");
  }
}
function render(rows: ReturnType<typeof matches>) {
  const box = new Node();
  const document = {
    createElement: () => new Node(),
    createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }),
  };
  new Function(
    "Recommender",
    "document",
    "$",
    "rows",
    `${jsFunction(runtime, "renderNextMeetingNote")}\nrenderNextMeetingNote(rows);`,
  )(Recommender, document, () => box, rows);
  return box;
}

describe("schedule-only UI respects date certainty and selected filters", () => {
  it("keeps current, ongoing and possible-month editions, excluding estimates and finished editions", () => {
    expect(names(matches())).toEqual([
      "domestic",
      "month",
      "online",
      "running",
      "split",
      "today",
      "unannounced",
      "unverified",
    ]);
    expect(names(matches(data, at, "", { window: "1" }))).toEqual(["month", "running", "today"]);
    expect(names(matches(data, "2028-02-20T14:59:59Z", "today"))).toEqual(["today"]);
    expect(matches(data, "2028-02-20T15:00:00Z", "today")).toEqual([]);
    expect(names(matches(data, "2028-02-29T14:59:59Z", "month"))).toEqual(["month"]);
    expect(matches(data, "2028-02-29T15:00:00Z", "month")).toEqual([]);
  });
  it("propagates certainty and split segments instead of describing the envelope as a continuous meeting", () => {
    const rows = matches();
    expect(rows.find((m) => m.name === "month")?.eventDatePrecision).toBe("month-only");
    expect(rows.find((m) => m.name === "split")?.eventSegments).toEqual([
      { start: "2028-02-01", end: "2028-02-01", label: "オンライン" },
      { start: "2028-02-28", end: "2028-02-28", label: "現地開催" },
    ]);
    expect(render(rows.filter((m) => m.name === "month")).text()).toContain(
      "2028-02（月のみ判明）",
    );
    expect(render(rows.filter((m) => m.name === "unverified")).text()).toContain("（日付未確認）");
    expect(render(rows.filter((m) => m.name === "unannounced")).text()).toContain("会期未発表");
    const split = render(rows.filter((m) => m.name === "split")).text();
    expect(split).toContain("2028-02-01(火)（オンライン） / 2028-02-28(月)（現地開催）");
    expect(split).not.toContain(" 〜 ");
  });
  it("honors the query, rank, category, domestic and online filters", () => {
    expect(names(matches(data, at, "month"))).toEqual(["month"]);
    expect(names(matches(data, at, "2028-02（月のみ判明）"))).toEqual(["month"]);
    expect(names(matches(data, at, "", { rank: "A*" }))).toEqual(["domestic"]);
    expect(names(matches(data, at, "", { domestic: true }))).toEqual(["domestic"]);
    expect(names(matches(data, at, "", { online: true }))).toEqual(["online"]);
    expect(matches(data, at, "", { cats: ["ai"] })).toEqual([]);
    expect(names(matches(data, at, "", { cats: ["systems"], rank: "A*" }))).toEqual(["domestic"]);
  });
  it("changes the same edition's certainty without changing its source dates", () => {
    const input = { conferences: [venue("dynamic", "2028-02-02", "2028-02-04")] };
    expect(matches(input)).toEqual([]);
    input.conferences[0].editions[0].event_date_precision = "month-only";
    const rows = matches(input);
    expect(names(rows)).toEqual(["dynamic"]);
    expect(render(rows).text()).toContain("2028-02（月のみ判明）");
    expect(input.conferences[0].editions[0].event_start).toBe("2028-02-02");
    expect(input.conferences[0].editions[0].event_end).toBe("2028-02-04");
  });
  it("renders factual absence of collected deadlines and links to HTML with an accurate description", () => {
    const box = render(matches(data, at, "month"));
    expect(box.hidden).toBe(false);
    expect(box.text()).toContain("投稿締切が未収録の開催回:");
    expect(box.text()).not.toMatch(/確定|締切が未定/);
    const link = box.children.find((n) => n.href === "upcoming.html");
    expect(link?.title).toContain("期間外の開催回は載りません");
    expect(link?.title).not.toContain("マークダウン");
    expect(render([]).hidden).toBe(true);
  });
  it("passes the selected rank through the real render call and shows the actual count in both text channels", () => {
    const src = jsFunction(runtime, "render");
    const init = /const scheduleOnly =([\s\S]*?);/.exec(src)?.[1];
    expect(init).toBeDefined();
    let received: unknown;
    const rows = matches(data, at, "", { rank: "A*" });
    const get = new Function(
      "scheduleOnlyMatches",
      "state",
      `const recMode=false,paperMode=false;return (${init});`,
    );
    expect(
      get(
        (filter: unknown) => {
          received = filter;
          return rows;
        },
        { win: "all", cats: [], domestic: false, online: false, rank: "A*" },
      ),
    ).toEqual(rows);
    expect(received).toMatchObject({ rank: "A*" });
    const block = /if \(shown.length && scheduleOnly.length\) \{([\s\S]*?)\n\s*\}/.exec(src)?.[1];
    expect(block).toBeDefined();
    const count = new Function(
      "scheduleOnly",
      "countJa",
      `let cnt='',cntLive='';${block};return {cnt,cntLive};`,
    )(rows, String);
    expect(count.cnt).toContain("開催回 1 件（投稿締切は未収録）");
    expect(count.cntLive).toBe(count.cnt);
    expect(count.cnt).not.toContain("確定");
  });
  it("keeps explicit split dates even without a continuous envelope", () => {
    const input = {
      conferences: [
        {
          key: "segments",
          title: "Segments",
          editions: [
            {
              id: "segments28",
              event_date_precision: "split-dates",
              deadlines: [],
              event_segments: [
                { start: "2028-02-01", end: "2028-02-01" },
                { start: "2028-02-28", end: "2028-02-28" },
              ],
            },
          ],
        },
      ],
    };
    expect(names(matches(input))).toEqual(["Segments"]);
    expect(matches(input, at, "", { window: "1" })).toEqual([]);
    expect(render(matches(input)).text()).toContain("2028-02-01(火) / 2028-02-28(月)");
  });
});
