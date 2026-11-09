/**
 * Payment-terms programme PR 2 (migration 962): an approved or part-paid bill's due date can be changed, and nothing
 * else; the change is recorded in the entity history. Through the real route, the real withAuth and the real capture:
 * the date and its source move and no other column does; drafts, pending, paid, cancelled, deleted, another company's
 * bills and an approved or part-paid bill with nothing owing (amounts are whole cents, so one cent owing is the boundary)
 * are refused and untouched; a body naming any other field is refused whole; a viewer cannot write; any member can read
 * the history, and an invoice's history copies no other column (customer_invoices.portal_token).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/supplier-invoices-due-date';
import entityChanges from '../../pages/api/accounting/entity-changes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import type { EntityChangePage } from '../../src/modules/accounting/services/core/entityChanges/entityChangeTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', viewer = '', other = '';

beforeAll(async () => { [admin, viewer, other] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin, viewer, other]); // ends the pool
});

const company = () => newCompany(pool, [[admin, 'admin'], [viewer, 'viewer']], companies);
const put = (user: string, c: string, body: unknown) =>
  callRoute(route, tokens[user]!, c, 'PUT', body, '/api/accounting/supplier-invoices-due-date');

async function bill(c: string, status: string, opts: { paid?: number; deleted?: boolean } = {}): Promise<string> {
  const { rows: [s] } = await pool.query("INSERT INTO suppliers(company_id, name) VALUES($1, 'Due Co') RETURNING id", [c]);
  const { rows: [b] } = await pool.query(
    `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_amount,
       total_amount, amount_paid, status, created_by, deleted_at)
     VALUES($1, $2, $3, DATE '2026-09-16', DATE '2026-12-15', 1000, 150, 1150, $4, $5, $6, $7) RETURNING id`,
    [c, `DD-${crypto.randomUUID().slice(0, 8)}`, s.id, opts.paid ?? 0, status, admin, opts.deleted ? new Date() : null]);
  return b.id as string;
}
const rowOf = async (id: string) => (await pool.query('SELECT * FROM supplier_invoices WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
const without = (r: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

describe('the date-only edit of an approved bill', () => {
  it.each([['approved', 0], ['partially_paid', 400]])('a %s bill: only due_date and its source move, and the change is recorded', async (status, paid) => {
    const c = await company();
    const id = await bill(c, status as string, { paid: paid as number });
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect(dataOf(res)).toMatchObject({ id, dueDate: '2026-12-31', previousDueDate: '2026-12-15', dueDateSource: 'manual', changed: true });
    const after = await rowOf(id);
    expect(after.due_date_source).toBe('manual');
    expect(without(after, 'due_date', 'due_date_source', 'updated_at')).toEqual(without(before, 'due_date', 'due_date_source', 'updated_at'));
    const history = await changesOf(pool, id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ company_id: c, entity_type: 'supplier_invoice', op: 'update', actor: admin, channel: 'session' });
    expect((history[0] as unknown as { changed: string[] }).changed).toEqual(['due_date', 'due_date_source']);
    expect(history[0]!.before).toEqual({ invoice_number: before.invoice_number, due_date: '2026-12-15', due_date_source: 'legacy' });
    expect(history[0]!.after).toEqual({ invoice_number: before.invoice_number, due_date: '2026-12-31', due_date_source: 'manual' });
  });

  it.each([['approved', 1150], ['partially_paid', 1150], ['approved', 1200]])(
    'a %s bill with nothing owing (paid %s of 1150) is refused and untouched', async (status, paid) => {
    const c = await company();
    const id = await bill(c, status as string, { paid: paid as number }); // its status not yet moved to paid
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(messageOf(res)).toMatch(/has nothing owing: its due date can't be changed/);
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('a bill owing one cent still takes the edit', async () => {
    const c = await company();
    const id = await bill(c, 'partially_paid', { paid: 1149.99 });
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    expect((await rowOf(id)).due_date_source).toBe('manual');
  });

  it.each([['draft'], ['pending_approval'], ['paid'], ['cancelled']])('a %s bill is refused and untouched', async (status) => {
    const c = await company();
    const id = await bill(c, status, { paid: status === 'paid' ? 1150 : 0 });
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode).toBe(400);
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('a deleted bill and another company\'s bill are not found, and untouched', async () => {
    const c = await company();
    const theirs = await newCompany(pool, [[other, 'admin']], companies);
    for (const id of [await bill(c, 'approved', { deleted: true }), await bill(theirs, 'approved')]) {
      const before = await rowOf(id);
      const res = await put(admin, c, { id, dueDate: '2026-12-31' });
      expect(res.state.statusCode).toBe(404);
      expect(await rowOf(id)).toEqual(before);
    }
  });

  it.each([
    [{ dueDate: '2026-12-31', totalAmount: 1 }], [{ dueDate: '2026-12-31', status: 'paid' }], [{ dueDate: '2026-12-31', notes: 'x' }],
    [{ dueDate: '2026-02-30' }], [{ dueDate: '31/12/2026' }], [{ dueDate: null }], [{}], [{ dueDate: '2026-09-15' }],
  ])('refuses %j whole: 400, nothing written', async (extra) => {
    const c = await company();
    const id = await bill(c, 'approved');
    const before = await rowOf(id);
    const res = await put(admin, c, { id, ...extra });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(await rowOf(id)).toEqual(before);
  });

  it('accepts the invoice date itself (due on receipt)', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    expect((await put(admin, c, { id, dueDate: '2026-09-16' })).state.statusCode).toBe(200);
  });

  it('a viewer cannot change it', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    const before = await rowOf(id);
    expect((await put(viewer, c, { id, dueDate: '2026-12-31' })).state.statusCode).toBe(403);
    expect(await rowOf(id)).toEqual(before);
  });

  it('the same date again writes and records nothing', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-15' });
    expect(dataOf(res)).toMatchObject({ changed: false, dueDateSource: 'legacy' });
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('any member reads the history through the entity-changes route', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    await put(admin, c, { id, dueDate: '2027-01-15' });
    const res = await callRoute(entityChanges, tokens[viewer]!, c, 'GET', undefined, '/api/accounting/entity-changes',
      { entityType: 'supplier_invoice', entityId: id });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    const page = dataOf(res) as EntityChangePage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ entityType: 'supplier_invoice', actor: admin });
    expect(page.items[0]!.fields.map((f) => [f.key, f.before, f.after])).toEqual([
      ['due_date', '2026-12-15', '2027-01-15'], ['due_date_source', 'legacy', 'manual']]);
  });
});

describe('migration 962', () => {
  it('a row that names no source is legacy; an unknown source is refused', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    expect((await rowOf(id)).due_date_source).toBe('legacy');
    await expect(pool.query("UPDATE supplier_invoices SET due_date_source = 'guess' WHERE id = $1", [id])).rejects.toThrow(/due_date_source_check/);
  });

  it('an UPDATE that leaves the due date and source alone records nothing; one that moves either is recorded', async () => {
    const c = await company();
    const id = await bill(c, 'approved');
    await pool.query("UPDATE supplier_invoices SET notes = 'n', due_date = due_date WHERE id = $1", [id]);
    expect(await changesOf(pool, id)).toHaveLength(0);
    await pool.query("UPDATE supplier_invoices SET due_date_source = 'terms' WHERE id = $1", [id]);
    expect((await changesOf(pool, id)).map((h) => (h as unknown as { changed: string[] }).changed)).toEqual([['due_date_source']]);
  });

  it('a customer invoice\'s due-date history copies no other column (no portal token, no amounts)', async () => {
    const c = await company();
    const { rows: [cust] } = await pool.query("INSERT INTO customers(company_id, name) VALUES($1, 'Due Cust') RETURNING id", [c]);
    const { rows: [inv] } = await pool.query(
      `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_amount,
         total_amount, status, portal_token, created_by)
       VALUES($1, 'CI-962', $2, $2, DATE '2026-09-16', DATE '2026-10-16', 100, 15, 115, 'approved', 'secret-portal-token', $3) RETURNING id`,
      [c, cust.id, admin]);
    await pool.query("UPDATE customer_invoices SET due_date = DATE '2026-11-30', due_date_source = 'manual' WHERE id = $1", [inv.id]);
    await expect(pool.query("UPDATE customer_invoices SET due_date_source = 'guess' WHERE id = $1", [inv.id])).rejects.toThrow(/due_date_source_check/);
    const [h] = await changesOf(pool, inv.id);
    expect(h).toMatchObject({ entity_type: 'customer_invoice', channel: 'system' });
    expect(h!.after).toEqual({ invoice_number: 'CI-962', due_date: '2026-11-30', due_date_source: 'manual' });
    expect(JSON.stringify(h)).not.toContain('secret-portal-token');
  });
});
