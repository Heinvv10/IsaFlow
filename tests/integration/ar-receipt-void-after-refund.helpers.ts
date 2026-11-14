/**
 * Shared ledger helpers for the receipt-void-after-refund suites (ar/customerVoidCredit, 2026-11-14): customers,
 * receipts and refunds posted through the REAL bank allocation path on the K-074 fixture. Disposable fixture DB only.
 */
import type { Pool } from 'pg';
import { als } from '@/lib/als';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getCustomerOnAccountCredit } from '@/modules/accounting/services/ar/customerRefundDocument';
import type { AutoApplyMode } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import type { K074Fixture } from './helpers/k074Fixture';

export function receiptLedger(pool: Pool, fx: () => K074Fixture) {
  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: fx().user, companyId: fx().company, claims: {} } as never, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const ctx = () => ({
    companyId: fx().company, userId: fx().user, scopes: ['write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null,
  }) as never;
  return {
    inTx,
    ctx,
    async newCustomer(): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,$3,'off')",
        [id, fx().company, `RVC ${id.slice(0, 6)}`]);
      return id;
    },
    /** A bank line of `amount` (negative = a refund out) allocated to `customer`; its line and document ids. */
    async allocated(customer: string, amount: number, date: string, autoApply: AutoApplyMode = 'none', id = crypto.randomUUID()) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,$4::DATE,$5,'RVC line','imported')`, [id, fx().company, fx().bankAccount, date, amount]);
      const { journalEntryId } = await inTx(() => allocateTransaction(
        fx().company, id, null, fx().user, 'RVC', 'customer', customer,
        undefined, undefined, undefined, undefined, undefined, { autoApply }));
      const { rows: [p] } = await pool.query(
        'SELECT id FROM customer_payments WHERE gl_journal_entry_id = $1 AND company_id = $2', [journalEntryId, fx().company]);
      return { line: id, receipt: String(p.id), journalEntryId: String(journalEntryId) };
    },
    async invoice(customer: string, total: number, date: string): Promise<string> {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
           total_amount,amount_paid,status,created_by)
         VALUES($1,$2,$3,$4,$5::DATE,$5::DATE + 20,$6,0,$6,0,'approved',$7)`,
        [id, fx().company, customer, `RVC-${id.slice(0, 8)}`, date, total, fx().user]);
      return id;
    },
    credit: async (customer: string) => (await inTx(() => getCustomerOnAccountCredit(fx().company, customer, '2026-05-31'))).credit,
    statusOf: async (receipt: string) =>
      String((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [receipt])).rows[0].status),
    lineStatus: async (line: string) =>
      String((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line])).rows[0].status),
  };
}

/** 'passed', or the thrown error's code (a tool that returns an error envelope answers 'tool-error'). */
export const verdict = (p: Promise<unknown>) => p.then(
  (r) => ((r as { isError?: boolean } | undefined)?.isError ? 'tool-error' : 'passed'),
  (err: { code?: string }) => err.code ?? 'uncoded');
