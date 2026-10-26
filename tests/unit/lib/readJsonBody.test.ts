/**
 * readJsonBody's bounds (round-3): size, the whole-body deadline, the gap between chunks, JSON.
 * Real streams with real timers, at small limits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'http';
import { JsonBodyError, effectiveLimits, readJsonBody, readRawBody } from '@/lib/readJsonBody';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A request whose body is `parts`, each sent `gapMs` after the last. */
function req(parts: string[], gapMs = 0, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from((async function* gen() {
    for (const [i, p] of parts.entries()) { if (i > 0 && gapMs) await sleep(gapMs); yield Buffer.from(p); }
  })());
  return Object.assign(stream, { headers }) as unknown as IncomingMessage;
}
const limits = { maxBytes: 1024, totalMs: 300, idleMs: 100 };
const refusal = async (p: Promise<unknown>) => p.then(() => 'read', (e: unknown) => (e instanceof JsonBodyError ? `${e.status} ${e.code}` : String(e)));

describe('readJsonBody', () => {
  it('reads JSON sent in several chunks inside the bounds', async () => {
    expect(await readJsonBody(req(['{"a":', '[1,', '2]}'], 20), limits)).toEqual({ a: [1, 2] });
  });

  it('a gap between chunks longer than idleMs is REQUEST_BODY_TIMEOUT, at about idleMs', async () => {
    const t0 = Date.now();
    expect(await refusal(readJsonBody(req(['{"a":', '1}'], 250), limits))).toBe('400 REQUEST_BODY_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(240);
  });

  it('chunks each inside idleMs that together pass totalMs are REQUEST_BODY_TIMEOUT, at about totalMs', async () => {
    const t0 = Date.now();
    const parts = ['[', ...Array.from({ length: 20 }, () => '1,'), '1]'];
    expect(await refusal(readJsonBody(req(parts, 60), limits))).toBe('400 REQUEST_BODY_TIMEOUT');
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(700);
  });

  it('over maxBytes is 413, declared or streamed; not JSON is 400 REQUEST_BODY_INVALID', async () => {
    expect(await refusal(readJsonBody(req(['{}'], 0, { 'content-length': '5000' }), limits))).toBe('413 REQUEST_BODY_TOO_LARGE');
    expect(await refusal(readJsonBody(req(['"', 'x'.repeat(600), 'x'.repeat(600), '"']), limits))).toBe('413 REQUEST_BODY_TOO_LARGE');
    expect(await refusal(readJsonBody(req(['{"a":']), limits))).toBe('400 REQUEST_BODY_INVALID');
  });
});

describe('effectiveLimits: the test override', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const route = { maxBytes: 100, totalMs: 15_000, idleMs: 5_000 };

  it('under Vitest, BODY_READ_IDLE_MS / BODY_READ_TOTAL_MS replace the route limits (bytes never)', () => {
    vi.stubEnv('BODY_READ_IDLE_MS', '1000');
    vi.stubEnv('BODY_READ_TOTAL_MS', '3000');
    expect(effectiveLimits(route)).toEqual({ maxBytes: 100, totalMs: 3000, idleMs: 1000 });
  });

  it('outside Vitest the variables are ignored, so production keeps the route limits', () => {
    vi.stubEnv('BODY_READ_IDLE_MS', '1000');
    vi.stubEnv('VITEST', '');
    expect(effectiveLimits(route)).toEqual(route);
  });
});


describe('readRawBody: the minimum rate for a large body', () => {
  /** `head` at once, then one byte every `gapMs` for `trickleMs`, then the end. */
  function trickle(head: number, gapMs: number, trickleMs: number, declared: number): IncomingMessage {
    const stream = Readable.from((async function* gen() {
      yield Buffer.alloc(head, 0x20);
      for (let t = 0; t < trickleMs; t += gapMs) { await sleep(gapMs); yield Buffer.from(' '); }
    })());
    return Object.assign(stream, { headers: { 'content-length': String(declared) } }) as unknown as IncomingMessage;
  }
  const big = { maxBytes: 32 * 1048576, totalMs: 60_000, idleMs: 5_000 };

  it('a large declared body that trickles under MIN_BYTES_PER_SEC is refused soon after MIN_RATE_AFTER_MS, before it ends', async () => {
    const t0 = Date.now();
    const out = await refusal(readRawBody(trickle(64 * 1024, 300, 6000, 4 * 1048576), big));
    expect(out).toBe('400 REQUEST_BODY_TIMEOUT');
    // Refused by the rate rule (~2.1 s), not by the end of the 6 s trickle or the 5 s idle bound.
    expect(Date.now() - t0).toBeLessThan(4500);
  }, 15000);

  it('a 4 MB body at about 250 KB/s (a slow 2 Mbit/s uplink) is read whole', async () => {
    const chunk = 256 * 1024;
    const stream = Readable.from((async function* gen() { for (let i = 0; i < 16; i++) { if (i) await sleep(1000); yield Buffer.alloc(chunk, 0x20); } })());
    const req = Object.assign(stream, { headers: { 'content-length': String(16 * chunk) } }) as unknown as IncomingMessage;
    expect((await readRawBody(req, big)).length).toBe(16 * chunk);
  }, 30000);

  it('a small body is never held to the rate', async () => {
    expect((await readRawBody(trickle(10, 300, 3000, 20), big)).length).toBe(20);
  }, 15000);
});
