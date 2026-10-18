import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reverifyData } from "../src/reverify.ts";
import { tempWork } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function run(hosts: string[], fetchImpl: typeof fetch) {
  const root = tempWork("kamiyobi-reverify-host-queue-");
  roots.push(root);
  const dataPath = join(root, "data.json");
  writeFileSync(
    dataPath,
    JSON.stringify({
      conferences: [
        {
          key: "demo",
          title: "Demo",
          editions: [
            {
              year: 2027,
              deadlines: hosts.map((host, index) => ({
                kind: "paper",
                round: index + 1,
                precision: "date-only",
                local_date: `2027-01-0${index + 2}`,
                verification: {
                  official_url: `https://${host}/${index}`,
                  source_class: "official-cfp",
                  next_check_at: "2026-08-30T00:00:00Z",
                  status: "pending",
                },
              })),
            },
          ],
        },
      ],
    }),
  );
  return reverifyData({
    dataPath,
    ledgerPath: join(root, "ledger.json"),
    bodyRoot: join(root, "blobs"),
    due: true,
    now: new Date("2026-08-31T00:00:00Z"),
    limits: { concurrency: 3, minHostIntervalMs: 40 },
    fetchImpl,
  });
}

it.each([false, true])(
  "spaces same-host requests after a slow capture (failure: %s)",
  async (fail) => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const work = run(["example.test", "example.test"], async () => {
      const first = starts.length === 0;
      starts.push(Date.now());
      if (first) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (fail) throw new Error("temporary network failure");
      }
      return new Response("no deadline here");
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
    await work;
  },
);

it("keeps different hosts concurrent", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const work = run(["first.test", "second.test"], async () => {
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response("no deadline here");
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveLength(2);
  expect(starts[1]! - starts[0]!).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  await work;
});
