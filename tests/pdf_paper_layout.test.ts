import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import R from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

interface LayoutFixture {
  source: string;
  metadata: unknown;
  pages: Array<Array<{ str: string; transform: number[]; width: number; height: number }>>;
  expected: {
    title: string;
    abstract?: string;
    abstractStart?: string;
    abstractEnd?: string;
    keywords: string;
  };
}
function fixture(name: string): LayoutFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/pdf-layout-${name}.json`, import.meta.url), "utf8"),
  );
}

describe.each(["kamping", "flat", "flashattention"])("real PDF layout: %s", (name) => {
  it.each([1, 0.5, 2])("preserves title and section boundaries at scale %s", (scale) => {
    const input = fixture(name);
    const saved = JSON.stringify(input);
    const pages = input.pages.map((page) =>
      page
        .map((item) => ({
          ...item,
          width: item.width * scale,
          height: item.height * scale,
          transform: item.transform.map(
            (value, index) => value * scale + (index === 4 ? 170 : index === 5 ? 90 : 0),
          ),
        }))
        .reverse(),
    );
    const passed = JSON.stringify({ metadata: input.metadata, pages });
    const actual = R.pdfPaperRecord(input.metadata, pages, "unrelated-filename.pdf");
    expect(actual.title).toBe(input.expected.title);
    expect(actual.abstract).toBeTypeOf("string");
    const abstract = actual.abstract ?? "";
    if (input.expected.abstract !== undefined) {
      const text = name === "flat" ? abstract.replace(/\s+/g, "") : abstract;
      expect(text).toBe(input.expected.abstract);
    } else {
      expect(abstract).toMatch(
        new RegExp(`^${input.expected.abstractStart!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      expect(abstract.endsWith(input.expected.abstractEnd!)).toBe(true);
    }
    expect(actual.keywords).toBe(input.expected.keywords);
    expect(`${actual.title} ${actual.abstract} ${actual.keywords}`).not.toContain("OUTSIDE-");
    expect(JSON.stringify(input)).toBe(saved);
    expect(JSON.stringify({ metadata: input.metadata, pages })).toBe(passed);
  });
});

it.each(["概要", "要旨", "抄録", "あらまし"])(
  "extracts Japanese %s without splitting words across lines",
  (label) => {
    const item = (str: string, y: number) => ({
      str,
      transform: [10, 0, 0, 10, 50, y],
      height: 10,
    });
    const pages = [
      [
        item(`${label}：分散システ`, 700),
        item("ムの評価を行った。", 686),
        item("キーワード：分散処理", 660),
        item("1. はじめに", 620),
        item("この本文は概要ではない。", 600),
      ],
    ];
    expect(R.pdfPaperRecord({ Title: "日本語の題名" }, pages, "fallback.pdf")).toEqual({
      title: "日本語の題名",
      abstract: "分散システムの評価を行った。",
      keywords: "分散処理",
      venue: "",
    });
  },
);

it.each([
  [
    "missing page",
    [[{ str: "Usable title", transform: [12, 0, 0, 12, 50, 700], width: 80, height: 12 }], null],
    "Usable title",
  ],
  [
    "nonfinite coordinate",
    [[{ str: "Invalid title", transform: [12, 0, 0, 12, Infinity, 700], width: 80, height: 12 }]],
    "fallback.pdf",
  ],
  [
    "nonfinite width",
    [[{ str: "Invalid title", transform: [12, 0, 0, 12, 50, 700], width: NaN, height: 12 }]],
    "fallback.pdf",
  ],
  [
    "nonfinite height",
    [[{ str: "Invalid title", transform: [12, 0, 0, 12, 50, 700], width: 80, height: Infinity }]],
    "fallback.pdf",
  ],
])(
  "handles a %s without losing usable input or accepting invalid geometry",
  (_name, pages, title) => {
    let result: ReturnType<typeof R.pdfPaperRecord> | undefined;
    expect(() => {
      result = R.pdfPaperRecord({}, pages, "fallback.pdf");
    }).not.toThrow();
    expect(result).toEqual({ title, abstract: "", keywords: "", venue: "" });
  },
);

function pdfReader(
  document: unknown,
  capture: (value: Record<string, unknown>) => void = () => {},
) {
  const app = siteRuntime();
  const constants = ["PDFJS_CMAPS", "PDF_TIMEOUT_MS", "PDF_MAX_PAGES", "PDF_PAGE_LIMIT"]
    .map((name) => {
      const declaration = new RegExp(`const ${name} = [^;]+;`).exec(app)?.[0];
      expect(declaration).toBeDefined();
      return declaration;
    })
    .join("\n");
  return new Function(
    "window",
    `${constants}\n${jsFunction(app, "abortError")}\n${jsFunction(app, "readPdf")}\nreturn readPdf;`,
  )({
    pdfjsLib: {
      getDocument(value: Record<string, unknown>) {
        capture(value);
        return {
          promise: Promise.resolve(document),
          destroy() {},
        };
      },
    },
  });
}

it("passes the pinned packed CMaps to the real PDF read path", async () => {
  const input = fixture("flat");
  const buffer = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]).buffer;
  let options: Record<string, unknown> | undefined;
  const read = pdfReader(
    {
      numPages: input.pages.length,
      getPage: async (index: number) => ({
        getTextContent: async () => ({ items: input.pages[index - 1] }),
      }),
      getMetadata: async () => input.metadata,
    },
    (value) => {
      options = value;
    },
  );
  const result = await read(buffer, new AbortController().signal);
  expect(options).toEqual({
    data: buffer,
    cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
    cMapPacked: true,
  });
  expect(Array.from(new Uint8Array(options?.data as ArrayBuffer))).toEqual([
    37, 80, 68, 70, 45, 49, 46, 55,
  ]);
  expect(result.pages).toEqual(input.pages);
  expect(R.pdfPaperRecord(result.metadata, result.pages, "unrelated.pdf").title).toBe(
    input.expected.title,
  );
});

it("reads only the first three pages of a longer document", async () => {
  const requested: number[] = [];
  const read = pdfReader({
    numPages: 8,
    getPage: async (page: number) => {
      requested.push(page);
      return { getTextContent: async () => ({ items: [{ str: `page-${page}` }] }) };
    },
    getMetadata: async () => ({ info: { Title: "A longer document" } }),
  });
  const result = await read(new ArrayBuffer(8), new AbortController().signal);
  expect(requested).toEqual([1, 2, 3]);
  expect(result.pages.map((page: Array<{ str: string }>) => page[0].str)).toEqual([
    "page-1",
    "page-2",
    "page-3",
  ]);
});

it("rejects a document over the page limit before reading page text", async () => {
  let requested = 0;
  const read = pdfReader({
    numPages: 101,
    getPage: async () => {
      requested++;
      return { getTextContent: async () => ({ items: [] }) };
    },
    getMetadata: async () => ({ info: {} }),
  });
  const failure = await read(new ArrayBuffer(8), new AbortController().signal).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("PDF has too many pages");
  expect(requested).toBe(0);
});
