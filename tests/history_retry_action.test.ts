import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const start = app.indexOf('$("historyRetry").addEventListener("click", () => {');
const close = /\n\s*}\);/.exec(app.slice(start));
if (start < 0 || !close) throw new Error("history retry wiring missing");
const wiring = app.slice(start, start + close.index + close[0].length);
const fullStart = app.indexOf('fullRecordButton.addEventListener("click", () => {');
const fullClose = /\n\s*}\);/.exec(app.slice(fullStart));
if (fullStart < 0 || !fullClose) throw new Error("full record button wiring missing");
const fullWiring = app.slice(fullStart, fullStart + fullClose.index + fullClose[0].length);
const functions = [
  "fullRecordNeeded",
  "createHistoryLoader",
  "resolveHistoryRef",
  "loadHistoryData",
  "fetchHistoryJson",
  "syncHistoryState",
  "updateHistoryStatus",
  "stopHistoryLoad",
]
  .map((name) => jsFunction(app, name))
  .join("\n");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(past = false) {
  let active: unknown;
  class Element {
    _hidden = true;
    get hidden() {
      return this._hidden;
    }
    set hidden(value: boolean) {
      this._hidden = value;
      if (value && active === this) active = undefined;
    }
    disabled = false;
    textContent = "";
    attributes = new Map<string, string>();
    listener = () => {};
    addEventListener(_name: string, callback: () => void) {
      this.listener = callback;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    toggleAttribute(name: string, present: boolean) {
      if (name === "disabled") {
        this.disabled = present;
        if (present && active === this) active = undefined;
      }
    }
    focus() {
      active = this;
    }
    click() {
      if (!this.disabled) {
        this.focus();
        this.listener();
      }
    }
  }
  const nodes = Object.fromEntries(
    ["historyStatus", "historyStatusText", "historyRetry", "fullRecordButton", "results", "q"].map(
      (id) => [id, new Element()],
    ),
  );
  const requests: Array<{
    ref: string;
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const initial = { history_ref: "data.json", conferences: [{ key: "initial", editions: [] }] };
  const context = {
    state: {
      mode: "deadlines",
      past,
      win: "all",
      q: "並列計算",
      kind: "paper",
      rank: "A",
      cats: ["hpc"],
    },
    fullRecordRequested: !past,
    historyStatus: "idle",
    DATA: initial,
    activeData: initial,
    window: { location: { href: "https://example.org/", origin: "https://example.org" } },
    URL,
    $: (id: string) => nodes[id],
    document: {
      get activeElement() {
        return active;
      },
    },
    HISTORY_LOADING_JA: "loading-state",
    HISTORY_ERROR_JA: "error-state",
    fetch: (ref: string) =>
      new Promise((resolve, reject) => requests.push({ ref, resolve, reject })),
    catalogFrom: (value: unknown) => value,
    setDeadlineProfile: (value: typeof initial) => {
      context.activeData = value;
    },
    render: () => {},
    loadHistoryData: () => {},
    updateHistoryStatus: (_recommend: boolean) => false,
    stopHistoryLoad: () => {},
  };
  context.render = () => {
    context.updateHistoryStatus(context.state.mode === "recommend");
  };
  runInNewContext(
    `${functions}\nvar historyLoader=createHistoryLoader(fetchHistoryJson,syncHistoryState);\n${wiring}\nvar fullRecordButton=$("fullRecordButton");\n${fullWiring}`,
    context,
  );
  return {
    context,
    requests,
    nodes,
    active: () => active,
    click: () => nodes.historyRetry.click(),
  };
}
it.each([false, true])(
  "retries the actual history button without changing filters (past: %s)",
  async (past) => {
    const ui = harness(past),
      before = JSON.stringify(ui.context.state);
    ui.context.loadHistoryData();
    await tick();
    expect(ui.requests).toHaveLength(1);
    ui.requests[0].reject(new Error("temporary failure"));
    await tick();
    expect(ui.context.historyStatus).toBe("error");
    expect(ui.nodes.historyStatus.hidden).toBe(false);
    expect(ui.nodes.historyRetry.hidden).toBe(false);
    ui.click();
    expect(ui.nodes.historyRetry.hidden).toBe(false);
    expect(ui.nodes.historyRetry.disabled).toBe(false);
    expect(ui.nodes.historyRetry.attributes.get("aria-disabled")).toBe("true");
    expect(ui.nodes.historyStatusText.textContent).toBe("loading-state");
    expect(ui.active()).toBe(ui.nodes.historyRetry);
    await tick();
    expect(ui.requests).toHaveLength(2);
    ui.click();
    await tick();
    expect(ui.requests).toHaveLength(2);
    expect(ui.requests[1].ref).toBe("https://example.org/data.json");
    const recovered = { conferences: [{ key: "recovered", editions: [] }] };
    ui.requests[1].resolve({ ok: true, json: async () => recovered });
    await tick();
    expect(ui.context.historyStatus).toBe("ready");
    expect(ui.context.activeData).toEqual(recovered);
    expect(JSON.stringify(ui.context.state)).toBe(before);
    expect(ui.context.fullRecordRequested).toBe(!past);
    expect(ui.nodes.historyStatus.hidden).toBe(true);
    expect(ui.active()).toBe(ui.nodes.results);
  },
);

it.each(["mode", "window", "not-requested", "ready", "loading"])(
  "does not retry when %s no longer permits it",
  async (kind) => {
    const ui = harness();
    ui.context.loadHistoryData();
    await tick();
    ui.requests[0].reject(new Error("temporary failure"));
    await tick();
    if (kind === "mode") ui.context.state.mode = "recommend";
    if (kind === "window") ui.context.state.win = "7";
    if (kind === "not-requested") ui.context.fullRecordRequested = false;
    if (kind === "ready") ui.context.historyStatus = "ready";
    if (kind === "loading") ui.context.historyStatus = "loading";
    ui.context.render();
    ui.click();
    await tick();
    expect(ui.requests).toHaveLength(1);
  },
);

it("keeps the action and filters after a repeated failure", async () => {
  const ui = harness(),
    before = JSON.stringify(ui.context.state);
  ui.context.loadHistoryData();
  await tick();
  ui.requests[0].reject(new Error("first failure"));
  await tick();
  ui.click();
  await tick();
  ui.requests[1].resolve({ ok: false, status: 503 });
  await tick();
  expect(ui.context.historyStatus).toBe("error");
  expect(ui.context.activeData).toBe(ui.context.DATA);
  expect(ui.nodes.historyStatus.hidden).toBe(false);
  expect(ui.nodes.historyStatusText.textContent).toBe("error-state");
  expect(ui.nodes.historyRetry.attributes.get("aria-disabled")).toBe("false");
  expect(ui.active()).toBe(ui.nodes.historyRetry);
  expect(JSON.stringify(ui.context.state)).toBe(before);
  ui.click();
  await tick();
  expect(ui.requests).toHaveLength(3);
  ui.requests[2].resolve({ ok: true, json: async () => ({ conferences: [] }) });
  await tick();
  expect(ui.context.historyStatus).toBe("ready");
  expect(ui.active()).toBe(ui.nodes.results);
  expect(JSON.stringify(ui.context.state)).toBe(before);
});

it("does not take focus from the search field on background completion", async () => {
  const ui = harness();
  ui.nodes.q.focus();
  ui.context.loadHistoryData();
  await tick();
  ui.requests[0].resolve({ ok: true, json: async () => ({ conferences: [] }) });
  await tick();
  expect(ui.context.historyStatus).toBe("ready");
  expect(ui.active()).toBe(ui.nodes.q);
});

it("ignores a retry response after leaving deadline mode", async () => {
  const ui = harness();
  ui.context.loadHistoryData();
  await tick();
  ui.requests[0].reject(new Error("failure"));
  await tick();
  ui.click();
  await tick();
  ui.context.state.mode = "recommend";
  ui.nodes.q.focus();
  ui.context.stopHistoryLoad();
  ui.context.render();
  ui.requests[1].resolve({
    ok: true,
    json: async () => ({ conferences: [{ key: "late", editions: [] }] }),
  });
  await tick();
  expect(ui.context.activeData).toBe(ui.context.DATA);
  expect(ui.context.historyStatus).toBe("idle");
  expect(ui.nodes.historyStatus.hidden).toBe(true);
  expect(ui.active()).toBe(ui.nodes.q);
});

it("updates the status and focus from the actual render function", () => {
  expect(jsFunction(app, "render")).toContain("updateHistoryStatus(recMode)");
});

it("keeps keyboard navigation through the full-record button, failure and retry without enabling past results", async () => {
  const ui = harness();
  ui.context.fullRecordRequested = false;
  const before = JSON.stringify(ui.context.state);
  ui.nodes.fullRecordButton.click();
  await tick();
  expect(ui.context.fullRecordRequested).toBe(true);
  expect(ui.context.state.past).toBe(false);
  expect(ui.requests).toHaveLength(1);
  expect(ui.active()).toBe(ui.nodes.historyRetry);
  ui.requests[0].reject(new Error("temporary failure"));
  await tick();
  expect(ui.active()).toBe(ui.nodes.historyRetry);
  ui.click();
  await tick();
  expect(ui.requests).toHaveLength(2);
  ui.requests[1].resolve({ ok: true, json: async () => ({ conferences: [] }) });
  await tick();
  expect(ui.context.historyStatus).toBe("ready");
  expect(ui.active()).toBe(ui.nodes.results);
  expect(JSON.stringify(ui.context.state)).toBe(before);
});
