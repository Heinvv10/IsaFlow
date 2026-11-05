/**
 * The three portal pages (invoice link, AFS dashboard, AFS document) read their data in getServerSideProps by calling
 * the same services as the portal API routes, in this process: no fetch, no NEXT_PUBLIC_APP_URL. Real PG, real
 * session verification (portal JWT, currentPortalSession), fetch stubbed to throw so any self-call fails the test.
 * Checked: company scoping, role rules (a shareholder sees only signed-off AFS), a foreign company's document, a
 * suspended company, Date columns surviving as JSON strings, and the invoice's read receipt naming the VISITOR.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import type { GetServerSidePropsContext } from 'next';
import { signPortalToken } from '@/lib/auth/portalJwt';
import { getServerSideProps as dashboard } from '../../pages/accounting/afs/portal/dashboard';
import { getServerSideProps as documentPage } from '../../pages/accounting/afs/portal/documents/[documentId]';
import { getServerSideProps as invoicePage } from '../../pages/portal/invoice/[token]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'portal-pages-in-process-secret-0123456789abcdef'; });
assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const co = randomUUID();
const other = randomUUID();
const user = randomUUID();
const ids = { afsDraft: randomUUID(), afsSigned: randomUUID(), pack: randomUUID(), foreign: randomUUID() };
const contacts: Record<string, string> = {};
const invoiceToken = randomBytes(32).toString('hex');
let invoiceId = '';

type Props = { props?: Record<string, unknown>; redirect?: { destination: string }; notFound?: true };
const cookieFor = async (role: string, companyId = co, contactId = contacts[role]!) =>
  signPortalToken({ contactId, companyId, role: role as never, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
const page = async (gssp: (c: GetServerSidePropsContext) => Promise<unknown>, cookie: string | null, params: Record<string, string> = {}) =>
  (await gssp({ req: { cookies: cookie ? { portal_session: cookie } : {}, headers: {}, socket: {} }, params } as unknown as GetServerSidePropsContext)) as Props;

beforeAll(async () => {
  for (const c of [co, other]) await pool.query(`INSERT INTO companies (id, name, registration_number) VALUES ($1, $2, $3)`, [c, `PIP ${c.slice(0, 6)}`, c.slice(0, 8)]);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  for (const role of ['director', 'shareholder_readonly']) {
    contacts[role] = (await pool.query(
      `INSERT INTO portal_contacts (company_id, name, email, role) VALUES ($1, $2, $3, $4) RETURNING id`, [co, role, `${role}-${co.slice(0, 6)}@t.local`, role])).rows[0].id;
  }
  const doc = (id: string, company: string, type: string, status: string, fy: number | null, period: string | null) => pool.query(
    `INSERT INTO afs_documents (id, company_id, fiscal_year, period, document_type, status, reporting_framework) VALUES ($1, $2, $3, $4, $5, $6, 'ifrs_smes')`,
    [id, company, fy, period, type, status]);
  await doc(ids.afsDraft, co, 'afs', 'draft', 2026, null);
  await doc(ids.afsSigned, co, 'afs', 'signed_off', 2025, null);
  await doc(ids.pack, co, 'management_pack', 'draft', null, '2026-08');
  await doc(ids.foreign, other, 'afs', 'signed_off', 2025, null);
  await pool.query(`INSERT INTO afs_sections (document_id, company_id, section_type, sort_order, status) VALUES ($1, $2, 'cover', 1, 'pending')`, [ids.afsSigned, co]);
  const customer = (await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1, 'PIP customer') RETURNING id`, [co])).rows[0].id;
  invoiceId = (await pool.query(
    `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, subtotal, total_amount, created_by, status, portal_token, due_date)
     VALUES ($1, $2, $3, $3, 100, 115, $4, 'sent', $5, '2000-01-01') RETURNING id`, [co, `PIP-${co.slice(0, 6)}`, customer, user, invoiceToken])).rows[0].id;
  await pool.query(`INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES ($1, 'PIP line', 1, 100, 100)`, [invoiceId]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_views WHERE company_id = $1', [co]);
    if (invoiceId) await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [invoiceId]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM afs_sections WHERE company_id = ANY($1::UUID[])', [[co, other]]);
    await pool.query('DELETE FROM afs_documents WHERE company_id = ANY($1::UUID[])', [[co, other]]);
    await pool.query('DELETE FROM portal_contacts WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [[co, other]]);
  } finally { await pool.end(); }
}, 60_000);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('a portal page must not fetch its own API'); })); });

describe('portal dashboard (in-process)', () => {
  it('a director sees every document of the session company, none of another company, dates as strings', async () => {
    const r = await page(dashboard, await cookieFor('director'));
    const docs = r.props!.documents as Array<{ id: string; created_at: unknown }>;
    expect(docs.map((d) => d.id).sort()).toEqual([ids.afsDraft, ids.afsSigned, ids.pack].sort());
    expect(typeof docs[0]!.created_at).toBe('string');
    expect(r.props!.loadError).toBe('');
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a shareholder sees only the signed-off AFS (the role rule), by the contact\'s current role', async () => {
    const r = await page(dashboard, await cookieFor('shareholder_readonly'));
    expect((r.props!.documents as Array<{ id: string }>).map((d) => d.id)).toEqual([ids.afsSigned]);
  });

  it('a session whose company is suspended is sent to sign in again', async () => {
    await pool.query(`UPDATE companies SET status = 'suspended', suspended_at = now() WHERE id = $1`, [co]);
    try {
      expect((await page(dashboard, await cookieFor('director'))).redirect?.destination).toBe('/accounting/afs/portal/login?error=expired');
    } finally { await pool.query(`UPDATE companies SET status = 'active', suspended_at = NULL WHERE id = $1`, [co]); }
  });
});

describe('portal document page (in-process)', () => {
  it('a director opens an own document with its sections (dates as strings)', async () => {
    const r = await page(documentPage, await cookieFor('director'), { documentId: ids.afsSigned });
    expect((r.props!.document as { id: string }).id).toBe(ids.afsSigned);
    expect((r.props!.sections as unknown[]).length).toBe(1);
    expect(r.props!.canAnnotate).toBe(true);
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['another company\'s document', ids.foreign],
    ['a document the role may not see (a draft, for a shareholder)', ids.afsDraft],
    ['an id that is not a uuid', '../../reports/x'],
    ['an unknown id', randomUUID()],
  ])('%s goes back to the dashboard', async (_label, documentId) => {
    const role = documentId === ids.afsDraft ? 'shareholder_readonly' : 'director';
    expect((await page(documentPage, await cookieFor(role), { documentId })).redirect?.destination).toBe('/accounting/afs/portal/dashboard');
  });

  it('a session for company A cannot open company B\'s document by presenting B\'s id in the session either', async () => {
    // A session is only ever trusted for the company it names; contact c of A under B's id has no portal contact there.
    expect((await page(documentPage, await cookieFor('director', other), { documentId: ids.foreign })).redirect?.destination)
      .toBe('/accounting/afs/portal/login?error=expired');
  });
});

describe('portal invoice page (in-process)', () => {
  it('loads the invoice, flags it overdue, and the read receipt names the visitor, not the server', async () => {
    const ctx = { params: { token: invoiceToken }, req: { headers: { 'x-forwarded-for': '203.0.113.77, 10.0.0.1', 'user-agent': 'VisitorBrowser/1.0' }, socket: { remoteAddress: '127.0.0.1' } } };
    const r = await invoicePage(ctx as never) as Props;
    expect((r.props!.invoice as { items: Array<{ description: string }> }).items.map((i) => i.description)).toEqual(['PIP line']);
    expect(r.props!.isOverdue).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const views = (await pool.query(`SELECT host(ip_address) AS ip, user_agent, view_source FROM customer_invoice_views WHERE customer_invoice_id = $1`, [invoiceId])).rows;
    expect(views).toEqual([{ ip: '203.0.113.77', user_agent: 'VisitorBrowser/1.0', view_source: 'portal' }]);
    expect((await pool.query('SELECT portal_viewed_at FROM customer_invoices WHERE id = $1', [invoiceId])).rows[0].portal_viewed_at).not.toBeNull();
  });

  it('an unknown or malformed token is not found, and a cancelled invoice is not found', async () => {
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    expect(await invoicePage({ params: { token: 'f'.repeat(64) }, req } as never)).toEqual({ notFound: true });
    expect(await invoicePage({ params: { token: 'short' }, req } as never)).toEqual({ notFound: true });
    await pool.query(`UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1`, [invoiceId]);
    try { expect(await invoicePage({ params: { token: invoiceToken }, req } as never)).toEqual({ notFound: true }); }
    finally { await pool.query(`UPDATE customer_invoices SET status = 'sent' WHERE id = $1`, [invoiceId]); }
  });
});
