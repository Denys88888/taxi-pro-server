// A value that costs a Firestore read to fetch, is asked for far more often
// than it changes, and is allowed to be a few seconds out of date.
//
// Firestore bills every read, including the ones that return the answer the
// caller already had. On the free tier that is not just waste, it is an outage:
// exhausting the daily quota is what made the API answer `8 RESOURCE_EXHAUSTED`
// on every request until midnight Pacific. The hot read paths share this rather
// than each growing its own ad-hoc cache.
//
// Two properties beyond the TTL are what make it safe:
//   - Single flight. Concurrent callers on a cold key wait on one load instead
//     of starting one each, so a burst can't multiply the very reads it saves.
//   - Explicit invalidation. Whoever writes the value refreshes it immediately,
//     so the TTL only ever bounds staleness caused by *another* instance.
//
// Nothing that decides money or authorization may depend on a cached value
// alone — check the callers before widening its use.
export class TtlCache<V> {
  private entries = new Map<string, { value: V; at: number }>();
  private inFlight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    // Bounded, because a per-user cache would otherwise grow with every account
    // the process ever sees and never give the memory back. Map preserves
    // insertion order, so evicting its first key drops the oldest entry.
    private readonly maxEntries = 5_000
  ) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    // A failed load caches nothing and rejects every waiter — the next caller
    // retries against the real store rather than inheriting an error.
    const load$ = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, load$);
    return load$;
  }

  set(key: string, value: V): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, at: Date.now() });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
