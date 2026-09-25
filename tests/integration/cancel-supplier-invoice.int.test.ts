/**
 * cancel_supplier_invoice's plan and the cancel it gates, against a real ledger.
 *
 * The plan answers every refusal from reads, so the write needs no catch — a
 * catch cannot tell a refusal from a failure after the contra posted. These
 * cases pin that each refusal the live cancel could hit is named first, that
 * the preview's contra is the one the cancel posts, and that the GL nets out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  SupplierInvoiceCancelRefusal, planSupplierInvoiceCancel, lockAndPlanSupplierInvoiceCancel,
} from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let apAccount: string;
let expenseAccount: string;
const ACTOR = { postingAgent: 'mcp:cancel_supplier_invoice:v1', actorType: 'agent' as const, actorTokenJti: 'jti-1' };

async function accountId(f: Fixture, subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${f.companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Record<string, unknown>[])[0]!.id);
}

/** An approved bill carrying a real, posted DR Expense / CR AP approval journal. */
async function seedPostedBill(number: string, total: number, date = '2026-05-01'): Promise<{ bill: string; je: string }> {
  const bill = await seedBill(fx, { number, date, total });
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`JE-${number}-${fx.tag}`}, ${date}::DATE, ${`Supplier invoice ${number}`},
            'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(),
            'auto_supplier_invoice')
    RETURNING id`) as { id: string }[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${expenseAccount}::UUID, ${total}, 0, 'expense'),
           (${fx.companyId}::UUID, ${je}::UUID, ${apAccount}::UUID, 0, ${total}, 'AP')`;
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
  return { bill, je };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SupplierInvoiceCancelRefusal);
  return (err as Error).message;
}

const plan = (id: string, f: Fixture = fx) => inTx(f, () => planSupplierInvoiceCancel(f.companyId, id));
const lockedPlan = (id: string) => inTx(fx, () => lockAndPlanSupplierInvoiceCancel(fx.companyId, id));

