import { expect, it } from "vitest";
import { profileTexts, topicProfileTexts } from "../src/embedding-profiles.ts";
import { SemanticProfileCache, semanticProfileKey } from "../src/semantic-profile-cache.ts";

it("does not reload profiles for a deadline change but reloads an official topic change", async () => {
  const venue = {
    key: "systems",
    title: "Systems",
    categories: ["systems"],
    official_scope: ["Distributed file storage"],
    editions: [{ year: 2026, deadlines: [{ utc: "2026-10-01T00:00:00Z" }] }],
  };
  const changedDate = {
    ...venue,
    editions: [{ year: 2027, deadlines: [{ utc: "2027-02-01T00:00:00Z" }] }],
  };
  const changedTopic = { ...changedDate, official_scope: ["Operating system process isolation"] };
  const key = (c: unknown) =>
    semanticProfileKey(
      "root",
      "model",
      "revision",
      profileTexts([c], { systems: "Systems" }, false, {}),
      topicProfileTexts([c], { systems: "Systems" }, false),
    );
  const cache = new SemanticProfileCache<object>(2);
  let loads = 0;
  const load = async () => ({ load: ++loads });
  const first = await cache.getOrCreate(key(venue), load);
  expect(await cache.getOrCreate(key(changedDate), load)).toBe(first);
  expect(loads).toBe(1);
  expect(await cache.getOrCreate(key(changedTopic), load)).not.toBe(first);
  expect(loads).toBe(2);
});
it("keeps the recently used profile and evicts the old revision when capacity is reached", async () => {
  const cache = new SemanticProfileCache<string>(2);
  const loaded: string[] = [];
  const get = (key: string) =>
    cache.getOrCreate(key, async () => {
      loaded.push(key);
      return key;
    });
  await get("english");
  await get("japanese");
  await get("english");
  await get("updated");
  await get("english");
  expect(loaded).toEqual(["english", "japanese", "updated"]);
  await get("japanese");
  expect(loaded).toEqual(["english", "japanese", "updated", "japanese"]);
});
it("shares work that is still running and retries after its failure", async () => {
  const cache = new SemanticProfileCache<string>(2);
  let fail!: (reason: Error) => void;
  let calls = 0;
  const first = cache.getOrCreate("profile", () => {
    calls++;
    return new Promise<string>((_, reject) => {
      fail = reject;
    });
  });
  expect(cache.getOrCreate("profile", async () => "duplicate")).toBe(first);
  await Promise.resolve();
  fail(new Error("inference unavailable"));
  await expect(first).rejects.toThrow("inference unavailable");
  expect(
    await cache.getOrCreate("profile", async () => {
      calls++;
      return "recovered";
    }),
  ).toBe("recovered");
  expect(calls).toBe(2);
});
it("does not let an evicted failed request remove a newer request for the same profile", async () => {
  const cache = new SemanticProfileCache<string>(1);
  let fail!: (reason: Error) => void;
  const old = cache.getOrCreate(
    "profile",
    () =>
      new Promise<string>((_, reject) => {
        fail = reject;
      }),
  );
  await Promise.resolve();
  await cache.getOrCreate("other", async () => "other");
  const current = cache.getOrCreate("profile", async () => "current");
  fail(new Error("old request failed"));
  await expect(old).rejects.toThrow("old request failed");
  expect(await current).toBe("current");
  expect(cache.getOrCreate("profile", async () => "should not run")).toBe(current);
});
