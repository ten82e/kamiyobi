import { expect, it } from "vitest";
import {
  assignShareIdentities,
  COMPSAC_JIP_CALL,
  consolidateReviewedSubmissions,
} from "../site/submission-identity.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const legacy = (r: { conf: { key: string }; ed: { year?: number }; kind: string; t?: number }) =>
  `${r.conf.key}|${r.ed.year}|${r.kind}|${r.t}`;
function row(key = "jip", id = "jip-compsac2027-si", year = 2027, label = "投稿締切") {
  return {
    conf: { key, title: key },
    ed: { id, year, link: COMPSAC_JIP_CALL.officialUrl },
    dl: { kind: "paper", label, round: 1, track: "", precision: "date-only" },
    kind: "paper",
    localDate: "2026-12-01",
    hay: key,
    t: 1,
    cats: [],
    tags: [],
  };
}
const pair = () => [row(), row("ipsj-27-r-compsac", "ipsj-27-r26", 2026, "Submission")];

it.each(["year", "label", "round", "track", "missing-round"])(
  "確認済み募集に重なる別 %s の記録を失わない",
  (change) => {
    const raw = pair();
    const extra = row();
    if (change === "year") extra.ed.year = 2028;
    if (change === "label") extra.dl.label = "Industrial papers";
    if (change === "round") extra.dl.round = 2;
    if (change === "track") extra.dl.track = "industry";
    if (change === "missing-round") delete (extra.dl as { round?: number }).round;
    raw.push(extra);
    const before = JSON.stringify(raw);
    const shown = consolidateReviewedSubmissions(raw, legacy);
    expect(shown).toHaveLength(2);
    expect(shown).toContain(extra);
    expect(JSON.stringify(raw)).toBe(before);
  },
);

it("同じ日時の別ラウンド・トラック・開催回の共有URLを区別し、旧キーを残す", () => {
  const raw = [row(), row(), row(), row()];
  raw[1].dl.round = 2;
  raw[2].dl.label = "Industrial papers";
  raw[3].ed.id = "different-edition";
  const before = JSON.stringify(raw);
  const shown = assignShareIdentities(raw, legacy);
  expect(new Set(shown.map((r) => r.shareDiscriminator)).size).toBe(4);
  expect(shown.every((r) => r.legacyShareKey === legacy(raw[0]))).toBe(true);
  expect(shown.every((r, i) => r.dl === raw[i].dl)).toBe(true);
  expect(JSON.stringify(raw)).toBe(before);
});

it("月次締切の12ラウンドと他の特集号の共有URLは変えない", () => {
  const rolling = Array.from({ length: 12 }, (_, i) => ({
    ...row("vldb", "vldb27", 2027, "Paper submission"),
    t: i + 1,
    dl: { ...row().dl, round: i + 1 },
  }));
  const other = { ...row("other-special-issue", "other27", 2027), t: 99 };
  const raw = [...rolling, other];
  expect(assignShareIdentities(raw, legacy)).toEqual(raw);
  expect(assignShareIdentities(raw, legacy).every((r, i) => r === raw[i])).toBe(true);
  expect(consolidateReviewedSubmissions(raw, legacy)).toBe(raw);
});

it("曖昧な旧リンクで最初のラウンドを黙って開かず、選択した候補だけを開く", () => {
  const raw = [row(), row()];
  raw[1].dl.round = 2;
  const rows = assignShareIdentities(raw, legacy);
  const opened: unknown[] = [],
    buttons: Array<{
      textContent?: string;
      click?: () => void;
      style: object;
      addEventListener: (event: string, callback: () => void) => void;
    }> = [];
  const document = {
    createElement: () => {
      const button = {
        style: {},
        addEventListener: (_: string, callback: () => void) => {
          button.click = callback;
        },
        click: undefined as (() => void) | undefined,
      };
      return button;
    },
  };
  const live = { appendChild: (button: (typeof buttons)[number]) => buttons.push(button) };
  let notice = "";
  new Function(
    "rows",
    "shown",
    "pendingDrawerKey",
    "state",
    "$",
    "document",
    "sharedRowNotice",
    "openDrawer",
    "KIND_LABEL",
    "Recommender",
    "kindDetailJa",
    `(${jsFunction(siteRuntime(), "restoreDrawerFromUrl")})();`,
  )(
    rows,
    rows,
    legacy(raw[0]),
    { mode: "deadlines" },
    () => live,
    document,
    (text: string) => {
      notice = text;
    },
    (r: unknown) => opened.push(r),
    { paper: "論文締切" },
    { titleWithYearJa: () => "JIP 2027" },
    (round: number, label: string) => `第${round}ラウンド ${label}`,
  );
  expect(opened).toEqual([]);
  expect(notice).toContain("複数の日程");
  expect(buttons).toHaveLength(2);
  expect(buttons[1].textContent).toContain("第 2 ラウンド");
  buttons[1].click?.();
  expect(opened).toEqual([rows[1]]);
});

it("詳細の描画後にフォーカスを回復し、閉じた後や利用者の操作からは奪わない", () => {
  const source = jsFunction(siteRuntime(), "focusDrawerAfterRender");
  const selected = row();
  function harness() {
    const callbacks: Array<() => void> = [];
    let focuses = 0;
    const document = { activeElement: {} };
    let inside = false;
    const button = {
      focus: () => {
        focuses += 1;
      },
    };
    const run = new Function(
      "requestAnimationFrame",
      "drawerRow",
      "$",
      "document",
      "row",
      "button",
      `${source};return { open: () => focusDrawerAfterRender(row, button), close: () => { drawerRow = null; } };`,
    )(
      (callback: () => void) => callbacks.push(callback),
      selected,
      () => ({ contains: () => inside }),
      document,
      selected,
      button,
    );
    return {
      run,
      callbacks,
      focuses: () => focuses,
      moveInside: () => {
        inside = true;
      },
    };
  }
  const reopened = harness();
  reopened.run.open();
  expect(reopened.focuses()).toBe(1);
  reopened.callbacks[0]();
  expect(reopened.focuses()).toBe(2);
  const closed = harness();
  closed.run.open();
  closed.run.close();
  closed.callbacks[0]();
  expect(closed.focuses()).toBe(1);
  const navigated = harness();
  navigated.run.open();
  navigated.moveInside();
  navigated.callbacks[0]();
  expect(navigated.focuses()).toBe(1);
});
