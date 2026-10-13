import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
const start = source.indexOf('  const paperFiles = inputElement("paperFiles");');
const end = source.indexOf("  /* 入力欄への入力を遅延適用する。", start);
if (start < 0 || end < 0) throw new Error("file input handlers not found");
const handlers = stripTypeScriptTypes(source.slice(start, end));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
interface RecordInput {
  title: string;
  abstract?: string;
}
function harness() {
  class Input {
    files: Array<{ name: string }> = [];
    value = "";
    listeners = new Map<string, (event: { currentTarget: Input }) => void>();
    addEventListener(name: string, fn: (event: { currentTarget: Input }) => void) {
      this.listeners.set(name, fn);
    }
  }
  const input = new Input();
  const label = { textContent: "" };
  const cancel = {
    hidden: true,
    addEventListener: (_name: string, fn: () => void) => {
      cancel.click = fn;
    },
    click: () => {},
  };
  const pending = new Map<
    string,
    {
      signal: AbortSignal;
      resolve: (record: RecordInput) => void;
      reject: (error: Error) => void;
    }
  >();
  const written: RecordInput[] = [];
  let applied = 0;
  runInNewContext(handlers, {
    HTMLInputElement: Input,
    AbortController,
    pdfJob: 0,
    pdfAbortController: null,
    inputElement: () => input,
    $: (id: string) => (id === "cancelPdf" ? cancel : label),
    unsupportedPaperFormatJa: () => "",
    loadPdfJs: (callback: (ok: boolean) => void) => callback(true),
    readPaperFile: (file: { name: string }, signal: AbortSignal) =>
      new Promise<RecordInput>((resolve, reject) => {
        pending.set(file.name, { signal, resolve, reject });
      }),
    abortError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
    readPaperInput: () => ({ title: "入力済み論文" }),
    paperInputWithSample: (kept: RecordInput, next: RecordInput) => ({ kept, next }),
    paperInputBeforeSwap: null,
    setPaperUndoVisible: () => {},
    writePaperInput: (record: RecordInput) => written.push(record),
    syncPaperText: () => {},
    apply: () => {
      applied++;
    },
    scheduleSemantic: () => {},
    pdfFailureMessageJa: (error: Error) =>
      error.name === "AbortError" ? "キャンセルしました" : "読み込みに失敗しました",
  });
  return {
    label,
    cancel,
    pending,
    written,
    applied: () => applied,
    async select(name: string) {
      input.files = [{ name }];
      input.listeners.get("change")!({ currentTarget: input });
      await tick();
    },
  };
}

it("cancels the previous read when another paper file is selected", async () => {
  const ui = harness();
  await ui.select("first.pdf");
  const first = ui.pending.get("first.pdf")!;
  expect(first.signal.aborted).toBe(false);
  await ui.select("second.pdf");
  expect(first.signal.aborted).toBe(true);
  expect(ui.pending.get("second.pdf")!.signal.aborted).toBe(false);
  ui.pending.get("second.pdf")!.resolve({ title: "新しい論文" });
  await tick();
  expect(ui.written.map((record) => record.title)).toEqual(["新しい論文"]);
  expect(ui.applied()).toBe(1);
  expect(ui.cancel.hidden).toBe(true);
});

it.each(["loading", "finished"])(
  "ignores a stale failure while the current file is %s",
  async (state) => {
    const ui = harness();
    await ui.select("first.pdf");
    await ui.select("second.pdf");
    if (state === "finished") {
      ui.pending.get("second.pdf")!.resolve({ title: "新しい論文" });
      await tick();
    }
    ui.pending.get("first.pdf")!.reject(new Error("old PDF failed late"));
    await tick();
    expect(ui.label.textContent).toBe(state === "loading" ? "読み込み中…" : "second.pdf");
    expect(ui.cancel.hidden).toBe(state === "finished");
    if (state === "loading") {
      ui.pending.get("second.pdf")!.resolve({ title: "新しい論文" });
      await tick();
    }
    expect(ui.written.map((record) => record.title)).toEqual(["新しい論文"]);
    expect(ui.applied()).toBe(1);
  },
);

it("keeps cancellation of the current file visible and preserves the existing input", async () => {
  const ui = harness();
  await ui.select("current.pdf");
  ui.cancel.click();
  expect(ui.pending.get("current.pdf")!.signal.aborted).toBe(true);
  ui.pending
    .get("current.pdf")!
    .reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await tick();
  expect(ui.label.textContent).toBe("キャンセルしました");
  expect(ui.written).toEqual([]);
  expect(ui.applied()).toBe(0);
  expect(ui.cancel.hidden).toBe(true);
});

it("ignores a previous read that finishes after the replacement has been applied", async () => {
  const ui = harness();
  await ui.select("first.pdf");
  await ui.select("second.pdf");
  ui.pending.get("second.pdf")!.resolve({ title: "新しい論文" });
  await tick();
  ui.pending.get("first.pdf")!.resolve({ title: "古い論文" });
  await tick();
  expect(ui.label.textContent).toBe("second.pdf");
  expect(ui.written.map((record) => record.title)).toEqual(["新しい論文"]);
  expect(ui.applied()).toBe(1);
});
