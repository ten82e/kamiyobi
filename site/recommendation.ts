import Core from "./recommender.ts";

const STOP = new Set(
  "a an and are as at be been both by can compared for from has have in into is it its of on or our that the their these this through to using was we were which while with work study paper proposes propose evaluation experiments results method approach performance techniques existing".split(
    " ",
  ),
);
function tokens(value: string): string[] {
  return (
    value
      .toLowerCase()
      .replace(/[-‐‑–]/g, " ")
      .match(/[a-z][a-z0-9]{2,}/g) ?? []
  )
    .filter((word) => !STOP.has(word))
    .map((word) => {
      const singular = word.endsWith("ies")
        ? `${word.slice(0, -3)}y`
        : word.length > 4 && word.endsWith("s") && !word.endsWith("ss")
          ? word.slice(0, -1)
          : word;
      return singular.length > 5 ? singular.replace(/(?:ing|ed)$/, "") : singular;
    });
}
function terms(value: string): string[] {
  return [...new Set(tokens(value))];
}
function phrases(value: string): Set<string> {
  const words = tokens(value);
  return new Set(
    words.flatMap((_, index) =>
      [2, 3]
        .filter((size) => index + size <= words.length)
        .map((size) => words.slice(index, index + size).join(" ")),
    ),
  );
}

function text(value: unknown): string {
  return Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
}

/** Use documented venue topics and corpus rarity for the word-only retrieval path. */
export function venueLexicalScores(
  rows: Parameters<typeof Core.venueRecommendations>[0],
  lines: Parameters<typeof Core.venueRecommendations>[1],
): Map<string, number> {
  const queryText = Core.queryText(lines);
  const query = terms(queryText);
  const nameQuery = new Set(queryText.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []);
  const queryPhrases = phrases(queryText);
  const documents = new Map<
    string,
    {
      names: Set<string>;
      topics: Set<string>;
      phrases: Set<string>;
      entries: Array<{ topics: Set<string>; phrases: Set<string> }>;
    }
  >();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("conf" in row)) continue;
    if (!row.conf || typeof row.conf !== "object") continue;
    const conf = row.conf as Record<string, unknown>;
    const key = typeof conf.key === "string" ? conf.key : "";
    if (!key || documents.has(key)) continue;
    const entries = [conf.scope, conf.official_scope, conf.keywords]
      .flatMap((value) => (Array.isArray(value) ? value.map(text) : [text(value)]))
      .filter((entry) => entry.trim());
    const topicText = entries.join(" ");
    documents.set(key, {
      names: new Set(terms([text(conf.title), text(conf.full_name), key].join(" "))),
      topics: new Set(terms(topicText)),
      phrases: phrases(topicText),
      entries: entries.map((entry) => ({ topics: new Set(terms(entry)), phrases: phrases(entry) })),
    });
  }
  const frequency = new Map<string, number>();
  for (const doc of documents.values())
    for (const word of new Set([...doc.names, ...doc.topics, ...doc.phrases]))
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return new Map(
    [...documents].map(([key, doc]) => {
      const overlap = (tokens: Set<string>, weight: number) =>
        query.reduce((score, word) => {
          if (!tokens.has(word)) return score;
          const count = frequency.get(word) ?? 0;
          return score + weight * Math.log(1 + (documents.size - count + 0.5) / (count + 0.5));
        }, 0);
      const phraseScore = (entryPhrases: Set<string>) =>
        [...queryPhrases].reduce(
          (score, phrase) =>
            !entryPhrases.has(phrase)
              ? score
              : score +
                4 *
                  Math.log(
                    1 +
                      (documents.size - (frequency.get(phrase) ?? 0) + 0.5) /
                        ((frequency.get(phrase) ?? 0) + 0.5),
                  ),
          0,
        );
      // Each documented topic is judged on its own, so a long topic list neither
      // collects scattered words nor is diluted by its length.
      const topicScore = Math.max(
        0,
        ...doc.entries.map((entry) => overlap(entry.topics, 2) + phraseScore(entry.phrases)),
      );
      return [
        key,
        overlap(new Set([...doc.names].filter((word) => nameQuery.has(word))), 1) + topicScore,
      ];
    }),
  );
}

