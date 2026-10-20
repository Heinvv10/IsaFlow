/**
 * AR audit 2026-10-18, B1 + B2 — a receipt must never push an invoice past its total.
 *
 * B1  `confirmCustomerPayment` added each stored draft allocation to `amount_paid` with no invoice
 *     lock and no outstanding re-check, while every other applier (bank-line match, apply an unapplied
 *     receipt, FIFO) computes outstanding as `total - amount_paid` and never sees drafts. A draft for the
 *     full balance, the invoice paid by another path, then Confirm: `amount_paid` = 2x total, AR credited twice.
 * B2  `createCustomerPayment` (and so `settle_by_contra`, which creates and confirms in one call) read the
 *     invoice and the pending drafts without `FOR UPDATE`, so two concurrent requests both passed the balance
 *     check and both created/confirmed.
 *
 * Every assertion is on the OUTCOME: the invoice's final `amount_paid` and the AR-control credits actually
 * posted to the ledger. The window is opened with the sql-wrapper pattern (r129/r193): the first request to
 * read the pending drafts is parked there (after its balance check, before its write); the second is started
 * and released-against only once it has finished or is waiting on the invoice lock. Real handlers, real
 * services, real Postgres (disposable fixture DB only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, confirmMatch, seedBankLine, seedInvoice, seedK074, type K074Fixture,
} from './helpers/k074Fixture';

type Park = { entered: () => void; hold: Promise<void> };
const hooks = vi.hoisted(() => ({ park: null as null | { entered: () => void; hold: Promise<void> }, fired: 0 }));

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  // The pending-drafts read of createCustomerPayment: the last statement of its balance check.
  const isPendingRead = (text: string) => /^\s*SELECT/.test(text)
    && text.includes('SUM(cpa.amount_allocated)') && text.includes("cp.status = 'draft'");
  // Unmatched statements get the real lazy query back untouched; Object.assign keeps `transaction` etc.
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const park = hooks.park;
    if (!park || !isPendingRead(strings.join('?'))) return realSql(strings, ...values);
    hooks.park = null;
    hooks.fired += 1;
    return (async () => {
      const read = await realSql(strings, ...values);
      park.entered();
      await park.hold;
      return read;
    })();
  }, realSql);
  return { ...real, sql };
});

import { als } from '@/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { settleByContraTool } from '../../src/lib/mcp/tools/writeSettleByContra';
import createPayment from '../../pages/api/accounting/customer-payments';
import paymentAction from '../../pages/api/accounting/customer-payments-action';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fx: K074Fixture;

beforeEach(async () => { fx = await seedK074(pool); hooks.fired = 0; });
afterEach(async () => { hooks.park = null; await cleanupK074(pool, fx); });

type Handler = (req: NextApiRequest, res: unknown) => Promise<unknown>;

/** Run a route the way withAuth does: one transaction on the ALS client, COMMIT below 500. */
async function call(handler: unknown, body: unknown) {
  const result = response();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      await (handler as Handler)({
        method: 'POST', body, companyId: fx.company, user: { id: fx.user },
      } as unknown as NextApiRequest, result.res);
    });
    await client.query(result.state.statusCode < 500 ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
  return { status: result.state.statusCode, body: result.state.body as { data?: { id?: string }; error?: { message?: string } } };
}

const createFor = (invoiceId: string, amount: number) => call(createPayment, {
  clientId: fx.customer, paymentDate: '2026-05-15', totalAmount: amount, paymentMethod: 'eft',
  bankAccountId: fx.bankAccount, allocations: [{ invoiceId, amount }],
});
const confirm = (paymentId: string) => call(paymentAction, { action: 'confirm', paymentId });

