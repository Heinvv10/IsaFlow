/**
 * Architecture review A1: a bill approved into a LOCKED VAT period posts its input VAT on the late-claim clearing
 * account (no VAT code) and a companion journal (late_claim_of_id) claims it in the next open period. Before the fix
 * the clearing leg read as BASE and the companion was never tied: vat_posted 0, so mirror_bill gave the note 0% VAT
 * and the input VAT the return claimed was never reversed. Now the companion is tied (late_claim) and the clearing
 * leg is VAT.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { P, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
const body = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Row;

describeIfDisposable('document_vat_history + mirror_bill on a late-claimed bill (s16(3))', () => {
  beforeAll(async () => {
    fx = await seedLateFixture('dvhlc', process.env.DATABASE_URL!);
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('the companion is tied and the clearing leg is VAT; a mirrored note reverses the 150 the return claimed', async () => {
    const bill = await draftBill(fx, '2026-06-15');
    const approved = await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));
    expect(approved.lateClaim).toMatchObject({ claimDate: '2026-07-01' });

    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', bill.id))!;
    expect(h.totals).toMatchObject({ vat_posted: 150, vat_derivable_now: 150, net_base_posted: 1000, net_base_now: 1000 });
    expect(h.lines.map((l) => [l.tie, l.vat_amount]).sort()).toEqual([['late_claim', -150], ['late_claim', 150], ['posting', 150]].sort());

    const ctx = { companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices'] } as unknown as McpToolContext;
    const r = await inTx(fx, () => createCreditNoteTool.handler({
      type: 'supplier', supplier_id: fx.supplierId, supplier_invoice_id: bill.id, credit_date: '2026-07-10', subtotal: 1000,
      mirror_bill: true, idempotency_key: 'k-lc',
    }, ctx));
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(body(r)).toMatchObject({ tax_amount: 150 });
    await inTx(fx, () => approveCreditNote(fx.companyId, String(body(r).id), fx.userId));
    expect((await getDocumentVatHistory(fx.companyId, 'supplier_invoice', bill.id))!.totals).toMatchObject({ vat_net_now: 0, net_base_now: 0 });
  });
});
