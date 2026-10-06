/**
 * R-035 PR5, decision Q4: payments gate the INSTRUCTION to pay, never the
 * record of money that has already moved. With supplier_payment AND
 * payment_batch enforcement on and an 'any' rule for each:
 *   - the bank-feed creators still record their payment straight as
 *     'processed' (withApprovalGateExemptBankFeed, pinned by the census);
 *   - the exemption ends with their INSERT — a raw 'processed' INSERT later in
 *     the same transaction is refused;
 *   - money IN is untouched: a customer receipt confirms as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { recordSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { plantInvoice } from './r035-pr4.helpers';
import { cleanupPr5, enforcePay, inRequest as inRequestAs, payCompany, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let fx: { company: string; bank: string };

beforeAll(async () => {
  a = await createUser(pool, tokens);
  fx = await payCompany(pool, [[a, 'owner']], companies);
  for (const type of ['supplier_payment', 'payment_batch'] as const) {
    await plantRule(pool, fx.company, 'owner', { documentType: type });
    await enforcePay(pool, fx.company, type, a);
  }
  const tag = fx.company.slice(0, 6);
  for (const [code, type, subtype, normal] of [['AR', 'asset', 'receivable', 'debit'], ['RV', 'revenue', 'default_revenue', 'credit'],
    ['VO', 'liability', 'vat_output', 'credit']]) {
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES ($1,$2,$3,$4,$5,true,true,$6)`, [fx.company, `${code}${tag}`, `R035 ${subtype}`, type, normal, subtype]);
  }
  clearSystemAccountCache(fx.company);
});
afterAll(() => cleanupPr5(pool, companies, [a]));

const inRequest = <T>(fn: (client: PoolClient) => Promise<T>) => inRequestAs(pool, a, fx.company, fn);

async function bankLine(db: PoolClient, amount: number) {
  const je = (await db.query(
    "INSERT INTO gl_journal_entries(company_id,entry_date,created_by,status,description) VALUES($1,DATE '2026-09-01',$2,'posted','R035 bank') RETURNING id",
    [fx.company, a])).rows[0].id as string;
  const bt = (await db.query(
    "INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description) VALUES($1,$2,DATE '2026-09-01',$3,'R035') RETURNING id",
    [fx.company, fx.bank, amount])).rows[0].id as string;
  return { je, bt };
}

describe('bank-feed creators under enforcement', () => {
  it('a supplier bank payment and a supplier refund are recorded as processed', async () => {
    const supplierId = await plantSupplier(pool, fx.company);
    const paid = await inRequest(async (db) => {
      const { je, bt } = await bankLine(db, -500);
      return recordSupplierBankPayment({
        companyId: fx.company, supplierId, bankTxId: bt, bankAccountId: fx.bank, journalEntryId: je,
        amount: 500, paymentDate: '2026-09-01', description: 'R035 bank payment', userId: a, autoApply: 'none',
      });
    });
    const refunded = await inRequest(async (db) => {
      const { je, bt } = await bankLine(db, 100);
      return recordSupplierRefund({
        companyId: fx.company, supplierId, bankTxId: bt, bankAccountId: fx.bank, journalEntryId: je,
        amount: 100, paymentDate: '2026-09-02', description: 'R035 refund', userId: a,
      });
    });
    const { rows } = await pool.query(
      'SELECT total_amount::FLOAT8 AS total, status FROM supplier_payments WHERE id = ANY($1) ORDER BY total_amount',
      [[paid.paymentId, refunded.paymentId]]);
    expect(rows).toEqual([{ total: -100, status: 'processed' }, { total: 500, status: 'processed' }]);
  });

  it('the exemption ends with the creator\'s INSERT: a raw processed INSERT after it, same transaction, is refused', async () => {
    const supplierId = await plantSupplier(pool, fx.company);
    const outcome = await inRequest(async (db) => {
      const { je, bt } = await bankLine(db, -50);
      await recordSupplierBankPayment({
        companyId: fx.company, supplierId, bankTxId: bt, bankAccountId: fx.bank, journalEntryId: je,
        amount: 50, paymentDate: '2026-09-01', description: 'R035', userId: a, autoApply: 'none',
      });
      await db.query(
        `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,status,created_by)
         VALUES($1,$2,DATE '2026-09-01',50,'eft','processed',$3)`, [fx.company, supplierId, a]);
    }).then(() => 'written', (e: Error) => e.message);
    expect(outcome).toMatch(/^R035_APPROVAL_REQUIRED/);
  });
});

describe('money in is out of scope', () => {
  it('a customer receipt confirms as before with both payment types enforced', async () => {
    const inv = await plantInvoice(pool, fx.company, a, { status: 'sent' });
    const confirmed = await inRequest(async () => {
      const payment = await createCustomerPayment(fx.company, {
        clientId: inv.customerId, paymentDate: '2026-09-05', totalAmount: 1150, paymentMethod: 'eft',
        bankAccountId: fx.bank, allocations: [{ invoiceId: inv.id, amount: 1150 }],
      }, a);
      return confirmCustomerPayment(fx.company, payment.id, a);
    });
    expect(confirmed.status).toBe('confirmed');
    const { rows: [row] } = await pool.query('SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = $1', [inv.id]);
    expect(row.paid).toBe(1150);
  });
});
