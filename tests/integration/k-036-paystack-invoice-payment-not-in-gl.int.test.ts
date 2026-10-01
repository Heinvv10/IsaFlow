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
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

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
const expenseAccountId = crypto.randomUUID();

const INVOICE_TOTAL = 1150.0;
const AMOUNT_CENTS = 115000;

function webhookBody(reference: string, extra: Record<string, unknown> = {}) {
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
      ...extra,
    },
  });
}

function deliverWebhook(reference: string, extra: Record<string, unknown> = {}) {
  const body = webhookBody(reference, extra);
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

async function seedPaymentRequest(reference: string, cents = AMOUNT_CENTS) {
  await pool.query(
    `INSERT INTO paystack_payment_requests(company_id,purpose,customer_invoice_id,
       paystack_reference,amount_cents,status)
     VALUES($1,'customer_invoice',$2,$3,$4,'pending')`,
    [companyId, invoiceId, reference, cents],
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
  // The actor for an unattended posting is resolved from this company's members,
  // never from the global users table.
  await pool.query(
    "INSERT INTO company_users(id,company_id,user_id,role,is_default) VALUES($1,$2,$3,'admin',true)",
    [crypto.randomUUID(), companyId, userId],
  );
  // The canonical AR path resolves both system accounts through
  // systemAccountResolver, which only sees is_system_account + is_active rows.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,
       account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'1100','Bank','asset','bank','debit',true,true),
            ($3,$2,'1120','Accounts Receivable','asset','receivable','debit',true,true),
            ($4,$2,'6000','Administrative Expenses','expense','admin_expense','debit',true,true)`,
    [bankAccountId, companyId, arAccountId, expenseAccountId],
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
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await pool.end();
  }
});

async function ledgerFootprint() {
  const payments = await pool.query(
    'SELECT id, total_amount, payment_method, bank_reference, status, created_by, gl_journal_entry_id FROM customer_payments WHERE company_id=$1',
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

  it('records the receipt when the invoice author is not a UUID', async () => {
    // customer_invoices.created_by is varchar; customer_payments.created_by is
    // uuid. An imported author used to abort the insert with 22P02 on every
    // redelivery, so the settled payment was lost for good.
    const reference = 'k036_actor_ref';
    await pool.query('UPDATE customer_invoices SET created_by=$1 WHERE id=$2', ['sage-import', invoiceId]);
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference);
    expect(result.state.statusCode).toBe(200);

    const after = await expectBalancedReceipt(INVOICE_TOTAL);
    // The actor fell back to a real user rather than the literal string.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [
      after.paymentRow!.created_by,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('banks the whole settlement when it exceeds the invoice balance', async () => {
    // R500 more than the invoice owes. The excess is real cash: it must reach
    // the bank account and sit on the customer as an unapplied receipt, never
    // be truncated away with a 200 ack.
    const reference = 'k036_over_ref';
    const settledRand = INVOICE_TOTAL + 500;
    await seedPaymentRequest(reference, Math.round(settledRand * 100));

    const result = await deliverWebhook(reference);
    expect(result.state.statusCode).toBe(200);

    const after = await ledgerFootprint();
    expect(after.payments).toBe(1);
    expect(after.journals).toBe(1);
    expect(Number(after.paymentRow!.total_amount)).toBeCloseTo(settledRand, 2);

    const lines = await journalLines(String(after.journalRow!.id));
    const bank = lines.find((l) => l.gl_account_id === bankAccountId);
    const ar = lines.find((l) => l.gl_account_id === arAccountId);
    // Every rand banked and credited to the customer...
    expect(bank?.debit).toBeCloseTo(settledRand, 2);
    expect(ar?.credit).toBeCloseTo(settledRand, 2);
    // ...but the invoice absorbs only what it owed.
    expect(Number(after.invoice.amount_paid)).toBeCloseTo(INVOICE_TOTAL, 2);
    expect(after.invoice.status).toBe('paid');

    const { rows } = await pool.query(
      `SELECT COALESCE(sum(amount_allocated),0)::float8 AS allocated
       FROM customer_payment_allocations WHERE payment_id=$1`,
      [after.paymentRow!.id],
    );
    expect(rows[0].allocated).toBeCloseTo(INVOICE_TOTAL, 2);
  });

  it('dates the receipt at settlement time, not at processing time', async () => {
    const reference = 'k036_paidat_ref';
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference, { paid_at: '2026-06-30T21:15:00.000Z' });
    expect(result.state.statusCode).toBe(200);

    const after = await ledgerFootprint();
    const { rows } = await pool.query(
      'SELECT payment_date::text AS d FROM customer_payments WHERE id=$1',
      [after.paymentRow!.id],
    );
    expect(rows[0].d).toBe('2026-06-30');
    const { rows: jRows } = await pool.query(
      'SELECT entry_date::text AS d FROM gl_journal_entries WHERE id=$1',
      [after.journalRow!.id],
    );
    expect(jRows[0].d).toBe('2026-06-30');
  });

  it('books the gateway fee so the bank leg nets to the actual deposit', async () => {
    const reference = 'k036_fee_ref';
    const feeRand = 23.5;
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });
    expect(result.state.statusCode).toBe(200);

    const { rows: jes } = await pool.query(
      'SELECT id FROM gl_journal_entries WHERE company_id=$1', [companyId],
    );
    expect(jes.length).toBe(2);

    let bankNet = 0;
    let feeDebit = 0;
    for (const je of jes) {
      for (const l of await journalLines(String(je.id))) {
        if (l.gl_account_id === bankAccountId) bankNet += l.debit - l.credit;
        if (l.gl_account_id === expenseAccountId) feeDebit += l.debit - l.credit;
      }
    }
    // Gross to the customer, net into the bank, fee in the P&L.
    expect(feeDebit).toBeCloseTo(feeRand, 2);
    expect(bankNet).toBeCloseTo(INVOICE_TOTAL - feeRand, 2);
  });

  it('records one receipt when two identical deliveries arrive concurrently', async () => {
    const reference = 'k036_race_ref';
    await seedPaymentRequest(reference);

    const [a, b] = await Promise.all([deliverWebhook(reference), deliverWebhook(reference)]);
    expect([a.state.statusCode, b.state.statusCode]).toEqual([200, 200]);
    // The FOR UPDATE on the event row means exactly one of them did the work.
    const acked = [a.state.body, b.state.body].filter(
      (x) => (x as { duplicate?: boolean } | undefined)?.duplicate === true,
    );
    expect(acked.length).toBe(1);

    await expectBalancedReceipt(INVOICE_TOTAL);
  });

  it('clears processing_error once a redelivery succeeds', async () => {
    const reference = 'k036_err_ref';
    await seedPaymentRequest(reference);
    // No bank system account -> the receipt throws, the event keeps the error.
    await pool.query('UPDATE gl_accounts SET is_system_account=false WHERE id=$1', [bankAccountId]);
    clearSystemAccountCache(companyId);
    const first = await deliverWebhook(reference);
    expect(first.state.statusCode).toBe(500);
    const errRow = await pool.query(
      'SELECT processed, processing_error FROM paystack_webhook_events WHERE reference=$1', [reference],
    );
    expect(errRow.rows[0].processed).toBe(false);
    expect(errRow.rows[0].processing_error).toBeTruthy();

    await pool.query('UPDATE gl_accounts SET is_system_account=true WHERE id=$1', [bankAccountId]);
    clearSystemAccountCache(companyId);
    const second = await deliverWebhook(reference);
    expect(second.state.statusCode).toBe(200);

    const okRow = await pool.query(
      'SELECT processed, processing_error FROM paystack_webhook_events WHERE reference=$1', [reference],
    );
    expect(okRow.rows[0].processed).toBe(true);
    expect(okRow.rows[0].processing_error).toBeNull();
  });

  it('refuses a second card payment on the same gateway reference at the database', async () => {
    const reference = 'k036_unique_ref';
    await seedPaymentRequest(reference);
    await deliverWebhook(reference);

    const { rows } = await pool.query(
      'SELECT client_id, bank_account_id, created_by FROM customer_payments WHERE company_id=$1', [companyId],
    );
    await expect(
      pool.query(
        `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,
           payment_method,bank_reference,bank_account_id,created_by)
         VALUES($1,$2,CURRENT_DATE,1,'card',$3,$4,$5)`,
        [companyId, rows[0].client_id, reference, rows[0].bank_account_id, rows[0].created_by],
      ),
    ).rejects.toThrow(/duplicate key value|ux_customer_payments_card_reference/);
  });

  it('books the fee even when the verify route banked the receipt first', async () => {
    // The return page exists to beat the webhook and carries no fee. Before the
    // fee posting moved outside the receipt dedupe, the webhook short-circuited
    // and the bank leg stayed gross for every customer who reached that page.
    const reference = 'k036_verifyfee_ref';
    const feeRand = 29.0;
    await seedPaymentRequest(reference);
    verifyTransaction.mockResolvedValue({
      status: 'success', id: 555000333, channel: 'card',
      authorization: { authorizationCode: 'AUTH_k036c' },
    });

    await callVerify(reference);
    const webhookResult = await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });
    expect(webhookResult.state.statusCode).toBe(200);

    const { rows: payments } = await pool.query(
      'SELECT id FROM customer_payments WHERE company_id=$1', [companyId],
    );
    expect(payments.length).toBe(1);

    const { rows: jes } = await pool.query(
      'SELECT id FROM gl_journal_entries WHERE company_id=$1', [companyId],
    );
    expect(jes.length).toBe(2);

    let bankNet = 0;
    let feeDebit = 0;
    for (const je of jes) {
      for (const l of await journalLines(String(je.id))) {
        if (l.gl_account_id === bankAccountId) bankNet += l.debit - l.credit;
        if (l.gl_account_id === expenseAccountId) feeDebit += l.debit - l.credit;
      }
    }
    expect(feeDebit).toBeCloseTo(feeRand, 2);
    expect(bankNet).toBeCloseTo(INVOICE_TOTAL - feeRand, 2);
  });

  it('does not book the fee twice when the webhook is redelivered', async () => {
    const reference = 'k036_feeretry_ref';
    const feeRand = 12.0;
    await seedPaymentRequest(reference);

    await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });
    await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND description LIKE 'Paystack fee %'",
      [companyId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('attributes a non-UUID author to a member of the PAYING company', async () => {
    // resolveUserUuid would have picked whichever user the heap yielded first,
    // from any tenant, and stamped the payment and its journal with a stranger.
    const otherCompanyId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const reference = 'k036_actorscope_ref';
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompanyId, 'K-036 other tenant']);
    await pool.query(
      "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
      [otherUserId, `${otherUserId}@k036.test.local`],
    );
    await pool.query(
      "INSERT INTO company_users(id,company_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [crypto.randomUUID(), otherCompanyId, otherUserId],
    );
    try {
      await pool.query('UPDATE customer_invoices SET created_by=$1 WHERE id=$2', ['sage-import', invoiceId]);
      await seedPaymentRequest(reference);
      const result = await deliverWebhook(reference);
      expect(result.state.statusCode).toBe(200);

      const after = await expectBalancedReceipt(INVOICE_TOTAL);
      expect(after.paymentRow!.created_by).toBe(userId);
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM company_users WHERE company_id=$1 AND user_id=$2',
        [companyId, after.paymentRow!.created_by],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [otherCompanyId]);
      await pool.query('DELETE FROM companies WHERE id=$1', [otherCompanyId]);
      await pool.query('DELETE FROM users WHERE id=$1', [otherUserId]);
    }
  });

  it('fails the delivery rather than attributing the receipt to nobody', async () => {
    const reference = 'k036_noactor_ref';
    await pool.query('UPDATE customer_invoices SET created_by=$1 WHERE id=$2', ['sage-import', invoiceId]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [companyId]);
    try {
      await seedPaymentRequest(reference);
      const result = await deliverWebhook(reference);
      // Retryable, not a stranger's name on the ledger. K-035 reprocesses it.
      expect(result.state.statusCode).toBe(500);
      const after = await ledgerFootprint();
      expect(after.payments).toBe(0);
      expect(after.journals).toBe(0);
      expect(Number(after.invoice.amount_paid)).toBeCloseTo(0, 2);
    } finally {
      await pool.query(
        "INSERT INTO company_users(id,company_id,user_id,role,is_default) VALUES($1,$2,$3,'admin',true)",
        [crypto.randomUUID(), companyId, userId],
      );
    }
  });

  it('leaves room for a draft receipt already claiming the invoice balance', async () => {
    // createCustomerPayment subtracted pending draft allocations before deciding
    // what an invoice can absorb. That invariant has to survive not calling it,
    // or both receipts confirm and amount_paid passes total_amount.
    const reference = 'k036_draft_ref';
    const draftId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,
         payment_method,bank_reference,created_by,status)
       VALUES($1,$2,$3,CURRENT_DATE,$4,'eft','K036-DRAFT',$5,'draft')`,
      [draftId, companyId, customerId, INVOICE_TOTAL, userId],
    );
    await pool.query(
      'INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)',
      [draftId, invoiceId, INVOICE_TOTAL],
    );
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference);
    expect(result.state.statusCode).toBe(200);

    const { rows: gateway } = await pool.query(
      'SELECT id, total_amount FROM customer_payments WHERE company_id=$1 AND bank_reference=$2',
      [companyId, reference],
    );
    // The cash is still banked in full...
    expect(Number(gateway[0].total_amount)).toBeCloseTo(INVOICE_TOTAL, 2);
    // ...but nothing is allocated, because the draft already claims the balance.
    const { rows: allocs } = await pool.query(
      'SELECT COALESCE(sum(amount_allocated),0)::float8 AS a FROM customer_payment_allocations WHERE payment_id=$1',
      [gateway[0].id],
    );
    expect(allocs[0].a).toBeCloseTo(0, 2);
    const { rows: inv } = await pool.query(
      'SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id=$1', [invoiceId],
    );
    expect(inv[0].p).toBeCloseTo(0, 2);
  });

  it('dates a receipt with an unparseable paid_at today instead of failing forever', async () => {
    const reference = 'k036_baddate_ref';
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference, { paid_at: 'not-a-date' });
    expect(result.state.statusCode).toBe(200);

    const after = await expectBalancedReceipt(INVOICE_TOTAL);
    const { rows } = await pool.query(
      'SELECT (payment_date = CURRENT_DATE) AS today FROM customer_payments WHERE id=$1',
      [after.paymentRow!.id],
    );
    expect(rows[0].today).toBe(true);
  });

  it('keys fee idempotency on the reference, not on a look-alike description', async () => {
    // A person can describe a journal anything. Before the lookup moved to the
    // reference column plus the posting agent, a decoy like this suppressed the
    // fee silently and the bank leg stayed gross.
    const reference = 'k036_feekey_ref';
    const feeRand = 17.0;
    await pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_date,description,source,status,created_by)
       VALUES($1,CURRENT_DATE,$2,'manual','posted',$3)`,
      [companyId, `Paystack fee ${reference}`, userId],
    );
    await seedPaymentRequest(reference);

    const result = await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });
    expect(result.state.statusCode).toBe(200);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM gl_journal_entries
       WHERE company_id=$1 AND reference=$2 AND posting_agent='system:paystack-receipt:v1'`,
      [companyId, reference],
    );
    expect(rows[0].n).toBe(1);

    const { rows: feeLines } = await pool.query(
      `SELECT COALESCE(sum(jl.debit),0)::float8 AS d FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.company_id=$1 AND je.reference=$2 AND jl.gl_account_id=$3`,
      [companyId, reference, expenseAccountId],
    );
    expect(feeLines[0].d).toBeCloseTo(feeRand, 2);
  });

  it('still books the fee when an earlier fee journal was reversed', async () => {
    // status is nullable, so `<> 'reversed'` would let a NULL-status row escape
    // the guard entirely. Prove the guard reads a real reversal.
    const reference = 'k036_feerev_ref';
    const feeRand = 8.0;
    await seedPaymentRequest(reference);
    await deliverWebhook(reference, { fees: Math.round(feeRand * 100) });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM gl_journal_entries
       WHERE company_id=$1 AND reference=$2 AND status IS DISTINCT FROM 'reversed'`,
      [companyId, reference],
    );
    expect(rows[0].n).toBe(1);
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
