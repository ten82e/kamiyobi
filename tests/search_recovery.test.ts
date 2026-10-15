import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

const now = Date.parse("2026-10-15T03:00:00Z");
const initial = {
  mode: "deadlines",
  q: "ＮＳＤＩ",
  cats: [] as string[],
  kind: "",
  rank: "",
  win: "all",
  est: false,
  domestic: false,
  online: false,
  past: false,
};
function edition(id: string, utc: string, estimated = false) {
  return {
    id,
    year: 2026,
    estimated,
    event_start: null,
    event_end: null,
    place: "Seattle, USA",
    deadlines: [{ kind: "paper", utc, tz_raw: "UTC" }],
  };
}
const data = {
  conferences: [
    {
      key: "nsdi",
      title: "NSDI",
      full_name: "Networked Systems Design and Implementation",
      rank: { ccf: "B" },
      categories: ["networks"],
      tags: [],
      editions: [
        edition("nsdi-past", "2026-09-15T00:00:00Z"),
        edition("nsdi-estimated", "2026-12-01T00:00:00Z", true),
        edition("nsdi-past-estimated", "2026-08-01T00:00:00Z", true),
      ],
    },
    {
      key: "other",
      title: "OTHER",
      rank: { ccf: "A*" },
      categories: ["graphics"],
      tags: [],
      editions: [
        ...Array.from({ length: 5 }, (_, i) => edition(`other${i}`, `2026-09-0${i + 1}T00:00:00Z`)),
        edition("other-future", "2026-12-10T00:00:00Z"),
      ],
    },
    {
      key: "domestic",
      title: "システム研究会",
      rank: {},
      categories: ["systems"],
      tags: ["domestic-jp"],
      editions: [edition("jp1", "2026-09-01T00:00:00Z"), edition("jp2", "2026-09-02T00:00:00Z")],
    },
  ],
};
interface Action {
  key: string;
  label: string;
  count: number;
  changes: Partial<typeof initial>;
}
function run(overrides: Partial<typeof initial> = {}, click?: string, partial = false) {
  const code = [
    "windowLimitMs",
    "windowFloorMs",
    "rowShownDayMs",
    "rowAfter",
    "compareDeadlineRows",
    "filter",
    "deadlineRecoveryOptions",
    "collectDeadlineRecoveries",
    "renderDeadlineRecoveries",
    "countJa",
  ]
    .map((name) => jsFunction(siteRuntime(), name))
    .join("\n");
  return new Function(
    "Recommender",
    "data",
    "original",
    "Date",
    "click",
    "partial",
    `
 const DAY=86400000, sortKey="rem", sortAsc=true;
 const rows=Recommender.candidateRows(data), activeData=data;
 let state=original, searchQuery,venueLookupMiss,hiddenCounts,catFacetCounts,截つた行,recommendationCandidateCount;
 const semQuery=null,semEmbeddings=null;
 const conferenceNameCell=row=>row.conf.key, kindSortIndex=()=>0;
 const box={textContent:"",hidden:true,children:[],appendChild(child){this.children.push(child)}};
 let focus=false,formCalls=0,applyCalls=0,shown=[];
 const $=id=>id==="emptyRecovery"?box:id==="results"?{focus(){focus=true}}:null;
 const document={createElement(){return {textContent:"",addEventListener(name,callback){this[name]=callback}}}};
 const toForm=()=>{formCalls++}, apply=()=>{applyCalls++;shown=filter()};
 ${code}
 shown=filter();
 const count=shown.length, before=JSON.stringify({hiddenCounts,catFacetCounts,searchQuery});
 const actions=collectDeadlineRecoveries();
 const restored=before===JSON.stringify({hiddenCounts,catFacetCounts,searchQuery}) && state===original;
 renderDeadlineRecoveries(actions,partial);
 const labels=box.children.map(button=>button.textContent);
 if(click){const at=actions.findIndex(action=>action.key===click);if(at<0)throw new Error("action missing");box.children[at].click();}
 return {count,actions,restored,labels,hidden:box.hidden,state,shown:shown.map(row=>row.ed.id),formCalls,applyCalls,focus};
 `,
  )(Recommender, data, { ...initial, ...overrides }, { now: () => now }, click, partial) as {
    count: number;
    actions: Action[];
    restored: boolean;
    labels: string[];
    hidden: boolean;
    state: typeof initial;
    shown: string[];
    formCalls: number;
    applyCalls: number;
    focus: boolean;
  };
}
it("counts only candidates matching the current full-width query, not global excluded rows", () => {
  const result = run();
  expect(result.count).toBe(0);
  expect(result.actions.map((a) => [a.key, a.count])).toEqual([
    ["past", 1],
    ["est", 1],
  ]);
  expect(result.restored).toBe(true);
  expect(result.state).toEqual(initial);
});
it("counts Japanese input against its own matching editions", () => {
  expect(run({ q: "ｼｽﾃﾑ研究会" }).actions.map((a) => [a.key, a.count])).toEqual([["past", 2]]);
});
it.each([
  ["rank", { est: true, rank: "A*" }],
  ["cats", { est: true, cats: ["graphics"] }],
  ["domestic", { est: true, domestic: true }],
  ["online", { est: true, online: true }],
  ["kind", { est: true, kind: "abstract" }],
  ["window", { est: true, win: "7d" }],
] as const)("offers %s only when changing it really restores a result", (key, state) => {
  const result = run({ ...state, cats: "cats" in state ? [...state.cats] : [] });
  expect(result.count).toBe(0);
  expect(result.actions.map((a) => [a.key, a.count])).toEqual([[key, 1]]);
  expect(result.restored).toBe(true);
});
it("offers one combined change when individual relaxations cannot recover a row", () => {
  const result = run({ rank: "A*", cats: ["graphics"], domestic: true });
  expect(result.count).toBe(0);
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0]).toMatchObject({ key: "combined", count: 2 });
  expect(result.actions[0].changes).not.toHaveProperty("q");
  expect(result.actions[0].changes).not.toHaveProperty("mode");
  const clicked = run({ rank: "A*", cats: ["graphics"], domestic: true }, "combined");
  expect(clicked.state.q).toBe("ＮＳＤＩ");
  expect(clicked.shown.sort()).toEqual(["nsdi-estimated", "nsdi-past"]);
});
it("does not offer irrelevant past or estimated rows for an unknown query", () => {
  const result = run({ q: "not-a-venue-98765" });
  expect(result.actions).toEqual([]);
  expect(result.hidden).toBe(true);
  expect(result.restored).toBe(true);
});
it("clicking a recovery keeps the query and other conditions, applies the result and focuses it", () => {
  const result = run({}, "past", true);
  expect(result.state).toEqual({ ...initial, past: true });
  expect(result.shown).toEqual(["nsdi-past"]);
  expect(result.labels).toContain("過去の締切も表示（1 件以上）");
  expect(result.labels).toContain("推定締切を含める（1 件）");
  expect(result.formCalls).toBe(1);
  expect(result.applyCalls).toBe(1);
  expect(result.focus).toBe(true);
});
it("does not duplicate misleading global exclusion counts beside recovery buttons", () => {
  const hint = deadlineHintFunction()({
    actionableRecovery: true,
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "",
    est: false,
    query: "NSDI",
    hidden: { past: 999, est: 888 },
    hiddenKindWords: [],
    queryMatch: { catalog: 1, journal: 0 },
    termCounts: [{ term: "NSDI", count: 1 }],
    catalogConferences: 3,
  });
  expect(hint).not.toContain("999");
  expect(hint).not.toContain("888");
  expect(hint).not.toContain("外せる条件:");
});

