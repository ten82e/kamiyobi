import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

it("updates dates, deadline boundaries and summaries across JST midnight on one live MCP connection", async () => {
  const repo = join(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-live-clock-"));
  for (const dir of ["src", "site"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "data"));
  const venue = (key: string, date: string, deadlines: unknown[], precision = "single-day") => ({
    key,
    title: key,
    categories: [],
    rank: {},
    editions: [
      {
        id: key,
        year: 2029,
        event_start: date || null,
        event_end: date || null,
        event_date_precision: precision,
        deadlines,
      },
    ],
  });
  const before = "2029-06-01T14:59:59.999Z";
  writeFileSync(join(root, "clock.txt"), String(Date.parse(before)));
  writeFileSync(
    join(root, "data/snapshot.json"),
    JSON.stringify({
      conferences: [
        venue("before", "2029-06-01", [{ kind: "paper", utc: before, tz_raw: "UTC" }]),
        venue("after", "2029-06-02", [
          { kind: "paper", utc: "2029-06-02T14:59:59.999Z", tz_raw: "UTC" },
        ]),
        venue("date-only", "", [
          {
            kind: "paper",
            precision: "date-only",
            local_date: "2029-06-01",
            earliest_utc: "2029-05-31T10:00:00Z",
            latest_utc: "2029-06-02T11:59:59.999Z",
          },
        ]),
        venue("month", "2029-06-01", [], "month-only"),
      ],
    }),
  );
  writeFileSync(
    join(root, "run.ts"),
    'import {readFileSync} from "node:fs";import {runStdio} from "./src/mcp.ts";Date.now=()=>Number(readFileSync("clock.txt","utf8"));runStdio();',
  );
  const child = spawn(process.execPath, ["run.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const result = JSON.parse(line);
    pending.get(result.id)?.resolve(result);
    pending.delete(result.id);
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.on("error", (error) => {
    for (const job of pending.values()) job.reject(error);
  });
  let id = 0;
  async function call(name: string, args: Record<string, unknown>) {
    const requestId = ++id;
    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP response timeout: ${stderr}`));
      }, 10000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
    });
    expect(reply.error, stderr).toBeUndefined();
    expect(reply.result.isError, stderr).not.toBe(true);
    expect(reply.result.structuredContent).toBeDefined();
    return reply.result.structuredContent;
  }
  try {
    for (const [clock, todayKeys, currentKeys, eventKeys, pendingDate] of [
      [
        before,
        ["before", "date-only"],
        ["after", "before", "date-only"],
        ["after", "before", "month"],
        true,
      ],
      ["2029-06-01T15:00:00.000Z", ["after"], ["after", "date-only"], ["after", "month"], true],
      ["2029-06-02T12:00:00.000Z", ["after"], ["after"], ["after", "month"], false],
    ] as const) {
      writeFileSync(join(root, "clock.txt"), String(Date.parse(clock)));
      const today = await call("search_deadlines", {
        query: "今日",
        kinds: ["paper"],
        scope: "all",
      });
      expect(today.evaluated_at).toBe(clock);
      expect(today.rows.map((row: { venue_key: string }) => row.venue_key).sort()).toEqual(
        todayKeys,
      );
      const current = await call("search_deadlines", { kinds: ["paper"], scope: "all" });
      expect(current.evaluated_at).toBe(clock);
      expect(current.rows.map((row: { venue_key: string }) => row.venue_key).sort()).toEqual(
        currentKeys,
      );
      const upcoming = await call("list_upcoming", { days: 1, scope: "all" });
      expect(upcoming.evaluated_at).toBe(clock);
      expect(
        upcoming.items
          .filter((row: { type: string }) => row.type === "event")
          .map((row: { venue_key: string }) => row.venue_key)
          .sort(),
      ).toEqual(eventKeys);
      const detail = await call("venue_info", { key: "date-only" });
      expect(detail.evaluated_at).toBe(clock);
      expect(detail.upcoming_deadline_total).toBe(pendingDate ? 1 : 0);
      expect(detail.past_deadline_total).toBe(pendingDate ? 0 : 1);
      if (pendingDate)
        expect(detail.next_submission).toMatchObject({
          edition_id: "date-only",
          uncertainty: { state: "uncertain-on-date" },
        });
      else expect(detail.next_submission).toBeNull();
      expect(child.exitCode).toBeNull();
    }
    expect(existsSync(join(root, "public"))).toBe(false);
    expect(existsSync(join(root, ".cache"))).toBe(false);
    child.stdin.end();
    expect(await closed, stderr).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
