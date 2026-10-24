import { expect, it } from "vitest";
import { paperFileReader } from "./paper_file_reader.ts";

const pdfCalls: number[] = [];
const runtime = paperFileReader(async (bytes) => {
  pdfCalls.push(bytes.byteLength);
  return { metadata: { info: { Title: "Actual PDF" } }, pages: [] };
});
const records = [
  {
    title: "Distributed memory management",
    abstract: "We share GPU memory across nodes and reduce transfer latency.",
    keywords: "GPU, memory",
    venue: "SC",
  },
  {
    title: "分散メモリ管理の設計",
    abstract: "複数ノードでGPUメモリを共有し、転送遅延を減らす。",
    keywords: "GPU, 分散処理",
    venue: "SC",
  },
];
function labeled(record: (typeof records)[number]) {
  return `Title: ${record.title}\r\nAbstract: ${record.abstract}\r\nKeywords: ${record.keywords}\r\nVenue: ${record.venue}\r\n`;
}
function utf16(text: string, little: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < text.length; i++) view.setUint16((i + 1) * 2, text.charCodeAt(i), little);
  return bytes;
}
const signal = () => new AbortController().signal;

it("reads English and Japanese UTF-8 TXT with or without its byte order mark", async () => {
  for (const record of records)
    for (const bom of [false, true]) {
      const bytes = new TextEncoder().encode(labeled(record));
      const input = bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]) : bytes;
      expect(await runtime.read(new File([input], "paper.TXT"), signal())).toEqual(record);
    }
});

it("reads both byte orders of BOM-marked UTF-16 without corrupting any paper field", async () => {
  for (const record of records)
    for (const little of [false, true])
      expect(
        await runtime.read(new File([utf16(labeled(record), little)], "paper.txt"), signal()),
      ).toEqual(record);
});

it("preserves unlabeled Japanese text and supplementary Unicode characters in UTF-16", async () => {
  for (const little of [false, true]) {
    const file = new File(
      [utf16("𠮷田の分散メモリ管理\nGPU/vGPU 間の通信を評価する。", little)],
      "原稿.txt",
    );
    expect(await runtime.read(file, signal())).toEqual({
      title: "𠮷田の分散メモリ管理",
      abstract: "GPU/vGPU 間の通信を評価する。",
      keywords: "",
      venue: "",
    });
  }
});

it("keeps a damaged UTF-16 ending visible and warns about it", async () => {
  const bytes = new Uint8Array([...utf16("Title: 日本語\nAbstract: 読み取り終端", true), 0x41]);
  const record = runtime.readable(await runtime.read(new File([bytes], "truncated.txt"), signal()));
  expect(record.title).toBe("日本語");
  expect(record.abstract).toBe("読み取り終端\uFFFD");
  expect(runtime.status(["truncated.txt"], [record])).toContain("読み取れない文字");
});

it("does not read an already-cancelled TXT and stops a pending read before parsing", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let reads = 0;
  const file = {
    name: "paper.txt",
    size: 5,
    arrayBuffer: async () => {
      reads++;
      return new ArrayBuffer(0);
    },
    text: async () => {
      reads++;
      return "title";
    },
  };
  await expect(runtime.read(file, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBe(0);
  let resolve!: (bytes: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((done) => {
    resolve = done;
  });
  const controller = new AbortController();
  const result = runtime.read(
    { name: "pending.txt", size: 5, arrayBuffer: () => pending },
    controller.signal,
  );
  controller.abort();
  resolve(utf16(labeled(records[1]), true).buffer);
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});

it("identifies TXT read failures in Japanese while keeping byte limits and PDF routing", async () => {
  const failure = new Error("disk unavailable");
  const broken = {
    name: "broken.txt",
    size: 1,
    arrayBuffer: async () => {
      throw failure;
    },
    text: async () => {
      throw failure;
    },
  };
  const error = await runtime.read(broken, signal()).catch((e: unknown) => e);
  expect(runtime.message(error)).toContain("TXT を読み込めませんでした");
  expect(runtime.message(error)).toContain("貼り付けてください");
  expect(runtime.message(error)).not.toContain("PDF");
  await expect(
    runtime.read(
      { name: "large.txt", size: runtime.limit + 1, arrayBuffer: async () => new ArrayBuffer(0) },
      signal(),
    ),
  ).rejects.toThrow("too large");
  expect(runtime.message(new Error("file is too large"))).toContain("ファイルが大きすぎます");
  expect(runtime.message(new Error("file is too large"))).toContain("20 MB");
  await expect(runtime.read({ name: "paper.docx", size: 0 }, signal())).rejects.toThrow(
    "unsupported document",
  );
  pdfCalls.length = 0;
  const pdf = await runtime.read(new File([new Uint8Array([1, 2, 3])], "paper.pdf"), signal());
  expect(pdfCalls).toEqual([3]);
  expect(pdf.title).toBe("Actual PDF");
});
