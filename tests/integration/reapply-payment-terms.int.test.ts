/**
 * Payment-terms programme PR 3: Re-apply terms to open supplier bills, through the real route. The preview lists what
 * the suppliers' own terms would move (Velocity's case: 3 months after statement, a 16 Sep bill -> 31 Dec), ticks
 * terms / legacy dates, leaves hand-set, document and stamped-default ones unticked, skips suppliers with no terms and
 * every closed, deleted or foreign bill. Apply writes exactly the confirmed pairs, re-checked under the row lock, and
 * each write is recorded in the entity history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/supplier-invoices-reapply-terms';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { REAPPLY_MAX, type ReapplyPreview, type ReapplyResult } from '../../src/modules/accounting/services/ap/reapplyTerms';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', viewer = '', other = '';

beforeAll(async () => { [admin, viewer, other] = await members(pool, tokens, 3); });
afterAll(async () => {
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin, viewer, other]); // ends the pool
});

const company = () => newCompany(pool, [[admin, 'admin'], [viewer, 'viewer']], companies);
const preview = async (user: string, c: string, supplierId?: string) => {
  const res = await callRoute(route, tokens[user]!, c, 'GET', undefined, '/api/accounting/supplier-invoices-reapply-terms',
    supplierId ? { supplierId } : {});
  expect(res.state.statusCode, messageOf(res)).toBe(200);
  return dataOf(res) as ReapplyPreview;
};
/** A confirmed item as the page sends it: the new date plus the date and source the preview showed (a bill()'s defaults). */
const item = (id: string, dueDate: string, fromDueDate: string | null = '2026-12-15', fromSource = 'legacy') =>
  ({ id, dueDate, fromDueDate, fromSource });
const apply = (user: string, c: string, items: unknown) =>
  callRoute(route, tokens[user]!, c, 'POST', { items }, '/api/accounting/supplier-invoices-reapply-terms');

