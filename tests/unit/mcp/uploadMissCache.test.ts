/** The PUT route's miss cache: answers a recent miss, forgets it after its TTL, and stays bounded (oldest out first). */
import { beforeEach, describe, expect, it } from 'vitest';
import { uploadMissCache } from '@/lib/mcp/uploadMissCache';

beforeEach(() => uploadMissCache.clear());

describe('uploadMissCache', () => {
  it('remembers a miss for a minute, then forgets it', () => {
    uploadMissCache.add('h', 0);
    expect(uploadMissCache.has('h', 59_000)).toBe(true);
    expect(uploadMissCache.has('h', 61_000)).toBe(false);
    expect(uploadMissCache.has('other', 0)).toBe(false);
  });

  it('holds at most 10,000 hashes, evicting the oldest', () => {
    for (let n = 0; n <= 10_000; n += 1) uploadMissCache.add(`h${n}`, 1);
    expect(uploadMissCache.size).toBe(10_000);
    expect(uploadMissCache.has('h0', 1)).toBe(false);
    expect(uploadMissCache.has('h10000', 1)).toBe(true);
  });
});
