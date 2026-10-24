import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT, tempWork } from "./helpers.ts";

it.each(["search_deadlines", "list_upcoming"])(
  "%s describes effective kinds without contradicting its returned rows",
  (tool) => {
    const root = tempWork("kamiyobi-kind-guidance-");
    for (const dir of ["src", "site"])
      cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    mkdirSync(join(root, "data"));
    writeFileSync(
      join(root, "data/snapshot.json"),
      JSON.stringify({
        conferences: [
          {
            key: "fixture",
            title: "Fixture",
            rank: {},
            categories: [],
            editions: [
              {
                id: "fixture30",
                year: 2030,
                event_start: "2030-01-10",
                event_end: "2030-01-11",
                event_date_precision: "exact-range",
                deadlines: ["abstract", "paper", "notification"].map((kind, i) => ({
                  kind,
                  utc: `2030-01-0${i + 2}T00:00:00Z`,
                  tz_raw: "UTC",
                })),
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      join(root, "run.ts"),
      'import {runStdio} from "./src/mcp.ts";runStdio(Date.parse("2030-01-01T00:00:00Z"));',
    );
    const search = tool === "search_deadlines";
    const cases: Array<{
      args: Record<string, unknown>;
      expected: string[];
      unknown: boolean;
      empty: boolean;
      ignored: boolean;
      unknownValue?: string;
    }> = [
      {
        args: { kinds: ["paper"] },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: ["paper", "zzz"] },
        expected: ["paper"],
        unknown: true,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: ["論文締切", "zzz"] },
        expected: ["paper"],
        unknown: true,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: ["all", "zzz"] },
        expected: ["abstract", "paper", "notification"],
        unknown: true,
        empty: false,
        ignored: false,
      },
      { args: { kinds: ["zzz"] }, expected: [], unknown: true, empty: false, ignored: false },
      {
        args: { kinds: [] },
        expected: search ? ["abstract", "paper"] : ["abstract", "paper", "notification"],
        unknown: false,
        empty: true,
        ignored: false,
      },
      {
        args: { kinds: ["paper"], kind: "zzz" },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: ["zzz"], kind: "paper" },
        expected: [],
        unknown: true,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: null, kind: "paper" },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: [], kind: "paper" },
        expected: search ? ["abstract", "paper"] : ["abstract", "paper", "notification"],
        unknown: false,
        empty: true,
        ignored: true,
      },
      {
        args: { kinds: ["paper"], kind: null },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: ["採否通知"], kind: "論文締切" },
        expected: ["notification"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: ["概要締切", "論文締切"], kind: "採否通知" },
        expected: ["abstract", "paper"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: ["notification"], kind: "all" },
        expected: ["notification"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: ["all"], kind: "notification" },
        expected: ["abstract", "paper", "notification"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: null, kind: "採否通知" },
        expected: ["notification"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: [{}] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "オブジェクト",
      },
      {
        args: { kinds: { paper: true } },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "オブジェクト",
      },
      {
        args: { kind: {} },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "オブジェクト",
      },
      {
        args: { kinds: [null] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "空の値",
      },
      {
        args: { kinds: [[]] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "配列",
      },
      {
        args: { kinds: [""] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "空の文字列",
      },
      {
        args: { kinds: "   " },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "空の文字列",
      },
      {
        args: { kinds: [true] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "真偽値",
      },
      {
        args: { kinds: 2 },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "数値",
      },
      {
        args: { kinds: ["paper", {}] },
        expected: ["paper"],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "オブジェクト",
      },
      {
        args: { kinds: ["論文締切", null] },
        expected: ["paper"],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "空の値",
      },
      {
        args: { kinds: ["paper", ["notification"]] },
        expected: ["paper"],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "配列",
      },
      {
        args: { kinds: [["paper"]] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "配列",
      },
      {
        args: { kinds: [{}, { a: 1 }, null, "notification"] },
        expected: ["notification"],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "オブジェクト",
      },
      {
        args: { kinds: ["PAPER"] },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kind: " PAPER " },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: false,
      },
      {
        args: { kinds: ["UNKNOWN"] },
        expected: [],
        unknown: true,
        empty: false,
        ignored: false,
        unknownValue: "UNKNOWN",
      },
      {
        args: { kinds: {}, kind: "paper" },
        expected: [],
        unknown: true,
        empty: false,
        ignored: true,
        unknownValue: "オブジェクト",
      },
      {
        args: { kinds: ["paper"], kind: {} },
        expected: ["paper"],
        unknown: false,
        empty: false,
        ignored: true,
      },
      {
        args: { kinds: ["ALL", {}] },
        expected: ["abstract", "paper", "notification"],
        unknown: true,
        unknownValue: "オブジェクト",
        empty: false,
        ignored: false,
      },
      {
        args: { kind: ["paper", "採否通知"] },
        expected: ["paper", "notification"],
        unknown: false,
        empty: false,
        ignored: false,
      },
    ];
    const child = spawnSync(process.execPath, ["run.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      input: `${cases
        .map((c, id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: tool,
              arguments: { scope: "all", ...(!search ? { days: 30 } : {}), ...c.args },
            },
          }),
        )
        .join("\n")}\n`,
    });
    expect(child.status, child.stderr).toBe(0);
    const replies = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(cases.length);
    for (const [i, c] of cases.entries()) {
      const reply = replies[i];
      expect(reply.id).toBe(i);
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).not.toBe(true);
      const data = reply.result.structuredContent;
      const rows = search
        ? data.rows
        : data.items.filter((item: { type: string }) => item.type === "deadline");
      expect(rows.map((row: { kind: string }) => row.kind)).toEqual(c.expected);
      expect(search ? data.total : data.deadline_total).toBe(c.expected.length);
      if (!search) expect(data.event_total).toBe(1);
      const text = reply.result.content.map((part: { text: string }) => part.text).join("\n");
      expect(text.includes("知らない種別")).toBe(c.unknown);
      expect(text).not.toMatch(/\[object Object\]|\[object Null\]|undefined|NaN/);
      if (c.unknown) {
        expect(text).toContain(c.unknownValue ?? "知らない種別: zzz");
        expect(text).not.toContain("指定したままでは 0 件になります");
      }
      expect(text.includes("kinds が空なので")).toBe(c.empty);
      if (c.empty)
        expect(text).toContain(
          search
            ? "kinds が空なので既定の投稿締切（概要・論文・常時受付）を対象にしています"
            : "kinds が空なので種別では絞り込んでいません",
        );
      expect(text.includes("kind は kinds と共に与えられたので見ていません")).toBe(c.ignored);
    }
  },
);
