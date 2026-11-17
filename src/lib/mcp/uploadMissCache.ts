/**
 * Per-process memory of upload-token hashes that recently named no intent, so a replayed junk token is answered
 * 404 without a database lookup or a rate-limit write. Bounded (oldest evicted first) and short-lived.
 *
 * Safe to cache a miss: a token is generated server-side and handed to the agent only in create_upload_urls' reply,
 * which is sent after that transaction commits, so a token that misses never starts to resolve later (rows are
 * deleted, never re-created).
 */

const MAX_ENTRIES = 10_000;
const TTL_MS = 60_000;

class MissCache {
  private readonly seen = new Map<string, number>();

  has(tokenHash: string, now = Date.now()): boolean {
    const at = this.seen.get(tokenHash);
    if (at === undefined) return false;
    if (now - at > TTL_MS) { this.seen.delete(tokenHash); return false; }
    return true;
  }

  add(tokenHash: string, now = Date.now()): void {
    this.seen.delete(tokenHash);
    this.seen.set(tokenHash, now);
    while (this.seen.size > MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number { return this.seen.size; }

  clear(): void { this.seen.clear(); }
}

export const uploadMissCache = new MissCache();
