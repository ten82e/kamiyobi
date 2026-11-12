import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { FULL_VENUE_COUNT, FULL_VENUE_KEYS, freshFullVenuePool } from "./full_venue_pool.ts";

it("the raw-source evaluation includes the original venues and every current coverage addition", () => {
  const pool = freshFullVenuePool();
  try {
    expect(pool.conferences.map((conf) => conf.key).sort()).toEqual(FULL_VENUE_KEYS);
    expect(FULL_VENUE_COUNT).toBe(745);
    for (const key of ["pldi", "popl", "ismb", "ispd"]) expect(FULL_VENUE_KEYS).toContain(key);
  } finally {
    rmSync(pool.raw, { recursive: true, force: true });
  }
});
