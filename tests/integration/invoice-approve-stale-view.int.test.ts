/**
 * PR S final review (HIGH): approve carries the total the approver saw (`expectedTotal`), and the route refuses with
 * 409 STALE_VIEW, writing nothing, when the stored total differs (a save that landed after the page was read). Through
 * the real customer-invoices-detail route:
 * - the total shown is the total stored: approved;
 * - a different total: 409 STALE_VIEW, the invoice still a draft, no journal;
 * - the same figure in another currency, or at another exchange rate: 409 STALE_VIEW, naming the invoice's currency;
 * - no `expectedTotal` (API clients, scripts; MCP calls the service, not this route): approved as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany, invoiceState, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';

const approve = (body: Record<string, unknown>) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, company, 'POST', { action: 'approve', ...body }, '/api/accounting/customer-invoices-detail');

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('approve and the total the approver saw', () => {
  it('the total shown is the total stored: approved', async () => {
    const inv = await plantInvoice(pool, company, owner); // R1 150
    const res = await approve({ id: inv.id, expectedTotal: 1150 });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await invoiceState(pool, inv.id)).status).toBe('approved');
  });

  it('a different total: 409 STALE_VIEW naming the stored total, and nothing written', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const before = (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0];
    const res = await approve({ id: inv.id, expectedTotal: 1035 });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect(messageOf(res)).toMatch(/changed after it was shown: its total is now R\s?1\s?150\.00\./);
    const state = await invoiceState(pool, inv.id);
    expect(state).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
    expect((await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0]).toEqual(before);
  });

  it('within a cent is the same total (the column is 2 dp)', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await approve({ id: inv.id, expectedTotal: 1150.004 })).state.statusCode).toBe(200);
  });

  it('the same figure in another currency is another total: 409 STALE_VIEW naming the invoice\'s own currency', async () => {
    await enableFxDocuments(pool, company);
    const inv = await plantInvoice(pool, company, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedCurrency: 'ZAR', expectedExchangeRate: 1 });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect(messageOf(res)).toMatch(/its total is now USD\s?1\s?150\.00 at 18\.5/);
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
  });

  it('the same total and currency at another exchange rate: 409 STALE_VIEW', async () => {
    await enableFxDocuments(pool, company);
    const inv = await plantInvoice(pool, company, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedCurrency: 'USD', expectedExchangeRate: 17.25 });
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('STALE_VIEW');
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
  });

  it('total, currency and rate all as stored: past the check (the currency case is the gate\'s)', async () => {
    await enableFxDocuments(pool, company);
    const inv = await plantInvoice(pool, company, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    const res = await approve({ id: inv.id, expectedTotal: 1150, expectedCurrency: 'usd ', expectedExchangeRate: 18.5 });
    expect(reasonOf(res)).not.toBe('STALE_VIEW');
  });

  it('no expectedTotal: approved as before (API clients without a screen)', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const res = await approve({ id: inv.id });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('a non-number expectedTotal is refused (422, the route\'s validation answer)', async () => {
    const inv = await plantInvoice(pool, company, owner);
    expect((await approve({ id: inv.id, expectedTotal: '1150' })).state.statusCode).toBe(422);
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
  });
});
