import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callMcp, createMcpSandbox, type McpCall } from "./mcp_stdio.ts";

const root = createMcpSandbox("kamiyobi-mcp-retrieval-inputs-", "2030-01-01T00:00:00Z");
const index = {
  generated_at: "2030-01-01T00:00:00Z",
  categories: { systems: "Systems", networks: "Networks" },
  conferences: [
    {
      key: "gpu",
      title: "GPU Memory Symposium",
      full_name: "GPUメモリ研究会",
      scope: "GPU memory management",
      categories: ["systems"],
    },
    {
      key: "net",
      title: "Network Routing Symposium",
      full_name: "ネットワーク経路制御研究会",
      scope: "network routing",
      categories: ["networks"],
    },
  ].map((venue) => ({ ...venue, tags: [], rank: {}, editions: [] })),
};
writeFileSync(join(root, "public/recommendation-index.json"), JSON.stringify(index));
interface Reply {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: {
    candidate_venues?: number;
    uses_embeddings?: boolean;
    embedding_model?: unknown;
    rows?: Array<{ venue_key: string }>;
    error?: { code: string; model: { id: string } };
  };
}
const calls = (requests: McpCall[]) => callMcp<Reply>(root, requests);
const text = (reply: Reply) => reply.content.map((part) => part.text).join("\n");
const papers = [
  { title: "GPU memory management", model: "Xenova/all-MiniLM-L6-v2" },
  { title: "GPUメモリ管理", model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" },
];
for (const tool of ["search_venues", "recommend_venues"]) {
  const field = tool === "search_venues" ? "query" : "paper";
  it(`${tool} rejects malformed retrieval modes and preserves lexical retry on the same connection`, () => {
    for (const paper of papers) {
      const args = { [field]: { title: paper.title } };
      const requests: McpCall[] = [[tool, { ...args, retrieval: "lexical" }]];
      for (const retrieval of [
        [],
        ["semantic"],
        [["semantic"]],
        ["lexical"],
        {},
        { mode: "semantic" },
        null,
        true,
        1,
        "",
        "SEMANTIC",
        " semantic ",
        "unknown",
      ])
        requests.push([tool, { ...args, retrieval }], [tool, { ...args, retrieval: "lexical" }]);
      requests.push([tool, args]);
      const [baseline, ...replies] = calls(requests);
      expect(baseline.isError).not.toBe(true);
      expect(baseline.structuredContent).toMatchObject({
        candidate_venues: 2,
        uses_embeddings: false,
        embedding_model: null,
      });
      expect(baseline.structuredContent?.rows?.[0].venue_key).toBe("gpu");
      for (let i = 0; i < replies.length - 1; i += 2) {
        expect(replies[i].isError, JSON.stringify(replies[i])).toBe(true);
        expect(replies[i].structuredContent).toBeUndefined();
        expect(text(replies[i])).toContain(
          "retrieval は lexical または semantic を指定してください",
        );
        expect(text(replies[i])).not.toContain("[object Object]");
        expect(replies[i + 1]).toEqual(baseline);
      }
      expect(replies.at(-1)).toEqual(baseline);
    }
  });

  it(`${tool} keeps a valid semantic request visible as a model error when weights are absent`, () => {
    expect(existsSync(join(root, ".cache"))).toBe(false);
    for (const paper of papers) {
      const args = { [field]: { title: paper.title } };
      const [bad, semantic, lexical] = calls([
        [tool, { ...args, retrieval: ["semantic"] }],
        [tool, { ...args, retrieval: "semantic" }],
        [tool, { ...args, retrieval: "lexical" }],
      ]);
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toBeUndefined();
      expect(semantic.isError).toBe(true);
      expect(semantic.structuredContent?.error).toMatchObject({
        code: "MODEL_NOT_READY",
        model: { id: paper.model },
      });
      expect(semantic.structuredContent?.rows).toBeUndefined();
      expect(lexical.isError).not.toBe(true);
      expect(lexical.structuredContent?.uses_embeddings).toBe(false);
      expect(lexical.structuredContent?.rows?.[0].venue_key).toBe("gpu");
    }
  });
}
