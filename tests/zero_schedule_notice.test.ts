import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

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

it("shows matching schedules in the empty-state explanation instead of asking for a different query", () => {
  const hint = deadlineHintFunction();
  const input = {
    ...filter,
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "paper",
    est: false,
  };
  for (const scheduleOnlyCount of [1, 1234]) {
    const text = hint({ ...input, scheduleOnlyCount });
    expect(text).toContain(
      `開催回が ${scheduleOnlyCount.toLocaleString("ja-JP")} 件見つかりました`,
    );
    expect(text).toContain("会期情報は下に表示しています");
    expect(text).not.toMatch(/打ち直すなら|別の語で試す|収録データにありません|条件を緩める/);
    expect(hint({ ...input, scheduleOnlyCount, urlQuery: true })).not.toContain(
      "収録に見当たりません",
    );
  }
  expect(hint({ ...input, scheduleOnlyCount: 0 })).toContain("打ち直すなら");
  expect(hint(input)).toContain("打ち直すなら");
  expect(hint({ ...input, scheduleOnlyCount: 1, catalogConferences: 0 })).toContain(
    "データが入っていません",
  );
});
it("passes the actual filtered schedule count to the empty-state explanation", () => {
  const render = jsFunction(runtime, "render");
  const call = /textContent = (emptyDeadlineHint\([\s\S]*?\));/.exec(render)?.[1];
  expect(call).toBeDefined();
  let received: Record<string, unknown> | undefined;
  new Function("emptyDeadlineHint", "filter", "scheduleOnly", `return (${call});`)(
    (value: Record<string, unknown>) => {
      received = value;
      return "";
    },
    filter,
    [{}, {}, {}],
  );
  expect(received).toMatchObject({ ...filter, scheduleOnlyCount: 3 });
});

it("still says the typed venue is in the collection when only other venues' schedules match", () => {
  const hint = deadlineHintFunction();
  const input = {
    ...filter,
    query: "SIGCOMM",
    queryMatch: { catalog: 12, journal: 0 },
    termCounts: [{ term: "SIGCOMM", count: 12 }],
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "paper",
    est: false,
    scheduleOnlyCount: 2,
  };
  const text = hint(input);
  // 主催の同じ会議の会期だけを並べて、打った会議その物が収録に無いように読ませない。
  expect(text).toContain("検索語「SIGCOMM」は収録済みで 12 件に当たります");
  expect(text).toContain("開催回が 2 件見つかりました");
  expect(text.indexOf("収録済み")).toBeLessThan(text.indexOf("開催回が"));
  expect(hint({ ...input, queryMatch: { catalog: 0, journal: 0 } })).not.toContain("収録済み");
});
