import Recommender from "../site/recommender.ts";

/** Query guidance APIs have different arguments; call each with its declared contract. */
export function queryGuidanceTexts(
  query: string,
  now: number,
  count: (query: string) => number,
): string[] {
  return [
    Recommender.columnQueryNoteJa(query, (word) => count(word) > 0),
    Recommender.columnQueryLiveNoteJa(query, (word) => count(word) > 0),
    Recommender.conjunctionQueryNoteJa(query, count),
    Recommender.splitHintJa(query, count),
    Recommender.uiWordNoteJa(query, false),
    Recommender.uiWordLiveNoteJa(query, false),
    Recommender.uiWordAlwaysNoteJa(query),
    Recommender.dayRangeNoteJa(query),
    Recommender.dayRangeLiveNoteJa(query),
    Recommender.wholeTableQueryNoteJa(query),
    Recommender.queryNarrowHintJa(query),
    ...Recommender.querySynonymNotes(query),
    ...Recommender.relativeDayNotes(query, now),
  ].filter((text) => text && !text.includes("当たっていて"));
}
