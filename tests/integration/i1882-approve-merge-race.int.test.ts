/**
 * #1882 fix-verify L1: approving a bill that a bank-first provisional settles, against a merge of the bill's supplier. The approval
 * locked the bill and then (the claim, the settlement's payment) the supplier; the merge holds the supplier and waits on the bill:
 * 40P01. It now takes the supplier first (supplierInvoiceBudgetCheck.lockBillAfterBudgetGate -> lockSettlingPayeeBeforeBill).
 * Real PostgreSQL (r127 fixture, superuser with the request context). Fixture route: isaflow_schema_fixture. Never skips.
 */
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import { isDeadlockVictim, settle, waitsOnLock } from './helpers/mergeRace';
import { company, pool, seedDoc, seedInvoice, seedProvisional, supplier, useR127Fixture, user } from './r127-double-booking.helpers';

useR127Fixture();

async function start<T>(fn: () => Promise<T>) {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  const pid = Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const done = settle(als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn)
    .then(async (v) => { await c.query('COMMIT'); return v; }, async (e) => { await c.query('ROLLBACK'); throw e; })
    .finally(() => c.release()));
  return { pid, done };
}

describe('a provisional-settled bill approval racing a merge of its supplier', () => {
  it('waits for the merge at the supplier, not holding the bill; neither side is a deadlock victim', async () => {
    // The survivor sorts first, so the merge holds it before it waits on the held source row.
    const target = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
    await pool.query("INSERT INTO suppliers(id, company_id, name, is_active) VALUES ($1, $2, 'R127 survivor', true)", [target, company]);
    const doc = await seedDoc();
    await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    const hold = await pool.connect();
    await hold.query('BEGIN');
    await hold.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [supplier]);
    let merge: Awaited<ReturnType<typeof start>> | undefined;
    let approve: Awaited<ReturnType<typeof start>> | undefined;
    try {
      merge = await start(() => mergeEntities(company, 'supplier', target, supplier, user, autoPostApprovalGuard(true), 'owner'));
      expect(await waitsOnLock(pool, merge.pid)).toBe(true);
      approve = await start(() => approveSupplierInvoice(company, invoiceId, user));
      expect(await waitsOnLock(pool, approve.pid)).toBe(true);
    } finally { await hold.query('ROLLBACK'); hold.release(); }
    const merged = await merge!.done;
    const approved = await approve!.done;
    expect(isDeadlockVictim(merged.e), String(merged.e)).toBe(false);
    expect(isDeadlockVictim(approved.e), String(approved.e)).toBe(false);
    expect(merged.e).toBeUndefined();
    // The merge won: the bill is on the survivor; the approval then went through there and the provisional settled it.
    expect(approved.e).toBeUndefined();
    expect((await pool.query('SELECT supplier_id::text AS s, status FROM supplier_invoices WHERE id = $1', [invoiceId])).rows[0])
      .toMatchObject({ s: target, status: 'paid' }); // approved, and settled by the provisional
  }, 30_000);
});