async function supplier(c: string, name: string, n: number | null, type: string | null): Promise<string> {
  const { rows } = await pool.query('INSERT INTO suppliers(company_id, name, payment_terms, payment_terms_type) VALUES($1,$2,$3,$4) RETURNING id', [c, name, n, type]);
  return rows[0].id as string;
}
async function bill(c: string, s: string, opts: { date?: string; due?: string | null; source?: string; status?: string; paid?: number; deleted?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, due_date, due_date_source, subtotal,
       tax_amount, total_amount, amount_paid, status, created_by, deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,1000,150,1150,$7,$8,$9,$10) RETURNING id`,
    [c, `RA-${crypto.randomUUID().slice(0, 8)}`, s, opts.date ?? '2026-09-16', opts.due === undefined ? '2026-12-15' : opts.due,
      opts.source ?? 'legacy', opts.paid ?? 0, opts.status ?? 'approved', admin, opts.deleted ? new Date() : null]);
  return rows[0].id as string;
}
const dueOf = async (id: string) =>
  (await pool.query("SELECT to_char(due_date,'YYYY-MM-DD') AS d, due_date_source AS s FROM supplier_invoices WHERE id=$1", [id])).rows[0] as { d: string | null; s: string };

describe('the preview', () => {
  it('lists what each supplier\'s own terms would move, ticks only terms / legacy dates from chosen terms', async () => {
    const c = await company();
    const cfs = await supplier(c, 'CFS', 3, 'statement_months');
    const legacy = await bill(c, cfs);
    const termsDated = await bill(c, cfs, { source: 'terms', due: null });
    const manual = await bill(c, cfs, { source: 'manual' });
    const doc = await bill(c, cfs, { source: 'document' });
    await bill(c, cfs, { due: '2026-12-31' }); // already right: counted, not listed
    for (const status of ['paid', 'cancelled']) await bill(c, cfs, { status, paid: status === 'paid' ? 1150 : 0 });
    await bill(c, cfs, { deleted: true });
    await bill(c, cfs, { paid: 1150, status: 'partially_paid' }); // nothing owing
    const p = await preview(admin, c);
    const byId = new Map(p.rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual([legacy, termsDated, manual, doc].sort());
    expect(byId.get(legacy)).toMatchObject({ currentDueDate: '2026-12-15', newDueDate: '2026-12-31', preselected: true, note: null, supplierName: 'CFS' });
    expect(byId.get(termsDated)).toMatchObject({ currentDueDate: null, newDueDate: '2026-12-31', preselected: true });
    expect(byId.get(manual)).toMatchObject({ preselected: false, currentSource: 'manual' });
    expect(byId.get(doc)).toMatchObject({ preselected: false, currentSource: 'document' });
    expect(p.unchanged).toBe(1);
    expect(p.skippedSuppliers).toEqual([]);
  });

  it('skips a supplier with no terms (never the company default), flags the old stamped default, filters by supplier', async () => {
    const c = await company();
    const none = await supplier(c, 'No Terms', null, null);
    const stamped = await supplier(c, 'Stamped', 30, null);
    const real = await supplier(c, 'Real', 10, 'invoice_days');
    await bill(c, none);
    await bill(c, none);
    const st = await bill(c, stamped);
    const rl = await bill(c, real);
    const p = await preview(admin, c);
    expect(p.skippedSuppliers).toEqual([{ supplierId: none, supplierName: 'No Terms', openBills: 2, balance: 2300 }]);
    expect(p.rows.find((r) => r.id === st)).toMatchObject({ newDueDate: '2026-10-16', preselected: false });
    expect(p.rows.find((r) => r.id === st)!.note).toMatch(/old default/);
    expect(p.rows.find((r) => r.id === rl)).toMatchObject({ newDueDate: '2026-09-26', preselected: true });
    expect((await preview(admin, c, real)).rows.map((r) => r.id)).toEqual([rl]);
  });

  it('never lists another company\'s bills', async () => {
    const c = await company();
    const theirs = await newCompany(pool, [[other, 'admin']], companies);
    await bill(theirs, await supplier(theirs, 'Theirs', 3, 'statement_months'));
    expect((await preview(admin, c)).rows).toEqual([]);
  });
});

describe('apply', () => {
  it('writes exactly the confirmed bills, marks them terms, and records each change', async () => {
    const c = await company();
    const s = await supplier(c, 'CFS', 3, 'statement_months');
    const a = await bill(c, s);
    const b = await bill(c, s, { source: 'manual' });
    const untouched = await bill(c, s);
    const res = await apply(admin, c, [item(a, '2026-12-31'), item(b, '2026-12-31', '2026-12-15', 'manual')]);
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    const r = dataOf(res) as ReapplyResult;
    expect(r.updated.map((u) => [u.id, u.from, u.to]).sort()).toEqual([[a, '2026-12-15', '2026-12-31'], [b, '2026-12-15', '2026-12-31']].sort());
    expect(r.skipped).toEqual([]);
    expect(await dueOf(a)).toEqual({ d: '2026-12-31', s: 'terms' });
    expect(await dueOf(b)).toEqual({ d: '2026-12-31', s: 'terms' });
    expect(await dueOf(untouched)).toEqual({ d: '2026-12-15', s: 'legacy' });
    const [h] = await changesOf(pool, a);
    expect(h).toMatchObject({ entity_type: 'supplier_invoice', actor: admin, channel: 'session' });
    expect(h!.after).toMatchObject({ due_date: '2026-12-31', due_date_source: 'terms' });
  });

  it('skips, with a reason, what changed since the preview, and writes nothing for it', async () => {
    const c = await company();
    const theirs = await newCompany(pool, [[other, 'admin']], companies);
    const s = await supplier(c, 'Moved', 3, 'statement_months');
    const moved = await bill(c, s);
    const closed = await bill(c, s);
    const dated = await bill(c, s, { due: '2026-12-31', source: 'manual' });
    const unset = await bill(c, await supplier(c, 'Unset', null, null));
    const foreign = await bill(theirs, await supplier(theirs, 'Theirs', 3, 'statement_months'));
    await pool.query("UPDATE suppliers SET payment_terms = 2 WHERE id = $1", [s]); // terms changed after the preview
    await pool.query("UPDATE supplier_invoices SET status = 'paid', amount_paid = total_amount WHERE id = $1", [closed]);
    const res = await apply(admin, c, [
      item(moved, '2026-12-31'), item(closed, '2026-11-30'), item(dated, '2026-12-31', '2026-12-31', 'manual'),
      item(unset, '2026-12-31'), item(foreign, '2026-12-31'),
    ]);
    const r = dataOf(res) as ReapplyResult;
    expect(r.updated).toEqual([]);
    expect(Object.fromEntries(r.skipped.map((k) => [k.id, k.reason]))).toEqual({
      [moved]: 'terms_changed', [closed]: 'not_open', [dated]: 'terms_changed', [unset]: 'terms_not_set', [foreign]: 'not_found',
    });
    expect(await dueOf(moved)).toEqual({ d: '2026-12-15', s: 'legacy' });
    expect(await dueOf(foreign)).toEqual({ d: '2026-12-15', s: 'legacy' });
    expect(await changesOf(pool, moved)).toHaveLength(0);
  });

  it('a bill already on the confirmed date is skipped as already dated', async () => {
    const c = await company();
    const s = await supplier(c, 'Same', 10, 'invoice_days');
    const id = await bill(c, s, { due: '2026-09-26', source: 'manual' });
    expect((dataOf(await apply(admin, c, [item(id, '2026-09-26', '2026-09-26', 'manual')])) as ReapplyResult).skipped).toEqual([{ id, reason: 'already_dated' }]);
    expect(await dueOf(id)).toEqual({ d: '2026-09-26', s: 'manual' });
  });

  it.each([
    [[]], ['x'], [[{ id: 'nope', dueDate: '2026-12-31' }]], [[{ id: crypto.randomUUID(), dueDate: '2026-02-30' }]],
    [[{ id: crypto.randomUUID(), dueDate: '2026-12-31' }]], [[{ id: crypto.randomUUID(), dueDate: '2026-12-31', fromSource: 'legacy' }]],
    [[{ ...item(crypto.randomUUID(), '2026-12-31'), fromSource: 'typed' }]], [[item(crypto.randomUUID(), '2026-12-31', '2026-13-01')]],
  ])('refuses %j whole', async (items) => {
    const c = await company();
    expect((await apply(admin, c, items)).state.statusCode).toBe(400);
  });

  it('refuses a bill listed twice, and a viewer, and writes nothing', async () => {
    const c = await company();
    const s = await supplier(c, 'Twice', 3, 'statement_months');
    const id = await bill(c, s);
    expect((await apply(admin, c, [item(id, '2026-12-31'), item(id, '2026-12-31')])).state.statusCode).toBe(400);
    expect((await apply(viewer, c, [item(id, '2026-12-31')])).state.statusCode).toBe(403);
    expect(await dueOf(id)).toEqual({ d: '2026-12-15', s: 'legacy' });
  });
});

describe('a date set since the preview (Codex, PR #1202)', () => {
  // The page and the MCP confirm send what the preview showed; a colleague's hand-set date in between is never overwritten.
  it('skips as date_changed a bill whose date or source moved after the preview, and writes nothing for it', async () => {
    const c = await company();
    const s = await supplier(c, 'Agreed', 3, 'statement_months');
    const handSet = await bill(c, s);
    const sourceOnly = await bill(c, s, { source: 'terms' });
    const kept = await bill(c, s);
    const p = await preview(admin, c);
    const confirm = p.rows.map((r) => item(r.id, r.newDueDate, r.currentDueDate, r.currentSource));
    expect(confirm.map((i) => i.id).sort()).toEqual([handSet, sourceOnly, kept].sort());
    // What PUT supplier-invoices-due-date writes: an agreed date, source manual. And one marked manual on the same date.
    await pool.query("UPDATE supplier_invoices SET due_date = '2027-01-15', due_date_source = 'manual' WHERE id = $1", [handSet]);
    await pool.query("UPDATE supplier_invoices SET due_date_source = 'manual' WHERE id = $1", [sourceOnly]);
    const res = await apply(admin, c, confirm);
    expect(res.state.statusCode, messageOf(res)).toBe(200);
    const r = dataOf(res) as ReapplyResult;
    expect(r.updated.map((u) => u.id)).toEqual([kept]);
    expect(Object.fromEntries(r.skipped.map((k) => [k.id, k.reason]))).toEqual({ [handSet]: 'date_changed', [sourceOnly]: 'date_changed' });
    expect(await dueOf(handSet)).toEqual({ d: '2027-01-15', s: 'manual' });
    expect(await dueOf(sourceOnly)).toEqual({ d: '2026-12-15', s: 'manual' });
  });
});

describe('review round 1', () => {
  it('lists draft, pending and part-paid bills with something owing; refuses a malformed supplierId', async () => {
    const c = await company();
    const s = await supplier(c, 'Open', 3, 'statement_months');
    const ids = [await bill(c, s, { status: 'draft' }), await bill(c, s, { status: 'pending_approval' }),
      await bill(c, s, { status: 'partially_paid', paid: 500 })];
    const p = await preview(admin, c);
    expect(p.rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(p.rows.find((r) => r.id === ids[2])!.balance).toBe(650);
    const bad = await callRoute(route, tokens[admin]!, c, 'GET', undefined, '/api/accounting/supplier-invoices-reapply-terms', { supplierId: 'nope' });
    expect(bad.state.statusCode).toBe(400);
  });

  // A lock timeout at a later bill must not leave the earlier ones written behind an error (a 4xx commits; a 503 rolls back).
  it('a bill held by another transaction fails the whole apply with 503 and writes nothing', { timeout: 20_000 }, async () => {
    const c = await company();
    const s = await supplier(c, 'Held', 3, 'statement_months');
    const [first, second] = [await bill(c, s), await bill(c, s)].sort();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [second]);
      const res = await apply(admin, c, [item(first!, '2026-12-31'), item(second!, '2026-12-31')]);
      expect(res.state.statusCode, messageOf(res)).toBe(503);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await dueOf(first!)).toEqual({ d: '2026-12-15', s: 'legacy' });
    expect(await changesOf(pool, first!)).toHaveLength(0);
  });

  it('lists at most REAPPLY_MAX bills and says the list is cut short', { timeout: 30_000 }, async () => {
    const c = await company();
    const s = await supplier(c, 'Many', 3, 'statement_months');
    await pool.query(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, created_by)
       SELECT $1, 'MANY-' || g, $2, DATE '2026-09-16', DATE '2026-12-15', 1000, 150, 1150, 'approved', $3 FROM generate_series(1, $4::INT) g`,
      [c, s, admin, REAPPLY_MAX + 1]);
    const p = await preview(admin, c);
    expect(p.rows).toHaveLength(REAPPLY_MAX);
    expect(p.truncated).toBe(true);
  });
});
