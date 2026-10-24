import Recommender from "../site/recommender.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

type Record = ReturnType<typeof Recommender.textPaperRecord>;
type PdfReader = (
  bytes: ArrayBuffer,
  signal: AbortSignal,
) => Promise<{ metadata: unknown; pages: unknown }>;
export function paperFileReader(readPdf: PdfReader = async () => ({ metadata: {}, pages: [[]] })) {
  const app = siteRuntime();
  const limits = ["PDF_MAX_BYTES", "PDF_MAX_PAGES"]
    .map((name) => {
      const value = new RegExp(`const ${name} = [^;]+;`).exec(app)?.[0];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    })
    .join("\n");
  const functions = [
    "unsupportedPaperFormatJa",
    "textRecord",
    "decodePaperText",
    "readPaperFile",
    "abortError",
    "pdfFailureMessageJa",
    "readablePaperFileRecord",
    "paperFileStatusJa",
  ];
  return new Function(
    "Recommender",
    "readPdf",
    [
      limits,
      ...functions.map((name) => jsFunction(app, name)),
      "return {read:readPaperFile, message:pdfFailureMessageJa, readable:readablePaperFileRecord, status:paperFileStatusJa, limit:PDF_MAX_BYTES};",
    ].join("\n"),
  )(Recommender, readPdf) as {
    read(
      file: Partial<File> & { name: string; size: number },
      signal: AbortSignal,
    ): Promise<Record>;
    message(error: unknown): string;
    readable(record: Record): Record;
    status(names: string[], records: Record[]): string;
    limit: number;
  };
}
