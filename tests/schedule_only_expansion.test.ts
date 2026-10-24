import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const runtime = siteRuntime();
const data = {
  conferences: [
    {
      key: "venue",
      title: "Venue",
      categories: ["systems"],
      editions: Array.from({ length: 6 }, (_, i) => ({
        id: `venue${2028 + i}`,
        year: 2028 + i,
        event_start: `${2029 + i}-02-17`,
        event_end: `${2029 + i}-02-19`,
        event_date_precision: i === 0 ? "not-announced" : i === 1 ? "month-only" : "exact-range",
        place: "Tokyo, Japan",
        link: `https://venue.example.org/${2028 + i}`,
        deadlines: [],
      })),
    },
  ],
};
class Node {
  children: Node[] = [];
  private ownText = "";
  hidden = true;
  href = "";
  title = "";
  type = "";
  tabIndex = 0;
  focused = false;
  events = new Map<string, () => void>();
  readonly tagName: string;
  constructor(tagName = "text") {
    this.tagName = tagName;
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  get textContent(): string {
    return this.ownText + this.children.map((n) => n.textContent).join("");
  }
  appendChild(child: Node) {
    this.children.push(child);
  }
  addEventListener(type: string, fn: () => void) {
    this.events.set(type, fn);
  }
  click() {
    this.events.get("click")?.();
  }
  focus() {
    this.focused = true;
  }
}
function visible(input: unknown = data, q = "") {
  class Clock extends Date {
    static now() {
      return Date.parse("2028-02-20T03:00:00Z");
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
  return run({ window: "all", cats: [], domestic: false, online: false, rank: "" }) as ReturnType<
    typeof Recommender.scheduleOnlyEditions
  >;
}
function renderer() {
  const box = new Node("div");
  const document = {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }),
  };
  const render = new Function(
    "Recommender",
    "document",
    "$",
    `${jsFunction(runtime, "fillScheduleOnlyList")}\n    return (${jsFunction(runtime, "renderNextMeetingNote")});`,
  )(Recommender, document, () => box);
  return { box, render };
}
const descendants = (box: Node): Node[] => box.children.flatMap((n) => [n, ...descendants(n)]);
const links = (box: Node) =>
  descendants(box).filter((n) => n.href.startsWith("https://venue.example.org/"));
const buttons = (box: Node) => box.children.filter((n) => n.tagName === "button");

describe("schedule-only editions can be identified and expanded in place", () => {
  it("keeps the named edition year separate from its postponed event year and supports copying its name", () => {
    const rows = visible();
    expect(rows.map((m) => m.year)).toEqual([2028, 2029, 2030, 2031, 2032, 2033]);
    const { box, render } = renderer();
    render(rows);
    expect(links(box).map((n) => n.textContent)).toEqual([
      "Venue 2028",
      "Venue 2029",
      "Venue 2030",
    ]);
    expect(box.textContent).toContain("会期未発表 Venue 2028");
    expect(box.textContent).toContain("2030-02（月のみ判明） Venue 2029");
    expect(visible(data, "Venue 2028").map((m) => m.year)).toEqual([2028]);
  });
  it("expands all remaining editions without losing or duplicating any original candidate", () => {
    const rows = visible();
    const { box, render } = renderer();
    render(rows);
    expect(links(box).map((n) => n.href)).toEqual(
      [2028, 2029, 2030].map((year) => `https://venue.example.org/${year}`),
    );
    expect(buttons(box)).toHaveLength(1);
    expect(buttons(box)[0].textContent).toBe("残り 3 開催回を表示");
    expect(buttons(box)[0].type).toBe("button");
    buttons(box)[0].click();
    expect(links(box).map((n) => n.href)).toEqual(
      [2028, 2029, 2030, 2031, 2032, 2033].map((year) => `https://venue.example.org/${year}`),
    );
    expect(new Set(links(box).map((n) => n.href)).size).toBe(6);
    expect(
      box.children.find((n) => n.tagName === "ul")?.children.filter((n) => n.tagName === "li"),
    ).toHaveLength(6);
    expect(buttons(box)).toEqual([]);
    expect(box.focused).toBe(true);
    expect(box.tabIndex).toBe(-1);
  });
  it("updates the remainder and clears old candidates when the result set changes", () => {
    const { box, render } = renderer();
    const rows = visible();
    render(rows.slice(0, 5));
    expect(buttons(box)[0].textContent).toBe("残り 2 開催回を表示");
    render(rows.slice(3));
    expect(links(box).map((n) => n.textContent)).toEqual([
      "Venue 2031",
      "Venue 2032",
      "Venue 2033",
    ]);
    expect(buttons(box)).toEqual([]);
    render([]);
    expect(box.hidden).toBe(true);
    expect(box.textContent).toBe("");
  });
  it("links to the bounded upcoming list without claiming all displayed editions appear there", () => {
    const { box, render } = renderer();
    render(visible());
    const link = box.children.find((n) => n.href === "upcoming.html");
    expect(link?.textContent).toBe("直近の締切と会期の一覧");
    expect(link?.title).toContain("期間外の開催回は載りません");
    expect(box.textContent).not.toContain("にも掲載");
    expect(box.textContent).not.toContain("upcoming.html");
  });
});
