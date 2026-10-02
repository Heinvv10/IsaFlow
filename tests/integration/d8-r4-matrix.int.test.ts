/**
 * D8 round 4 (from the adversarial round brk-d8 M, and review M-1): chain
 * lengths 0..4 (k reversals already on the document's journal) through every
 * D8 flow. Taken out exactly once: after the flow the document contributes
 * NOTHING to the TB, and a new contra exists iff k is even. The odd k are the
 * "chain already out, reverse nothing" branches the review found untested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { planSupplierInvoiceCancel } from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { importOpeningBalances } from '@/modules/accounting/services/core/migrationImportService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { seedBankTx } from './helpers/l1FifoFixture';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, diff, postedBill, postedInvoice, postedReversalsOf, processedPayment, provisional, settle, setup,
  tb, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const KS = [0, 1, 2, 3, 4];

describe.skipIf(!process.env.DATABASE_URL)('D8 round 4: chain-length matrix (k = 0..4)', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 4 matrix');
    c = await setup('D8R4M');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  for (const k of KS) {
    it(`M-AR k=${k}: AR cancel takes the invoice out exactly once`, async () => {
      const t0 = await tb(c);
      const inv = await postedInvoice(c);
      const chain = await buildChain(c, inv.je, k);
      const r = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [st] = (await sql`SELECT status FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[];
      expect(r.ok).toBe(true);
      expect(d).toMatchObject({ ar: 0, sales: 0, vatOut: 0 });
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-AP k=${k}: AP cancel takes the bill out exactly once`, async () => {
      const t0 = await tb(c);
      const bill = await postedBill(c);
      const chain = await buildChain(c, bill.je, k);
      const plan = await inTx(c.fx, () => planSupplierInvoiceCancel(c.fx.companyId, bill.id));
      expect(plan.journal?.id ?? null).toBe(k % 2 === 0 ? chain[chain.length - 1]! : null);
      const r = await settle(inTx(c.fx, () => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      expect(r.ok).toBe(true);
      expect(d).toMatchObject({ ap: 0, expense: 0, vatIn: 0 });
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-VOID-HTTP k=${k}: supplier payment void takes the payment out exactly once and reopens the bill`, async () => {
      const bill = await postedBill(c);
      const t0 = await tb(c);
      const pay = await processedPayment(c, bill.id, 400);
      const chain = await buildChain(c, pay.je, k);
      const r = await settle(inTx(c.fx, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [b] = (await sql`SELECT amount_paid::float8 AS p FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
      expect(r.ok).toBe(true);
      expect(d).toMatchObject({ ap: 0, bank: 0 });
      expect(Number(b!.p)).toBe(0);
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-VOID-MCP k=${k}: MCP void (voidPaymentDocument) — same outcome as the HTTP void`, async () => {
      const bill = await postedBill(c);
      const t0 = await tb(c);
      const pay = await processedPayment(c, bill.id, 300);
      const chain = await buildChain(c, pay.je, k);
      const r = await settle(inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [b] = (await sql`SELECT amount_paid::float8 AS p FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
      const [p] = (await sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`) as Row[];
      // Round 4 (observation 13): on an OUT chain the MCP void does what the
      // HTTP void does — voids the document, reopens the bill, reverses nothing.
      expect(r.ok).toBe(true);
      expect(d).toMatchObject({ ap: 0, bank: 0 });
      expect(Number(b!.p)).toBe(0);
      expect(p!.status).toBe('cancelled');
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-RCPT k=${k}: customer receipt cancel takes the receipt out exactly once and reopens the invoice`, async () => {
      const inv = await postedInvoice(c);
      const t0 = await tb(c);
      const rc = await confirmedReceipt(c, inv.id, 400);
      const chain = await buildChain(c, rc.je, k);
      const r = await settle(inTx(c.fx, () => cancelCustomerPayment(c.fx.companyId, rc.id, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [i] = (await sql`SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[];
      const [p] = (await sql`SELECT status FROM customer_payments WHERE id = ${rc.id}::UUID`) as Row[];
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(d).toMatchObject({ ar: 0, bank: 0 });
      expect(Number(i!.p)).toBe(0);
      expect(p!.status).toBe('cancelled');
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-DISMISS k=${k}: dismissing a provisional takes it out exactly once and frees its bank line`, async () => {
      const t0 = await tb(c);
      const pv = await provisional(c, 230);
      const chain = await buildChain(c, pv.je, k);
      const r = await settle(inTx(c.fx, () => dismissProvisionalEntry(c.fx.companyId, pv.je, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [bt] = (await sql`SELECT status, provisional_je_id FROM bank_transactions WHERE id = ${pv.bt}::UUID`) as Row[];
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(d).toMatchObject({ expense: 0, bank: 0 });
      expect(bt).toEqual({ status: 'imported', provisional_je_id: null });
      expect(newContras.length).toBe(k % 2 === 0 ? 1 : 0);
    });

    it(`M-BANK k=${k}: bank reversal reverses a standing chain's head; an OUT chain is refused, nothing posted`, async () => {
      const tx = await seedBankTx(c.fx, { date: '2026-05-12', amount: -230, description: `D8R4 SHOP ${k}` });
      await inTx(c.fx, () => allocateTransaction(c.fx.companyId, tx, c.acct.expense!, c.fx.userId, undefined, 'account', undefined, undefined));
      const [m] = (await sql`
        SELECT l.journal_entry_id AS j FROM bank_transactions bt JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id
        WHERE bt.id = ${tx}::UUID`) as Row[];
      const chain = await buildChain(c, String(m!.j), k);
      const t0 = await tb(c);
      const r = await settle(inTx(c.fx, () => reverseReconciledTransaction(c.fx.companyId, tx, c.fx.userId)));
      const d = diff(t0, await tb(c));
      const newContras = await postedReversalsOf(c, chain[chain.length - 1]!);
      const [bt] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[];
      if (k % 2 === 0) {
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(d).toMatchObject({ expense: -230, bank: 230 }); // no VAT code: one expense line
        expect(bt!.status).toBe('imported');
        expect(newContras.length).toBe(1);
      } else {
        // Deliberately unchanged (k021): an OUT chain reaches reverseJournalEntry on the journal and is refused.
        expect(r.ok).toBe(false);
        expect(d).toMatchObject({ expense: 0, bank: 0 });
        expect(bt!.status).toBe('allocated');
        expect(newContras.length).toBe(0);
      }
    });

    it(`M-OB k=${k}: opening-balance re-import twice leaves exactly one take-on`, async () => {
      const [s] = (await sql`
        INSERT INTO migration_sessions (company_id, source_system, started_by)
        VALUES (${c.fx.companyId}::UUID, 'sage', ${c.fx.userId}) RETURNING id`) as Row[];
      const session = String(s!.id);
      const tbRows = [{ accountCode: '6000', debit: 700, credit: 0 }, { accountCode: '3900', debit: 0, credit: 700 }];
      const t0 = await tb(c);
      const first = await inTx(c.fx, () => importOpeningBalances(c.fx.companyId, session, '2026-01-01', tbRows, c.fx.userId));
      await buildChain(c, first.journalEntryId, k);
      const r1 = await settle(inTx(c.fx, () => importOpeningBalances(c.fx.companyId, session, '2026-01-01', tbRows, c.fx.userId)));
      expect(diff(t0, await tb(c))).toMatchObject({ expense: 700, equity: -700 }); // after ONE re-import
      const r2 = await settle(inTx(c.fx, () => importOpeningBalances(c.fx.companyId, session, '2026-01-01', tbRows, c.fx.userId)));
      const d = diff(t0, await tb(c));
      expect(r1.ok && r2.ok).toBe(true);
      expect(d).toMatchObject({ expense: 700, equity: -700 });
    });
  }
});
