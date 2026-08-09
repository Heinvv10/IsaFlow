/**
 * Unit tests for assertOk (src/lib/apiFetch.ts).
 *
 * apiFetch RESOLVES on 4xx/5xx — it only intercepts 401 to refresh — so
 * `await apiFetch(...)` inside a try/catch catches nothing on an error status.
 * Every mutating caller routes its response through assertOk; without it the
 * failure is discarded and the UI looks like a dead button (which is exactly
 * what happened to the admin feature toggles).
 */

import { describe, it, expect } from 'vitest';
import { assertOk, ApiRequestError } from '@/lib/apiFetch';

function make(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('assertOk', () => {
  it('resolves silently on a 2xx', async () => {
    await expect(assertOk(make(200, '{"data":1}'), 'nope')).resolves.toBeUndefined();
  });

  it('throws the server message and status on a 4xx', async () => {
    const res = make(400, JSON.stringify({ message: 'feature_id is required' }));

    await expect(assertOk(res, 'Failed to toggle')).rejects.toThrow('feature_id is required');
  });

  it('reads the nested error.message shape too', async () => {
    const res = make(403, JSON.stringify({ error: { message: 'Admin access required' } }));

    await expect(assertOk(res, 'Failed')).rejects.toThrow('Admin access required');
  });

  it('carries the HTTP status so callers can branch on it', async () => {
    const res = make(429, JSON.stringify({ message: 'Rate limited' }));

    await expect(assertOk(res, 'Failed')).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 429,
      message: 'Rate limited',
    });
    await expect(assertOk(make(500, ''), 'Boom')).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('falls back to the caller message on an empty or non-JSON body', async () => {
    await expect(assertOk(make(500, ''), 'Suspend failed')).rejects.toThrow('Suspend failed');
    await expect(assertOk(make(502, '<html>bad gateway</html>'), 'Activate failed')).rejects.toThrow(
      'Activate failed',
    );
  });

  it('falls back when the body is valid JSON but carries no message', async () => {
    await expect(assertOk(make(400, '{"data":null}'), 'Bulk update failed')).rejects.toThrow(
      'Bulk update failed',
    );
  });
});
