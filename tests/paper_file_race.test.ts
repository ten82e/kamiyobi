import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { jsFunction } from "./runtime_extract.ts";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");
const start = source.indexOf('  const paperFiles = inputElement("paperFiles");');
const end = source.indexOf("  /* 入力欄への入力を遅延適用する。", start);
if (start < 0 || end < 0) throw new Error("file input handlers not found");
const handlers = stripTypeScriptTypes(source.slice(start, end));
const javascript = stripTypeScriptTypes(source);
const inputFunctions = [
  "setPrimaryRecord",
  "readPaperInput",
  "writePaperInput",
  "syncPaperText",
  "paperInputHasText",
  "paperInputWithSample",
  "savePaperDraft",
  "clearPaperInput",
]
  .map((name) => jsFunction(javascript, name))
  .join("\n");
const resetStart = source.indexOf('  $("paperReset").addEventListener');
const resetEnd = source.indexOf('  $("reset").addEventListener', resetStart);
if (resetStart < 0 || resetEnd < 0) throw new Error("paper reset handler not found");
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
  const reset = new Input();
  const label = { textContent: "" };
  const values = Object.fromEntries(
    [
      "paperPrimaryTitle",
      "paperPrimaryAbstract",
      "paperPrimaryKeywords",
      "paperReferences",
      "paperText",
    ].map((id) => [id, { value: id === "paperPrimaryTitle" ? "入力済み論文" : "" }]),
  );
  const draft = new Map<string, string>();
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
  runInNewContext(
    `${inputFunctions}\n${handlers}\n${source.slice(resetStart, resetEnd)}
    const originalWrite = writePaperInput;
    writePaperInput = (record) => { recordWrite(record); originalWrite(record); };
    savePaperDraft(readPaperInput());`,
    {
      HTMLInputElement: Input,
      AbortController,
      Recommender,
      PAPER_DRAFT_KEY: "draft",
      paperPrimaryVenue: "",
      window: {
        sessionStorage: {
          setItem: (key: string, value: string) => draft.set(key, value),
          removeItem: (key: string) => draft.delete(key),
        },
      },
      valueElement: (id: string) => values[id],
      pdfJob: 0,
      pdfAbortController: null,
      inputElement: () => input,
      $: (id: string) => (id === "cancelPdf" ? cancel : id === "paperReset" ? reset : label),
      unsupportedPaperFormatJa: () => "",
      loadPdfJs: (callback: (ok: boolean) => void) => callback(true),
      readPaperFile: (file: { name: string }, signal: AbortSignal) =>
        new Promise<RecordInput>((resolve, reject) => {
          pending.set(file.name, { signal, resolve, reject });
        }),
      abortError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
      paperInputBeforeSwap: null,
      setPaperUndoVisible: () => {},
      recordWrite: (record: RecordInput) => written.push(record),
      apply: () => {
        applied++;
      },
      scheduleSemantic: () => {},
      invalidateSemantic: () => {},
      pdfFailureMessageJa: (error: Error) =>
        error.name === "AbortError" ? "キャンセルしました" : "読み込みに失敗しました",
    },
  );
  return {
    label,
    cancel,
    pending,
    written,
    values,
    draft,
    reset: () => reset.listeners.get("click")!({ currentTarget: reset }),
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

it.each([
  ["paper.pdf", "success"],
  ["paper.txt", "success"],
  ["paper.pdf", "failure"],
  ["paper.txt", "failure"],
])("keeps cleared input and its draft empty after %s completes with %s", async (file, outcome) => {
  const ui = harness();
  await ui.select(file);
  const read = ui.pending.get(file)!;
  expect(ui.draft.size).toBe(1);
  ui.reset();
  const cancelledImmediately = read.signal.aborted && ui.cancel.hidden;
  expect(ui.draft.size).toBe(0);
  expect(Object.values(ui.values).map((field) => field.value)).toEqual(["", "", "", "", ""]);
  if (outcome === "success")
    read.resolve({ title: "消したはずの論文", abstract: "遅れて届いた概要" });
  else read.reject(new Error("late read failure"));
  await tick();
  expect(ui.written).toEqual([]);
  expect(ui.draft.size).toBe(0);
  expect(Object.values(ui.values).map((field) => field.value)).toEqual(["", "", "", "", ""]);
  expect(ui.label.textContent).toBe("未選択");
  expect(ui.cancel.hidden).toBe(true);
  expect(ui.applied()).toBe(1);
  expect(cancelledImmediately).toBe(true);
});

it("accepts a new file after clearing without a late old result replacing its draft", async () => {
  const ui = harness();
  await ui.select("old.pdf");
  const old = ui.pending.get("old.pdf")!;
  ui.reset();
  await ui.select("new.txt");
  const next = ui.pending.get("new.txt")!;
  old.resolve({ title: "古い論文" });
  await tick();
  expect(ui.label.textContent).toBe("読み込み中…");
  expect(ui.cancel.hidden).toBe(false);
  expect(ui.draft.size).toBe(0);
  expect(ui.written).toEqual([]);
  expect(next.signal.aborted).toBe(false);
  next.resolve({ title: "新しい論文", abstract: "選び直した概要" });
  await tick();
  expect(ui.values.paperPrimaryTitle.value).toBe("新しい論文");
  expect(ui.values.paperPrimaryAbstract.value).toBe("選び直した概要");
  expect(JSON.parse(ui.draft.get("draft")!)).toMatchObject({
    title: "新しい論文",
    abstract: "選び直した概要",
  });
  expect(ui.label.textContent).toBe("new.txt");
  expect(ui.cancel.hidden).toBe(true);
  expect(ui.written.map((record) => record.title)).toEqual(["新しい論文"]);
  expect(ui.applied()).toBe(2);
});
