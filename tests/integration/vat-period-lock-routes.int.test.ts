/**
 * A VAT-lock refusal through the REAL route handlers — withAuth, CSRF,
 * write-access and all — because two properties exist only there: the refusal
 * is a 4xx, and withAuth COMMITs a 4xx. A route that created a draft journal
 * and then had postJournalEntry refuse it used to commit that draft, and every
 * retry added another. The refusal must therefore land BEFORE the first write:
 * after each refused call there is no gl_journal_entries row at all.
 *
 * Covered: bank-transactions-action allocate and split_allocate,
 * supplier-invoices-action approve, bank-transfers (refused onto a VAT account;
 * bank-to-bank gets past the guard — see the note on that case), and the
 * petty-cash service behind capture post-expense, which CLAIMS the document
 * before it creates the journal and so must refuse before that claim.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { postReceiptAsPettyCashJournal } from '@/modules/accounting/services/capture/pettyCashJournalService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

type Row = Record<string, unknown>;
type Handler = (req: never, res: never) => Promise<unknown> | unknown;
let fx: Fixture;
let token = '';
const acc: Record<string, string> = {};

async function accountBySubtype(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

async function call(handler: Handler, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/vat-lock-route-fixture';
  const out = response();
  await handler(req as never, out.res as never);
  return out.state;
}

const journalCount = async () => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);

describeIfDb('VAT-lock refusals through the route handlers leave no journal behind', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts through route handlers into a locked VAT period.');
    fx = await seedFixture('VLRT', DATABASE_URL!);
    acc.expense = await accountBySubtype('default_expense');
    acc.vatInput = await accountBySubtype('vat_input');
    acc.bank2 = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '1010', ${`Bank 2 ${fx.tag}`}, 'asset', 'bank', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vlrt-${fx.userId}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId})`;
    token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    const c = fx.companyId;
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM approval_requests WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_coding_history WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
  }, 120000);

  it('allocate with a VAT code answers 4xx and commits no draft journal', async () => {
    const tx = await seedBankTx(fx, { date: '2026-06-15', amount: -115, description: 'VAT spend' });
    const before = await journalCount();
    const state = await call(bankTransactionsAction, {
      action: 'allocate', bankTransactionId: tx, allocationType: 'account',
      contraAccountId: acc.expense, vatCode: 'standard',
    });
    expect(state.statusCode).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/locked/);
    expect(await journalCount()).toBe(before);
    const st = ((await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[])[0]!;
    expect(st.status).toBe('imported');
  });

  it('split_allocate onto a VAT control account answers 4xx and commits no draft journal', async () => {
    const tx = await seedBankTx(fx, { date: '2026-06-16', amount: -100, description: 'Split spend' });
    const before = await journalCount();
    const state = await call(bankTransactionsAction, {
      action: 'split_allocate', bankTransactionId: tx,
      lines: [{ contraAccountId: acc.expense, amount: 85 }, { contraAccountId: acc.vatInput, amount: 15 }],
    });
    expect(state.statusCode).toBe(400);
    expect(await journalCount()).toBe(before);
  });

  it('supplier-invoice approve answers 4xx, leaves the bill a draft and commits no journal', async () => {
    const bill = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
      supplierId: fx.supplierId, invoiceNumber: `VLRT-${fx.tag}`.slice(0, 50), invoiceDate: '2026-06-12',
      items: [{ description: 'Stock', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: acc.expense }],
    }, fx.userId));
    const before = await journalCount();
    const state = await call(supplierInvoicesAction, { action: 'approve', invoiceId: bill.id });
    expect(state.statusCode).toBe(400);
    expect(await journalCount()).toBe(before);
    const row = ((await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[])[0]!;
    expect(row).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('bank-transfers onto a VAT account inside the lock answers 400 and writes nothing', async () => {
    const before = await journalCount();
    const state = await call(bankTransfers, {
      fromAccountId: fx.bankAccountId, toAccountId: acc.vatInput, amount: 50, transferDate: '2026-06-18',
    });
    expect(state.statusCode).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/locked/);
    expect(await journalCount()).toBe(before);
  });

  /** This route cannot post ANYTHING today, lock or no lock: its INSERT names
   *  total_debit/total_credit (columns gl_journal_entries does not have) and
   *  source 'bank_transfer', which migrations 509/627 deliberately keep out of
   *  the source CHECK while the writer is unvalidated. So "allowed" is proven
   *  as: NOT the guard's 400 — the request gets past the guard and fails later,
   *  as a 500 that rolls back, writing nothing. */
  it('bank-transfers between two bank accounts inside the lock gets past the VAT guard', async () => {
    const before = await journalCount();
    const state = await call(bankTransfers, {
      fromAccountId: fx.bankAccountId, toAccountId: acc.bank2, amount: 50, transferDate: '2026-06-18',
    });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(500);
    expect(JSON.stringify(state.body)).not.toMatch(/locked/);
    expect(await journalCount()).toBe(before);
  });

  /** The route (capture/[id]/post-expense) cannot run on isaflow_dev: its row
   *  lock reads captured_documents.posted_at, added by migration 672, which dev
   *  lacks. So the petty-cash service it calls is driven directly. The claim it
   *  makes before creating the journal writes that same column — so a refusal
   *  that surfaces as VatPeriodLockedError (not 42703) proves it came BEFORE
   *  the claim, the service's first write; the route maps it to 400. */
  it('petty cash refuses a VAT receipt dated in the lock before claiming the document', async () => {
    const before = await journalCount();
    const err = await inTx(fx, () => postReceiptAsPettyCashJournal({
      companyId: fx.companyId, userId: fx.userId, eventId: randomUUID(), documentId: randomUUID(),
      extracted: {
        documentType: 'receipt', vendorName: 'Waltons Stationery', date: '2026-06-10', referenceNumber: 'REC-VL',
        currency: 'ZAR', subtotal: 100, vatAmount: 15, vatRate: 15, totalAmount: 115, lineItems: [], rawText: '',
        confidence: 0.9, warnings: [], extractionMethod: 'vlm',
      } as never,
      resolvedGlAccountId: acc.expense!, vatInputAccountId: acc.vatInput!,
    })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(await journalCount()).toBe(before);
  });
});