type Args = Parameters<typeof Core.venueRecommendations>;
type Result = ReturnType<typeof Core.venueRecommendations>[number];

/** Encode the complete text and its topic-setting title/opening sentence separately. */
export function semanticQueryPlan(lines: Args[1]): Array<{ text: string; weight: number }> {
  const query = Core.queryText(lines);
  const primary = lines[0];
  const abstract = primary?.abstract?.trim() ?? "";
  if (!abstract) return [{ text: query, weight: 1 }];
  const boundary = /[。！？]|\.(?:\s|$)/.exec(abstract);
  const opening = boundary ? abstract.slice(0, boundary.index).trim() : abstract;
  if (!primary?.title?.trim() && opening === abstract) return [{ text: query, weight: 1 }];
  const focus = Core.queryText([
    {
      title: primary?.title ?? "",
      abstract: opening,
      keywords: [
        primary?.keywords ?? "",
        primary?.title?.trim() ? "" : Core.expandJp(abstract, true),
      ].join(" "),
    },
  ]);
  if (focus === query) return [{ text: query, weight: 1 }];
  const fullWeight = 0.5;
  return [
    { text: query, weight: fullWeight },
    { text: focus, weight: 1 - fullWeight },
  ];
}

export function semanticQueryVector(lines: Args[1], vectors: number[][]): number[] {
  const plan = semanticQueryPlan(lines);
  if (vectors.length !== plan.length || !vectors[0]?.length)
    throw new Error("query embedding outputs do not match their input fields");
  if (plan.length === 1) return vectors[0];
  if (vectors[0].length !== vectors[1].length)
    throw new Error("query embedding dimensions disagree");
  return Core.blendVectors(vectors[0], vectors[1], plan[0].weight);
}

/** Word-only fallback: respect an explicitly named venue and reject category-only false matches.
 * Semantic retrieval keeps its independently verified scoring and feature artifacts. */
export function venueRecommendations(...args: Args): Result[] {
  const [rows, lines, semanticScores, now, options = {}] = args;
  const topN =
    Number.isInteger(options.topN) && (options.topN ?? 0) > 0
      ? options.topN!
      : Math.max(1, rows.length);
  if (semanticScores)
    return Core.venueRecommendations(rows, lines, semanticScores, now, { ...options, topN });
  const named = new Set<string>();
  const text = lines
    .slice(0, 1)
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
  /* 語の重なりの点は、一致評価が同じ候補どうしの並びにだけ使う（点の順は画面の札と
   * 揃える – 2026-10-18）。 */
  const retrieval = venueLexicalScores(rows, lines);
  const expanded = lines.map((line) => ({
    ...line,
    keywords: [line.keywords ?? "", Core.queryText([line])].join(" "),
  }));
  const results = Core.venueRecommendations(
    rows,
    Core.queryHasJapanese(lines) ? expanded : lines,
    semanticScores,
    now,
    {
      ...options,
      topN: named.size ? Math.max(rows.length, topN) : topN,
    },
  );
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
        Number(named.has(b.venueKey.toLowerCase())) - Number(named.has(a.venueKey.toLowerCase())) ||
        /* 並びは**画面に出している一致評価（`fit.score`）の強い順**にする。語の重なりの
         * 点数（`retrieval`）で並べ替えると、点の低い候補（例: 16 点）が点の高い候補
         * （例: 80 点）より上に来て、カードの札（「候補」「重なりうすい」）と順が食い違う
         * （2026-10-18 実測: TSN の例で RTSS 80 点が 9 番目、COLT 16 点が 1 番目）。 */
        (b.fit?.score ?? 0) - (a.fit?.score ?? 0) ||
        (retrieval.get(b.venueKey) ?? 0) - (retrieval.get(a.venueKey) ?? 0),
    )
    .slice(0, topN);
}

export default { ...Core, venueRecommendations, semanticQueryPlan, semanticQueryVector };
