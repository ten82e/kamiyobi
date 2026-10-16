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
  "setPaperActionHidden",
  "setPaperUndoVisible",
  "savePaperDraft",
  "clearPaperInput",
]
  .map((name) => jsFunction(javascript, name))
  .join("\n");
const resetStart = source.indexOf('  $("paperReset").addEventListener');
const resetEnd = source.indexOf('  $("reset").addEventListener', resetStart);
if (resetStart < 0 || resetEnd < 0) throw new Error("paper reset handler not found");
const swapStart = source.indexOf('  document.querySelectorAll<HTMLElement>(".sample-btn")');
const swapEnd = source.indexOf('  ["kind", "rank", "win",', swapStart);
if (swapStart < 0 || swapEnd < 0) throw new Error("paper swap handlers not found");
const swapHandlers = stripTypeScriptTypes(source.slice(swapStart, swapEnd));
const sample = {
  title: "分散システムの入力例",
  abstract: "障害時にも処理を続ける分散システム",
  keywords: "分散処理",
  venue: "",
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
interface RecordInput {
  title: string;
  abstract?: string;
}
function harness() {
  let active: unknown = null;
  class Input {
    files: Array<{ name: string }> = [];
    value = "";
    private isHidden = true;
    get hidden() {
      return this.isHidden;
    }
    set hidden(value: boolean) {
      this.isHidden = value;
      if (value && active === this) active = null;
    }
    clicks = 0;
    listeners = new Map<string, (event: { currentTarget: Input }) => void>();
    addEventListener(name: string, fn: (event: { currentTarget: Input }) => void) {
      this.listeners.set(name, fn);
    }
    click() {
      this.clicks++;
      this.listeners.get("click")?.({ currentTarget: this });
    }
    focus() {
      active = this;
    }
  }
  const input = new Input();
  const reset = new Input();
  const choose = new Input();
  const undo = new Input();
  const sampleButton = new Input();
  const sampleNode = Object.assign(sampleButton, { getAttribute: () => JSON.stringify(sample) });
  const label = { textContent: "" };
  const values = Object.fromEntries(
    [
      "paperPrimaryTitle",
      "paperPrimaryAbstract",
      "paperPrimaryKeywords",
      "paperReferences",
      "paperText",
    ].map((id) => [
      id,
      {
        value: id === "paperPrimaryTitle" ? "入力済み論文" : "",
        focus() {
          active = this;
        },
      },
    ]),
  );
  const draft = new Map<string, string>();
  const cancel = new Input();
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
    `${inputFunctions}\n${handlers}\n${source.slice(resetStart, resetEnd)}\n${swapHandlers}
    const originalWrite = writePaperInput;
    writePaperInput = (record) => { recordWrite(record); originalWrite(record); };
    savePaperDraft(readPaperInput());`,
    {
      HTMLInputElement: Input,
      AbortController,
      Recommender,
      document: {
        querySelectorAll: () => [sampleNode],
        get activeElement() {
          return active;
        },
      },
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
      $: (id: string) =>
        id === "cancelPdf"
          ? cancel
          : id === "paperReset"
            ? reset
            : id === "paperUndo"
              ? undo
              : id === "paperChoose"
                ? choose
                : label,
      unsupportedPaperFormatJa: () => "",
      loadPdfJs: (callback: (ok: boolean) => void) => callback(true),
      readPaperFile: (file: { name: string }, signal: AbortSignal) =>
        new Promise<RecordInput>((resolve, reject) => {
          pending.set(file.name, { signal, resolve, reject });
        }),
      abortError: () => Object.assign(new Error("cancelled"), { name: "AbortError" }),
      paperInputBeforeSwap: null,
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
    activeElement: () => active,
    focus: (id: string) => {
      if (id === "paperUndo") undo.focus();
      else if (id === "cancelPdf") cancel.focus();
      else values[id].focus();
    },
    choose: () => choose.click(),
    chooserOpens: () => input.clicks,
    undoButton: undo,
    sample: () => sampleButton.listeners.get("click")!({ currentTarget: sampleButton }),
    undo: () => undo.listeners.get("click")!({ currentTarget: undo }),
    reset: () => reset.listeners.get("click")!({ currentTarget: reset }),
    applied: () => applied,
    async select(name: string) {
      input.files = [{ name }];
      input.listeners.get("change")!({ currentTarget: input });
      await tick();
    },
  };
}

it("offers a named native button with a connected file status and supported formats", () => {
  const html = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  const picker = /<button\b([^>]*\bid="paperChoose"[^>]*)>([\s\S]*?)<\/button>/.exec(html);
  expect(picker).not.toBeNull();
  const attributes = picker![1];
  expect(attributes).toContain('type="button"');
  expect(attributes).toContain('class="paper-file-button"');
  expect(attributes).toContain('aria-describedby="paperFileLabel"');
  expect(attributes).not.toMatch(/\b(hidden|disabled)\b|tabindex="-1"|aria-hidden="true"/);
  expect(picker![2]).toContain("投稿予定の論文を選ぶ");
  expect(picker![2]).toContain("PDF / TXT・複数可");
  expect(html).toMatch(/<span\b[^>]*id="paperFileLabel"[^>]*role="status"/);
  const file = /<input\b[^>]*id="paperFiles"[^>]*>/.exec(html)?.[0];
  expect(file).toContain('accept=".pdf,.txt"');
  expect(file).toMatch(/\bmultiple\b/);
});

it("opens the native chooser without changing the current paper or draft", () => {
  const ui = harness();
  const savedDraft = ui.draft.get("draft");
  ui.choose();
  expect(ui.chooserOpens()).toBe(1);
  expect(ui.values.paperPrimaryTitle.value).toBe("入力済み論文");
  expect(ui.draft.get("draft")).toBe(savedDraft);
  expect(ui.written).toEqual([]);
  expect(ui.pending.size).toBe(0);
  expect(ui.applied()).toBe(0);
});

it("returns focus to the restored title when the focused undo button disappears", () => {
  const ui = harness();
  const originalDraft = ui.draft.get("draft");
  ui.sample();
  ui.focus("paperUndo");
  ui.undo();
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryTitle);
  expect(ui.values.paperPrimaryTitle.value).toBe("入力済み論文");
  expect(ui.draft.get("draft")).toBe(originalDraft);
  expect(ui.undoButton.hidden).toBe(true);
});

