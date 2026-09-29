/**
 * R-155..R-157 — the K-101 portal follow-ups, driven through the real routes
 * (withAuth as app_user with RLS and the membership check, withErrorHandler).
 *
 * R-155: POST /api/portal/invoice/generate minted with a SELECT, then a plain
 *   UPDATE. A rival write landing between the two was overwritten, so the link
 *   already handed out went dead. The rival below commits on its own connection
 *   between the route's read and its mint UPDATE.
 * R-156: POST /api/portal/invoice/[token] duplicated generate.ts and ignored
 *   ?action=. It is gone (405); the public token GET is untouched.
 * R-157: a viewer could mint a permanent public token or a payment link, and
 *   the mint routes took no CSRF token. Every mint is now CSRF-checked and
 *   limited to owner/admin/manager, refused before any write (withAuth COMMITs
 *   a 4xx). GET /api/accounting/ar/invoice/[id]/portal-link, which minted too,
 *   only reads now.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

/** Runs once, just before the next portal_token mint UPDATE (after the route's own read). */
let beforeNextTokenWrite: (() => Promise<void>) | null = null;
let mintWrites = 0;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (/UPDATE\s+customer_invoices/.test(text) && /SET\s+portal_token/.test(text)) {
      mintWrites += 1;
      if (beforeNextTokenWrite) {
        const hook = beforeNextTokenWrite;
        beforeNextTokenWrite = null;
        return hook().then(() => original.sql(strings, ...values));
      }
    }
    return original.sql(strings, ...values);
  };
  return { ...original, sql };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const CO = randomUUID();
const CUSTOMER = randomUUID();
const ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type Role = (typeof ROLES)[number];
const userOf = {} as Record<Role, string>;
const jwtOf = {} as Record<Role, string>;

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
const route = async (path: string) => (await import(path)).default as Handler;

interface MintRoute {
  name: string;
  path: string;
  url: string;
  query: (invoiceId: string) => Record<string, unknown>;
  body: (invoiceId: string) => Record<string, unknown>;
  written: (invoiceId: string) => Promise<number>;
}

const tokenCount = async (invoiceId: string) => Number((await pool.query(
  'SELECT count(*) AS n FROM customer_invoices WHERE id = $1 AND portal_token IS NOT NULL', [invoiceId])).rows[0].n);
const linkCount = async (invoiceId: string) => Number((await pool.query(
  'SELECT count(*) AS n FROM portal_payment_links WHERE invoice_id = $1', [invoiceId])).rows[0].n);

const GENERATE: MintRoute = { name: 'POST /api/portal/invoice/generate', path: '../../pages/api/portal/invoice/generate',
  url: '/api/portal/invoice/generate', query: () => ({}), body: (id) => ({ invoiceId: id }), written: tokenCount };
const PORTAL_LINK: MintRoute = { name: 'POST /api/accounting/ar/invoice/[id]/portal-link',
  path: '../../pages/api/accounting/ar/invoice/[id]/portal-link',
  url: '/api/accounting/ar/invoice/x/portal-link', query: (id) => ({ id }), body: () => ({}), written: tokenCount };
const PAYMENT_LINK: MintRoute = { name: 'POST /api/portal/payment-link', path: '../../pages/api/portal/payment-link',
  url: '/api/portal/payment-link', query: () => ({}),
  body: (id) => ({ invoiceId: id, clientId: CUSTOMER, amount: 115 }), written: linkCount };
const MINT_ROUTES = [GENERATE, PORTAL_LINK, PAYMENT_LINK];

