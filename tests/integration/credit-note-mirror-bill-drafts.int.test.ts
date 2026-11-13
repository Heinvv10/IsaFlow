/**
 * create_credit_note mirror_bill counts the bill's OPEN DRAFT notes, and serialises mirrored creates per
 * bill (the bill's credit-note key, held until the create commits). Without both, two mirrored drafts
 * could each take the bill's whole remaining VAT and, once approved, reverse it twice.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { formatMoney } from '@/lib/money/formatMoney';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, runOn, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { backendPid, waitUntilBlocked } from './helpers/lockWait';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
let cos = '';
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices'] }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;
const body = (r: McpToolResult) => JSON.parse(text(r)) as Row;

async function bill(amount: number) {
  const supplierId = await seedSupplier(fx, `drafts-${++seq}`);
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId, invoiceNumber: `SIVD${String(Date.now()).slice(-6)}${seq}`, invoiceDate: '2026-06-01',
    items: [{ description: 'Line', quantity: 1, unitPrice: amount, glAccountId: cos }],
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return { id: created.id, supplierId };
}
const args = (b: { id: string; supplierId: string }, subtotal: number) => ({
  type: 'supplier', supplier_id: b.supplierId, supplier_invoice_id: b.id, credit_date: '2026-06-20', subtotal,
  mirror_bill: true, idempotency_key: `k-${++seq}`,
});
const create = (b: { id: string; supplierId: string }, subtotal: number) => inTx(fx, () => createCreditNoteTool.handler(args(b, subtotal), ctx()));
const notesOn = async (billId: string) => Number(((await sql`
  SELECT COUNT(*) AS n FROM credit_notes WHERE company_id = ${fx.companyId}::UUID AND supplier_invoice_id = ${billId}::UUID`) as Row[])[0]!.n);

describeIfDisposable('mirror_bill counts open drafts and serialises per bill', () => {
  beforeAll(async () => {
    fx = await seedFixture('mirrord', process.env.DATABASE_URL!);
    cos = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '5010', ${`COS ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('two mirrored drafts share the bill\'s VAT; a third is refused and pointed at the open draft; approved, VAT nets to 0', async () => {
    const b = await bill(1000);
    const first = await create(b, 500);
    // The same subtotal again is an identical draft (the dedupe); a genuine second names the first.
    expect(text(await create(b, 500))).toContain('An identical draft credit note already exists');
    const second = await inTx(fx, () => createCreditNoteTool.handler({ ...args(b, 500), duplicate_of: String(body(first).id) }, ctx()));
    expect([body(first).tax_amount, body(second).tax_amount]).toEqual([75, 75]);
    const third = await create(b, 500);
    expect(text(third)).toContain('There is nothing to mirror');
    expect(text(third)).toContain(`(id ${String(body(first).id)}) for the same subtotal is already open`);
    expect(await notesOn(b.id)).toBe(2);
    for (const r of [first, second]) await inTx(fx, () => approveCreditNote(fx.companyId, String(body(r).id), fx.userId));
    expect((await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!.totals).toMatchObject({ vat_net_now: 0, net_base_now: 0 });
  });

  it('a non-mirrored draft counts too: a mirror above what it leaves is refused', async () => {
    const b = await bill(1000);
    await inTx(fx, () => createCreditNote(fx.companyId, {
      type: 'supplier', supplierId: b.supplierId, supplierInvoiceId: b.id, creditDate: '2026-06-20', subtotal: 400,
    }, fx.userId));
    expect(text(await create(b, 700))).toContain(`more than the ${formatMoney(600)}`);
    expect(body(await create(b, 600))).toMatchObject({ tax_amount: 90 });
  });

  it('two concurrent mirrored creates for the whole bill: the second waits for the first, then is refused', async () => {
    const b = await bill(1000);
    const a = await fx.pool.connect();
    const c = await fx.pool.connect();
    try {
      await a.query('BEGIN');
      const firstResult = await runOn(fx, a, () => createCreditNoteTool.handler(args(b, 1000), ctx()));
      expect(body(firstResult).tax_amount).toBe(150);
      await c.query('BEGIN');
      const pid = await backendPid(c);
      const pending = runOn(fx, c, () => createCreditNoteTool.handler(args(b, 1000), ctx()));
      await waitUntilBlocked(fx.pool, pid);
      await a.query('COMMIT');
      const second = await pending;
      await c.query('COMMIT');
      expect(second.isError).toBe(true);
      expect(text(second)).toContain('There is nothing to mirror');
      expect(await notesOn(b.id)).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await c.query('ROLLBACK').catch(() => undefined);
      a.release();
      c.release();
    }
  }, 30000);
});
