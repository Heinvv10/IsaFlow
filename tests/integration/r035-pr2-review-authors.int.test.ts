/**
 * R-035 PR2 review MEDIUM-2 and LOW-1: two more ways a bill's content changes
 * hands.
 *
 *  - A SUPPLIER merge (supplier-merge route, duplicates-merge route) rewrites
 *    supplier_id — part of the approval digest — on every bill of the merged
 *    supplier. The merging user becomes an author of each, as with an account
 *    merge.
 *  - An edit reads the digest it compares against UNDER the bill's row lock:
 *    read unlocked, a concurrent edit committed between the read and the write
 *    made a reverting edit look like no change, and its author went unrecorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierMerge from '../../pages/api/accounting/supplier-merge';
import duplicatesMerge from '../../pages/api/accounting/duplicates-merge';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, plantRule, reasonOf, type Bill } from './r035-approval.helpers';
import { cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', d: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

/** Four owners; D creates the bill, so D is an author from the start. */
async function fixture(): Promise<{ c: string; bill: Bill }> {
  const c = await postableCompany(pool, [[u.a, 'owner'], [u.b, 'owner'], [u.c, 'owner'], [u.d, 'owner']], companies);
  await plantRule(pool, c, 'owner');
  await enforce(pool, c, u.a);
  return { c, bill: await plantBill(pool, c, u.d) };
}

async function otherSupplier(c: string): Promise<string> {
  const { rows } = await pool.query('INSERT INTO suppliers(company_id,name,is_active) VALUES($1,$2,true) RETURNING id',
    [c, `R035 merge target ${crypto.randomUUID().slice(0, 6)}`]);
  return rows[0].id as string;
}

async function raisedBy(user: string, c: string, billId: string): Promise<string> {
  const res = await r.raise(user, c, billId);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ id: string }>(res).id;
}

describe('a supplier merge makes the merger an author of every moved bill (MEDIUM-2)', () => {
  it('through /api/accounting/supplier-merge', async () => {
    const { c, bill } = await fixture();
    const target = await otherSupplier(c);
    const merged = await callRoute(supplierMerge, tokens[u.b]!, c, 'POST',
      { source_id: bill.supplierId, target_id: target }, '/api/accounting/supplier-merge');
    expect(merged.state.statusCode, JSON.stringify(merged.state.body)).toBe(200);
    const requestId = await raisedBy(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.c, c, requestId)).state.statusCode).toBe(200);
  });

  it('through /api/accounting/duplicates-merge', async () => {
    const { c, bill } = await fixture();
    const primary = await otherSupplier(c);
    const merged = await callRoute(duplicatesMerge, tokens[u.b]!, c, 'POST',
      { entityType: 'supplier', primaryId: primary, duplicateId: bill.supplierId }, '/api/accounting/duplicates-merge');
    expect(merged.state.statusCode, JSON.stringify(merged.state.body)).toBe(200);
    const requestId = await raisedBy(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await r.decide(pool, u.c, c, requestId)).state.statusCode).toBe(200);
  });
});

describe('the edit reads its before-digest under the row lock (LOW-1)', () => {
  it('a reverting edit that waited on a concurrent edit still makes its author an author', async () => {
    const { c, bill } = await fixture();
    // Another writer holds the bill mid-edit (the date moved, not yet committed).
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("UPDATE supplier_invoices SET invoice_date = DATE '2026-09-05' WHERE id = $1", [bill.id]);
      // B sets the date back to what it was. Its request must block on the row.
      const edit = r.editBill(u.b, c, { id: bill.id, invoiceDate: '2026-09-01' });
      const waiting = async () => (await pool.query(
        `SELECT count(*)::INT AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [holder.processID])).rows[0].n;
      for (let i = 0; i < 100 && (await waiting()) === 0; i++) await new Promise((done) => setTimeout(done, 50));
      expect(await waiting()).toBe(1); // the window was entered: B is blocked behind the holder
      await holder.query('COMMIT');
      expect((await edit).state.statusCode).toBe(200);
    } finally {
      holder.release();
    }
    // B moved the date 09-05 → 09-01: B authored the content as it stands.
    const requestId = await raisedBy(u.a, c, bill.id);
    expect(reasonOf(await r.decide(pool, u.b, c, requestId))).toBe('SELF_APPROVAL_FORBIDDEN');
  });
});
