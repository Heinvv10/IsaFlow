// The bank connector's ingest call (chrome-extension/bank-connector/lib/api.js). Since WP2-2 (#1447) a feed batch can
// meet a 503 + Retry-After while another import holds the bank account's ingest lock (5 s at most, nothing written):
// the call retries ONCE after Retry-After (default 2 s, at most 10 s) and never on any other status.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SRC = readFileSync(join(process.cwd(), 'chrome-extension/bank-connector/lib/api.js'), 'utf8');
const CONN = { connectionId: 'c1', ingestUrl: '/api/accounting/bank-feeds/c1/extension-ingest', host: 'https://app.isaflow.co.za', jwt: 'j' };
const PAYLOAD = { scraperId: 'absa', transactions: [{ date: '2026-09-08', amount: -50 }] };

type Answer = { status: number; retryAfter?: string; body?: unknown };
type Api = { ingest: (c: unknown, p: unknown) => Promise<{ status: number; ok: boolean; body: unknown }> };

/** Load api.js as the service worker does, with `fetch` answering `answers` in turn and `setTimeout` recorded. */
function load(answers: Answer[]) {
  const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => {
    const a = answers.shift();
    if (!a) throw new Error('fetch called more often than the test allows');
    return {
      status: a.status, ok: a.status >= 200 && a.status < 300,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? a.retryAfter ?? null : null) },
      json: async () => a.body ?? null,
    };
  });
  const waits: number[] = [];
  const setTimeoutMock = (fn: () => void, ms: number) => { waits.push(ms); fn(); return 0; };
  const self: Record<string, unknown> = {};
  vm.runInNewContext(SRC, { self, fetch: fetchMock, setTimeout: setTimeoutMock, chrome: {} });
  return { api: self.IsaflowApi as Api, fetchMock, waits };
}

describe('bank connector ingest: one retry on a 503', () => {
  it('503 then 200: retries once after Retry-After and succeeds, sending the same batch', async () => {
    const { api, fetchMock, waits } = load([{ status: 503, retryAfter: '3' }, { status: 200, body: { data: { imported: 1 } } }]);
    expect(await api.ingest(CONN, PAYLOAD)).toEqual({ status: 200, ok: true, body: { data: { imported: 1 } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3000]);
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
  });

  it('503 then 503: the second refusal is surfaced after exactly one retry', async () => {
    const held = { error: { message: 'Another import into this bank account is still running — retry in a moment.' } };
    const { api, fetchMock, waits } = load([{ status: 503, retryAfter: '2', body: held }, { status: 503, retryAfter: '2', body: held }]);
    expect(await api.ingest(CONN, PAYLOAD)).toEqual({ status: 503, ok: false, body: held });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2000]);
  });

  it.each([400, 409, 500, 502])('%s: no retry, no wait', async (status) => {
    const { api, fetchMock, waits } = load([{ status, retryAfter: '2', body: { error: { message: 'no' } } }]);
    expect(await api.ingest(CONN, PAYLOAD)).toEqual({ status, ok: false, body: { error: { message: 'no' } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it.each([
    [undefined, 2000], ['', 2000], ['soon', 2000], ['-1', 2000], ['0', 0], ['60', 10000], ['10', 10000],
  ])('Retry-After %j waits %i ms (default 2 s, at most 10 s)', async (retryAfter, ms) => {
    const { api, waits } = load([{ status: 503, retryAfter }, { status: 200, body: {} }]);
    await api.ingest(CONN, PAYLOAD);
    expect(waits).toEqual([ms]);
  });
});
