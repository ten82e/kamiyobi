import { afterEach, expect, it, vi } from "vitest";
import { booleanValue, positiveIntegerValue } from "../src/args.ts";
import { parseArgs } from "../src/cli.ts";

afterEach(() => vi.restoreAllMocks());

it("accepts padded and case-insensitive true/false aliases without changing their meaning", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const [value, expected] of [
    [" true ", true],
    ["\tYES\n", true],
    ["ON", true],
    ["1", true],
    [" false ", false],
    ["　No　", false],
    ["\tOFF", false],
    ["0", false],
  ] as const)
    expect(booleanValue(value, !expected), value).toBe(expected);
  expect(warning).not.toHaveBeenCalled();
});

it("reports an invalid boolean's original value, fallback and accepted alternatives", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const [value, fallback] of [
    ["maybe", true],
    ["TRUE!", false],
  ] as const) {
    warning.mockClear();
    expect(booleanValue(value, fallback)).toBe(fallback);
    expect(warning).toHaveBeenCalledOnce();
    const text = String(warning.mock.calls[0][0]);
    expect(text).toContain(JSON.stringify(value));
    expect(text).toContain(`既定値 ${fallback} を使います`);
    for (const alias of ["true", "false", "1", "0", "yes", "no", "on", "off"])
      expect(text).toContain(alias);
  }
});

it("preserves exact positive integers including the safe upper boundary", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const [raw, expected] of [
    ["5", 5],
    ["99999", 99999],
    [" 120 ", 120],
    ["9007199254740991", 9007199254740991],
  ] as const)
    expect(positiveIntegerValue(raw, 60), raw).toBe(expected);
  expect(warning).not.toHaveBeenCalled();
});

it("rejects lossy integers and other invalid numbers with an actionable fallback", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const raw of [
    "9007199254740993",
    "9007199254740992",
    "Infinity",
    "1.25",
    "0",
    "-5",
    "abc",
  ]) {
    warning.mockClear();
    expect(positiveIntegerValue(raw, 60), raw).toBe(60);
    expect(warning).toHaveBeenCalledOnce();
    const text = String(warning.mock.calls[0][0]);
    expect(text).toContain(JSON.stringify(raw));
    expect(text).toContain("最大 9007199254740991");
    expect(text).toContain("既定値 60 を使います");
  }
});

it("treats omitted integer arguments and native booleans as ordinary defaults without warnings", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const raw of [undefined, "", "　 "]) expect(positiveIntegerValue(raw, 60)).toBe(60);
  expect(booleanValue(undefined, false)).toBe(false);
  expect(booleanValue(undefined, true)).toBe(true);
  expect(booleanValue(true, false)).toBe(true);
  expect(booleanValue(false, true)).toBe(false);
  expect(warning).not.toHaveBeenCalled();
});

it("applies boolean normalization and integer precision checks through the actual CLI parser", () => {
  const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const args = parseArgs([
    "build",
    "--offline= false ",
    "--no-embeddings= TRUE ",
    "--limit=9007199254740993",
  ]);
  expect(args).toMatchObject({ offline: false, noEmbeddings: true, limit: 60 });
  expect(warning).toHaveBeenCalledOnce();
  expect(String(warning.mock.calls[0][0])).toContain("9007199254740993");
});