async function amountPaid(invoiceId: string): Promise<number> {
  const { rows } = await pool.query('SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id=$1', [invoiceId]);
  return rows[0].p as number;
}
/** What the ledger credited to the AR control account: the figure that must equal what the invoice absorbed. */
async function arCredits(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.credit), 0)::float8 AS c FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND l.gl_account_id = $2`, [fx.company, fx.arAccount]);
  return rows[0].c as number;
}
async function paymentIds(): Promise<string[]> {
  const { rows } = await pool.query('SELECT id FROM customer_payments WHERE company_id=$1 ORDER BY created_at', [fx.company]);
  return rows.map((r) => String(r.id));
}

/** 'waiting' once a backend of this database waits on a lock while running a statement over `table`. */
async function waitsOnLock(table: string): Promise<'waiting'> {
  for (let i = 0; i < 400; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [`%${table}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing finished and nothing waited on a ${table} lock`);
}

/**
 * Start `first` and park it after its balance check; start `second`; release `first` once `second` has finished
 * or is blocked on the invoice lock. Returns both results.
 */
async function raceTwo<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  let release!: () => void;
  let entered!: () => void;
  const gate: Park = {
    hold: new Promise<void>((r) => { release = r; }),
    entered: () => entered(),
  };
  const parked = new Promise<void>((r) => { entered = r; });
  hooks.park = gate;
  const firstP = first();
  await parked; // balance and pending drafts read; nothing written yet
  const secondP = second();
  let state: 'finished' | 'waiting';
  try {
    state = await Promise.race([secondP.then(() => 'finished' as const), waitsOnLock('customer_invoices')]);
  } finally {
    release();
  }
  const out = await Promise.all([firstP, secondP]);
  expect(hooks.fired).toBe(1); // the window really opened — the test is not vacuous
  expect(state).toBe('waiting'); // the second request queued behind the first's invoice lock
  return out;
}

describe('B1: confirming a draft receipt after the invoice was paid another way', () => {
  it('refuses, so the invoice absorbs the money once and AR is credited once', async () => {
    const invoice = await seedInvoice(pool, fx, 1000);
    const draft = await createFor(invoice, 1000);
    expect(draft.status).toBe(201);

    // Another path pays the whole invoice. It ignores drafts: it only reads total - amount_paid.
    const line = await seedBankLine(pool, fx, 1000);
    const paid = await confirmMatch(pool, fx, { bankTransactionId: line, candidateType: 'customer_invoice', candidateId: invoice });
    expect(paid.status).toBe(200);
    expect(await amountPaid(invoice)).toBe(1000);
    expect(await arCredits()).toBe(1000);

    const confirmed = await confirm(draft.body.data!.id!);

    expect(await amountPaid(invoice)).toBe(1000);
    expect(await arCredits()).toBe(1000);
    expect(confirmed.status).toBe(400);
    expect(confirmed.body.error?.message).toMatch(/exceeds invoice balance R0\.00/);
    const { rows } = await pool.query('SELECT status FROM customer_payments WHERE id=$1', [draft.body.data!.id]);
    expect(rows[0].status).toBe('draft'); // refused whole: the draft is still there to cancel
  });

  it('a draft that still fits confirms normally (partial application of what is left)', async () => {
    const invoice = await seedInvoice(pool, fx, 1000);
    const draft = await createFor(invoice, 400);
    const line = await seedBankLine(pool, fx, 600);
    await confirmMatch(pool, fx, { bankTransactionId: line, candidateType: 'customer_invoice', candidateId: invoice });

    const confirmed = await confirm(draft.body.data!.id!);

    expect(confirmed.status).toBe(200);
    expect(await amountPaid(invoice)).toBe(1000);
    expect(await arCredits()).toBe(1000);
  });
});

describe('B2: two concurrent receipts for the full balance', () => {
  it('POST /customer-payments x2, then confirm both: the invoice is paid once', async () => {
    const invoice = await seedInvoice(pool, fx, 1000);

    const [a, b] = await raceTwo(() => createFor(invoice, 1000), () => createFor(invoice, 1000));
    expect([a.status, b.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const id of await paymentIds()) await confirm(id);

    expect(await amountPaid(invoice)).toBe(1000);
    expect(await arCredits()).toBe(1000);
    // The loser is refused at CREATE, not left as a second draft that can never be confirmed.
    expect(await paymentIds()).toHaveLength(1);
  });
});

describe('B2: two concurrent settle_by_contra for the full balance', () => {
  it('settles once', async () => {
    const invoice = await seedInvoice(pool, fx, 1000);
    const contra = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES ($1,'DL001','Director loan','liability','credit',true,'other_current_liability') RETURNING id`,
      [fx.company])).rows[0].id as string;
    const registry = new McpRegistry();
    registry.register(settleByContraTool);
    const settle = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, () =>
          registry.call('settle_by_contra', {
            subledger: 'ar', document_id: invoice, contra_account_id: contra, amount: 1000,
            reason: 'B2 contra race', settlement_date: '2026-05-15', idempotency_key: crypto.randomUUID(),
          }, { userId: fx.user, companyId: fx.company, scopes: ['write:invoices', 'write:post'], tokenJti: 'ar-b2', oauthAppId: null }));
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    const [a, b] = await raceTwo(settle, settle);

    expect(await amountPaid(invoice)).toBe(1000);
    expect(await arCredits()).toBe(1000);
    expect([a.isError, b.isError].filter((e) => !e).length).toBe(1); // exactly one settlement succeeded
  });
});
