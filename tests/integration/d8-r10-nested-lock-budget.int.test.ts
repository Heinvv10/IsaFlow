/**
 * D8 round 10: a pre-existing lock helper running INSIDE core/rowLockBudget.withRowLockBudget must leave the
 * outer budget in force. Each helper set its own 5 s and then reset `lock_timeout` to DEFAULT (no timeout), so
 * every lock the outer flow took afterwards waited unbounded. Each now restores the value it found.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { withRowLockBudget, RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { claimJournalReversal } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { lockBankTransactionForUpdate, withBankLockBudget } from '@/modules/accounting/services/bank/bankTxLock';
import {
  lockContactForRefund, lockCustomerPaymentForUpdate, lockSupplierPaymentForUpdate,
} from '@/modules/accounting/services/core/paymentLock';
import { claimUnderLockTimeout } from '@/modules/accounting/services/core/documentClaimLock';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { withCustomerInvoiceLock } from '@/modules/accounting/services/ar/customerInvoiceLock';
import { lockSupplierInvoiceForUpdate, withSupplierInvoiceLock } from '@/modules/accounting/services/ap/supplierInvoiceLock';
import { lockCapturedDocumentForUpdate, lockPostableCaptureEventIds } from '@/modules/accounting/services/capture/captureRowLock';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn, seedBankTx } from './helpers/l1FifoFixture';
import { confirmedReceipt, postedBill, postedInvoice, processedPayment, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const setting = async () => String(((await sql`SELECT current_setting('lock_timeout') AS v`) as Row[])[0]!.v);

/** In a rolled-back request transaction: inside an outer 3 s budget, run `inner`, then report lock_timeout. */
async function settingAfterNested(inner: () => Promise<unknown>): Promise<string> {
  const cl = await c.fx.pool.connect();
  try {
    await cl.query('BEGIN');
    return await runOn(c.fx, cl, () => withRowLockBudget(async () => {
      await inner();
      return setting();
    }, () => new RowLockTimeoutError('outer'), { deadline: Date.now() + 3000 }));
  } finally {
    await cl.query('ROLLBACK');
    cl.release();
  }
}

let ids: Record<string, string> = {};

describe.skipIf(!process.env.DATABASE_URL)('D8 round 10: a nested lock helper leaves the outer budget in force', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 10 nested budget');
    c = await setup('D8R10');
    const inv = await postedInvoice(c);
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 100);
    const rc = await confirmedReceipt(c, inv.id, 100);
    const bt = await seedBankTx(c.fx, { date: '2026-05-12', amount: -50, description: 'D8R10' });
    const cn = await inTx(c.fx, () => createCreditNote(c.fx.companyId,
      { type: 'customer', clientId: c.fx.customerId, creditDate: '2026-05-10', subtotal: 100, taxRate: 15 }, c.fx.userId));
    const [doc] = (await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${c.fx.companyId}::UUID, 'd8r10.pdf', 'application/pdf', 'reviewed', 'supplier_invoice') RETURNING id`) as Row[];
    ids = { inv: inv.id, invJe: inv.je, bill: bill.id, pay: pay.id, rc: rc.id, bt, cn: cn.id, doc: String(doc!.id) };
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  const company = () => c.fx.companyId;
  const nested: [string, () => Promise<unknown>][] = [
    ['claimJournalReversal', () => claimJournalReversal(company(), ids.invJe!, c.fx.userId)],
    ['lockBankTransactionForUpdate', () => lockBankTransactionForUpdate(company(), ids.bt!)],
    ['withBankLockBudget', () => withBankLockBudget(() => sql`SELECT 1`)],
    ['lockCustomerPaymentForUpdate', () => lockCustomerPaymentForUpdate(company(), ids.rc!)],
    ['lockSupplierPaymentForUpdate', () => lockSupplierPaymentForUpdate(company(), ids.pay!)],
    ['lockContactForRefund', () => lockContactForRefund(company(), 'supplier', c.fx.supplierId)],
    ['claimUnderLockTimeout', () => claimUnderLockTimeout('quote', () => sql`SELECT 1`)],
    ['lockCreditNoteForUpdate', () => lockCreditNoteForUpdate(company(), ids.cn!)],
    ['withCustomerInvoiceLock', () => withCustomerInvoiceLock('t', 'Invoice', () => sql`
      SELECT id FROM customer_invoices WHERE id = ${ids.inv!}::UUID AND company_id = ${company()}::UUID FOR UPDATE`)],
    ['lockSupplierInvoiceForUpdate', () => lockSupplierInvoiceForUpdate(company(), ids.bill!)],
    ['withSupplierInvoiceLock', () => withSupplierInvoiceLock('t', ids.bill!, () => sql`SELECT 1`)],
    ['lockCapturedDocumentForUpdate', () => lockCapturedDocumentForUpdate(company(), ids.doc!)],
    ['lockPostableCaptureEventIds', () => lockPostableCaptureEventIds(company(), ids.doc!)],
  ];

  it.each(nested)('%s restores the outer budget, not DEFAULT', async (_name, inner) => {
    const after = await settingAfterNested(inner);
    expect(after, 'DEFAULT (0) would unbound every later lock of the outer flow').not.toBe('0');
    expect(after).toMatch(/^\d+(ms|s)$/);
  });

  it.each([
    ['claimJournalReversal', () => claimJournalReversal(company(), ids.invJe!, c.fx.userId)],
    ['lockBankTransactionForUpdate', () => lockBankTransactionForUpdate(company(), ids.bt!)],
  ] as [string, () => Promise<unknown>][])('after a nested %s the outer flow\'s next lock still refuses within the outer budget', async (_n, inner) => {
    const holder = await c.fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [ids.bill]);
    const cl = await c.fx.pool.connect();
    const started = Date.now();
    let code = '';
    try {
      await cl.query('BEGIN');
      await cl.query("SET LOCAL statement_timeout = '15s'");
      await runOn(c.fx, cl, () => withRowLockBudget(async () => {
        await inner();
        await sql`SELECT id FROM supplier_invoices WHERE id = ${ids.bill!}::UUID FOR UPDATE`;
      }, () => new RowLockTimeoutError('outer'), { deadline: Date.now() + 3000 })).catch((e: unknown) => {
        code = e instanceof RowLockTimeoutError ? 'outer-timeout' : String((e as { code?: string }).code);
      });
    } finally {
      await cl.query('ROLLBACK');
      cl.release();
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(code).toBe('outer-timeout');
    expect(Date.now() - started).toBeLessThan(6000);
  }, 30000);
});
