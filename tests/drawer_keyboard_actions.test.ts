import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const start = app.indexOf('$("drawer").addEventListener("keydown", (e) => {');
const end = /\n\s*}\);/.exec(app.slice(start));
if (start < 0 || !end) throw new Error("drawer keyboard wiring missing");
const wiring = app.slice(start, start + end.index + end[0].length);

function harness() {
  const calls: string[] = [];
  let active = 0;
  let listener = (_event: any) => {};
  const controls = [0, 1, 2].map((index) => ({
    focus: () => {
      active = index;
      calls.push(`focus:${index}`);
    },
  }));
  runInNewContext(wiring, {
    $: () => ({
      addEventListener: (_type: string, callback: typeof listener) => {
        listener = callback;
      },
      querySelectorAll: () => controls,
    }),
    document: {
      get activeElement() {
        return controls[active];
      },
    },
    closeDrawer: () => calls.push("close"),
  });
  return {
    calls,
    active: () => active,
    fire: (
      key: string,
      index: number,
      flags: Record<string, boolean | number | undefined> = {},
    ) => {
      active = index;
      listener({
        key,
        ...flags,
        preventDefault: () => calls.push("prevent"),
        stopPropagation: () => calls.push("stop"),
      });
    },
  };
}

it.each(["ctrlKey", "metaKey", "altKey"])("leaves %s dialog keys to the platform", (modifier) => {
  for (const [key, index, shiftKey] of [
    ["Tab", 2, false],
    ["Tab", 0, true],
    ["Escape", 1, false],
  ] as const) {
    const ui = harness();
    ui.fire(key, index, { [modifier]: true, shiftKey });
    expect(ui.calls, `${modifier}/${key}/${shiftKey}`).toEqual([]);
    expect(ui.active()).toBe(index);
  }
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "leaves composition keys inside the dialog ($isComposing/$keyCode)",
  (flags) => {
    for (const key of ["Escape", "Tab"]) {
      const ui = harness();
      ui.fire(key, 2, flags);
      expect(ui.calls).toEqual([]);
      expect(ui.active()).toBe(2);
    }
  },
);

it.each([
  { index: 2, shiftKey: false, expected: 0 },
  { index: 0, shiftKey: true, expected: 2 },
])("wraps ordinary Tab from $index to $expected", ({ index, shiftKey, expected }) => {
  const ui = harness();
  ui.fire("Tab", index, { shiftKey });
  expect(ui.calls).toEqual(["stop", "prevent", `focus:${expected}`]);
  expect(ui.active()).toBe(expected);
});

it("allows ordinary Tab between dialog controls", () => {
  const ui = harness();
  ui.fire("Tab", 1);
  expect(ui.calls).toEqual(["stop"]);
});

it("closes the dialog for ordinary Escape", () => {
  const ui = harness();
  ui.fire("Escape", 0);
  expect(ui.calls).toContain("prevent");
  expect(ui.calls.filter((call) => call === "close")).toHaveLength(1);
  expect(ui.calls.every((call) => ["prevent", "stop", "close"].includes(call))).toBe(true);
});