async function invoice(opts: { deleted?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
       subtotal, tax_amount, total_amount, amount_paid, status, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 100, 15, 115, 0, 'approved', $5, $6)`,
    [id, CO, `R155-${id.slice(0, 8)}`, CUSTOMER, userOf.admin, opts.deleted ? new Date() : null]);
  return id;
}

interface CallOpts { role?: Role; method?: string; csrf?: boolean; query?: Record<string, unknown>; url?: string }

async function call(handler: Handler, body: Record<string, unknown>, opts: CallOpts = {}) {
  const req = request({ 'sb-access-token': jwtOf[opts.role ?? 'admin'], active_company_id: CO },
    opts.method ?? 'POST') as never as {
    body: unknown; query: Record<string, unknown>; url: string; headers: Record<string, string>;
  };
  req.body = body;
  req.query = opts.query ?? {};
  if (opts.url) req.url = opts.url;
  if (opts.csrf === false) delete req.headers['x-csrf-token'];
  const out = response();
  await handler(req as never, out.res as never);
  return out.state as { statusCode: number; body: { data?: Record<string, unknown> } | undefined };
}

const mint = async (r: MintRoute, invoiceId: string, opts: CallOpts = {}) =>
  call(await route(r.path), r.body(invoiceId), { query: r.query(invoiceId), url: r.url, ...opts });

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R155 portal guards']);
  await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)', [CUSTOMER, CO, 'R155 customer']);
  for (const role of ROLES) {
    userOf[role] = randomUUID();
    await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)',
      [userOf[role], `r155-${role}-${userOf[role]}@isaflow.test`, role === 'viewer' ? 'viewer' : 'admin']);
    await pool.query('INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)',
      [CO, userOf[role], role]);
    jwtOf[role] = await new SignJWT({ sub: userOf[role], aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }
});

afterAll(async () => {
  try {
    await pool.query(
      'DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [CO]);
    for (const t of ['customer_invoice_views', 'customer_invoices', 'company_document_numbers', 'company_users', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(userOf)]);
  } finally {
    await pool.end();
  }
});

describe('R-155 generate keeps a token a concurrent writer already stored', () => {
  it.each([GENERATE, PORTAL_LINK])('$name returns the rival token and does not overwrite it', async (r) => {
    const id = await invoice();
    const rival = randomUUID().replace(/-/g, '').repeat(2);
    let rivalRan = false;
    beforeNextTokenWrite = async () => {
      await pool.query('UPDATE customer_invoices SET portal_token = $1 WHERE id = $2', [rival, id]);
      rivalRan = true;
    };
    const state = await mint(r, id);
    beforeNextTokenWrite = null;
    // The rival landed between the route's read and its mint, not before the read.
    expect(rivalRan).toBe(true);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(state.body?.data?.token).toBe(rival);
    // generate answers `portalUrl`, portal-link `url`: the link the UI copies must carry the stored token.
    expect(state.body?.data?.portalUrl ?? state.body?.data?.url).toMatch(new RegExp(`/portal/invoice/${rival}$`));
    const { rows } = await pool.query('SELECT portal_token FROM customer_invoices WHERE id = $1', [id]);
    expect(rows[0].portal_token).toBe(rival);
  });

  it.each([GENERATE, PORTAL_LINK])('$name refuses a soft-deleted invoice (404), minting nothing', async (r) => {
    const id = await invoice({ deleted: true });
    const state = await mint(r, id);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(404);
    expect(await tokenCount(id)).toBe(0);
  });
});

describe('R-156 POST /api/portal/invoice/[token] is gone', () => {
  it.each([{ token: 'generate', action: 'generate' }, { token: 'generate' }])(
    'answers 405 for query %j and writes no token', async (query) => {
      const id = await invoice();
      const state = await call(await route('../../pages/api/portal/invoice/[token]'), { invoiceId: id },
        { query, url: '/api/portal/invoice/generate?action=generate' });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(405);
      expect(await tokenCount(id)).toBe(0);
    });

  it('still serves the public GET for a stored token', async () => {
    const id = await invoice();
    const stored = 'c'.repeat(64);
    await pool.query('UPDATE customer_invoices SET portal_token = NULL WHERE portal_token = $1', [stored]);
    await pool.query('UPDATE customer_invoices SET portal_token = $2 WHERE id = $1', [id, stored]);
    const req = { method: 'GET', query: { token: stored }, url: '/api/portal/invoice/x', headers: {}, cookies: {},
      socket: { remoteAddress: '127.0.0.80' } };
    const out = response();
    await (await route('../../pages/api/portal/invoice/[token]'))(req as never, out.res as never);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    expect(JSON.stringify(out.state.body)).toContain(`R155-${id.slice(0, 8)}`);
  });
});

describe.each(MINT_ROUTES)('R-157 $name', (r) => {
  it.each(['owner', 'admin', 'manager'] as const)('a %s with a CSRF token mints (200)', async (role) => {
    const id = await invoice();
    const state = await mint(r, id, { role });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await r.written(id)).toBe(1);
  });

  it('refuses a viewer (403) before any write', async () => {
    const id = await invoice();
    mintWrites = 0;
    const state = await mint(r, id, { role: 'viewer' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(await r.written(id)).toBe(0);
    expect(mintWrites).toBe(0);
  });

  it('refuses a request without the CSRF header (403) before any write', async () => {
    const id = await invoice();
    mintWrites = 0;
    const state = await mint(r, id, { csrf: false });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(state.body && JSON.stringify(state.body)).toMatch(/CSRF/);
    expect(await r.written(id)).toBe(0);
    expect(mintWrites).toBe(0);
  });
});

describe('R-157 GET /api/accounting/ar/invoice/[id]/portal-link only reads', () => {
  it.each(['viewer', 'admin'] as const)('a %s GET on an invoice with no token is 404 and mints nothing', async (role) => {
    const id = await invoice();
    const state = await mint(PORTAL_LINK, id, { role, method: 'GET' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(404);
    expect(await tokenCount(id)).toBe(0);
  });

  it('a GET returns the token a POST minted', async () => {
    const id = await invoice();
    const minted = await mint(PORTAL_LINK, id);
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    const read = await mint(PORTAL_LINK, id, { role: 'viewer', method: 'GET' });
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body?.data?.token).toBe(minted.body?.data?.token);
    expect(read.body?.data?.url).toBe(minted.body?.data?.url);
  });

  it.each(['GET', 'POST'])('%s answers 400, not 500, for an id that is not a UUID', async (method) => {
    const state = await call(await route(PORTAL_LINK.path), {}, { method, query: { id: 'not-a-uuid' } });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
  });

  it('POST answers 404, not 500, for an unknown invoice', async () => {
    const state = await call(await route(PORTAL_LINK.path), {}, { query: { id: randomUUID() } });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(404);
  });
});
