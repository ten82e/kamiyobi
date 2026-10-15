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
    const cases = [
      { args: { kinds: ["paper"] }, expected: ["paper"], unknown: false, empty: false },
      { args: { kinds: ["paper", "zzz"] }, expected: ["paper"], unknown: true, empty: false },
      { args: { kinds: ["論文締切", "zzz"] }, expected: ["paper"], unknown: true, empty: false },
      {
        args: { kinds: ["all", "zzz"] },
        expected: ["abstract", "paper", "notification"],
        unknown: true,
        empty: false,
      },
      { args: { kinds: ["zzz"] }, expected: [], unknown: true, empty: false },
      {
        args: { kinds: [] },
        expected: search ? ["abstract", "paper"] : ["abstract", "paper", "notification"],
        unknown: false,
        empty: true,
      },
      {
        args: { kinds: ["paper"], kind: "zzz" },
        expected: search ? ["paper"] : [],
        unknown: !search,
        empty: false,
      },
      {
        args: { kinds: ["zzz"], kind: "paper" },
        expected: search ? [] : ["paper"],
        unknown: search,
        empty: false,
      },
      { args: { kinds: null, kind: "paper" }, expected: ["paper"], unknown: false, empty: false },
      {
        args: { kinds: [], kind: "paper" },
        expected: search ? ["abstract", "paper"] : ["paper"],
        unknown: false,
        empty: search,
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
      if (c.unknown) {
        expect(text).toContain("知らない種別: zzz");
        expect(text).not.toContain("指定したままでは 0 件になります");
      }
      expect(text.includes("kinds が空なので")).toBe(c.empty);
      if (c.empty)
        expect(text).toContain(
          search
            ? "kinds が空なので既定の投稿締切（概要・論文・常時受付）を対象にしています"
            : "kinds が空なので種別では絞り込んでいません",
        );
      if (c.args.kinds === null)
        expect(text).not.toContain("kind は kinds と共に与えられたので見ていません");
    }
  },
);
