/**
 * PR S round eight: a draft PUT keeps each line's WIP time-entry link. The draft edit replaces every line on a PUT;
 * it used to re-insert them without `time_entry_id`, so a notes autosave on a WIP invoice cut its lines from the time
 * entries they bill. Through the real customer-invoices-detail route:
 * - a notes-only PUT (lines re-sent unchanged, with their `timeEntryId`) keeps every link;
 * - a quantity edit keeps the edited line's link;
 * - a `timeEntryId` not already on one of this invoice's lines is refused (400) and nothing changes;
 * - a line sent with `timeEntryId: null` (a new line) has none;
 * - on an invoice whose lines link time entries, every line must carry the `timeEntryId` key (null: deliberately not
 *   linked). A body that lacks it on any line comes from a client that does not know the links (an old tab, an API
 *   or MCP client): releasing its "missing" links would make still-charged entries billable again (double billing),
 *   so it is refused 409 INVOICE_WIP_CLIENT_STALE and nothing is written. An invoice with no links: unchanged;
 * - a link sent in upper case is the same link;
 * - one link on two lines is refused and nothing changes; a refusal carries its own code (INVOICE_WIP_LINK_REFUSED);
 * - a PUT that names a removed line's entry in `releaseTimeEntryIds` releases it: back to approved and unbilled, so it
 *   can be billed again; it is audited and logged. Only this company's entries, billed by the WIP path to this invoice,
 *   are released; a kept line's entry stays billed (refusals: invoice-draft-edit-wip-release.int.test.ts);
 * - the check reads links through the invoice's own company: asked for under another company, none is "already linked".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { entry as wipEntry, links as wipLines, putBody, timeEntry as wipTimeEntry, wipDraft as makeWipDraft, wipPut, type WipCtx } from './invoice-wip-links.helpers';
import { withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { markEntriesBilled } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { wipLinks } from '@/modules/accounting/services/ar/customerInvoiceWipLinks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const ctx: WipCtx = { pool: new Pool({ connectionString: process.env.DATABASE_URL }), tokens: {}, owner: '', company: '', otherCompany: '' };
const { pool, tokens } = ctx;
const companies: string[] = [];
let owner = '';
let company = '';
let otherCompany = '';
const put = (b: unknown) => wipPut(ctx, b);
const timeEntry = (companyId: string, invoiceId: string | null) => wipTimeEntry(ctx, companyId, invoiceId);
const wipDraft = () => makeWipDraft(ctx);
const links = (id: string) => wipLines(ctx, id);
const entry = (id: string) => wipEntry(ctx, id);
const body = putBody;
const RELEASED = 'Draft edit removed WIP lines: their time entries are unbilled again';

beforeAll(async () => {
  owner = ctx.owner = await createUser(pool, tokens);
  company = ctx.company = await invoiceCompany(pool, [[owner, 'owner']], companies);
  otherCompany = ctx.otherCompany = await invoiceCompany(pool, [[owner, 'owner']], companies);
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

  it('a quantity edit keeps the edited line\'s link; a new line (timeEntryId: null) has none', async () => {
    const { id, entries } = await wipDraft();
    const res = await put(body(id, [
      { description: 'Time A', quantity: 3, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
      { description: 'Travel', quantity: 1, unitPrice: 50, taxRate: 15, timeEntryId: null },
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

  it('a PUT that keeps every link leaves every entry billed to the invoice, and logs no release', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      const { id, entries } = await wipDraft();
      const res = await put(body(id, [
        { description: 'Time A', quantity: 3, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
        { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
      ]));
      expect(res.state.statusCode).toBe(200);
      for (const e of entries) expect(await entry(e)).toMatchObject({ status: 'billed', invoice_id: id, billed: true });
      expect((await pool.query(`SELECT 1 FROM audit_log WHERE entity_type = 'time_entry' AND entity_id = ANY($1)`, [entries])).rows).toHaveLength(0);
      expect(info.mock.calls.filter((c) => c[0] === RELEASED)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('removing a WIP line releases its time entry: approved, unbilled, billable again; the kept line\'s stays billed', async () => {
    const info = vi.spyOn(log, 'info');
    try {
      const { id, entries } = await wipDraft();
      const res = await put(body(id, [{ description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] }],
        { releaseTimeEntryIds: [entries[1]] }));
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      expect(await entry(entries[0]!)).toMatchObject({ status: 'billed', invoice_id: id, billed: true });
      expect(await entry(entries[1]!)).toMatchObject({ status: 'approved', invoice_id: null, billed: false });
      expect(info).toHaveBeenCalledWith(RELEASED, { invoiceId: id, dropped: 1, released: 1 }, 'customerInvoiceWipLinks');
      // One audit row per released entry, in the edit's transaction: who, when, which invoice, which entry.
      const audit = (await pool.query(
        `SELECT user_id, action, entity_id, changes->'metadata'->>'invoiceId' AS invoice_id, created_at IS NOT NULL AS dated
           FROM audit_log WHERE company_id = $1 AND entity_type = 'time_entry' AND entity_id = ANY($2)`, [company, entries])).rows;
      expect(audit).toEqual([{ user_id: owner, action: 'update', entity_id: entries[1], invoice_id: id, dated: true }]);
      const again = await plantInvoice(pool, company, owner);
      expect(await withTransaction(() => markEntriesBilled(company, [entries[1]!], again.id))).toBe(1); // billable again
    } finally {
      info.mockRestore();
    }
  });

  it.each([
    ['another company\'s entry', async (id: string) => timeEntry(otherCompany, id)],
    ['an entry billed to another invoice', async () => timeEntry(company, (await plantInvoice(pool, company, owner)).id)],
    ['an entry the timesheet path invoiced (status invoiced)', async (id: string) => {
      const te = await timeEntry(company, id);
      await pool.query(`UPDATE time_entries SET status = 'invoiced', invoiced = true, billed_at = NULL WHERE id = $1`, [te]);
      return te;
    }],
  ])('a dropped link to %s is not released', async (_name, make) => {
    const { id, entries } = await wipDraft();
    const odd = await make(id);
    await pool.query(
      `INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, tax_rate, currency_code, time_entry_id)
       VALUES ($1, 'Time odd', 1, 100, 100, 15, 'ZAR', $2)`, [id, odd]);
    const before = await entry(odd);
    const res = await put(body(id, [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: entries[0] },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: entries[1] },
    ], { releaseTimeEntryIds: [odd] }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await entry(odd)).toEqual(before);
  });

  it.each([
    ['no line carries the key (a client that does not know the field)', (e: string[]) => [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15 },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15 },
    ]],
    ['one line lacks it', (e: string[]) => [
      { description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: e[0] },
      { description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15 },
    ]],
    ['a removed line, and the kept one lacks it', () => [{ description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15 }]],
  ])('a WIP invoice, %s: 409 INVOICE_WIP_CLIENT_STALE; lines, notes and entries unchanged', async (_name, items) => {
    const { id, entries } = await wipDraft();
    const before = { lines: await links(id), entries: await Promise.all(entries.map(entry)) };
    const res = await put(body(id, items(entries), { notes: 'From an old tab' }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(res.state.body).toMatchObject({ error: { details: { code: 'INVOICE_WIP_CLIENT_STALE' } } });
    expect({ lines: await links(id), entries: await Promise.all(entries.map(entry)) }).toEqual(before);
    expect((await pool.query('SELECT notes FROM customer_invoices WHERE id = $1', [id])).rows[0].notes).not.toBe('From an old tab');
  });

  it('an invoice with no WIP links takes a body without the key, as before', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const res = await put(body(inv.id, [{ description: 'Plain work', quantity: 1, unitPrice: 100, taxRate: 15 }], { notes: 'No links here' }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await links(inv.id)).map((l) => l.description)).toEqual(['Plain work']);
  });

  it('the detail GET counts the billed time entries no line links (a grouped WIP or timesheet invoice)', async () => {
    const get = async (id: string) => (await callRoute(customerInvoicesDetail, tokens[owner]!, company, 'GET', undefined,
      '/api/accounting/customer-invoices-detail', { id })).state.body as { data: { unlinked_time_entries: number } };
    const { id } = await wipDraft(); // both entries linked
    expect((await get(id)).data.unlinked_time_entries).toBe(0);
    await timeEntry(company, id); // billed to it, on no line
    await timeEntry(otherCompany, id); // another company's: not counted
    expect((await get(id)).data.unlinked_time_entries).toBe(1);
  });

  it('read under another company, this invoice has no links to keep', async () => {
    const { id, entries } = await wipDraft();
    const asked = entries.map((timeEntryId) => ({ timeEntryId })); // every link kept
    expect((await withTransaction((tx) => wipLinks(tx, company, id, asked))).refusal).toBeNull();
    expect((await withTransaction((tx) => wipLinks(tx, otherCompany, id, asked))).refusal).not.toBeNull();
  });
});
