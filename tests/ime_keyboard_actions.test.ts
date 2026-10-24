import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const start = app.indexOf('$("q").addEventListener("keydown", (e) => {');
const end = /\n\s*}\);/.exec(app.slice(start));
if (start < 0 || !end) throw new Error("search keyboard wiring missing");
const searchWiring = app.slice(start, start + end.index + end[0].length);
const buttonWiring = app.match(
  /\$\("showResults"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n\s*\}\);/,
)?.[0];
if (!buttonWiring) throw new Error("search results button wiring missing");
const queryWiring = app.match(/const cancelQueryUpdate = wireDebouncedInput\([^;]+;/)?.[0];
if (!queryWiring) throw new Error("search debounce wiring missing");
const functions = ["keyBlockedByTarget", "onKeydown", "wireDebouncedInput"]
  .map((name) => jsFunction(app, name))
  .join("\n");
function harness() {
  let active: unknown;
  const calls: string[] = [];
  class Element {
    value = "機械学習";
    isContentEditable = false;
    listeners = new Map<string, Array<(event?: any) => void>>();
    readonly id: string;
    readonly tagName: string;
    constructor(id: string, tagName: string) {
      this.id = id;
      this.tagName = tagName;
    }
    focus() {
      active = this;
      calls.push(`focus:${this.id}`);
    }
    blur() {
      active = undefined;
      calls.push(`blur:${this.id}`);
    }
    addEventListener(type: string, callback: (event?: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }
    fire(type: string, event?: any) {
      for (const callback of this.listeners.get(type) ?? []) callback(event);
    }
  }
  const nodes = {
    q: new Element("q", "INPUT"),
    showResults: new Element("showResults", "BUTTON"),
    abstract: new Element("abstract", "TEXTAREA"),
    editable: new Element("editable", "DIV"),
    body: new Element("body", "BODY"),
    results: new Element("results", "SECTION"),
    paperPrimaryTitle: new Element("paperPrimaryTitle", "INPUT"),
  };
  nodes.editable.isContentEditable = true;
  const context = {
    $: (id: string) => nodes[id as keyof typeof nodes],
    valueElement: (id: string) => nodes[id as keyof typeof nodes],
    setTimeout,
    clearTimeout,
    apply: () => calls.push("apply"),
    state: { mode: "deadlines" },
    selectedIndex: 1,
    shown: [0, 1, 2].map((i) => ({
      conf: { key: String(i), link: `https://example.org/${i}` },
      ed: { link: "" },
    })),
    window: { open: (href: string) => calls.push(`open:${href}`) },
    safeExternalUrl: (href: string) => href,
    updateRowSelection: () => {
      calls.push("selection");
      nodes.results.focus();
    },
    ensureRowsDrawn: () => calls.push("draw"),
    dataRows: () => [nodes.results, nodes.results, nodes.results],
    openDrawer: () => calls.push("drawer"),
    closeDrawer: () => calls.push("close"),
    onKeydown: (_event: any) => {},
  };
  runInNewContext(`${functions}\n${queryWiring}\n${buttonWiring}\n${searchWiring}`, context);
  return {
    context,
    nodes,
    calls,
    active: () => active,
    fire: (
      target: keyof typeof nodes,
      key: string,
      options: {
        isComposing?: boolean;
        keyCode?: number;
        ctrlKey?: boolean;
        metaKey?: boolean;
        altKey?: boolean;
      } = {},
    ) => {
      active = nodes[target];
      let stopped = false;
      const event = {
        key,
        keyCode: 0,
        isComposing: false,
        ...options,
        target: nodes[target],
        preventDefault: () => calls.push("prevent"),
        stopPropagation: () => {
          stopped = true;
          calls.push("stop");
        },
      };
      nodes[target].fire("keydown", event);
      if (!stopped) context.onKeydown(event);
    },
  };
}
afterEach(() => vi.useRealTimers());
it.each(["q", "abstract", "editable"] as const)(
  "keeps composition cancellation inside %s",
  (target) => {
    for (const flags of [
      { isComposing: true, keyCode: 27 },
      { isComposing: false, keyCode: 229 },
    ]) {
      const ui = harness();
      ui.fire(target, "Escape", flags);
      expect(ui.calls).toEqual([]);
      expect(ui.active()).toBe(ui.nodes[target]);
      expect(ui.nodes[target].value).toBe("機械学習");
    }
  },
);
it.each([
  { isComposing: true, keyCode: 13 },
  { isComposing: false, keyCode: 229 },
  { isComposing: true, keyCode: 229 },
])("does not submit search for an IME confirmation $isComposing/$keyCode", (flags) => {
  const ui = harness();
  ui.fire("q", "Enter", flags);
  expect(ui.calls).toEqual([]);
  expect(ui.active()).toBe(ui.nodes.q);
});
it.each(
  ["Enter", "ArrowDown", "j", "d", "/", "Escape"].flatMap((key) => [
    { key, isComposing: true, keyCode: 0 },
    { key, isComposing: false, keyCode: 229 },
  ]),
)("does not run global $key for an IME event $isComposing/$keyCode", ({ key, ...flags }) => {
  const ui = harness();
  ui.fire("body", key, flags);
  expect(ui.calls).toEqual([]);
  expect(ui.context.selectedIndex).toBe(1);
});
it("still applies ordinary Enter and focuses results", () => {
  const ui = harness();
  ui.fire("q", "Enter", { keyCode: 13 });
  expect(ui.calls).toEqual(["prevent", "apply", "focus:results"]);
  expect(ui.active()).toBe(ui.nodes.results);
});

it.each(["ctrlKey", "metaKey", "altKey"] as const)(
  "leaves modified search Enter to the platform (%s)",
  (modifier) => {
    const ui = harness();
    ui.fire("q", "Enter", { keyCode: 13, [modifier]: true });
    expect(ui.calls).toEqual([]);
    expect(ui.active()).toBe(ui.nodes.q);
    expect(ui.nodes.q.value).toBe("機械学習");
  },
);
it("still leaves the search field with ordinary Escape", () => {
  const ui = harness();
  ui.fire("q", "Escape", { keyCode: 27 });
  expect(ui.calls).toEqual(["prevent", "blur:q", "selection", "focus:results"]);
});
it("still opens the selected venue with ordinary Enter", () => {
  const ui = harness();
  ui.fire("body", "Enter", { keyCode: 13 });
  expect(ui.calls).toEqual(["open:https://example.org/1"]);
});
it.each(["j", "ArrowDown"])("still selects the next row with %s", (key) => {
  const ui = harness();
  ui.fire("body", key);
  expect(ui.context.selectedIndex).toBe(2);
  expect(ui.calls).toEqual(["prevent", "draw", "selection", "focus:results"]);
});
it("still focuses search with an ordinary slash", () => {
  const ui = harness();
  ui.fire("body", "/");
  expect(ui.calls).toEqual(["prevent", "focus:q"]);
});
it("applies a committed Japanese query once without stealing its confirmation Enter", () => {
  vi.useFakeTimers();
  const ui = harness();
  ui.nodes.q.fire("compositionstart");
  ui.nodes.q.fire("input");
  vi.advanceTimersByTime(200);
  expect(ui.calls).toEqual([]);
  ui.nodes.q.fire("compositionend");
  ui.fire("q", "Enter", { isComposing: false, keyCode: 229 });
  expect(ui.calls).toEqual([]);
  expect(ui.active()).toBe(ui.nodes.q);
  vi.advanceTimersByTime(180);
  expect(ui.calls).toEqual(["apply"]);
  expect(ui.nodes.q.value).toBe("機械学習");
});

it.each(["input", "compositionend"])(
  "does not reapply a queued %s after explicit Enter and row navigation",
  (event) => {
    vi.useFakeTimers();
    const ui = harness();
    ui.nodes.q.fire(event);
    ui.fire("q", "Enter", { keyCode: 13 });
    expect(ui.calls).toEqual(["prevent", "apply", "focus:results"]);
    ui.fire("body", "j");
    const selected = ui.context.selectedIndex;
    const calls = [...ui.calls];
    vi.advanceTimersByTime(500);
    expect(ui.calls).toEqual(calls);
    expect(ui.context.selectedIndex).toBe(selected);
    expect(ui.active()).toBe(ui.nodes.results);
  },
);

it("continues to debounce later input after explicit Enter", () => {
  vi.useFakeTimers();
  const ui = harness();
  ui.nodes.q.fire("input");
  ui.fire("q", "Enter", { keyCode: 13 });
  vi.advanceTimersByTime(90);
  ui.nodes.q.value = "ネットワーク";
  ui.nodes.q.fire("input");
  vi.advanceTimersByTime(179);
  expect(ui.calls.filter((call) => call === "apply")).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(ui.calls.filter((call) => call === "apply")).toHaveLength(2);
  expect(ui.nodes.q.value).toBe("ネットワーク");
});

it.each(["input", "compositionend"])(
  "applies a pending %s before leaving search with Escape",
  (event) => {
    vi.useFakeTimers();
    const ui = harness();
    ui.nodes.q.fire(event);
    ui.fire("q", "Escape");
    expect(ui.calls).toEqual(["prevent", "stop", "apply", "focus:results"]);
    expect(ui.nodes.q.value).toBe("機械学習");
    ui.fire("body", "j");
    const calls = [...ui.calls];
    vi.advanceTimersByTime(500);
    expect(ui.calls).toEqual(calls);
    ui.nodes.q.fire("input");
    vi.advanceTimersByTime(180);
    expect(ui.calls.filter((call) => call === "apply")).toHaveLength(2);
  },
);

it("preserves the selected row when Escape follows an already applied query", () => {
  vi.useFakeTimers();
  const ui = harness();
  ui.nodes.q.fire("input");
  vi.advanceTimersByTime(180);
  ui.calls.length = 0;
  ui.fire("q", "Escape");
  expect(ui.calls).toEqual(["prevent", "blur:q", "selection", "focus:results"]);
  expect(ui.context.selectedIndex).toBe(1);
});

it.each(["none", "empty", "out-of-range"])(
  "focuses results when Escape has no valid selected row (%s)",
  (selection) => {
    const ui = harness();
    if (selection === "empty") ui.context.shown = [];
    else ui.context.selectedIndex = selection === "none" ? -1 : 10;
    ui.fire("q", "Escape");
    expect(ui.calls).toEqual(["prevent", "blur:q", "focus:results"]);
    expect(ui.nodes.q.value).toBe("機械学習");
    expect(ui.active()).toBe(ui.nodes.results);
  },
);

it.each([
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { isComposing: true },
  { keyCode: 229 },
])(
  "does not flush pending search for protected Escape ($ctrlKey/$metaKey/$altKey/$isComposing/$keyCode)",
  (flags) => {
    vi.useFakeTimers();
    const ui = harness();
    ui.nodes.q.fire("input");
    ui.fire("q", "Escape", flags);
    expect(ui.calls).toEqual([]);
    vi.advanceTimersByTime(180);
    expect(ui.calls).toEqual(["apply"]);
    expect(ui.active()).toBe(ui.nodes.q);
  },
);

it.each(["ctrlKey", "metaKey", "altKey"] as const)(
  "keeps a pending query update for modified Enter (%s)",
  (modifier) => {
    vi.useFakeTimers();
    const ui = harness();
    ui.nodes.q.fire("input");
    ui.fire("q", "Enter", { [modifier]: true });
    expect(ui.calls).toEqual([]);
    vi.advanceTimersByTime(180);
    expect(ui.calls).toEqual(["apply"]);
    expect(ui.active()).toBe(ui.nodes.q);
  },
);

it("shows results from the button once, without a delayed second update", () => {
  vi.useFakeTimers();
  const ui = harness();
  ui.nodes.q.fire("input");
  ui.nodes.showResults.fire("click");
  expect(ui.calls).toEqual(["apply", "focus:results"]);
  expect(ui.nodes.q.value).toBe("機械学習");
  vi.advanceTimersByTime(500);
  expect(ui.calls).toEqual(["apply", "focus:results"]);
  expect(ui.active()).toBe(ui.nodes.results);
});
