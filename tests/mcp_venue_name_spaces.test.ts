import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-mcp-venue-name-spaces-", "2030-01-01T00:00:00Z");
const data = {
  generated_at: "2030-01-01T00:00:00Z",
  snapshot_metadata: { generated_at: "2030-01-01T00:00:00Z" },
  categories: { hpc: "高性能計算" },
  conferences: [
    {
      key: "ipsj-sighpc",
      title: "情報処理学会 HPC 研究会",
      full_name: "情報処理学会 ハイパフォーマンスコンピューティング研究会 (SIGHPC)",
      categories: ["hpc"],
      tags: ["domestic-jp"],
      editions: [
        {
          id: "ipsj-hpc-2030-03",
          year: 2030,
          deadlines: [{ kind: "paper", utc: "2030-02-01T00:00:00Z", tz_raw: "UTC" }],
        },
      ],
    },
  ],
};
for (const path of ["data/snapshot.json", "public/catalog.json"])
  writeFileSync(join(root, path), JSON.stringify(data));

/* 2026-10-17 – AI 役の試しで、`venue_info` に `HPC研究会` を渡すと「収録に在りません」と返った（収録の名前は
 * `情報処理学会 HPC 研究会` で、語の間に空白がある）。日本語の名前は空白を入れても入れなくても同じ会議。 */
it("venue_info の name は、空白の有無が違っても同じ会議に当たる", () => {
  const calls: McpCall[] = [
    ["venue_info", { name: "HPC研究会" }],
    ["venue_info", { name: "HPC 研究会" }],
    ["venue_info", { name: "情報処理学会HPC研究会" }],
  ];
  const replies = callMcp<{ isError?: boolean; content: Array<{ text: string }> }>(root, calls);
  for (const [i, reply] of replies.entries()) {
    expect(reply.content[0].text, `呼び出し ${i}`).toContain("key: ipsj-sighpc");
    expect(reply.content[0].text, `呼び出し ${i}`).not.toContain("収録に在りません");
  }
});
