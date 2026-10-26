/**
 * readJsonBody's bounds (round-3): size, the whole-body deadline, the gap between chunks, JSON.
 * Real streams with real timers, at small limits.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'http';
import { JsonBodyError, readJsonBody } from '@/lib/readJsonBody';

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
