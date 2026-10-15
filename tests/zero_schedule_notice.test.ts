import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const runtime = siteRuntime();
const note = new Function(
  "Recommender",
  "countJa",
  `return (${jsFunction(runtime, "zeroResultLiveNote")});`,
)(Recommender, (value: number) => value.toLocaleString("ja-JP"));
const filter = {
  catalogConferences: 1,
  query: "未発表検証",
  queryMatch: { catalog: 0, journal: 0 },
  termCounts: [{ term: "未発表検証", count: 0 }],
  hiddenKindWords: [],
  shorterHits: [],
  urlQuery: false,
  clearable: true,
  pastShown: false,
  hidden: {},
};
it("announces matching schedule-only editions without claiming their query is absent, and clears the notice", () => {
  for (const scheduleOnlyCount of [1, 1234]) {
    const text = note({ ...filter, scheduleOnlyCount });
    expect(text).toContain(`会期情報がある開催回 ${scheduleOnlyCount.toLocaleString("ja-JP")} 件`);
    expect(text).toContain("投稿締切は未収録");
    expect(text).not.toMatch(
      /収録データにありません|収録に見当たりません|いま以降の締切が残っていません/,
    );
    expect(text.length).toBeLessThanOrEqual(60);
  }
  expect(note({ ...filter, scheduleOnlyCount: 0 })).toContain("収録データにありません");
  expect(note(filter)).toContain("収録データにありません");
  expect(note({ ...filter, scheduleOnlyCount: 1, clearable: false, pastShown: true })).toContain(
    "会期情報がある開催回 1 件",
  );
  expect(note({ ...filter, scheduleOnlyCount: 1, urlQuery: true })).not.toContain(
    "収録に見当たりません",
  );
});
it("passes the actual filtered schedule count to the live notice from the render path", () => {
  const render = jsFunction(runtime, "render");
  const call = /cntLive \+= (zeroResultLiveNote\(\{[\s\S]*?\}\));/.exec(render)?.[1];
  expect(call).toBeDefined();
  let received: Record<string, unknown> | undefined;
  new Function(
    "zeroResultLiveNote",
    "zeroFilter",
    "filtersClearable",
    "state",
    "scheduleOnly",
    `return (${call});`,
  )(
    (value: Record<string, unknown>) => {
      received = value;
      return "";
    },
    filter,
    () => true,
    { past: false },
    [{}, {}, {}],
  );
  expect(received).toMatchObject({ ...filter, scheduleOnlyCount: 3 });
});
