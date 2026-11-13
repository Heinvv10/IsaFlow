/**
 * Sage read-only client: GET only, allow-listed paths, filter cannot inject parameters,
 * 401 is recorded and never retried, nothing secret leaks into an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SageClient, SageRequestError, assertSafeFilter, scrub, type FetchLike } from '../../../packages/sage-readonly-mcp/src/client';
import { LoginFailureLedger, MAX_FAILURES, SageLockoutGuardError } from '../../../packages/sage-readonly-mcp/src/lockout';
import type { SageConfig } from '../../../packages/sage-readonly-mcp/src/config';

const PW = 'pw-fixture';
const KEY = 'api-key-123';

function config(stateDir: string): SageConfig {
  return {
    baseUrl: 'https://accounting.sageone.co.za/api/2.0.0', username: 'integration@example.test', password: PW,
    apiKey: KEY, companyId: '42', downloadDir: join(stateDir, 'dl'), stateDir,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let client: SageClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sage-mcp-'));
  fetchMock = vi.fn(async () => json({ TotalResults: 1, ReturnedResults: 1, Results: [{ ID: 7 }] }));
  client = new SageClient(config(dir), fetchMock as unknown as FetchLike);
});

const calledUrl = (i = 0): URL => new URL(String(fetchMock.mock.calls[i]![0]));
const calledInit = (i = 0) => fetchMock.mock.calls[i]![1] as { method: string; headers: Record<string, string> };

describe('SageClient requests', () => {
  it('lists with GET, Basic auth, apikey + companyid, $top/$skip and the filter as one value', async () => {
    const page = await client.list('SupplierInvoice', { filter: "SupplierId eq 5 and Name eq 'A B'", page: 2 });
    const url = calledUrl();
    expect(calledInit().method).toBe('GET');
    expect(url.pathname).toBe('/api/2.0.0/SupplierInvoice/Get');
    expect(url.searchParams.get('apikey')).toBe(KEY);
    expect(url.searchParams.get('companyid')).toBe('42');
    expect(url.searchParams.get('$top')).toBe('100');
    expect(url.searchParams.get('$skip')).toBe('200');
    expect(url.searchParams.get('$filter')).toBe("SupplierId eq 5 and Name eq 'A B'");
    expect(url.searchParams.get('includeDetail')).toBe('true');
    expect(calledInit().headers.Authorization).toBe(`Basic ${Buffer.from(`integration@example.test:${PW}`).toString('base64')}`);
    expect(page).toEqual({ totalResults: 1, returnedResults: 1, results: [{ ID: 7 }] });
  });

  it('reads one record by numeric id only', async () => {
    await client.get('TaxInvoice', 123);
    expect(calledUrl().pathname).toBe('/api/2.0.0/TaxInvoice/Get/123');
    await expect(client.get('TaxInvoice', '1/../Delete/2')).rejects.toThrow(/numeric id/);
    await expect(client.get('TaxInvoice', '5?apikey=x')).rejects.toThrow(/numeric id/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a filter that could add or replace a query parameter', () => {
    for (const bad of ['a eq 1&apikey=evil', 'a eq 1?x', 'a#b', 'a\nb']) {
      expect(() => assertSafeFilter(bad)).toThrow(SageRequestError);
    }
    expect(() => assertSafeFilter("Name eq 'O''Brien'")).not.toThrow();
  });

  it('list() refuses an injecting filter or order_by before anything is sent', async () => {
    await expect(client.list('Supplier', { filter: 'ID eq 1&apikey=evil' })).rejects.toThrow(SageRequestError);
    await expect(client.list('Supplier', { orderBy: 'Name#x' })).rejects.toThrow(SageRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops delete links and flags at any depth', () => {
    expect(scrub({ ID: 1, DeleteUrl: 'x', Lines: [{ delete_url: 'y', Amount: 2 }], CanDelete: true }))
      .toEqual({ ID: 1, Lines: [{ Amount: 2 }] });
  });

  it('never puts the password, api key or username in an error', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    const err = await client.list('Supplier').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SageRequestError);
    expect(err.message).toBe('Sage Supplier list: HTTP 500');
    for (const s of [PW, KEY, 'integration@example.test']) expect(err.message).not.toContain(s);
  });
});

describe('request hardening (review round 1)', () => {
  it('never follows a redirect (the api key is in the query string)', async () => {
    await client.list('Supplier');
    expect((fetchMock.mock.calls[0]![1] as { redirect: string }).redirect).toBe('error');
  });

  it('refuses an attachment over the size cap', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-length': String(60 * 1024 * 1024) } }));
    await expect(client.download(1)).rejects.toThrow(/larger than/);
  });
});

describe('login failures and the lockout guard', () => {
  it('records a 401, does not retry it, and stops sending once MAX_FAILURES are in the hour', async () => {
    fetchMock.mockResolvedValue(json({}, 401));
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expect(client.list('Supplier')).rejects.toThrow(/login refused \(401\)/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(MAX_FAILURES);
    await expect(client.list('Supplier')).rejects.toBeInstanceOf(SageLockoutGuardError);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_FAILURES); // nothing sent
  });

  it('survives a restart: a new client on the same state dir is still stopped', async () => {
    fetchMock.mockResolvedValue(json({}, 403));
    for (let i = 0; i < MAX_FAILURES; i++) await client.list('Supplier').catch(() => undefined);
    const restarted = new SageClient(config(dir), fetchMock as unknown as FetchLike);
    await expect(restarted.list('Supplier')).rejects.toBeInstanceOf(SageLockoutGuardError);
  });

  it('lets requests through again once the failures are older than an hour', () => {
    let now = 1_000_000;
    const ledger = new LoginFailureLedger(dir, () => now);
    for (let i = 0; i < MAX_FAILURES; i++) ledger.recordFailure();
    expect(() => ledger.assertMayAttempt()).toThrow(SageLockoutGuardError);
    now += 60 * 60 * 1000 + 1;
    expect(() => ledger.assertMayAttempt()).not.toThrow();
  });
});

describe('the ledger fails closed (review round 1)', () => {
  it('a state dir that is a file fails closed before any request', async () => {
    const notDir = join(dir, 'file');
    writeFileSync(notDir, 'x');
    const c = new SageClient(config(notDir), fetchMock as unknown as FetchLike);
    await expect(c.list('Supplier')).rejects.toThrow(/cannot be read/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a corrupt ledger stops every request', async () => {
    writeFileSync(join(dir, 'auth-failures.log'), '{"not":"a timestamp"}\n');
    await expect(client.list('Supplier')).rejects.toThrow(/corrupt/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unwritable state dir still counts the failure, and then refuses everything', async () => {
    // A directory that can be read (no ledger yet) but not written: the failure cannot be recorded.
    const blocked = join(dir, 'readonly');
    mkdirSync(blocked, { mode: 0o500 });
    const stuck = new SageClient(config(blocked), fetchMock as unknown as FetchLike);
    fetchMock.mockResolvedValue(json({}, 401));
    await expect(stuck.list('Supplier')).rejects.toThrow(/login refused/);
    await expect(stuck.list('Supplier')).rejects.toThrow(/could not be written/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two processes appending to one ledger both count', () => {
    const a = new LoginFailureLedger(dir);
    const b = new LoginFailureLedger(dir);
    a.recordFailure(); b.recordFailure(); a.recordFailure();
    expect(() => b.assertMayAttempt()).toThrow(SageLockoutGuardError);
    expect(readFileSync(join(dir, 'auth-failures.log'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
