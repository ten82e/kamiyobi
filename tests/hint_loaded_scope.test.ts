import { expect, it } from "vitest";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

const hint = deadlineHintFunction();
const base = {
  query: "2030-05-17",
  queryDaySpan: { first: "2030-05-17", last: "2030-05-17", label: "2030-05-17" },
  loadedLastDay: "2029-02-01",
  recordLastDay: "",
  horizonDays: 180,
  fullRecordLoaded: false,
  canLoadFullRecord: true,
  window: "all",
  past: false,
  cats: 0,
  domestic: false,
  online: false,
  rank: "all",
  kind: "",
  est: false,
  hidden: { past: 0, est: 0, window: 0, rank: 0, cats: 0, domestic: 0, online: 0, kind: 0 },
  hiddenKindWords: [],
  termCounts: [{ term: "2030-05-17", count: 0 }],
  queryMatch: { catalog: 0, journal: 0 },
  urlQuery: false,
  catalogConferences: 1,
};
it("describes the loaded range without claiming the last recorded date proves truncation", () => {
  for (const days of [30, 180, 0]) {
    const text = hint({ ...base, horizonDays: days });
    expect(text).toContain("2029-02-01");
    expect(text).toContain("収録の全体を読み込む");
    expect(text).not.toContain("切れているため");
    if (days) expect(text).toContain(`初期表示は生成から ${days} 日先まで`);
    else expect(text).not.toMatch(/生成から \d+ 日|一定の日数先で切れ/);
  }
});
it("uses the actual full-data edge after loading even when calendar metadata is missing or stale", () => {
  for (const recordLastDay of ["", "2028-01-01", "2032-01-01"]) {
    const text = hint({ ...base, fullRecordLoaded: true, recordLastDay });
    expect(text).toContain("収録している中で一番遠い締切 2029-02-01 より先");
    expect(text).toContain("まだ確認できていません");
    expect(text).not.toContain("収録の全体を読み込む");
    expect(text).not.toContain("初期表示は");
  }
});
it("does not offer an unavailable full-record action", () => {
  for (const recordLastDay of ["", "2032-01-01"]) {
    const text = hint({ ...base, canLoadFullRecord: false, recordLastDay });
    expect(text).toContain("いま読み込んでいるデータ");
    expect(text).toContain("まだ確認できていません");
    expect(text).not.toContain("収録の全体を読み込む");
  }
});
it("derives loaded scope and action availability from the actual render state", () => {
  const render = jsFunction(siteRuntime(), "render");
  const loaded = /fullRecordLoaded:\s*([^,]+),/.exec(render)?.[1];
  const available = /canLoadFullRecord:\s*([^,]+),/.exec(render)?.[1];
  expect(loaded).toBeDefined();
  expect(available).toBeDefined();
  const inspect = new Function(
    "DATA",
    "activeData",
    "historyStatus",
    "resolveHistoryRef",
    `return {loaded: ${loaded}, available: ${available}}`,
  );
  const data = {};
  expect(inspect(data, data, "idle", () => "data.json")).toEqual({
    loaded: false,
    available: true,
  });
  expect(inspect(data, {}, "ready", () => "data.json")).toEqual({ loaded: true, available: false });
  for (const status of ["loading", "error"])
    expect(inspect(data, data, status, () => "data.json")).toEqual({
      loaded: false,
      available: false,
    });
  expect(inspect(data, data, "idle", () => "")).toEqual({ loaded: false, available: false });
});
