/**
 * pages/api/accounting/supplier-merge.ts — the inline-SQL merge path — against
 * a real database, auth wrappers passed through. Pins that it refuses a merge
 * across differing DRC VAT flags before moving anything, and the race the
 * ledger review reproduced: a flag set on the SOURCE by a concurrent,
 * still-uncommitted request must not be carried through the merge.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));

import { sql } from '@/lib/neon';
import supplierMerge from '../../pages/api/accounting/supplier-merge';
import { matchSageSupplier } from '@/modules/admin/services/sagePartyMatch';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { plantExternal } from './intercompany/intercompany.plant';
import { asOwner } from './intercompany/intercompany.session';
import { SIDE_GUARD_REFUSAL } from '@/modules/accounting/services/core/supplierMergeOpenWork';
import { restoreRow } from '@/modules/accounting/services/core/softDeleteRowOps';
import { dropFixture, runOn, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;
let userRowAdded = false;

function response() {
  const state: { status?: number; body?: { error?: { message?: string } } } = {};
  const res = {
    status: (s: number) => { state.status = s; return res; },
    json: (b: typeof state.body) => { state.body = b; return res; },
    setHeader: () => res,
  };
  return { res: res as unknown as NextApiResponse, state };
}

/** One request: its own transaction, committed whatever the status (as withAuth does below 500). */
async function merge(source_id: string, target_id: string, companyRole = 'admin') {
  const c = await fx.pool.connect();
  const { res, state } = response();
  try {
    await c.query('BEGIN');
    await runOn(fx, c, () => supplierMerge(
      { method: 'POST', companyId: fx.companyId, companyRole, user: { id: fx.userId }, query: {},
        body: { source_id, target_id } } as unknown as NextApiRequest, res));
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return state;
}

const billSupplier = async (id: string) => String(((await sql`
  SELECT supplier_id FROM supplier_invoices WHERE id = ${id}::UUID`) as { supplier_id: string }[])[0]!.supplier_id);

describeIfDb('supplier-merge route — DRC flags must agree', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test merges suppliers.');
    fx = await seedFixture('SMR', DATABASE_URL!);
    // The merge writes audit rows for the purchase orders it moves, and audit_log.user_id names a users row.
    userRowAdded = ((await sql`
      INSERT INTO users (id, email, role, is_active, account_type)
      VALUES (${fx.userId}::UUID, ${`${fx.userId}@smr.test.local`}, 'admin', true, 'direct')
      ON CONFLICT (id) DO NOTHING RETURNING id`) as unknown[]).length > 0;
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
    if (userRowAdded) await sql`DELETE FROM users WHERE id = ${fx.userId}::TEXT`;
    await dropFixture(fx);
  }, 120000);

  it('refuses differing flags with a 400 and moves nothing', async () => {
    const flagged = await seedSupplier(fx, 'R Flagged');
    const plain = await seedSupplier(fx, 'R Plain');
    await sql`UPDATE suppliers SET subject_to_drc_vat = true WHERE id = ${flagged}::UUID`;
    const bill = await seedBill(fx, { number: 'SMR-1', date: '2026-05-01', total: 100, supplierId: plain });
    const r = await merge(plain, flagged);
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toContain('Subject to DRC VAT');
    expect(await billSupplier(bill)).toBe(plain);
  });

  it('a flag set on the source by an uncommitted request is seen, not merged through', async () => {
    const source = await seedSupplier(fx, 'R Source');
    const target = await seedSupplier(fx, 'R Target');
    const bill = await seedBill(fx, { number: 'SMR-2', date: '2026-05-01', total: 100, supplierId: source });
    const b = await fx.pool.connect();
    let r: Awaited<ReturnType<typeof merge>>;
    try {
      await b.query('BEGIN');
      await b.query('UPDATE suppliers SET subject_to_drc_vat = true WHERE id = $1', [source]);
      const pending = merge(source, target);          // blocks on the source row
      await new Promise((resolve) => setTimeout(resolve, 300));
      await b.query('COMMIT');
      r = await pending;
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      b.release();
    }
    expect(r!.status).toBe(400);
    expect(await billSupplier(bill)).toBe(source);
  });

  it('a merge soft-deletes the source and records its survivor, so a Sage re-sync reaches the survivor (#1655)', async () => {
    const source = await seedSupplier(fx, 'R Sage Source');
    const target = await seedSupplier(fx, 'R Sage Target');
    await sql`UPDATE suppliers SET external_system = 'sage', external_ref = 'SMR-S1' WHERE id = ${source}::UUID`;
    expect((await merge(source, target)).status).toBe(200);
    const rows = (await sql`
      SELECT deleted_at IS NOT NULL AS deleted, merged_into_id FROM suppliers WHERE id = ${source}::UUID`) as Record<string, unknown>[];
    expect(rows[0]).toEqual({ deleted: true, merged_into_id: target });
    const match = await matchSageSupplier(fx.companyId, { name: 'R Sage Source', sageId: 'SMR-S1' });
    expect(match).toMatchObject({ id: target, viaMerge: true, byRef: true, mergedAwayId: source });
  });

  it('a hand-keyed source merged into a differently named survivor still reaches it by its own name (#1655)', async () => {
    const source = await seedSupplier(fx, 'R Keyed Source');
    const target = await seedSupplier(fx, 'R Keyed Survivor');
    const nameOf = async () => ((await sql`SELECT name FROM suppliers WHERE id = ${source}::UUID`) as { name: string }[])[0]!.name;
    const name = await nameOf();
    expect((await merge(source, target)).status).toBe(200);
    expect(await nameOf()).toBe(name);
    const match = await matchSageSupplier(fx.companyId, { name, sageId: 'SMR-K1' });
    expect(match).toMatchObject({ id: target, viaMerge: true, byRef: false, mergedAwayId: source });
  });
  const seedPo = async (supplier: string, number: string, status = 'approved') => String(((await sql`
    INSERT INTO purchase_orders (company_id, po_number, supplier_id, status)
    VALUES (${fx.companyId}::UUID, ${number}, ${supplier}::UUID, ${status}) RETURNING id`) as { id: string }[])[0]!.id);
  const poSupplier = async (id: string) => String(((await sql`SELECT supplier_id FROM purchase_orders WHERE id = ${id}::UUID`) as { supplier_id: string }[])[0]!.supplier_id);
  const poAudit = async (id: string) => ((await sql`
    SELECT changes FROM audit_log WHERE entity_type = 'purchase_order' AND entity_id = ${id}::UUID AND action = 'update'`) as { changes: unknown }[]);

  it('a merge moves the canonical purchase orders (an audit row each) and supplier credit notes to the survivor (#1699 review)', async () => {
    const source = await seedSupplier(fx, 'R Doc Source');
    const target = await seedSupplier(fx, 'R Doc Target');
    const po = await seedPo(source, 'SMR-PO-1');
    const draft = await seedPo(source, 'SMR-PO-2', 'draft');
    const cn = String(((await sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, credit_date, created_by, status)
      VALUES (${fx.companyId}::UUID, 'supplier', ${source}::UUID, '2026-05-02', ${fx.userId}::UUID, 'draft') RETURNING id`) as { id: string }[])[0]!.id);
    expect((await merge(source, target)).status).toBe(200);
    const cn2 = (await sql`SELECT supplier_id FROM credit_notes WHERE id = ${cn}::UUID`) as { supplier_id: string }[];
    expect(await poSupplier(po)).toBe(target);
    expect(await poSupplier(draft)).toBe(target);
    expect(String(cn2[0]!.supplier_id)).toBe(target);
    expect(await poAudit(po)).toHaveLength(1);
    expect(await poAudit(draft)).toHaveLength(1);
    // The fixture teardown does not know these tables, and both reference the supplier.
    await sql`DELETE FROM credit_notes WHERE id = ${cn}::UUID`;
    await sql`DELETE FROM purchase_orders WHERE id = ANY(${[po, draft]}::UUID[])`;
  });

  it('a role that may not edit approved purchase orders is refused with a 400 while one would move, and nothing moves', async () => {
    const source = await seedSupplier(fx, 'R Role Source');
    const target = await seedSupplier(fx, 'R Role Target');
    const po = await seedPo(source, 'SMR-PO-3');
    const r = await merge(source, target, 'manager');
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toContain('owner or admin');
    expect(await poSupplier(po)).toBe(source);
    expect(await poAudit(po)).toHaveLength(0);
    await sql`DELETE FROM purchase_orders WHERE id = ${po}::UUID`;
  });

  it('a purchase order with a bill linked to it refuses the merge with a 400', async () => {
    const source = await seedSupplier(fx, 'R Link Source');
    const target = await seedSupplier(fx, 'R Link Target');
    const po = await seedPo(source, 'SMR-PO-4');
    const bill = await seedBill(fx, { number: 'SMR-LINK', date: '2026-05-01', total: 100, supplierId: source });
    await sql`
      INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source)
      VALUES (${fx.companyId}::UUID, ${po}::UUID, ${bill}::UUID, 10, 'app')`;
    const r = await merge(source, target);
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toContain('linked to purchase orders');
    expect(await poSupplier(po)).toBe(source);
    expect(await billSupplier(bill)).toBe(source);
    await sql`DELETE FROM purchase_orders WHERE id = ${po}::UUID`;
  });

  it('a session the intercompany sides guard refuses gets a 400 with the reason, not a 500, and nothing moves (#1699 review)', async () => {
    const source = await seedSupplier(fx, 'R Side Source');
    const target = await seedSupplier(fx, 'R Side Target');
    const partner = crypto.randomUUID();
    await sql`INSERT INTO companies (id, name) VALUES (${partner}::UUID, ${`SMR partner ${partner.slice(0, 6)}`})`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}::TEXT, 'owner') ON CONFLICT DO NOTHING`;
    const po = await seedPo(source, 'SMR-PO-SIDE', 'draft');
    const connection = await plantExternal(fx.pool, fx.companyId, partner, 'active', fx.userId);
    // The side is planted as a member (claims set); the merge request below carries none, as a session the guard refuses.
    await asOwner(fx.pool, fx.userId, fx.companyId, (q) => q.query(
      'INSERT INTO intercompany_connection_sides (connection_id, company_id, partner_company_id, supplier_id) VALUES ($1, $2, $3, $4)',
      [connection, fx.companyId, partner, source]), true);
    try {
      const r = await merge(source, target);
      expect(r.status).toBe(400);
      expect(r.body?.error?.message).toBe(SIDE_GUARD_REFUSAL);
      expect(await poSupplier(po)).toBe(source);
      const side = (await sql`SELECT supplier_id FROM intercompany_connection_sides WHERE connection_id = ${connection}::UUID`) as { supplier_id: string }[];
      expect(String(side[0]!.supplier_id)).toBe(source);
    } finally {
      await sql`DELETE FROM intercompany_connection_sides WHERE connection_id = ${connection}::UUID`;
      await sql`DELETE FROM intercompany_connections WHERE id = ${connection}::UUID`;
      await sql`DELETE FROM purchase_orders WHERE id = ${po}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID AND user_id = ${fx.userId}::TEXT`;
      await sql`DELETE FROM companies WHERE id = ${partner}::UUID`;
    }
  });

  it.each([[true], [false]])('restoring a supplier the route merged (active: %s) leaves is_active and the name as they were (#1699 review)', async (active) => {
    const source = await seedSupplier(fx, `R Restore ${active}`);
    const target = await seedSupplier(fx, `R Restore Target ${active}`);
    const name = ((await sql`SELECT name FROM suppliers WHERE id = ${source}::UUID`) as { name: string }[])[0]!.name;
    await sql`UPDATE suppliers SET is_active = ${active} WHERE id = ${source}::UUID`;
    expect((await merge(source, target)).status).toBe(200);
    const merged = (await sql`SELECT name, is_active, deleted_at IS NOT NULL AS deleted FROM suppliers WHERE id = ${source}::UUID`) as Record<string, unknown>[];
    expect(merged[0]).toEqual({ name, is_active: active, deleted: true });
    expect(await restoreRow('supplier', source, fx.companyId)).toBe(true);
    const back = (await sql`SELECT name, is_active, deleted_at, merged_into_id FROM suppliers WHERE id = ${source}::UUID`) as Record<string, unknown>[];
    expect(back[0]).toEqual({ name, is_active: active, deleted_at: null, merged_into_id: null });
  });

  it('a 255-character supplier name merges through the route and restores unchanged (no rename can overflow the column)', async () => {
    const long = 'M'.repeat(255);
    const source = await seedSupplier(fx, 'R Long Source');
    const target = await seedSupplier(fx, 'R Long Target');
    await sql`UPDATE suppliers SET name = ${long} WHERE id = ${source}::UUID`;
    expect((await merge(source, target)).status).toBe(200);
    expect(await restoreRow('supplier', source, fx.companyId)).toBe(true);
    const back = (await sql`SELECT name, deleted_at FROM suppliers WHERE id = ${source}::UUID`) as Record<string, unknown>[];
    expect(back[0]).toEqual({ name: long, deleted_at: null });
  });
});