/** A posted journal with two lines, optionally pointing back at a bill. */
async function seedJournal(number: string, date: string, amount: number, opts: {
  status?: string; sourceRecordId?: string; source?: string;
} = {}): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at,
       source, source_record_id)
    VALUES (${fx.companyId}::UUID, ${`JE-${number}-${fx.tag}`}, ${date}::DATE, ${number},
            ${opts.status ?? 'posted'}, ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1),
            ${opts.status === 'draft' ? null : new Date().toISOString()}::TIMESTAMPTZ,
            ${opts.source ?? 'manual'}, ${opts.sourceRecordId ?? null}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${expenseAccount}::UUID, ${amount}, 0, 'dr'),
           (${fx.companyId}::UUID, ${je}::UUID, ${apAccount}::UUID, 0, ${amount}, 'cr')`;
  return je;
}

describeIfDb('cancel_supplier_invoice — plan and cancel over a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('CSI', DATABASE_URL!);
    other = await seedFixture('CSX', DATABASE_URL!);
    apAccount = await accountId(fx, 'payable');
    expenseAccount = await accountId(fx, 'default_expense');
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM payment_allocations WHERE payment_id IN (
        SELECT id FROM supplier_payments WHERE company_id = ${f.companyId}::UUID)`;
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${f.companyId}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL, reversed_by = NULL
                WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  it('previews the contra the cancel then posts, stamps it as the agent\'s, and the GL nets to zero', async () => {
    const { bill, je } = await seedPostedBill('C1', 230);

    const planned = await plan(bill);
    expect(planned.journal).toMatchObject({ id: je });
    expect(planned.journal!.lines.map((l) => [l.debit, l.credit]).sort()).toEqual([[0, 230], [230, 0]]);

    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, bill, fx.userId, ACTOR));

    const contra = ((await sql`
      SELECT id, entry_date::TEXT AS d, posting_agent FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID`) as Record<string, unknown>[])[0]!;
    expect(contra.d).toBe(planned.journal!.reversalDate);
    expect(contra.posting_agent).toBe(ACTOR.postingAgent);
    const ap = ((await sql`
      SELECT COALESCE(SUM(debit - credit), 0) AS net FROM gl_journal_lines
      WHERE company_id = ${fx.companyId}::UUID AND gl_account_id = ${apAccount}::UUID
        AND journal_entry_id IN (${je}::UUID, ${String(contra.id)}::UUID)`) as Record<string, unknown>[])[0]!;
    expect(Number(ap.net)).toBe(0);
    const row = ((await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill}::UUID`) as Record<string, unknown>[])[0]!;
    expect(row).toEqual({ status: 'cancelled', gl_journal_entry_id: null });
  });

  it('plans a draft bill with no journal as a status change only', async () => {
    const bill = await seedBill(fx, { number: 'C2', date: '2026-05-02', total: 50, status: 'draft' });
    expect((await plan(bill)).journal).toBeNull();
  });

  it('refuses a bill with anything applied, naming the remedy', async () => {
    const { bill } = await seedPostedBill('C3', 100);
    await sql`UPDATE supplier_invoices SET amount_paid = 40, status = 'partially_paid' WHERE id = ${bill}::UUID`;
    const msg = await refusal(plan(bill));
    expect(msg).toContain('R40.00');
    expect(msg).toContain('void_payment');
  });

  it('refuses a bill a draft or approved payment still plans to pay, naming the payment', async () => {
    const { bill } = await seedPostedBill('C4', 100);
    const payNumber = `PC4-${fx.tag}`.slice(0, 30); // payment_number is VARCHAR(30)
    const pay = String(((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${payNumber}, '2026-05-05', 100, 'approved', ${fx.userId}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id);
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pay}::UUID, ${bill}::UUID, 100)`;

    expect(await refusal(plan(bill))).toContain(payNumber);
  });

  /** A contra dated into a filed VAT period would change a VAT201 already
   *  filed. Only a journal that carries VAT can do that, and a defaulted
   *  reversal date ROLLS FORWARD past the lock (it is not refused) — the plan
   *  previews the rolled date and says why. A zero-VAT bill keeps its date. */
  it('previews a VAT-carrying contra rolled past a locked VAT period, and a zero-VAT one on its own date', async () => {
    const vatInput = await accountId(fx, 'vat_input');
    const { bill: withVat, je } = await seedPostedBill('V1', 100, '2026-06-10');
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${fx.companyId}::UUID, ${je}::UUID, ${vatInput}::UUID, 15, 0, 'VAT'),
             (${fx.companyId}::UUID, ${je}::UUID, ${apAccount}::UUID, 0, 15, 'AP VAT')`;
    const { bill: zeroVat } = await seedPostedBill('V2', 100, '2026-06-11');
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-06-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId}::UUID)`;
    try {
      const rolled = (await plan(withVat)).journal!;
      expect(rolled.reversalDate).toBe('2026-07-01');
      expect(rolled.vatLockRoll).toMatchObject({ rolledFrom: '2026-06-10', date: '2026-07-01' });
      expect(rolled.vatLockRoll!.reason).toContain('locked VAT period');
      const plain = (await plan(zeroVat)).journal!;
      expect(plain.reversalDate).toBe('2026-06-11');
      expect(plain.vatLockRoll).toBeNull();

      // The live cancel posts the contra on the date the plan previewed.
      await inTx(fx, () => cancelSupplierInvoice(fx.companyId, withVat, fx.userId, ACTOR));
      const contra = ((await sql`
        SELECT entry_date::TEXT AS d FROM gl_journal_entries
        WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID`) as Record<string, unknown>[])[0]!;
      expect(contra.d).toBe('2026-07-01');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  /** The lock records the VAT201 snapshot (vatBoxBasis), which reads only the
   *  vat_input / vat_output legs and vat_type-tagged lines — an UNTAGGED
   *  'tax'-subtype leg is in no box, so its contra keeps its date. A vat_input
   *  leg rolls; a 'no_vat' tag moves nothing. */
  it('rolls only what the return recorded: not an untagged tax-subtype leg, not a no_vat tag', async () => {
    const taxAccount = String(((await sql`
      INSERT INTO gl_accounts
        (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '2190', ${`Tax ${fx.tag}`}, 'liability', 'tax', 'credit', true)
      RETURNING id`) as { id: string }[])[0]!.id);
    const { bill: onTax, je: taxJe } = await seedPostedBill('T1', 100, '2026-07-10');
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${fx.companyId}::UUID, ${taxJe}::UUID, ${taxAccount}::UUID, 15, 0, 'tax leg'),
             (${fx.companyId}::UUID, ${taxJe}::UUID, ${apAccount}::UUID, 0, 15, 'AP tax')`;
    const { bill: noVat, je: noVatJe } = await seedPostedBill('T2', 100, '2026-07-11');
    await sql`UPDATE gl_journal_lines SET vat_type = 'no_vat' WHERE journal_entry_id = ${noVatJe}::UUID`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-07-01', '2026-07-31', 0, 0, 0, '2026-07-31', ${fx.userId}::UUID)`;
    try {
      expect((await plan(onTax)).journal!.reversalDate).toBe('2026-07-10');
      expect((await plan(noVat)).journal!.reversalDate).toBe('2026-07-11');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  /** Ledger review HIGH: an approved bill with no approval journal (a Sage
   *  import, even one with no sage_invoice_id; a seeded history) may have its
   *  liability in the GL by other means, so cancelling it is refused. */
  it('refuses an approved bill with no approval journal that no capture created', async () => {
    const bill = await seedBill(fx, { number: 'NJ1', date: '2026-05-06', total: 80 });
    expect(await refusal(plan(bill))).toContain('no approval journal');
  });

  /** An approved bill that was never posted (the capture/AI pipeline's
   *  auto-approve, awaiting Post to GL) put nothing in the GL, so there is
   *  nothing to reverse: the plan lets it cancel with no contra. */
  it('plans a plain cancel for a captured, auto-approved bill that was never posted', async () => {
    const bill = await seedBill(fx, { number: 'NJ2', date: '2026-05-06', total: 80 });
    const doc = String(((await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, document_type, status)
       VALUES (${fx.companyId}::UUID, 'capture.pdf', 'application/pdf', 'invoice', 'posted') RETURNING id`) as Array<{ id: string }>)[0]!.id);
    await sql`UPDATE supplier_invoices SET source_document_id = ${doc}::UUID WHERE id = ${bill}::UUID`;
    const planned = await plan(bill);
    expect(planned.journal).toBeNull();
  });

  /** Ledger review MEDIUM: bank-matched with amount_paid 0 (the legacy path). */
  it('refuses a bank-matched bill', async () => {
    const { bill } = await seedPostedBill('BM1', 60);
    await sql`UPDATE supplier_invoices SET payment_matched = true WHERE id = ${bill}::UUID`;
    expect(await refusal(plan(bill))).toContain('matched to a bank payment');
  });

  /** Ledger review MEDIUM: a DRC VAT journal (or any other posted journal
   *  sourced from the bill) would be left standing for a cancelled bill. */
  it('refuses while another posted journal sourced from the bill stands, naming it', async () => {
    const { bill } = await seedPostedBill('DR1', 115);
    await seedJournal('DRC1', '2026-05-01', 15, { sourceRecordId: bill, source: 'auto_vat_adjustment' });
    expect(await refusal(plan(bill))).toContain(`JE-DRC1-${fx.tag}`);
  });

  /** Ledger review LOW: a DRAFT approval journal would be orphaned and could be posted later. */
  it('refuses a bill whose linked journal is still a draft', async () => {
    const bill = await seedBill(fx, { number: 'DJ1', date: '2026-05-07', total: 40, status: 'draft' });
    const je = await seedJournal('DJ1', '2026-05-07', 40, { status: 'draft' });
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
    expect(await refusal(plan(bill))).toContain('draft journal');
  });

  /** Ledger review MEDIUM (TOCTOU): the plan the live cancel uses reads a LOCKED row. */
  it('lockAndPlan plans from the locked row and refuses what the plan refuses', async () => {
    const { bill } = await seedPostedBill('LK1', 90);
    expect((await lockedPlan(bill)).journal).not.toBeNull();
    await sql`UPDATE supplier_invoices SET amount_paid = 5 WHERE id = ${bill}::UUID`;
    expect(await refusal(lockedPlan(bill))).toContain('R5.00');
  });

  it('refuses an already-cancelled bill, and another company\'s bill reads as not found', async () => {
    const cancelled = await seedBill(fx, { number: 'C5', date: '2026-05-03', total: 10, status: 'cancelled' });
    expect(await refusal(plan(cancelled))).toContain('already cancelled');

    const foreign = await seedBill(other, { number: 'C6', date: '2026-05-03', total: 10 });
    expect(await refusal(plan(foreign))).toBe('Not found');
  });
});