it("passes the computed recovery plan and suppresses global counts through the real render expressions", () => {
  const text = jsFunction(siteRuntime(), "render");
  function initializer(name: string) {
    const expression = new RegExp(`const ${name} =([\\s\\S]*?);`).exec(text)?.[1];
    expect(expression, `${name} is missing from render`).toBeDefined();
    return expression!;
  }
  const get = new Function(
    "Recommender",
    "collectDeadlineRecoveries",
    "state",
    "shown",
    "recMode",
    `
    const paperMode=false,searchQuery=state.q,DATA={conferences:[{},{},{}]},rows=[],KIND_LABEL={};
    const hiddenDeadlineCounts=()=>({past:999,est:888}),hiddenKindQueryWords=()=>[];
    const queryMatchCounts=()=>({catalog:3,journal:0}),queryTermNotes=()=>[];
    const columnValueHitsJa=()=>false,splitCountJa=()=>0,shorterWordsForZero=()=>[],deadTermRemainderCount=()=>null;
    const farthestRowDayJa=()=>"",nameOnlyRecordInfo=()=>null,nameOnlyConferenceMatch=()=>null,categoryChipKeys=()=>[];
    const recoveries=${initializer("recoveries")};
    const zeroFilter=${initializer("zeroFilter")};
    return {recoveries,zeroFilter};
  `,
  );
  const result = get(Recommender, () => run().actions, initial, [], false);
  expect(result.recoveries.map((action: Action) => [action.key, action.count])).toEqual([
    ["past", 1],
    ["est", 1],
  ]);
  const hint = deadlineHintFunction()(result.zeroFilter);
  expect(hint).not.toContain("999");
  expect(hint).not.toContain("888");
  for (const [shown, mode] of [
    [[], true],
    [[{}], false],
  ]) {
    expect(
      get(
        Recommender,
        () => {
          throw new Error("recovery ran outside empty deadline view");
        },
        initial,
        shown,
        mode,
      ),
    ).toEqual({ recoveries: [], zeroFilter: null });
  }
});
