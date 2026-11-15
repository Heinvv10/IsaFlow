/**
 * A statement line's purchase-order link (`bank_transactions.linked_po_id`) goes when the line stops paying that order.
 *
 * The PO match ties the line to the order through `linked_po_id`, and an order's outstanding amount is its total less
 * every allocated / reconciled line linked to it. `reallocateReconciledTransaction` re-points a reconciled line through
 * `allocateTransaction`, whose UPDATE left the link in place: the old order still counted the cash as paid. The same
 * held for the other writers that re-point or reset a line — split, unmatch, a cancelled reconciliation's matched
 * lines. Reverse (`resetBankLine`) and the auto-post undo already cleared it; reverse is pinned here too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import {
  allocateTransaction, reverseReconciledTransaction, splitAllocateTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import { unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { cancelReconciliation } from '@/modules/accounting/services/bank/bankReconciliationCancelService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import { TOOL, lineRow, mcp, newBank, newSupplier, reconciledLine, setupCompany } from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;

async function purchaseOrder(supplierId: string, total: number): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, status, subtotal, total)
            VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${`PO-${id.slice(0, 8)}`}, ${supplierId}::UUID, 'approved', ${total}, ${total})`;
  return id;
}
/** The order's outstanding amount as the PO match reads it: total less every allocated/reconciled line linked to it. */
async function outstanding(po: string): Promise<number> {
  return Number(((await sql`
    SELECT (po.total - COALESCE((SELECT SUM(ABS(b.amount)) FROM bank_transactions b
      WHERE b.company_id = po.company_id AND b.linked_po_id = po.id AND b.status IN ('allocated', 'reconciled')), 0))::float8 AS o
    FROM purchase_orders po WHERE po.id = ${po}::UUID`) as Row[])[0]!.o);
}
async function linkOf(bt: string): Promise<string | null> {
  const r = ((await sql`SELECT linked_po_id::TEXT AS po FROM bank_transactions WHERE id = ${bt}::UUID`) as Row[])[0]!;
  return r.po === null ? null : String(r.po);
}
async function link(bt: string, po: string): Promise<void> {
  await sql`UPDATE bank_transactions SET linked_po_id = ${po}::UUID WHERE id = ${bt}::UUID AND company_id = ${c.fx.companyId}::UUID`;
}
async function importedLine(bank: string, amount: number, date = '2026-06-12'): Promise<string> {
  return String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${amount}, ${`PO link ${randomUUID().slice(0, 6)}`}, 'imported')
    RETURNING id`) as Row[])[0]!.id);
}

describe('a line that stops paying a purchase order loses its PO link', () => {
  beforeAll(async () => { c = await setupCompany('POLINK'); }, 120000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET linked_po_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM purchase_orders WHERE company_id = ${c.fx.companyId}::UUID`;
    await cleanup(c); await clearExtras(c); await teardown(c);
  }, 120000);

  it('reallocating a reconciled line paid against a PO clears the link, and the order is outstanding again', async () => {
    const supplier = await newSupplier(c);
    const po = await purchaseOrder(supplier, 400);
    // Paid against the order the way the PO match does it: a supplier allocation leaving the cash unapplied, then the link.
    const s = await reconciledLine(c, { amount: -400, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier',
      entity: supplier, autoApply: 'none' });
    await link(s.bt, po);
    expect(await outstanding(po)).toBe(0);

    const moved = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je,
      target: { gl_account_id: c.acct.expense }, dry_run: false, idempotency_key: randomUUID() });
    expect(moved.isError, moved.text).toBe(false);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'reconciled', rec: s.rec, allocation_type: 'account' });
    expect(await linkOf(s.bt)).toBeNull();
    expect(await outstanding(po)).toBe(400);
  }, 120000);

  it('a split of a line carrying a stale link clears it', async () => {
    const bank = await newBank(c);
    const po = await purchaseOrder(await newSupplier(c), 300);
    const bt = await importedLine(bank, -300);
    await link(bt, po);
    await inTx(c.fx, () => splitAllocateTransaction(c.fx.companyId, bt,
      [{ contraAccountId: c.acct.expense, amount: 100 }, { contraAccountId: c.acct.expense, amount: 200 }], c.fx.userId));
    expect(await linkOf(bt)).toBeNull();
    expect(await outstanding(po)).toBe(300);
  }, 120000);

  it('unmatching a line clears its link', async () => {
    const bank = await newBank(c);
    const po = await purchaseOrder(await newSupplier(c), 250);
    const bt = await importedLine(bank, -250);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, c.acct.expense, c.fx.userId, undefined, 'account'));
    // A matched line linked to the order (seeded): the state unmatch resets.
    await sql`UPDATE bank_transactions SET status = 'matched', linked_po_id = ${po}::UUID WHERE id = ${bt}::UUID`;
    await inTx(c.fx, () => unmatchTransaction(c.fx.companyId, bt, c.fx.userId));
    expect(await lineRow(bt)).toMatchObject({ status: 'imported', jl: null });
    expect(await linkOf(bt)).toBeNull();
  }, 120000);

  it("cancelling a reconciliation clears the link on the matched lines it releases", async () => {
    const bank = await newBank(c);
    const po = await purchaseOrder(await newSupplier(c), 150);
    const bt = await importedLine(bank, -150);
    const rec = await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, '2026-06-30', -150, c.fx.userId));
    await sql`UPDATE bank_transactions SET status = 'matched', reconciliation_id = ${rec.id}::UUID, linked_po_id = ${po}::UUID
              WHERE id = ${bt}::UUID`;
    await inTx(c.fx, () => cancelReconciliation(c.fx.companyId, rec.id, c.fx.userId));
    expect(await lineRow(bt)).toMatchObject({ status: 'imported', rec: null });
    expect(await linkOf(bt)).toBeNull();
  }, 120000);

  it('reversing an allocated line clears its link (already true: resetBankLine)', async () => {
    const supplier = await newSupplier(c);
    const po = await purchaseOrder(supplier, 200);
    const bank = await newBank(c);
    const bt = await importedLine(bank, -200);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'supplier', supplier,
      'none', undefined, undefined, undefined, undefined, { autoApply: 'none' }));
    await link(bt, po);
    expect(await outstanding(po)).toBe(0);
    await inTx(c.fx, () => reverseReconciledTransaction(c.fx.companyId, bt, c.fx.userId));
    expect(await linkOf(bt)).toBeNull();
    expect(await outstanding(po)).toBe(200);
  }, 120000);
});
