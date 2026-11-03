/**
 * PR S round eight: a draft PUT keeps each line's WIP time-entry link. The draft edit replaces every line on a PUT;
 * it used to re-insert them without `time_entry_id`, so a notes autosave on a WIP invoice cut its lines from the time
 * entries they bill. Through the real customer-invoices-detail route:
 * - a notes-only PUT (lines re-sent unchanged, with their `timeEntryId`) keeps every link;
 * - a quantity edit keeps the edited line's link;
 * - a `timeEntryId` not already on one of this invoice's lines is refused (400) and nothing changes;
 * - a line sent without one (a new line) has none;
 * - a link sent in upper case is the same link;
 * - one link on two lines is refused and nothing changes; a refusal carries its own code (INVOICE_WIP_LINK_REFUSED);
 * - a PUT whose lines leave links out drops them (a WIP line removed) and logs it: never silently;
 * - the check reads links through the invoice's own company: asked for under another company, none is "already linked".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { wipLinks } from '@/modules/accounting/services/ar/customerInvoiceWipLinks';
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
    expect(res.state.body).toMatchObject({ error: { details: { code: 'INVOICE_WIP_LINK_REFUSED' } } });
    expect(await links(id)).toEqual(before);
  });

  it('one link on two lines is refused, and nothing changes', async () => {
    const { id, entries } = await wipDraft();
    const before = await links(id);
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time A again', quantity: 1, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
    ]));
    expect(res.state.statusCode).toBe(400);
    expect(res.state.body).toMatchObject({ error: { details: { code: 'INVOICE_WIP_LINK_REFUSED' } } });
    expect(await links(id)).toEqual(before);
  });

  it('a link sent in upper case is the same link, and is kept', async () => {
    const { id, entries } = await wipDraft();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0]!.toUpperCase() },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
    ], { notes: 'Upper-case link' }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await links(id)).map((l) => l.time_entry_id)).toEqual(entries);
  });

  it('a PUT that leaves links out drops them and warns, with the invoice and the count; one that keeps them does not', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      const { id, entries } = await wipDraft();
      const kept = await put(body(id, [
        { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
        { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
      ]));
      expect(kept.state.statusCode).toBe(200);
      expect(warn.mock.calls.filter((c) => c[0] === 'Draft edit dropped WIP time-entry links')).toHaveLength(0);
      const res = await put(body(id, [
        { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
        { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15 },
      ]));
      expect(res.state.statusCode).toBe(200);
      expect((await links(id)).map((l) => l.time_entry_id)).toEqual([entries[0], null]);
      expect(warn).toHaveBeenCalledWith('Draft edit dropped WIP time-entry links', { invoiceId: id, dropped: 1 }, 'customerInvoiceWipLinks');
    } finally {
      warn.mockRestore();
    }
  });

  it('read under another company, this invoice has no links to keep', async () => {
    const { id, entries } = await wipDraft();
    const asked = [{ timeEntryId: entries[0] }];
    expect((await withTransaction((tx) => wipLinks(tx, company, id, asked))).refusal).toBeNull();
    expect((await withTransaction((tx) => wipLinks(tx, otherCompany, id, asked))).refusal).not.toBeNull();
  });
});
