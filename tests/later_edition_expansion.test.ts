import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const runtime = siteRuntime();
const conf = {
  key: "fresh",
  title: "Fresh",
  editions: Array.from({ length: 9 }, (_, i) => ({
    id: `edition${i}`,
    year: 2028 + i,
    event_start: `${2028 + i}-05-17`,
    event_end: `${2028 + i}-05-19`,
    event_date_precision: i === 1 ? "month-only" : i === 2 ? "unverified" : "exact-range",
    place: `City${i}, Japan`,
    deadlines: [],
  })),
};
const now = Date.parse("2028-01-01T00:00:00Z");
function collected(input: unknown = conf) {
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const drawer = jsFunction(runtime, "openDrawer");
  const init = /const laterEditions =([\s\S]*?);/.exec(drawer)?.[1];
  expect(init).toBeDefined();
  return new Function("Recommender", "r", "Date", `return (${init});`)(
    Recommender,
    { conf: input, ed: conf.editions[0] },
    Clock,
  ) as ReturnType<typeof Recommender.upcomingEditionsOf>;
}
function markup(rows: ReturnType<typeof collected>) {
  const render = new Function(
    "Recommender",
    "esc",
    `return (${jsFunction(runtime, "laterEditionsMarkup")});`,
  )(Recommender, new Function(`return (${jsFunction(runtime, "esc")});`)());
  const expr = /const laterEditionsHtml =([\s\S]*?);/.exec(jsFunction(runtime, "openDrawer"))?.[1];
  expect(expr).toBeDefined();
  return new Function("laterEditionsMarkup", "laterEditions", `return (${expr});`)(
    render,
    rows,
  ) as string;
}
function listItems(html: string) {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
}
describe("all future drawer editions are reachable", () => {
  it("collects every eligible edition through the real drawer expression, excluding the displayed one", () => {
    expect(collected().map((e) => e.editionId)).toEqual([
      "edition1",
      "edition2",
      "edition3",
      "edition4",
      "edition5",
      "edition6",
      "edition7",
      "edition8",
    ]);
    expect(Recommender.upcomingEditionsOf(conf, "2028-05-17", now)).toHaveLength(3);
  });
  it("renders the first three separately and exposes all remaining editions in a native disclosure", () => {
    const html = markup(collected());
    const detail = /<details><summary>(.*?)<\/summary>([\s\S]*?)<\/details>/.exec(html);
    expect(detail?.[1]).toBe("残り 5 開催回を表示");
    expect(listItems(html.slice(0, html.indexOf("<details>")))).toHaveLength(3);
    expect(listItems(detail![2])).toHaveLength(5);
    const items = listItems(html);
    expect(items).toHaveLength(8);
    for (let i = 1; i < 9; i++) {
      expect(items.filter((item) => item.includes(`City${i}, 日本`))).toHaveLength(1);
      expect(items[i - 1]).toContain(`原表記: City${i}, Japan`);
    }
    expect(html).toContain("2029-05（月のみ判明）");
    expect(html).toContain("（日付未確認）");
    expect(html).not.toContain("City0");
  });
  it("changes the remainder with the input, omits unnecessary controls, and clears empty content", () => {
    const rows = collected();
    expect(markup(rows.slice(0, 4))).toContain("残り 1 開催回を表示");
    expect(markup(rows.slice(0, 5))).toContain("残り 2 開催回を表示");
    expect(markup(rows.slice(0, 3))).not.toContain("<details>");
    expect(listItems(markup(rows.slice(0, 2)))).toHaveLength(2);
    expect(markup([])).toBe("");
  });
  it("keeps uncertain dates, split segments and original place wording bound to each edition", () => {
    const input = {
      editions: [
        {
          id: "month",
          year: 2029,
          event_start: "2029-05-17",
          event_end: "2029-05-19",
          event_date_precision: "month-only",
          place: "<City> & Japan",
        },
        {
          id: "split",
          year: 2029,
          event_date_precision: "split-dates",
          event_segments: [
            { start: "2029-06-01", end: "2029-06-01", label: "オンライン" },
            { start: "2029-06-05", end: "2029-06-05", label: "現地開催" },
          ],
          place: "Osaka, Japan",
        },
        {
          id: "unknown",
          year: 2029,
          event_start: "2030-07-01",
          event_end: "2030-07-03",
          event_date_precision: "not-announced",
          place: "Kyoto, Japan",
        },
      ],
    };
    const items = listItems(markup(collected(input)));
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("2029-05（月のみ判明）");
    expect(items[0]).toContain("原表記: &lt;City&gt; &amp; Japan");
    expect(items[0]).not.toContain("<City>");
    expect(items[1]).toContain("2029-06-01(金)（オンライン） / 2029-06-05(火)（現地開催）");
    expect(items[1]).toContain("原表記: Osaka, Japan");
    expect(items[2]).toContain("2029年の開催回: 会期未発表");
    expect(items[2]).toContain("原表記: Kyoto, Japan");
  });
});
