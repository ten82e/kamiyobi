import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const app = siteRuntime();
const keyboard = `${jsFunction(app, "keyBlockedByTarget")}\n${jsFunction(app, "onKeydown")}`;
function harness(mode: "recommend" | "deadlines") {
  const state = { mode };
  const actions: string[] = [];
  const controls = Object.fromEntries(
    ["q", "paperPrimaryTitle"].map((id) => [
      id,
      {
        id,
        tagName: "INPUT",
        value: "GPU/vGPU memory",
        focus: () => actions.push(`focus:${id}`),
        blur: () => actions.push(`blur:${id}`),
      },
    ]),
  );
  const rows = [0, 1, 2].map((i) => ({ focus: () => actions.push(`row:${i}`) }));
  const onKeydown = new Function(
    "state",
    "window",
    "document",
    "$",
    "selectedIndex",
    "shown",
    "updateRowSelection",
    "ensureRowsDrawn",
    "dataRows",
    "openDrawer",
    "closeDrawer",
    "safeExternalUrl",
    `${keyboard}\nreturn onKeydown;`,
  )(
    state,
    { open: (url: string) => actions.push(`open:${url}`) },
    {},
    (id: string) => controls[id],
    1,
    rows.map(() => ({ conf: { link: "https://example.org/selected" }, ed: {} })),
    () => actions.push("select"),
    () => actions.push("draw"),
    () => rows,
    () => actions.push("drawer"),
    () => actions.push("close"),
    (url: string) => url,
  );
  function fire(
    key: string,
    target: object = { tagName: "BODY" },
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
  ) {
    actions.length = 0;
    let prevented = false;
    onKeydown({
      key,
      ...modifiers,
      target,
      preventDefault() {
        prevented = true;
      },
    });
    return { prevented, actions: [...actions] };
  }
  return { state, controls, fire };
}

it("slash focuses the visible input for the current mode, including after switching modes", () => {
  const h = harness("deadlines");
  for (const mode of ["deadlines", "recommend", "deadlines", "recommend"] as const) {
    h.state.mode = mode;
    for (const tagName of ["BODY", "BUTTON", "A"]) {
      expect(h.fire("/", { tagName })).toEqual({
        prevented: true,
        actions: [`focus:${mode === "recommend" ? "paperPrimaryTitle" : "q"}`],
      });
    }
  }
});

it.each(["ctrlKey", "metaKey", "altKey"] as const)(
  "does not intercept platform shortcuts with %s",
  (modifier) => {
    for (const mode of ["deadlines", "recommend"] as const) {
      const h = harness(mode);
      for (const target of [
        { tagName: "BODY" },
        { tagName: "BUTTON" },
        { tagName: "A" },
        h.controls.q,
        h.controls.paperPrimaryTitle,
      ]) {
        for (const key of ["j", "k", "d", "ArrowDown", "ArrowUp", "Enter", "Escape", "/"])
          expect(
            h.fire(key, target, { [modifier]: true }),
            `${mode}/${target.tagName}/${modifier}/${key}`,
          ).toEqual({ prevented: false, actions: [] });
      }
    }
  },
);

it("preserves a shift-only slash for keyboard layouts that require it", () => {
  for (const mode of ["deadlines", "recommend"] as const) {
    const h = harness(mode);
    expect(h.fire("/", { tagName: "BODY" }, { shiftKey: true })).toEqual({
      prevented: true,
      actions: [`focus:${mode === "recommend" ? "paperPrimaryTitle" : "q"}`],
    });
  }
});

it("Enter on a link activates that link without opening the selected deadline instead", () => {
  for (const mode of ["deadlines", "recommend"] as const) {
    const h = harness(mode);
    expect(h.fire("Enter", { tagName: "A", href: "https://example.org/focused" })).toEqual({
      prevented: false,
      actions: [],
    });
    expect(h.fire("Enter", { tagName: "BUTTON" })).toEqual({ prevented: false, actions: [] });
    expect(h.fire(" ", { tagName: "A" })).toEqual({ prevented: false, actions: [] });
  }
});

it("recommendation mode leaves native scrolling and Enter intact without touching hidden deadline rows", () => {
  const h = harness("recommend");
  for (const key of ["j", "k", "d", "ArrowDown", "ArrowUp", "Enter"])
    expect(h.fire(key)).toEqual({ prevented: false, actions: [] });
});

it("deadline mode retains row movement, detail opening and the selected-row Enter shortcut", () => {
  const h = harness("deadlines");
  expect(h.fire("j")).toEqual({ prevented: true, actions: ["draw", "select"] });
  expect(h.fire("k")).toEqual({ prevented: true, actions: ["select"] });
  expect(h.fire("d")).toEqual({ prevented: true, actions: ["draw", "row:1", "drawer"] });
  expect(h.fire("Enter")).toEqual({
    prevented: false,
    actions: ["open:https://example.org/selected"],
  });
});

it("preserves slash and navigation keys while typing and Escape leaves paper contents untouched", () => {
  for (const mode of ["deadlines", "recommend"] as const) {
    const h = harness(mode);
    for (const target of [
      h.controls.q,
      h.controls.paperPrimaryTitle,
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      for (const key of ["/", "j", "k", "d", "ArrowDown", "ArrowUp", "Enter"])
        expect(h.fire(key, target)).toEqual({ prevented: false, actions: [] });
    }
    expect(h.fire("Escape", h.controls.paperPrimaryTitle)).toEqual({
      prevented: false,
      actions: ["blur:paperPrimaryTitle"],
    });
    expect(h.controls.paperPrimaryTitle.value).toBe("GPU/vGPU memory");
    expect(h.fire("Escape", h.controls.q)).toEqual({
      prevented: false,
      actions: ["blur:q", "select"],
    });
  }
});
