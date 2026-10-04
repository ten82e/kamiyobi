import Core from "./recommender.ts";

type Args = Parameters<typeof Core.venueRecommendations>;
type Result = ReturnType<typeof Core.venueRecommendations>[number];

/** Word-only fallback: respect an explicitly named venue and reject category-only false matches.
 * Semantic retrieval keeps its independently verified scoring and feature artifacts. */
export function venueRecommendations(...args: Args): Result[] {
  const [rows, lines, semanticScores, now, options = {}] = args;
  if (semanticScores) return Core.venueRecommendations(...args);
  const named = new Set<string>();
  const text = lines
    .map((line) => `${line.title} ${line.keywords ?? ""}`)
    .join(" ")
    .toLowerCase();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const conf = (raw as { conf?: { key?: string } }).conf;
    const key = String(conf?.key ?? "").toLowerCase();
    if (key.length < 3 || Object.hasOwn(Core.DOMAIN_SIGNAL, key)) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, "i").test(text)) named.add(key);
  }
  const topN = Number.isInteger(options.topN) && (options.topN ?? 0) > 0 ? options.topN! : 200;
  const results = Core.venueRecommendations(rows, lines, semanticScores, now, {
    ...options,
    topN: named.size ? Math.max(200, topN) : topN,
  });
  return results
    .filter((result) => {
      if (named.has(result.venueKey.toLowerCase())) return true;
      const fields = result.fit.fieldScores;
      const agg = result.match.agg;
      const categoryOnly = Object.entries(fields).every(
        ([field, value]) => field === "categories" || value === 0,
      );
      return !(
        categoryOnly &&
        agg.name > 0 &&
        agg.domain === 0 &&
        agg.jp === 0 &&
        agg.paper === 0 &&
        agg.tags === 0 &&
        agg.venue === 0
      );
    })
    .sort(
      (a, b) =>
        Number(named.has(b.venueKey.toLowerCase())) - Number(named.has(a.venueKey.toLowerCase())),
    )
    .slice(0, topN);
}

export default { ...Core, venueRecommendations };
