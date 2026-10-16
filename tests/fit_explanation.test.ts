import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import R from "../site/recommender.ts";
import { callMcp, createMcpSandbox } from "./mcp_stdio.ts";

const now = "2030-01-01T00:00:00Z";
const conference = {
  key: "gpu",
  title: "GPU memory management",
  full_name: "GPU memory management",
  scope: "GPU memory management",
  tags: ["gpu", "memory"],
  categories: ["hpc"],
  editions: [
    { year: 2030, deadlines: [{ kind: "paper", utc: "2030-02-01T00:00:00Z", tz_raw: "UTC" }] },
  ],
};
const paper = { title: conference.title, abstract: conference.scope, keywords: "GPU, memory" };
it("retains the candidate label for strong isolated evidence without implying a small margin", () => {
  R.setReranker(null);
  const result = R.venueRecommendations(
    R.candidateRows({ conferences: [conference] }),
    [paper],
    null,
    Date.parse(now),
    { fieldedLexical: true },
  );
  expect(result).toHaveLength(1);
  expect(result[0].fit.evidenceStrength).toBe(100);
  expect(result[0].fit.queryConfidence.margin).toBe(100);
  expect(R.confidenceState(100, Infinity)).toBe("sufficient");
  expect(result[0].fit.confidence).toBe("ambiguous");
  expect(result[0].fit.label).toBe("候補");
});

it.each(["search_venues", "recommend_venues"])(
  "%s explains a strong isolated candidate consistently with the screen",
  (tool) => {
    const root = createMcpSandbox("kamiyobi-fit-explanation-", now);
    const data = {
      conferences: [conference],
      categories: { hpc: "高性能計算" },
      generated_at: now,
      snapshot_metadata: { generated_at: now },
    };
    for (const path of [
      "data/snapshot.json",
      "public/catalog.json",
      "public/recommendation-index.json",
    ])
      writeFileSync(join(root, path), JSON.stringify(data));
    const [reply] = callMcp<{
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: {
        rows: Array<{ fit: { confidence: string; label: string; score: number } }>;
      };
    }>(root, [[tool, { [tool === "search_venues" ? "query" : "paper"]: paper }]]);
    expect(reply.isError).not.toBe(true);
    expect(reply.structuredContent?.rows).toHaveLength(1);
    expect(reply.structuredContent?.rows[0].fit).toMatchObject({
      confidence: "ambiguous",
      label: "候補",
    });
    expect(reply.structuredContent?.rows[0].fit.score).toBeGreaterThanOrEqual(55);
    const text = reply.content[0].text;
    const html = readFileSync(new URL("../site/template.html", import.meta.url), "utf8").replace(
      /<[^>]*>/g,
      "",
    );
    for (const sentence of [
      "候補",
      "は投稿先として適合を確認する対象で、強い一致も含みます。",
      "は言葉や意味の一致が弱い候補です。",
    ]) {
      expect(text).toContain(sentence);
      expect(html).toContain(sentence);
    }
    expect(text).toContain("採択の予測ではありません");
    expect(html).toContain("採択される可能性の予測ではありません");
    expect(text).not.toContain("いちばん近い会議との差が小さい");
    expect(html).not.toContain("いちばん近い会議との差が小さい");
    expect(html).toContain("意味検索が使えるときは、2つの検索の順位を合わせます");
    const section = html.slice(
      html.indexOf("一致評価の出し方（投稿先を探す）"),
      html.indexOf("当たった要素の名前"),
    );
    expect(section).toContain("カードの「選定理由」");
    expect(section).toContain("会議名か「公式サイト」を開いて募集分野を確認");
    expect(section).not.toContain("チップを押す");
    expect(section).not.toContain("Tab でチップ");
  },
);
