/**
 * K-139 — RED. pages/api/accounting/suppliers-list.ts:60-68 (origin/master)
 * caches the first page of the unfiltered supplier list under
 * `CACHE_KEYS.suppliers(companyId)` — `${companyId}:suppliers`
 * (src/lib/cache-keys.ts:20), a key that carries no page size.
 *
 * The route accepts `?limit=` up to 200 (line 47) and the cached entry lives for
 * CACHE_TTL.REFERENCE_DATA (5 minutes), so whichever page size asks first wins
 * for everyone: a picker that asks for 200 is served the 25 the table asked for
 * a moment earlier, and the `total` alongside it is truthful — so the caller
 * sees "25 of 30" and silently loses suppliers it will never offer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const SUPPLIER_COUNT = 30;

let admin: Pool;
type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
let route: Route;

function mockRes() {
  const res = {
    statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

async function list(limit: string) {
  const res = mockRes();
  await route({ method: 'GET', query: { limit }, headers: {}, companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest, res);
  expect(res.statusCode).toBe(200);
  const body = res.body as { data: { suppliers: unknown[]; total: number } };
  return body.data;
}

describeIfDb('K-139 the supplier list cache must not serve the wrong page size', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K139 Company',true)`, [COMPANY]);
    for (let i = 0; i < SUPPLIER_COUNT; i++) {
      await admin.query(
        `INSERT INTO suppliers (company_id,name,is_active) VALUES ($1,$2,true)`,
        [COMPANY, `K139 Supplier ${String(i).padStart(2, '0')}`]);
    }
    route = (await import('../../pages/api/accounting/suppliers-list')).default as unknown as Route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('serves limit=200 in full after a limit=25 request warmed the cache', async () => {
    const small = await list('25');
    expect(small.suppliers).toHaveLength(25);
    expect(small.total).toBe(SUPPLIER_COUNT);

    const large = await list('200');
    expect(large.total).toBe(SUPPLIER_COUNT);
    expect(large.suppliers).toHaveLength(SUPPLIER_COUNT);
  });
});
