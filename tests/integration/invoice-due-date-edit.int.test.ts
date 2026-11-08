/**
 * Payment-terms programme, AR parity with PR 2: an approved, sent, overdue or part-paid CUSTOMER invoice's due date can
 * be changed, and nothing else; the change is recorded in the entity history (entity_type customer_invoice). Through the
 * real route, the real withAuth and the real capture: the date and its source move and no other column does; drafts,
 * pending, paid, cancelled, deleted and another company's invoices are refused and untouched; a
 * body naming any other field is refused whole; a viewer cannot write; any member can read the history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/customer-invoices-due-date';
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
  await cleanupEntityChanges(pool, companies, [admin, viewer, other]); // ends the pool
});

const company = () => newCompany(pool, [[admin, 'admin'], [viewer, 'viewer']], companies);
const put = (user: string, c: string, body: unknown) =>
  callRoute(route, tokens[user]!, c, 'PUT', body, '/api/accounting/customer-invoices-due-date');

async function invoice(c: string, status: string, opts: { paid?: number; deleted?: boolean } = {}): Promise<string> {
  const { rows: [cu] } = await pool.query("INSERT INTO customers(company_id, name) VALUES($1, 'Due Cust') RETURNING id", [c]);
  const { rows: [i] } = await pool.query(
    `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_amount,
       total_amount, amount_paid, status, created_by, deleted_at)
     VALUES($1, $2, $3, $3, DATE '2026-09-16', DATE '2026-12-15', 1000, 150, 1150, $4, $5, $6, $7) RETURNING id`,
    [c, `DD-${crypto.randomUUID().slice(0, 8)}`, cu.id, opts.paid ?? 0, status, admin, opts.deleted ? new Date() : null]);
  return i.id as string;
}
const rowOf = async (id: string) => (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
const without = (r: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

describe('the date-only edit of an open customer invoice', () => {
  it.each([['approved', 0], ['sent', 0], ['overdue', 0], ['partially_paid', 400]])(
    'a %s invoice: only due_date and its source move, and the change is recorded', async (status, paid) => {
      const c = await company();
      const id = await invoice(c, status as string, { paid: paid as number });
      const before = await rowOf(id);
      const res = await put(admin, c, { id, dueDate: '2026-12-31' });
      expect(res.state.statusCode, messageOf(res)).toBe(200);
      expect(dataOf(res)).toMatchObject({ id, dueDate: '2026-12-31', previousDueDate: '2026-12-15', dueDateSource: 'manual', changed: true });
      const after = await rowOf(id);
      expect(after.due_date_source).toBe('manual');
      expect(without(after, 'due_date', 'due_date_source', 'updated_at')).toEqual(without(before, 'due_date', 'due_date_source', 'updated_at'));
      const history = await changesOf(pool, id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ company_id: c, entity_type: 'customer_invoice', op: 'update', actor: admin, channel: 'session' });
      expect((history[0] as unknown as { changed: string[] }).changed).toEqual(['due_date', 'due_date_source']);
      expect(history[0]!.before).toEqual({ invoice_number: before.invoice_number, due_date: '2026-12-15', due_date_source: 'legacy' });
      expect(history[0]!.after).toEqual({ invoice_number: before.invoice_number, due_date: '2026-12-31', due_date_source: 'manual' });
    });

  it.each([['draft'], ['pending_approval'], ['paid'], ['cancelled']])('a %s invoice is refused and untouched', async (status) => {
    const c = await company();
    const id = await invoice(c, status, { paid: status === 'paid' ? 1150 : 0 });
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it.each([['sent'], ['approved'], ['overdue']])('a %s invoice with nothing owing is refused and untouched', async (status) => {
    const c = await company();
    const id = await invoice(c, status, { paid: 1150 }); // fully paid, its status not yet moved to paid
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-31' });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(messageOf(res)).toMatch(/fully paid: its due date can't be changed/);
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('a deleted invoice and another company\'s invoice are not found, and untouched', async () => {
    const c = await company();
    const theirs = await newCompany(pool, [[other, 'admin']], companies);
    for (const id of [await invoice(c, 'approved', { deleted: true }), await invoice(theirs, 'approved')]) {
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
    const id = await invoice(c, 'approved');
    const before = await rowOf(id);
    const res = await put(admin, c, { id, ...extra });
    expect(res.state.statusCode, messageOf(res)).toBe(400);
    expect(await rowOf(id)).toEqual(before);
  });

  it('refuses a body without a valid invoice id', async () => {
    const c = await company();
    expect((await put(admin, c, { id: 'nope', dueDate: '2026-12-31' })).state.statusCode).toBe(400);
  });

  it('accepts the invoice date itself (due on receipt)', async () => {
    const c = await company();
    const id = await invoice(c, 'approved');
    expect((await put(admin, c, { id, dueDate: '2026-09-16' })).state.statusCode).toBe(200);
  });

  it('a viewer cannot change it', async () => {
    const c = await company();
    const id = await invoice(c, 'approved');
    const before = await rowOf(id);
    expect((await put(viewer, c, { id, dueDate: '2026-12-31' })).state.statusCode).toBe(403);
    expect(await rowOf(id)).toEqual(before);
  });

  it('the same date again writes and records nothing', async () => {
    const c = await company();
    const id = await invoice(c, 'approved');
    const before = await rowOf(id);
    const res = await put(admin, c, { id, dueDate: '2026-12-15' });
    expect(dataOf(res)).toMatchObject({ changed: false, dueDateSource: 'legacy' });
    expect(await rowOf(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(0);
  });

  it('a held invoice (another transaction has it locked) is answered 409 and not changed', { timeout: 20_000 }, async () => {
    const c = await company();
    const id = await invoice(c, 'approved');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM customer_invoices WHERE id = $1 FOR UPDATE', [id]);
      const res = await put(admin, c, { id, dueDate: '2026-12-31' });
      expect(res.state.statusCode, messageOf(res)).toBe(409);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await rowOf(id)).due_date_source).toBe('legacy');
  });

  it('any member reads the history through the entity-changes route', async () => {
    const c = await company();
    const id = await invoice(c, 'approved');
    await put(admin, c, { id, dueDate: '2027-01-15' });
    const res = await callRoute(entityChanges, tokens[viewer]!, c, 'GET', undefined, '/api/accounting/entity-changes',
      { entityType: 'customer_invoice', entityId: id });
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    const page = dataOf(res) as EntityChangePage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ entityType: 'customer_invoice', actor: admin });
    expect(page.items[0]!.fields.map((f) => [f.key, f.before, f.after])).toEqual([
      ['due_date', '2026-12-15', '2027-01-15'], ['due_date_source', 'legacy', 'manual']]);
  });
});
