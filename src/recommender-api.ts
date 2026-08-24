/** Typed boundary shared by the static site runtime and benchmark. */

export type RecommenderApi = typeof import("../site/recommender.ts").default;
export type PaperLine = ReturnType<RecommenderApi["parsePaperLines"]>[number];
export type VenueRecommendation = ReturnType<RecommenderApi["venueRecommendations"]>[number];

export async function loadRecommender(): Promise<RecommenderApi> {
  return (await import("../site/recommender.ts")).default;
}
