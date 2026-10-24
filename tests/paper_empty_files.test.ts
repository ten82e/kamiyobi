import { expect, it } from "vitest";
import { paperFileReader } from "./paper_file_reader.ts";

const signal = () => new AbortController().signal;
it("rejects empty and whitespace-only TXT in supported encodings instead of treating its filename as a title", async () => {
  const reader = paperFileReader();
  const inputs = [
    new Uint8Array(),
    new TextEncoder().encode(" \r\n\t　"),
    new Uint8Array([0xef, 0xbb, 0xbf]),
    new Uint8Array([0xff, 0xfe, 0x20, 0, 0x0a, 0]),
    new Uint8Array([0xfe, 0xff, 0, 0x20, 0, 0x0a]),
  ];
  for (const input of inputs) {
    const outcome = await reader.read(new File([input], "SC.txt"), signal()).then(
      (record) => ({ record }),
      (error) => ({ error }),
    );
    expect(outcome).toMatchObject({ error: { message: "TXT has no paper text" } });
    const message = reader.message((outcome as { error: Error }).error);
    expect(message).toContain("TXT");
    expect(message).toContain("題名や概要");
    expect(message).toContain("貼り付けてください");
    expect(message).not.toContain("PDF");
  }
});

it("rejects PDF extractions without paper text rather than borrowing the filename", async () => {
  for (const pages of [[], [[]], [[{ str: "   " }]]]) {
    const reader = paperFileReader(async () => ({ metadata: {}, pages }));
    const outcome = await reader.read(new File(["fixture"], "SC.pdf"), signal()).then(
      (record) => ({ record }),
      (error) => ({ error }),
    );
    expect(outcome).toMatchObject({ error: { message: "PDF has no paper text" } });
    const message = reader.message((outcome as { error: Error }).error);
    expect(message).toContain("PDF");
    expect(message).toContain("題名や概要");
    expect(message).toContain("貼り付けてください");
  }
});

it("retains actual PDF metadata or extracted titles and actual text titles", async () => {
  const metadata = paperFileReader(async () => ({
    metadata: { info: { Title: "分散メモリの設計" } },
    pages: [],
  }));
  await expect(
    metadata.read(new File(["fixture"], "unrelated.pdf"), signal()),
  ).resolves.toMatchObject({
    title: "分散メモリの設計",
  });
  const extracted = paperFileReader(async () => ({
    metadata: {},
    pages: [[{ str: "Distributed memory design" }]],
  }));
  await expect(
    extracted.read(new File(["fixture"], "unrelated.pdf"), signal()),
  ).resolves.toMatchObject({
    title: "Distributed memory design",
  });
  await expect(
    paperFileReader().read(
      new File(["日本語の題名\nGPUメモリを共有する概要"], "unrelated.txt"),
      signal(),
    ),
  ).resolves.toMatchObject({ title: "日本語の題名", abstract: "GPUメモリを共有する概要" });
});
