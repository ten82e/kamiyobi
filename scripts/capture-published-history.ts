/** Capture the actual publication, never a newly rebuilt approximation of it. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function verifyPublishedHistory(manifest: Record<string, any>, data: Uint8Array): void {
  const expected = manifest.artifacts?.["data.json"]?.sha256;
  if (
    !/^[a-f0-9]{64}$/.test(expected ?? "") ||
    createHash("sha256").update(data).digest("hex") !== expected
  )
    throw new Error("published history manifest/data hash mismatch");
  if (
    !/^[a-f0-9]{40}$/.test(manifest.source_commit ?? "") ||
    !/^[a-f0-9]{40}$/.test(manifest.data_commit ?? "")
  )
    throw new Error("published history manifest has no valid commit identity");
  const payload = JSON.parse(Buffer.from(data).toString("utf8"));
  if (!Array.isArray(payload.conferences) || !payload.conferences.length)
    throw new Error("published history is empty or malformed");
}

export async function capturePublishedHistory(out: string): Promise<void> {
  const origin = "https://ten82e.github.io/kamiyobi/";
  const read = async (name: string): Promise<Uint8Array> => {
    const response = await fetch(new URL(name, origin), {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`published history ${name}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const manifestBytes = await read("publish.json");
  const data = await read("data.json");
  verifyPublishedHistory(JSON.parse(Buffer.from(manifestBytes).toString("utf8")), data);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, data);
  writeFileSync(join(dirname(out), "publish.json"), manifestBytes);
}

if (process.argv[1]?.endsWith("capture-published-history.ts")) {
  await capturePublishedHistory(process.argv[2] ?? "/tmp/kamiyobi-update/published/data.json");
}
