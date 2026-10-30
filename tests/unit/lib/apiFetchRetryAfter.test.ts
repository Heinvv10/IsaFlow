/**
 * assertOk carries a refusal's Retry-After (whole seconds) on the ApiRequestError it throws, so a page
 * can say how long to wait (PR-B review r2, browser N2). Additive: the message and status are as
 * before; no header, or one that is not a whole number of seconds, leaves it undefined.
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError, assertOk } from '@/lib/apiFetch';

const refused = (headers: Record<string, string>) =>
  new Response(JSON.stringify({ success: false, error: { message: 'Too many requests. Please try again shortly.' } }), { status: 429, headers });

async function caught(res: Response): Promise<ApiRequestError> {
  try { await assertOk(res, 'fallback'); } catch (err) { return err as ApiRequestError; }
  throw new Error('assertOk did not throw');
}

describe('assertOk Retry-After', () => {
  it('a whole-seconds Retry-After is on the error', async () => {
    const err = await caught(refused({ 'Retry-After': '42' }));
    expect([err.message, err.status, err.retryAfterSecs]).toEqual(['Too many requests. Please try again shortly.', 429, 42]);
  });

  it.each([[{}], [{ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }], [{ 'Retry-After': '-3' }]])('%j leaves it undefined', async (h) => {
    expect((await caught(refused(h))).retryAfterSecs).toBeUndefined();
  });
});
