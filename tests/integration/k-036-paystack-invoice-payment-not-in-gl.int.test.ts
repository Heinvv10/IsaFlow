/**
 * K-036 RED — a Paystack card payment against a customer invoice only bumps
 * customer_invoices.amount_paid:
 *   pages/api/webhooks/paystack.ts:227-240 (charge.success branch)
 *   pages/api/portal/payments/paystack/verify.ts:80-96 (return-page fallback)
 * Neither creates a customer_payments row nor a GL journal, so bank stays
 * undebited and AR stays uncredited. The manual path,
 * customerPaymentAllocationService.confirmCustomerPayment, posts
 * DR Bank / CR Receivable and writes customer_payments.
 *
 * Paystack is mocked in both directions: the webhook route never calls the
 * provider, and verifyTransaction is stubbed for the verify route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHmac } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const verifyTransaction = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (...args: unknown[]) => verifyTransaction(...args),
  chargeAuthorization: vi.fn(async () => {
    throw new Error('Paystack must not be charged in this test');
  }),
}));

const webhook = (await import('../../pages/api/webhooks/paystack')).default;
const verifyRoute = (await import('../../pages/api/portal/payments/paystack/verify')).default;

const SECRET = 'sk_test_k036_disposable_secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const customerId = crypto.randomUUID();
const invoiceId = crypto.randomUUID();
const bankAccountId = crypto.randomUUID();
const arAccountId = crypto.randomUUID();

const INVOICE_TOTAL = 1150.0;
const AMOUNT_CENTS = 115000;

function webhookBody(reference: string) {
  return JSON.stringify({
    event: 'charge.success',
    data: {
      id: 123456789,
      reference,
      status: 'success',
      amount: AMOUNT_CENTS,
      currency: 'ZAR',
      channel: 'card',
      customer: { email: 'payer@k036.test.local', customer_code: 'CUS_k036' },
    },
  });
}

function deliverWebhook(reference: string) {
  const body = webhookBody(reference);
  const req = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  (req as { method: string }).method = 'POST';
  (req as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', SECRET).update(body).digest('hex'),
  };
  const result = response();
  return webhook(req, result.res).then(() => result);
}

function callVerify(reference: string) {
  const req = {
    method: 'GET',
    url: `/api/portal/payments/paystack/verify?ref=${reference}`,
    query: { ref: reference },
    cookies: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.36' },
  } as unknown as NextApiRequest;
  const result = response();
  return verifyRoute(req, result.res).then(() => result);
}

async function seedPaymentRequest(reference: string) {
  await pool.query(
    `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,
       paystack_reference,amount_cents,status)
     VALUES($1,'customer_invoice',$2,$3,$4,'pending')`,
    [companyId, invoiceId, reference, AMOUNT_CENTS],
  );
}

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-036 fixture']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k036.test.local`],
  );
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [
    customerId, companyId, 'K-036 debtor',
  ]);
  // The canonical AR path resolves both system accounts through
  // systemAccountResolver, which only sees is_system_account + is_active rows.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,
       account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'1100','Bank','asset','bank','debit',true,true),
            ($3,$2,'1120','Accounts Receivable','asset','receivable','debit',true,true)`,
    [bankAccountId, companyId, arAccountId],
  );
});

beforeEach(async () => {
  verifyTransaction.mockReset();
  await pool.query('DELETE FROM paystack_webhook_events WHERE reference LIKE $1', ['k036_%']);
  await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
  await clearLedger();
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,customer_id,invoice_number,subtotal,
       total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5,$5,0,'sent',$6)`,
    [invoiceId, companyId, customerId, `K036-0001`, INVOICE_TOTAL, userId],
  );
});

async function clearLedger() {
  await pool.query(
    `DELETE FROM customer_payment_allocations WHERE payment_id IN
       (SELECT id FROM customer_payments WHERE company_id=$1)`, [companyId],
  );
  await pool.query('DELETE FROM customer_payments WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [companyId]);
}

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM paystack_webhook_events WHERE reference LIKE $1', ['k036_%']);
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
    await clearLedger();
    await pool.query(
      'DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)',
      [companyId],
    );
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await pool.end();
  }
});

async function ledgerFootprint() {
  const payments = await pool.query(
    'SELECT id, total_amount, payment_method, bank_reference, status, gl_journal_entry_id FROM customer_payments WHERE company_id=$1',
    [companyId],
  );
  const journals = await pool.query(
    'SELECT id, posting_agent, fiscal_period_id, status FROM gl_journal_entries WHERE company_id=$1',
    [companyId],
  );
  const invoice = await pool.query(
    'SELECT amount_paid, status FROM customer_invoices WHERE id=$1', [invoiceId],
  );
  return {
    payments: payments.rowCount,
    paymentRow: payments.rows[0] as Record<string, string | null> | undefined,
    journals: journals.rowCount,
    journalRow: journals.rows[0] as Record<string, string | null> | undefined,
    invoice: invoice.rows[0] as { amount_paid: string; status: string },
  };
}

/** DR/CR totals per account for the one journal the receipt posts. */
async function journalLines(journalEntryId: string) {
  const { rows } = await pool.query(
    `SELECT gl_account_id, debit::float8 AS debit, credit::float8 AS credit
     FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2`,
    [journalEntryId, companyId],
  );
  return rows as { gl_account_id: string; debit: number; credit: number }[];
}