it("does not move focus from another field when showing or hiding undo", () => {
  const ui = harness();
  ui.focus("paperPrimaryAbstract");
  ui.sample();
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryAbstract);
  ui.undo();
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryAbstract);
  expect(ui.undoButton.hidden).toBe(true);
});

it.each([
  ["paper.pdf", "success"],
  ["paper.txt", "success"],
  ["paper.pdf", "failure"],
  ["paper.txt", "failure"],
])("keeps keyboard focus in the input after %s finishes with %s", async (file, outcome) => {
  const ui = harness();
  await ui.select(file);
  ui.focus("cancelPdf");
  if (outcome === "success") ui.pending.get(file)!.resolve({ title: "読み取った論文" });
  else ui.pending.get(file)!.reject(new Error("reading failed"));
  await tick();
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryTitle);
  expect(ui.cancel.hidden).toBe(true);
  expect(ui.values.paperPrimaryTitle.value).toBe(
    outcome === "success" ? "読み取った論文" : "入力済み論文",
  );
});

it("does not take focus from another field when a file finishes reading", async () => {
  const ui = harness();
  await ui.select("paper.txt");
  ui.focus("paperPrimaryKeywords");
  ui.pending.get("paper.txt")!.resolve({ title: "読み取った論文" });
  await tick();
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryKeywords);
  expect(ui.cancel.hidden).toBe(true);
});

it("keeps focus on an undo button that remains visible after another file is read", async () => {
  const ui = harness();
  ui.sample();
  await ui.select("replacement.txt");
  ui.focus("paperUndo");
  ui.pending.get("replacement.txt")!.resolve({ title: "選び直した論文" });
  await tick();
  expect(ui.activeElement()).toBe(ui.undoButton);
  expect(ui.undoButton.hidden).toBe(false);
  expect(ui.values.paperPrimaryTitle.value).toBe("選び直した論文");
});

it("returns focus to the input after cancelling the focused file read", async () => {
  const ui = harness();
  await ui.select("cancelled.pdf");
  ui.focus("cancelPdf");
  ui.cancel.click();
  const read = ui.pending.get("cancelled.pdf")!;
  read.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await tick();
  expect(read.signal.aborted).toBe(true);
  expect(ui.activeElement()).toBe(ui.values.paperPrimaryTitle);
  expect(ui.cancel.hidden).toBe(true);
  expect(ui.values.paperPrimaryTitle.value).toBe("入力済み論文");
  expect(ui.label.textContent).toBe("キャンセルしました");
});

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

it.each([
  ["sample", "old.pdf", "success"],
  ["sample", "old.txt", "success"],
  ["sample", "old.pdf", "failure"],
  ["sample", "old.txt", "failure"],
  ["undo", "old.pdf", "success"],
  ["undo", "old.txt", "success"],
  ["undo", "old.pdf", "failure"],
  ["undo", "old.txt", "failure"],
])("preserves %s after %s finishes with %s", async (action, file, outcome) => {
  const ui = harness();
  if (action === "undo") ui.sample();
  await ui.select(file);
  const read = ui.pending.get(file)!;
  if (action === "sample") ui.sample();
  else ui.undo();
  const chosenTitle = action === "sample" ? sample.title : "入力済み論文";
  const chosenAbstract = action === "sample" ? sample.abstract : "";
  expect(ui.values.paperPrimaryTitle.value).toBe(chosenTitle);
  expect(ui.values.paperPrimaryAbstract.value).toBe(chosenAbstract);
  const chosenDraft = ui.draft.get("draft");
  expect(JSON.parse(chosenDraft!)).toMatchObject({ title: chosenTitle, abstract: chosenAbstract });
  if (outcome === "success") read.resolve({ title: "古いファイルの題名", abstract: "古い概要" });
  else read.reject(new Error("stale failure after choosing another input"));
  await tick();
  expect(ui.values.paperPrimaryTitle.value).toBe(chosenTitle);
  expect(ui.values.paperPrimaryAbstract.value).toBe(chosenAbstract);
  expect(ui.draft.get("draft")).toBe(chosenDraft);
  expect(ui.label.textContent).toBe("未選択");
  expect(ui.cancel.hidden).toBe(true);
  expect(read.signal.aborted).toBe(true);
  expect(ui.undoButton.hidden).toBe(action === "undo");
  expect(ui.applied()).toBe(action === "sample" ? 1 : 2);
  if (action === "sample") {
    ui.undo();
    expect(ui.values.paperPrimaryTitle.value).toBe("入力済み論文");
    expect(JSON.parse(ui.draft.get("draft")!)).toMatchObject({
      title: "入力済み論文",
      abstract: "",
    });
    expect(ui.undoButton.hidden).toBe(true);
  }
});
