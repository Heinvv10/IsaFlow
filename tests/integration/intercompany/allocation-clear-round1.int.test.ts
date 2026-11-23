/**
 * Intercompany P4-D, fix round 1 (the ledger findings). F1: the payer's cash counts as loan-funded only while the payer side's loan account is a
 * loan class (a side re-pointed at a bank clears nothing), and the side form refuses a non-loan-class loan account. F2: the caps count every
 * receiver's standing clearings of the same payer, and the clearing serialises on the payer's payment / journal / bill (advisory locks, service and
 * guard). F3: a per-payer-bill cap (clear, the payer voids and pays again: refused). F4: the posting date is on or after the invoice date. F5: the
 * payer's and the receiver's loan accounts are of opposite types. F9: a reversal of the reversal stands again (net chain). m3: a payment dated
 * after today is not live. m5: an external connection is its own refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { CLEAR_REFUSAL_SENTENCES } from '../../../src/modules/accounting/services/intercompany/allocationClearRefusals';
import { acct, api, asAppUser, co, plantExternal, plantSide, party, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { acc, dataOf, mirrorCleanup, rawReverseJournal } from './mirror.helpers';
import { bank, clearPayments, linkBill, plantPaid, sendFor } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { lockWaiter } from './ledger.helpers';
import { accept, backdateMirroring, bodyFor, clearConnect, clearSetup, ledger, outcomeOf, reapply, sentClearable } from './allocation-clear.helpers';
import { holdCapLock, plantForeignClearing } from './allocation-clear-round1.helpers';
import { plantArInvoice } from './mirror.helpers';
import type { AllocationPage } from '../../../src/modules/accounting/services/intercompany/allocationInboxTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability', is_system_account = false WHERE id = $1", [acct.bLoan]);
  conn = await clearConnect(pool);
});

const failed = (code: keyof typeof CLEAR_REFUSAL_SENTENCES) => ({ accepted: false, status: 'failed', code, error: CLEAR_REFUSAL_SENTENCES[code] });
const live = (m: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT live, reason, cap, payer_loan_type FROM public.intercompany_allocation_clearable($1)', [m])).rows[0]);

describe("F1: the payer's loan account must be a loan class", () => {
  it('the payer re-points its side at a bank account after paying: nothing counts as loan-funded, the clearing is refused', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = $3 WHERE connection_id = $1 AND company_id = $2', [conn, co.B, bank.b]), true);
    expect(await live(sent.message)).toEqual({ live: true, reason: 'ok', cap: 'cash_not_through_loan', payer_loan_type: null });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('cash_not_through_loan'));
  });

  it('a payer loan account that is a system account, or of a control subtype, counts for nothing', async () => {
    for (const set of ["is_system_account = true", "account_subtype = 'payable'", "account_type = 'equity', account_subtype = 'other'"]) {
      const sent = await sentClearable(pool, conn, { amount: 400 });
      await pool.query(`UPDATE gl_accounts SET ${set} WHERE id = $1`, [acct.bLoan]);
      expect([set, (await live(sent.message)).cap]).toEqual([set, 'cash_not_through_loan']);
      await pool.query("UPDATE gl_accounts SET account_type = 'liability', account_subtype = 'other_current_liability', is_system_account = false WHERE id = $1", [acct.bLoan]);
    }
  });

  it('the side form refuses a loan account that is not a loan class (a bank; a SYSTEM account of an otherwise allowed subtype), and takes one that is', async () => {
    const res = await api.edit(U.b, co.B, conn, { loanAccountId: bank.b });
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/loan or intercompany balance-sheet account/);
    const system = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, is_system_account, account_subtype)
       VALUES ($1, $2, $3, 'IC B system liability', 'liability', 'credit', true, true, 'other_current_liability')`, [system, co.B, `ISY${system.slice(0, 6)}`]);
    const sys = await api.edit(U.b, co.B, conn, { loanAccountId: system });
    expect(sys.state.statusCode).toBe(400);
    expect(JSON.stringify(sys.state.body)).toMatch(/loan or intercompany balance-sheet account/);
    expect((await api.edit(U.b, co.B, conn, { loanAccountId: acct.bLoan })).state.statusCode).toBe(200);
  });
});

describe('F2: the caps count every receiver, and serialise on the payer', () => {
  it("another receiver's standing clearing of the same payment leaves nothing: refused already_cleared", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await plantForeignClearing(pool, conn, sent, 400);
    expect((await live(sent.message)).cap).toBe('already_cleared');
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('already_cleared'));
  });

  it("another receiver's clearing whose receipt journal was reversed no longer counts", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const foreign = await plantForeignClearing(pool, conn, sent, 400);
    const je = (await pool.query('SELECT p.gl_journal_entry_id AS je FROM intercompany_messages m JOIN customer_payments p ON p.id = m.target_doc_id WHERE m.id = $1', [foreign])).rows[0].je as string;
    await rawReverseJournal(pool, je);
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
  });

  it("the service waits on the payer's advisory locks BEFORE it reads the caps: another receiver's clearing committed meanwhile is seen", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const held = await holdCapLock(pool, sent.message);
    const pending = accept(sent.message, bodyFor(sent));
    expect(await lockWaiter(pool, 'advisory')).toBe(true);
    // (what another receiver's Accept would commit while holding the same locks)
    await plantForeignClearing(pool, conn, sent, 400);
    await held.release();
    const res = await pending;
    expect(res.state.statusCode).toBe(200);
    expect(outcomeOf(res)).toMatchObject(failed('already_cleared'));
  });

  it('with nothing committed meanwhile, the waiting clearing goes on and clears', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const held = await holdCapLock(pool, sent.message);
    const pending = accept(sent.message, bodyFor(sent));
    expect(await lockWaiter(pool, 'advisory')).toBe(true);
    await held.release();
    expect(outcomeOf(await pending)).toMatchObject({ accepted: true });
  });
});

describe('F3: the per-payer-bill cap', () => {
  it('cleared, then the payer voids its payment and pays the bill again: the new message is refused already_cleared', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
    await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [sent.payment]);
    const again = await plantPaid(pool, sent.bill, { amount: 400, leg: acct.bLoan });
    const msg = (await sendFor(pool, again.allocation)).message_id as string;
    expect((await live(msg)).cap).toBe('already_cleared');
    expect(outcomeOf(await accept(msg, bodyFor(sent)))).toMatchObject(failed('already_cleared'));
  });
});

describe('F4, F5: the posting date and the two loan accounts', () => {
  it('a posting date before the invoice date is a 400, nothing written', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2026-09-05' WHERE id = $1", [sent.invoice]);
    const journals = await ledger.journals(pool);
    expect((await accept(sent.message, bodyFor(sent, { postingDate: '2026-09-02' }))).state.statusCode).toBe(400);
    expect(await ledger.message(pool, sent.message)).toMatchObject({ status: 'pending' });
    expect(await ledger.journals(pool)).toBe(journals);
  });

  it("the payer's and the receiver's loan accounts of the same type (both assets): refused loan_class_mismatch", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.bLoan]);
    expect(await live(sent.message)).toMatchObject({ live: true, payer_loan_type: 'asset' });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject(failed('loan_class_mismatch'));
  });
});

describe('F9: a reversal of the reversal stands again (the net chain)', () => {
  it('the receipt journal reversed twice still counts against the payment and is not shown voided; reversed once it is', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    const first = await rawReverseJournal(pool, out.journalEntryId!);
    const voided = async () => dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A, { filter: 'handled' })).items.find((i) => i.id === sent.message)?.clearedBy?.voided;
    expect(await voided()).toBe(true);
    await rawReverseJournal(pool, first);
    expect(await voided()).toBe(false);
    await pool.query('DELETE FROM payment_allocations WHERE id = $1', [sent.allocation]);
    const again = await reapply(pool, sent.payment, sent.bill, 400);
    expect(outcomeOf(await accept(again.message, bodyFor(sent)))).toMatchObject(failed('already_cleared'));
  });
});

describe('m3, m5', () => {
  it('a payment dated after today is not live (future_dated), and the clearing is refused not_live', async () => {
    const sent = await sentClearable(pool, conn, { amount: 400, date: '2099-01-01' });
    expect(await live(sent.message)).toMatchObject({ live: false, reason: 'future_dated' });
    expect(outcomeOf(await accept(sent.message, bodyFor(sent, { postingDate: '2026-09-01' })))).not.toMatchObject({ accepted: true });
    const items = dataOf<AllocationPage>(await allocationsApi.list(U.a, co.A)).items;
    expect(items.find((i) => i.id === sent.message)).toMatchObject({ live: false, liveReason: 'future_dated' });
  });

  it('an external (non-group) loan connection is refused not_group, not as a cut-over', async () => {
    await wipeConnections(pool);
    const ext = await plantExternal(pool, co.A, co.B, 'active');
    await withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'loan', cutover_date = DATE '2026-01-01' WHERE id = $1", [ext]));
    await plantSide(pool, ext, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier, loan_account_id: acct.aLoan });
    await plantSide(pool, ext, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier, default_expense_account_id: acc.bExp1, loan_account_id: acct.bLoan });
    await backdateMirroring(pool, ext);
    const invoice = (await plantArInvoice(pool, { status: 'approved' })).id;
    const bill = crypto.randomUUID();
    await pool.query(
      `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount, currency, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, $3, $4, DATE '2026-09-01', DATE '2026-10-01', 1150, 15, 0, 1150, 'ZAR', 'ZAR', 1, 'approved', $5)`, [bill, co.B, `ICX-${bill.slice(0, 8)}`, party.bSupplier, U.ab]);
    await linkBill(pool, ext, invoice, bill);
    const p = await plantPaid(pool, bill, { amount: 400, leg: acct.bLoan });
    const msg = (await sendFor(pool, p.allocation)).message_id as string;
    expect(msg).toBeTruthy();
    expect(outcomeOf(await accept(msg, bodyFor({ invoice, amount: 400 })))).toMatchObject(failed('not_group'));
  });
});
