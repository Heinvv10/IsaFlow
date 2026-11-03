/**
 * PR S round eight: a draft PUT keeps each line's WIP time-entry link. The draft edit replaces every line on a PUT;
 * it used to re-insert them without `time_entry_id`, so a notes autosave on a WIP invoice cut its lines from the time
 * entries they bill. Through the real customer-invoices-detail route:
 * - a notes-only PUT (lines re-sent unchanged, with their `timeEntryId`) keeps every link;
 * - a quantity edit keeps the edited line's link;
 * - a `timeEntryId` not already on one of this invoice's lines is refused (400) and nothing changes;
 * - a line sent without one (a new line) has none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
let otherCompany = '';

const put = (body: unknown) => callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT', body, '/api/accounting/customer-invoices-detail');

async function timeEntry(companyId: string, invoiceId: string | null): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO time_entries (company_id, user_id, task_description, hours, rate, status, invoice_id, billed_at)
     VALUES ($1, $2, 'WIP work', 2, 300, $3, $4, CASE WHEN $4::UUID IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
    [companyId, owner, invoiceId ? 'billed' : 'approved', invoiceId]);
  return rows[0].id as string;
}

/** A WIP draft: two lines, each billing one time entry (as practiceWipService writes them). */
async function wipDraft(): Promise<{ id: string; entries: string[] }> {
  const inv = await plantInvoice(pool, company, owner);
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [inv.id]);
  const entries = [await timeEntry(company, inv.id), await timeEntry(company, inv.id)];
  await pool.query(
    `INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, tax_rate, currency_code, time_entry_id)
     VALUES ($1, 'Time A', 2, 300, 600, 15, 'ZAR', $2), ($1, 'Time B', 1, 400, 400, 15, 'ZAR', $3)`, [inv.id, entries[0], entries[1]]);
  return { id: inv.id, entries };
}
const links = async (id: string) => (await pool.query(
  'SELECT description, quantity::TEXT AS quantity, time_entry_id FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY description', [id])).rows;
const body = (id: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id, invoiceDate: '2026-09-01', taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1, items, ...extra,
});

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
  otherCompany = await invoiceCompany(pool, [[owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('a draft PUT and its lines\' WIP links', () => {
  it('a notes-only PUT keeps every link', async () => {
    const { id, entries } = await wipDraft();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
    ], { notes: 'A notes typo' }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await links(id)).toEqual([
      { description: 'Time A', quantity: '2.00', time_entry_id: entries[0] },
      { description: 'Time B', quantity: '1.00', time_entry_id: entries[1] },
    ]);
  });

  it('a quantity edit keeps the edited line\'s link; a new line has none', async () => {
    const { id, entries } = await wipDraft();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 3, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
      { description: 'Travel', quantity: 1, unitPrice: 50, taxRate: 15 },
    ]));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await links(id)).toEqual([
      { description: 'Time A', quantity: '3.00', time_entry_id: entries[0] },
      { description: 'Time B', quantity: '1.00', time_entry_id: entries[1] },
      { description: 'Travel', quantity: '1.00', time_entry_id: null },
    ]);
  });

  it.each([
    ['a time entry of this company not on this invoice', async () => timeEntry(company, null)],
    ['another company\'s time entry', async () => timeEntry(otherCompany, null)],
  ])('a link to %s is refused, and nothing changes', async (_name, make) => {
    const { id, entries } = await wipDraft();
    const before = await links(id);
    const foreign = await make();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: foreign },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
    ]));
    expect(res.state.statusCode).toBe(400);
    expect(await links(id)).toEqual(before);
  });

  it('one link on two lines is refused', async () => {
    const { id, entries } = await wipDraft();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time A again', quantity: 1, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
    ]));
    expect(res.state.statusCode).toBe(400);
  });
});
