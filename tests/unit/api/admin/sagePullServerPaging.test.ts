// #1655: suppliers that exist in Sage were missing after the Sage import. The
// server pull asked for 200 rows a page, stopped at the first page holding fewer
// than 200 and moved Skip on by 200 regardless, so a Sage that serves at most 100
// rows a page (its API's documented cap) lost every row after the first page:
// 102 suppliers arrived as 100. Sage is faked here; no request leaves the box.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

/** What the fake Sage holds per endpoint, the most rows it serves a page, and what TotalResults it claims. */
const sage = { suppliers: [] as Array<Record<string, unknown>>, cap: 100, claimTotal: null as number | null };
const supplier = (id: number) => ({ ID: id, Name: `Supplier ${id}`, Active: true, Balance: 0 });

vi.mock('@/lib/safeFetch', () => ({
  checkPublicUrl: vi.fn(async () => null),
  safeFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/Company/Current')) return new Response(JSON.stringify({ Name: 'Sage Co' }), { status: 200 });
    if (!url.endsWith('/Supplier/GetWithFilter')) return new Response(JSON.stringify({ Results: [], TotalResults: 0 }), { status: 200 });
    const { Skip, Take } = JSON.parse(init?.body ?? '{}') as { Skip: number; Take: number };
    const page = sage.suppliers.slice(Skip, Skip + Math.min(Take, sage.cap));
    return new Response(JSON.stringify({ Results: page, TotalResults: sage.claimTotal ?? sage.suppliers.length }), { status: 200 });
  }),
}));

import handler from '../../../../pages/api/admin/migration/sage-pull-server';

const COMPANY = '11111111-1111-4111-8111-111111111111';

async function pull(): Promise<{ status: number; body: { data?: { pulled: { suppliers: { total: number; records: Array<{ sageId: number }> } } }; error?: { message: string } } }> {
  let body: unknown;
  const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { body = b; return this; },
    setHeader() { return this; } };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(
    { method: 'POST', body: { companyId: COMPANY, sageCookie: 'sage-cookie-value-0123456789' } }, res);
  return { status: res.statusCode, body: body as never };
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'unit-test-signing-material-not-a-real-one-0123456789');
  sage.cap = 100;
  sage.claimTotal = null;
});

describe('sage-pull-server pages every supplier (#1655)', () => {
  it('102 suppliers from a Sage that serves 100 a page all arrive, each once', async () => {
    sage.suppliers = Array.from({ length: 102 }, (_, i) => supplier(i + 1));
    const r = await pull();
    expect(r.status).toBe(200);
    const ids = r.body.data!.pulled.suppliers.records.map((s) => s.sageId);
    expect(ids).toEqual(sage.suppliers.map((s) => s.ID));
    expect(r.body.data!.pulled.suppliers.total).toBe(102);
  });

  it('450 suppliers from a Sage that serves the full 200 a page all arrive', async () => {
    sage.cap = 1000;
    sage.suppliers = Array.from({ length: 450 }, (_, i) => supplier(i + 1));
    const r = await pull();
    expect(r.body.data!.pulled.suppliers.records.map((s) => s.sageId)).toEqual(sage.suppliers.map((s) => s.ID));
  });

  it('a pull that ends short of the total Sage reported is refused, not passed on as complete', async () => {
    sage.suppliers = Array.from({ length: 3 }, (_, i) => supplier(i + 1));
    sage.claimTotal = 5;
    const r = await pull();
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/Sage reported 5 records but returned 3/);
  });
});
