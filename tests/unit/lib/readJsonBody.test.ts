/**
 * readJsonBody's bounds (round-3): size, the whole-body deadline, the gap between chunks, JSON.
 * Real streams with real timers, at small limits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'http';
import { JsonBodyError, effectiveLimits, readJsonBody, readRawBody } from '@/lib/readJsonBody';
import { SAVE_BODY_LIMITS } from '../../../pages/api/accounting/budget-grid/save';

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

describe('readRawBody: the three tiers on slow links, and aborted requests', () => {
  // The save route's own limits.
  const save = SAVE_BODY_LIMITS;
  /** `chunks` pieces of `size` bytes, one every `gapMs`, after `pauseMs`; declared length = the total. */
  function paced(size: number, chunks: number, gapMs: number, pauseMs = 0, declared = size * chunks): IncomingMessage {
    const stream = Readable.from((async function* gen() {
      await sleep(pauseMs);
      for (let i = 0; i < chunks; i++) { if (i) await sleep(gapMs); yield Buffer.alloc(size, 0x20); }
    })());
    return Object.assign(stream, { headers: { 'content-length': String(declared) } }) as unknown as IncomingMessage;
  }

  it('large: a body declared 2 MB, sent at about 64 KB/s (512 kbit/s ADSL) after a 5 s pause, passes the floor once the grace is over', async () => {
    // Twelve 64 KB chunks a second apart: 11 s of sending, so the floor (after 10 s) is applied.
    expect((await readRawBody(paced(64 * 1024, 12, 1000, 5000, 2 * 1048576), save)).length).toBe(12 * 64 * 1024);
  }, 40000);

  it('large: a body trickled at 8 KB/s (under the 16 KB/s floor) is refused once the 10 s grace from its first byte is over', async () => {
    const t0 = Date.now();
    // Declared 2 MB (large), sent at 8 KB a second.
    expect(await refusal(readRawBody(paced(8 * 1024, 40, 1000, 0, 2 * 1048576), save))).toBe('400 REQUEST_BODY_TIMEOUT');
    // After the grace (10 s), long before the 290 s total or the trickle's own end (40 s).
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(ms).toBeLessThan(20_000);
  }, 40000);

  it('large: the floor is measured from the FIRST byte, so a long pause before it costs nothing', async () => {
    // Declared 2 MB; 8 s of silence (under the 10 s idle bound), then 32 KB a second (twice the floor).
    expect((await readRawBody(paced(32 * 1024, 12, 1000, 8000, 2 * 1048576), save)).length).toBe(12 * 32 * 1024);
  }, 40000);

  it('small: a declared ~200 KB body at ~5 KB/s is refused at its 30 s total, not the route\'s 290 s', async () => {
    const t0 = Date.now();
    expect(await refusal(readRawBody(paced(5 * 1024, 40, 1000), save))).toBe('400 REQUEST_BODY_TIMEOUT');
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(29_000);
    expect(ms).toBeLessThan(36_000);
  }, 50000);

  it('tiny: a 2 KB body is held to 15 s in all, not the route\'s 290 s', async () => {
    const t0 = Date.now();
    expect(await refusal(readRawBody(paced(100, 20, 1000), save))).toBe('400 REQUEST_BODY_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(17_000);
  }, 30000);

  it('a request already aborted or destroyed is refused at once, not when the idle timer fires', async () => {
    const patient = { maxBytes: 1024, totalMs: 60_000, idleMs: 60_000 };
    const destroyed = Readable.from((async function* gen() { await sleep(60_000); yield Buffer.from('{}'); })());
    destroyed.destroy();
    const aborted = Object.assign(Readable.from((async function* gen() { await sleep(60_000); yield Buffer.from('{}'); })()), { aborted: true });
    for (const stream of [destroyed, aborted]) {
      const req = Object.assign(stream, { headers: {} }) as unknown as IncomingMessage;
      expect(await refusal(readRawBody(req, patient))).toBe('400 REQUEST_BODY_INVALID');
    }
  }, 3000);
});
