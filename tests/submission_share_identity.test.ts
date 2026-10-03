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

it.each([false, true])("曖昧な旧リンク（確認済み別名=%s）で選択した候補だけを開く", (alias) => {
  const raw = [row(), row()];
  raw[1].dl.round = 2;
  const rows = assignShareIdentities(raw, legacy).map((r) => ({
    ...r,
    conf: { ...r.conf, legacy_keys: ["former-jip"] },
  }));
  const shareKey = new Function(`return (${jsFunction(siteRuntime(), "rowShareKeyJa")});`)();
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
  const choiceBox = { hidden: true };
  const guide = { textContent: "" };
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
    "rowShareKeyJa",
    `(${jsFunction(siteRuntime(), "restoreDrawerFromUrl")})();`,
  )(
    rows,
    rows,
    alias ? shareKey({ ...rows[0], shareDiscriminator: undefined }, "former-jip") : legacy(raw[0]),
    { mode: "deadlines" },
    (id: string) =>
      id === "sharedRowChoices" ? choiceBox : id === "sharedRowChoiceGuide" ? guide : live,
    document,
    (text: string) => {
      notice = text;
    },
    (r: unknown) => opened.push(r),
    { paper: "論文締切" },
    { titleWithYearJa: () => "JIP 2027" },
    (round: number, label: string) => `第${round}ラウンド ${label}`,
    shareKey,
  );
  expect(opened).toEqual([]);
  expect(notice).toContain("複数の日程");
  expect(choiceBox.hidden).toBe(false);
  expect(guide.textContent).toContain("複数の日程");
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

it("再処理でも両方の旧共有リンクと出典・検索文を保持し、会議のタグを失わない", () => {
  const raw = pair().map((r, i) => ({
    ...r,
    conf: { ...r.conf, tags: [i ? "special-issue" : "journal"] },
  }));
  const first = consolidateReviewedSubmissions(raw, legacy);
  expect(first[0].conf.tags).toEqual(["journal", "special-issue"]);
  for (let i = 0; i < 6; i++) expect(consolidateReviewedSubmissions(first, legacy)).toBe(first);
  const mixed = consolidateReviewedSubmissions([...first, raw[1]], legacy);
  expect(mixed[0].submission?.shareAliases).toEqual(first[0].submission?.shareAliases);
  expect(mixed[0].submission?.sourceRecords).toEqual(first[0].submission?.sourceRecords);
});

it("同じ開催回の別の投稿日程へ、確認済み論文募集の別名を流用しない", () => {
  const chosen = consolidateReviewedSubmissions(pair(), legacy)[0];
  const other = { ...chosen.dl, kind: "notification", label: "Notification" };
  const selected = { ...chosen, ed: { ...chosen.ed, deadlines: [chosen.dl, other] } };
  const run = new Function(
    "Recommender",
    "assignShareIdentities",
    "rowShareKeyJa",
    "rows",
    "selected",
    `${jsFunction(siteRuntime(), "editionScheduleRows")};return editionScheduleRows(selected);`,
  );
  const result = run(
    {
      candidateRows: () => [
        { ...selected, tShown: 1 },
        { ...selected, dl: other, kind: "notification", submission: undefined, tShown: 2 },
      ],
    },
    (r: unknown[]) => r,
    legacy,
    [selected],
    selected,
  );
  expect(result[0].submission).toEqual(selected.submission);
  expect(result[1].submission).toBeUndefined();
});

it("確認済みの会議別名だけで旧URLを照合し、年・種別・時刻・slotは変えない", () => {
  const key = new Function(`return (${jsFunction(siteRuntime(), "rowShareKeyJa")});`)();
  const r = {
    ...row("published-series"),
    conf: { key: "published-series", legacy_keys: ["former-series"] },
    shareDiscriminator: "round-2",
  };
  expect(key(r, "former-series")).toBe("former-series|2027|paper|1|slot=round-2");
  expect(key(r, "unrelated-series")).toBe(key(r));
  expect(key({ ...r, ed: { year: 2026 } }, "former-series")).not.toBe(key(r, "former-series"));
  expect(key({ ...r, t: 2 }, "former-series")).not.toBe(key(r, "former-series"));
  expect(key({ ...r, shareDiscriminator: "round-1" }, "former-series")).not.toBe(
    key(r, "former-series"),
  );
});
