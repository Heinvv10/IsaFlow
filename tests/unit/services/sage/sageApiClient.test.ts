import { describe, expect, it, vi } from 'vitest';
import { createSageApiClient, SageApiError } from '@/modules/accounting/services/sage/sageApiClient';
import { createSagePacer, sharedSagePacer } from '@/modules/accounting/services/sage/sageApiPacer';

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

const base = { apiKey: '{key-123}', username: 'owner@acme.test', password: 's3cret!', pacer: createSagePacer(0), sleep: async () => {} };

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
    const c = createSageApiClient({ ...base, pacer: createSagePacer(700, () => 0, sleep), fetchImpl }).forCompany(1);
    await c.get('A');
    await c.get('B');
    expect(sleep).toHaveBeenCalledWith(700);
  });

  // Every tenant shares one SAGE_API_KEY and one server IP, and Sage blocks the
  // IP for an hour on an overrun: the spacing is per PROCESS, not per client.
  it('spaces calls across clients: two logins share one pacer', async () => {
    const sleep = vi.fn(async () => {});
    const pacer = createSagePacer(700, () => 0, sleep);
    const { fetchImpl } = fakeSage(() => ({ status: 200, body: {} }));
    await createSageApiClient({ ...base, pacer, fetchImpl }).forCompany(1).get('A');
    await createSageApiClient({ ...base, username: 'other@b.test', pacer, fetchImpl }).forCompany(2).get('B');
    expect(sleep).toHaveBeenCalledWith(700);
  });

  it('reserves slots in order when calls overlap', async () => {
    const waits: number[] = [];
    const pacer = createSagePacer(700, () => 0, async (ms) => { waits.push(ms); });
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
    expect(waits).toEqual([700, 1400]);
  });

  it('uses the one process-wide pacer unless a test supplies its own', async () => {
    expect(sharedSagePacer()).toBe(sharedSagePacer());
    const wait = vi.spyOn(sharedSagePacer(), 'wait').mockResolvedValue();
    try {
      const { pacer: _drop, ...noPacer } = base;
      const { fetchImpl } = fakeSage(() => ({ status: 200, body: {} }));
      await createSageApiClient({ ...noPacer, fetchImpl }).forCompany(1).get('A');
      expect(wait).toHaveBeenCalledTimes(1);
    } finally {
      wait.mockRestore();
    }
  });

  it('stops paging once a limit is passed', async () => {
    const all = Array.from({ length: 500 }, (_, i) => ({ ID: i }));
    const { calls, fetchImpl } = fakeSage((url) => {
      const skip = Number(url.searchParams.get('$skip'));
      return { status: 200, body: { TotalResults: all.length, ReturnedResults: 100, Results: all.slice(skip, skip + 100) } };
    });
    const rows = await createSageApiClient({ ...base, fetchImpl }).forCompany(1).getAll('TaxInvoice/Get', {}, 150);
    expect(rows).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  it('refuses to run without an API key, and says why', () => {
    expect(() => createSageApiClient({ ...base, apiKey: '' })).toThrow(SageApiError);
    try { createSageApiClient({ ...base, apiKey: '  ' }); } catch (e) { expect((e as SageApiError).kind).toBe('not_configured'); }
  });

  // R1: a pull whose row was discarded must stop reading Sage — between pages
  // too, not only between steps — and let go of the login.
  it('asks the guard before every call, every page and every retry, and stops when it throws', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ ID: i }));
    const { calls, fetchImpl } = fakeSage((url) => {
      const skip = Number(url.searchParams.get('$skip'));
      return { status: 200, body: { TotalResults: all.length, ReturnedResults: 100, Results: all.slice(skip, skip + 100) } };
    });
    let asked = 0;
    const guard = async () => { if (++asked === 2) throw new Error('stopped'); };
    await expect(createSageApiClient({ ...base, fetchImpl }).forCompany(1, guard).getAll('Customer/Get')).rejects.toThrow('stopped');
    expect(calls).toHaveLength(1);
    expect(asked).toBe(2);
  });

  it('dispose drops the login: no call goes out after it', async () => {
    const { calls, fetchImpl } = fakeSage(() => ({ status: 200, body: {} }));
    const client = createSageApiClient({ ...base, fetchImpl });
    client.dispose();
    await expect(client.forCompany(1).get('A')).rejects.toThrow(/disposed/);
    await expect(client.listCompanies()).rejects.toThrow(/disposed/);
    expect(calls).toHaveLength(0);
  });
});
