import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

/* 「投稿締切が未収録の開催回」の一覧は、会議の名前・会期・開催地で引く。URL のホストを混ぜると、
 * 同じ親サイトの下に別の会議が並ぶ所で、その会議の名前が別の会議に当たる（2026-10-23 実測:
 * `SIGCOMM` の 0 件の画面に、IMC 2027（https://conferences.sigcomm.org/imc/…）が出た）。 */
it("会期だけの行を、別の会議の URL のホストで引かない", () => {
  const data = JSON.parse(readFileSync(join(REPO_ROOT, "public", "data.json"), "utf8"));
  const eds = Recommender.scheduleOnlyEditions(data) as Array<{ key: string; hay: string }>;
  const imc = eds.filter((ed) => ed.key === "imc");
  expect(imc.length, "この検査の前提（IMC の会期だけの行）が崩れた").toBeGreaterThan(0);
  for (const ed of imc)
    expect(ed.hay, "IMC の行が sigcomm.org のホストで引ける").not.toContain("sigcomm");
  /* 会議の名前では引ける（URL を落としても名前の検索は残る）。 */
  expect(
    imc.some((ed) => ed.hay.includes("imc")),
    "IMC の名前で引けない",
  ).toBe(true);
  /* SIGCOMM の名前で、IMC の開催回が出ない。 */
  const at = Date.parse("2026-08-09T00:00:00Z");
  const hit = Recommender.searchMatcher(Recommender.expandRelativeMonths("SIGCOMM", at), at);
  expect(
    eds.filter((ed) => hit(ed.hay) === true).map((ed) => ed.key),
    "SIGCOMM の検索に、別の会議（IMC）の開催回が当たる",
  ).not.toContain("imc");
});