/** The receipt must balance AND agree with what the invoice says was paid. */
async function expectBalancedReceipt(expectedRand: number) {
  const after = await ledgerFootprint();
  expect(after.payments).toBe(1);
  expect(after.journals).toBe(1);
  expect(Number(after.paymentRow!.total_amount)).toBeCloseTo(expectedRand, 2);
  expect(after.paymentRow!.payment_method).toBe('card');
  expect(after.paymentRow!.status).toBe('confirmed');
  expect(after.paymentRow!.gl_journal_entry_id).toBe(after.journalRow!.id);
  expect(after.journalRow!.posting_agent).toBe('system:paystack-receipt:v1');
  expect(after.journalRow!.status).toBe('posted');
  expect(after.journalRow!.fiscal_period_id).toBeTruthy();

  const lines = await journalLines(String(after.journalRow!.id));
  const debits = lines.reduce((t, l) => t + l.debit, 0);
  const credits = lines.reduce((t, l) => t + l.credit, 0);
  expect(debits).toBeCloseTo(credits, 2);
  expect(debits).toBeCloseTo(expectedRand, 2);
  // DR Bank / CR Receivable, for exactly what the invoice records as paid.
  const bank = lines.find((l) => l.gl_account_id === bankAccountId);
  const ar = lines.find((l) => l.gl_account_id === arAccountId);
  expect(bank?.debit).toBeCloseTo(expectedRand, 2);
  expect(ar?.credit).toBeCloseTo(expectedRand, 2);
  expect(Number(after.invoice.amount_paid)).toBeCloseTo(expectedRand, 2);
  return after;
}

describe('K-036 Paystack invoice payments never reach the general ledger', () => {
  it('webhook: posts DR Bank / CR Receivable alongside the subledger write', async () => {
    const reference = 'k036_webhook_ref';
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference);
    expect(result.state.statusCode).toBe(200);

    const after = await expectBalancedReceipt(INVOICE_TOTAL);
    expect(after.invoice.status).toBe('paid');
    expect(after.paymentRow!.bank_reference).toBe(reference);
  });

  it('verify route: same ledger posting on the return-page fallback', async () => {
    const reference = 'k036_verify_ref';
    await seedPaymentRequest(reference);
    verifyTransaction.mockResolvedValue({
      status: 'success', id: 555000111, channel: 'card',
      authorization: { authorizationCode: 'AUTH_k036' },
    });

    const result = await callVerify(reference);
    expect(result.state.statusCode).toBe(200);
    expect(verifyTransaction).toHaveBeenCalledWith(reference);

    await expectBalancedReceipt(INVOICE_TOTAL);
  });

  it('records the receipt once when the verify route and the webhook both fire', async () => {
    const reference = 'k036_both_ref';
    await seedPaymentRequest(reference);
    verifyTransaction.mockResolvedValue({
      status: 'success', id: 555000222, channel: 'card',
      authorization: { authorizationCode: 'AUTH_k036b' },
    });

    await callVerify(reference);
    await deliverWebhook(reference);

    // Idempotent on the Paystack reference: one payment, one journal, and the
    // invoice is not double-credited.
    await expectBalancedReceipt(INVOICE_TOTAL);
  });

  it('records the receipt once across a webhook redelivery', async () => {
    const reference = 'k036_retry_ref';
    await seedPaymentRequest(reference);

    await deliverWebhook(reference);
    const second = await deliverWebhook(reference);
    expect(second.state.statusCode).toBe(200);

    await expectBalancedReceipt(INVOICE_TOTAL);
  });

  it('posts only the part-payment when the gateway settles less than the invoice', async () => {
    const reference = 'k036_partial_ref';
    const partialCents = 40000;
    await pool.query(
      `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,
         paystack_reference,amount_cents,status)
       VALUES($1,'customer_invoice',$2,$3,$4,'pending')`,
      [companyId, invoiceId, reference, partialCents],
    );

    const result = await deliverWebhook(reference);
    expect(result.state.statusCode).toBe(200);

    const after = await expectBalancedReceipt(partialCents / 100);
    expect(after.invoice.status).toBe('partially_paid');
  });

  it('does not touch another tenant\'s invoice with the same reference', async () => {
    const otherCompanyId = crypto.randomUUID();
    const reference = 'k036_tenant_ref';
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompanyId, 'K-036 other tenant']);
    try {
      await seedPaymentRequest(reference);
      await deliverWebhook(reference);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM customer_payments WHERE company_id=$1`,
        [otherCompanyId],
      );
      expect(rows[0].n).toBe(0);
      const { rows: jRows } = await pool.query(
        `SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1`,
        [otherCompanyId],
      );
      expect(jRows[0].n).toBe(0);
      await expectBalancedReceipt(INVOICE_TOTAL);
    } finally {
      await pool.query('DELETE FROM companies WHERE id=$1', [otherCompanyId]);
    }
  });
});
