/**
 * Intercompany P4-B: the BANK-FEED path. A bank line applied to a linked bill (`applyBankLineToSupplierInvoices`, what bank-match-confirm and the MCP
 * allocation tools call) posts DR Accounts Payable / CR the line's bank account through `allocateTransaction`, writes the payer's payment at status
 * `processed` carrying THAT journal, and applies it through `applySupplierPaymentPlan`. So the payment ends on a posted, standing journal and the
 * definer sends for it; the cash leg is the bank account the line sits on (the loan account only when the line does).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { applyBankLineToSupplierInvoices } from '../../../src/modules/accounting/services/ap/supplierBankPaymentService';
import { acct } from './intercompany.fixture';
import { asAppUser } from './intercompany.session';
import { asService, co, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import { allocSetup, allocationMessages, bank, clearPayments, loanConnect, plantBill } from './allocation.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

async function bankLine(account: string, amount = -1150): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1, $2, DATE '2026-09-01', $3, 'IC bank-feed payment', 'imported') RETURNING id`, [co.B, account, amount])).rows[0].id as string;
}

const apply = (bankTxId: string, invoiceId: string, amount = 1150) => asService(pool, U.b, co.B, () => applyBankLineToSupplierInvoices(co.B, {
  bankTxId, userId: U.b, allocations: [{ invoiceId, amount }],
}));

describe('a bank line applied to a linked loan-mode bill', () => {
  it('leaves a fully applied (reconciled) payment on the posted, standing journal the bank line posted, and the definer sends for it', async () => {
    const { bill, invoice } = await plantBill(pool, conn);
    const res = await apply(await bankLine(bank.b), bill);
    const pay = (await pool.query(
      `SELECT sp.status, sp.gl_journal_entry_id AS je, je.status AS je_status, je.reversal_of_id
         FROM supplier_payments sp JOIN gl_journal_entries je ON je.id = sp.gl_journal_entry_id WHERE sp.id = $1`, [res.supplierPaymentId])).rows[0];
    expect(pay).toMatchObject({ status: 'reconciled', je_status: 'posted', reversal_of_id: null });
    expect(pay.je).toBe(res.journalEntryId);
    const rows = await allocationMessages(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_company_id: co.B, to_company_id: co.A, source_journal_entry_id: pay.je, status: 'pending' });
    expect(rows[0].payload).toMatchObject({ amount: 1150, issuerDocument: { id: invoice }, payment: { id: res.supplierPaymentId, cashLegIsLoanAccount: false } });
  });

  it('a line on the payer\'s loan account says so (the journal credits it)', async () => {
    const { bill } = await plantBill(pool, conn);
    await apply(await bankLine(acct.bLoan), bill);
    expect((await allocationMessages(pool))[0].payload.payment.cashLegIsLoanAccount).toBe(true);
  });

  it('a part payment (the payment keeps its status) is sent as well, once per allocation row', async () => {
    const { bill } = await plantBill(pool, conn);
    const res = await apply(await bankLine(bank.b, -2000), bill, 1150);
    expect(res.paymentStatus).toBe('processed');
    const rows = await allocationMessages(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.amount).toBe(1150);                                                 // the allocation, not the 2 000 line
  });

  it('on a cash connection nothing is sent and the application is unharmed', async () => {
    const { bill } = await plantBill(pool, conn);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]), true);
    const res = await apply(await bankLine(bank.b), bill);
    expect(res.lines).toHaveLength(1);
    expect(await allocationMessages(pool)).toHaveLength(0);
  });
});
