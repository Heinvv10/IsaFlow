/**
 * Breaker check (review round 2): a partial mirrored note and a rate note on a late-claimed (s16(3)) bill post a
 * balanced ledger: GL, the late-claim clearing account and the next period's VAT201 input. Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { NEXT, P, balanceOf, draftBill, dropLateFixture, lockPeriod, seedLateFixture, vatFigures, type LateFixture } from './helpers/vatLateClaimFixture';

const d = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
const body = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Row;
d('breaker5 late-claim', () => {
  beforeAll(async () => { fx = await seedLateFixture('brklc', process.env.DATABASE_URL!); await lockPeriod(fx, P.start, P.end); }, 120000);
  afterAll(async () => {
    if (!fx) return; const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropLateFixture(fx);
  }, 120000);
  it('partial mirrored + rate note on a late-claimed bill: GL, clearing and VAT201 input', async () => {
    const before = await vatFigures(fx, NEXT.start, NEXT.end);
    const bill = await draftBill(fx, '2026-06-15');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));
    const ctx = { companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices'] } as unknown as McpToolContext;
    const r = await inTx(fx, () => createCreditNoteTool.handler({ type: 'supplier', supplier_id: fx.supplierId, supplier_invoice_id: bill.id,
      credit_date: '2026-07-10', subtotal: 400, mirror_bill: true, idempotency_key: 'k-lc1' }, ctx));
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(body(r).tax_amount).toBe(60);
    await inTx(fx, () => approveCreditNote(fx.companyId, String(body(r).id), fx.userId));
    const rate = await inTx(fx, async () => (await createCreditNote(fx.companyId, { type: 'supplier', supplierId: fx.supplierId,
      supplierInvoiceId: bill.id, creditDate: '2026-07-11', subtotal: 600 }, fx.userId)).id);
    await inTx(fx, () => approveCreditNote(fx.companyId, rate, fx.userId));
    const after = await vatFigures(fx, NEXT.start, NEXT.end);
    expect({ clearing: await balanceOf(fx, fx.clearingId), expense: await balanceOf(fx, fx.expenseId),
      input: Math.round((Number(after.inputTax) - Number(before.inputTax)) * 100) / 100 })
      .toEqual({ clearing: 0, expense: 0, input: 0 });
  });
});
