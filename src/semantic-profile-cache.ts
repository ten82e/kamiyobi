import { createHash } from "node:crypto";

type Texts = { keys: string[]; texts: string[] };
/** Cache exactly the texts the encoder receives, rather than deadline or publication metadata. */
export function semanticProfileKey(
  root: string,
  model: string,
  revision: string,
  profiles: Texts,
  topics: Texts,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ root, model, revision, profiles, topics }))
    .digest("hex");
}

/** Bound retained profile revisions and share in-flight work; rejected work remains retryable. */
export class SemanticProfileCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("cache capacity must be a positive integer");
  }
  getOrCreate(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    while (this.entries.size >= this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
    const pending = Promise.resolve().then(load);
    this.entries.set(key, pending);
    void pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }
}
