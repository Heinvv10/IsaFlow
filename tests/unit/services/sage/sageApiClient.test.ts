import { describe, expect, it, vi } from 'vitest';
import { createSageApiClient, SageApiError } from '@/modules/accounting/services/sage/sageApiClient';

type Call = { url: URL; init: RequestInit };

function fakeSage(handler: (url: URL, n: number) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    calls.push({ url, init });
    const { status, body } = handler(url, calls.length);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetchImpl };
}

const base = { apiKey: '{key-123}', username: 'owner@acme.test', password: 's3cret!', minIntervalMs: 0, sleep: async () => {} };

describe('createSageApiClient', () => {
  it('sends the API key, the company id and Basic auth on every call', async () => {
    const { calls, fetchImpl } = fakeSage(() => ({ status: 200, body: { ID: 1, Name: 'Acme' } }));
    const client = createSageApiClient({ ...base, fetchImpl });
    await client.forCompany(42).get('FinancialYear/GetCurrent');
    const { url, init } = calls[0]!;
    expect(url.origin + url.pathname).toBe('https://accounting.sageone.co.za/api/2.0.0/FinancialYear/GetCurrent');
    expect(url.searchParams.get('apikey')).toBe('{key-123}');
    expect(url.searchParams.get('companyid')).toBe('42');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('owner@acme.test:s3cret!').toString('base64')}`);
  });

  it('lists companies without a company id', async () => {
    const { calls, fetchImpl } = fakeSage(() => ({ status: 200, body: { TotalResults: 1, ReturnedResults: 1, Results: [{ ID: 7, Name: 'Acme' }] } }));
    const companies = await createSageApiClient({ ...base, fetchImpl }).listCompanies();
    expect(companies).toEqual([{ ID: 7, Name: 'Acme' }]);
    expect(calls[0]!.url.pathname).toBe('/api/2.0.0/Company/Get');
    expect(calls[0]!.url.searchParams.has('companyid')).toBe(false);
  });

  it('pages a list 100 at a time until Sage has returned everything', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ ID: i }));
    const { calls, fetchImpl } = fakeSage((url) => {
      const skip = Number(url.searchParams.get('$skip'));
      const top = Number(url.searchParams.get('$top'));
      const page = all.slice(skip, skip + top);
      return { status: 200, body: { TotalResults: all.length, ReturnedResults: page.length, Results: page } };
    });
    const rows = await createSageApiClient({ ...base, fetchImpl }).forCompany(1).getAll<{ ID: number }>('Customer/Get');
    expect(rows.map((r) => r.ID)).toEqual(all.map((r) => r.ID));
    expect(calls.map((c) => c.url.searchParams.get('$skip'))).toEqual(['0', '100', '200']);
    expect(calls.every((c) => c.url.searchParams.get('$top') === '100')).toBe(true);
  });

  it('accepts a bare array where Sage returns one', async () => {
    const { fetchImpl } = fakeSage(() => ({ status: 200, body: [{ AccountId: 1 }] }));
    const rows = await createSageApiClient({ ...base, fetchImpl }).forCompany(1).post<unknown[]>('TrialBalance/Export', { FromDate: '2026-03-01' });
    expect(rows).toEqual([{ AccountId: 1 }]);
  });

  it('turns a 401 into a plain-language auth error that never echoes the password', async () => {
    const { fetchImpl } = fakeSage(() => ({ status: 401, body: { Message: 'Authorization has been denied' } }));
    const err = await createSageApiClient({ ...base, fetchImpl }).listCompanies().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SageApiError);
    expect((err as SageApiError).kind).toBe('auth');
    expect((err as SageApiError).message).toMatch(/email address or password/i);
    expect(JSON.stringify(err)).not.toContain('s3cret!');
    expect((err as SageApiError).message).not.toContain('s3cret!');
  });

  it('waits and retries when Sage throttles, then gives up with a rate-limit error', async () => {
    const sleep = vi.fn(async () => {});
    const { calls, fetchImpl } = fakeSage(() => ({ status: 429 }));
    const err = await createSageApiClient({ ...base, sleep, maxRetries: 2, fetchImpl }).forCompany(1).get('Account/Get').catch((e: unknown) => e);
    expect((err as SageApiError).kind).toBe('rate_limited');
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalled();
  });

  it('recovers from a single throttled or failed call', async () => {
    const { calls, fetchImpl } = fakeSage((_u, n) => (n === 1 ? { status: 503 } : { status: 200, body: { ok: true } }));
    const out = await createSageApiClient({ ...base, fetchImpl }).forCompany(1).get('Company/Current');
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('spaces calls to stay under Sage\'s 100 requests a minute', async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl } = fakeSage(() => ({ status: 200, body: {} }));
    const c = createSageApiClient({ ...base, minIntervalMs: 700, sleep, now: () => 0, fetchImpl }).forCompany(1);
    await c.get('A');
    await c.get('B');
    expect(sleep).toHaveBeenCalledWith(700);
  });

  it('refuses to run without an API key, and says why', () => {
    expect(() => createSageApiClient({ ...base, apiKey: '' })).toThrow(SageApiError);
    try { createSageApiClient({ ...base, apiKey: '  ' }); } catch (e) { expect((e as SageApiError).kind).toBe('not_configured'); }
  });
});
