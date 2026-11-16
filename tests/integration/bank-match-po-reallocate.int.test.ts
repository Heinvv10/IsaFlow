/**
 * PR #1458 round 3 (breaker Finding 1): a PO-paid statement line, reconciled, then re-pointed by
 * reallocate_bank_transaction. The line no longer pays the order, so the order's outstanding must come back in full.
 *
 * It did not: the reallocation re-links the line to the new journal through allocateTransaction and restores it to
 * 'reconciled', but nothing cleared `linked_po_id`. Re-pointed to ANOTHER SUPPLIER the line stayed a supplier payment
 * linked to the old order, so purchaseOrderOutstandingSql kept counting it and a legitimate payment of that order was
 * refused for good. Now restoreReconciled (the reallocation's own write) clears the link.
 *
 * The real flow, end to end: confirmPurchaseOrderMatch, a completed reconciliation, the MCP tool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { confirmPurchaseOrderMatch } from '@/modules/accounting/services/bank/confirmPurchaseOrderMatch';
import { purchaseOrderOutstandingSql } from '@/modules/accounting/services/bank/purchaseOrderOutstanding';
import { completeReconciliation, startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import { REVIEWED_AT, TOOL, bankGl, mcp, newBank, newSupplier, setupCompany } from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;

beforeAll(async () => { c = await setupCompany('POREALLOC'); }, 120000);
afterAll(async () => {
  if (c) {
    await sql`UPDATE bank_transactions SET linked_po_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM purchase_orders WHERE company_id = ${c.fx.companyId}::UUID`;
  }
  await cleanup(c); await clearExtras(c); await teardown(c);
}, 120000);

/** A R400 order paid by a −R400 line through the confirm, then reconciled by a completed reconciliation. */
async function poPaidAndReconciled() {
  const supplier = await newSupplier(c);
  const po = String(((await sql`
    INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, subtotal, total)
    VALUES (${c.fx.companyId}::UUID, ${`PO-RA-${++c.seq}-${c.fx.tag}`}, ${supplier}::UUID, 'approved', 400, 400)
    RETURNING id`) as Row[])[0]!.id);
  const bank = await newBank(c);
  const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, DATE '2026-06-10', -400, 'PO realloc', 'imported')
    RETURNING id`) as Row[])[0]!.id);
  expect(await inTx(c.fx, () => confirmPurchaseOrderMatch(c.fx.companyId, bt, po, c.fx.userId, 400))).toEqual({ ok: true });
  const je = String(((await sql`SELECT l.journal_entry_id::TEXT AS je FROM bank_transactions b
    JOIN gl_journal_lines l ON l.id = b.matched_journal_line_id WHERE b.id = ${bt}::UUID`) as Row[])[0]!.je);
  const balance = await bankGl(c, bank, '2026-06-30'); // the line is the bank's only movement
  const rec = await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, '2026-06-30', balance, c.fx.userId));
  await sql`UPDATE bank_transactions SET reviewed_at = ${REVIEWED_AT}::TIMESTAMPTZ, reviewed_by = ${c.fx.userId}::UUID
    WHERE id = ${bt}::UUID`;
  await inTx(c.fx, () => completeReconciliation(c.fx.companyId, rec.id, c.fx.userId));
  return { po, bt, je };
}

const outstanding = async (po: string) => Number(((await sql`
  SELECT ${purchaseOrderOutstandingSql(null)} AS o FROM purchase_orders po
  WHERE po.id = ${po}::UUID AND po.company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.o);
const lineOf = async (bt: string) => ((await sql`SELECT status, allocation_type, linked_po_id::TEXT AS po
  FROM bank_transactions WHERE id = ${bt}::UUID`) as Row[])[0]!;

describe('a reconciled PO payment re-pointed by reallocate_bank_transaction frees its order', () => {
  it.each([
    ['another supplier', () => newSupplier(c).then((s) => ({ supplier_id: s })), 'supplier'],
    ['an expense account', async () => ({ gl_account_id: c.acct.expense }), 'account'],
  ])('to %s: the line keeps no PO link and the order is fully outstanding again', async (_to, target, type) => {
    const s = await poPaidAndReconciled();
    expect({ line: await lineOf(s.bt), outstanding: await outstanding(s.po) })
      .toEqual({ line: { status: 'reconciled', allocation_type: 'supplier', po: s.po }, outstanding: 0 });
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: await target(),
      idempotency_key: randomUUID(), dry_run: false });
    expect(r.isError, r.text).toBe(false);
    expect({ line: await lineOf(s.bt), outstanding: await outstanding(s.po) })
      .toEqual({ line: { status: 'reconciled', allocation_type: type, po: null }, outstanding: 400 });
  }, 120000);
});
