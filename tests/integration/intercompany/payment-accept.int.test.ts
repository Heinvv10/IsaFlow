/**
 * Intercompany F: the receiver's accept (`acceptPaymentMessage`, POST /payments/[id]/accept). `existing` writes ONLY the message row (accepted,
 * target = the receipt); `draft` writes exactly ONE draft receipt (`IC:<message>`) and its allocations, no journal in either company. Every
 * refusal is a plain 4xx from reads before any write and writes nothing; after the first write a failure is a 5xx and rolls back.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, Client } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { impersonationToken } from '../r035-pr2.helpers';
import { callRoute, reasonOf } from '../r035-approval.helpers';
import acceptRoute from '../../../pages/api/accounting/intercompany/payments/[id]/accept';
import { asAppUser, count } from './intercompany.helpers';
import { mirrorCleanup, plantArInvoice, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments } from './allocation.helpers';
import {
  cashConnect, clearReceipts, co, dataOf, draftBody, errorText, existingBody, offeredOf, payApi, paymentSetup, plantReceipt, rbank, rows, sentPayment, U,
} from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(async () => {
  await paymentSetup(pool);
  // the switch is a table's existence (pg_class is readable by every role), so app_user's request sees it without a grant
  await pool.query(`CREATE OR REPLACE FUNCTION public.ic_f_guard_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind = 'payment' AND NEW.status = 'accepted' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'ic_f_guard_on') THEN
      RAISE EXCEPTION 'forced guard' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER trg_zzz_ic_f_guard_fail BEFORE UPDATE ON intercompany_messages FOR EACH ROW EXECUTE FUNCTION public.ic_f_guard_fail()');
}, 60000);
afterAll(async () => {
  await pool.query('DROP TRIGGER IF EXISTS trg_zzz_ic_f_guard_fail ON intercompany_messages');
  await pool.query('DROP FUNCTION IF EXISTS public.ic_f_guard_fail()');
  await pool.query('DROP TABLE IF EXISTS public.ic_f_guard_on');
  await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});
afterEach(() => vi.restoreAllMocks());

const snapshot = async (s: { message: string }) => ({
  aj: await rows.journals(pool, co.A), bj: await rows.journals(pool, co.B), receipts: await rows.receipts(pool),
  allocs: await count(pool, 'SELECT count(*) AS n FROM customer_payment_allocations a JOIN customer_payments p ON p.id = a.payment_id WHERE p.company_id = $1', [co.A]),
  msg: await rows.message(pool, s.message),
});
async function refused(s: { message: string }, call: () => Promise<{ state: { statusCode: number; body: unknown } }>, status: number, text?: RegExp) {
  const before = await snapshot(s);
  const res = await call();
  expect(res.state.statusCode, errorText(res)).toBe(status);
  if (text) expect(errorText(res)).toMatch(text);
  expect(await snapshot(s)).toEqual(before);
  return res;
}

describe('existing: "this is my receipt"', () => {
  it('accepts with the receipt as target and writes nothing else (no journal, no allocation, the receipt untouched)', async () => {
    const s = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool);
    const before = await snapshot(s);
    const res = await payApi.accept(U.a, co.A, s.message, existingBody(s, receipt));
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(dataOf(res)).toMatchObject({ accepted: true, outcome: 'existing', receiptId: receipt });
    expect(await rows.message(pool, s.message)).toMatchObject({ status: 'accepted', target_doc_type: 'customer_payment', target_doc_id: receipt, handled_by: U.a });
    const after = await snapshot(s);
    expect({ ...after, msg: null }).toEqual({ ...before, msg: null });
  });

  it('a split payment: two messages consume one receipt up to its total; a third past it is refused (consumption)', async () => {
    const one = await sentPayment(pool, conn, { amount: 600 });
    const two = await sentPayment(pool, conn, { amount: 550 });
    const three = await sentPayment(pool, conn, { amount: 100 });
    const receipt = await plantReceipt(pool, { amount: 1150 });
    for (const s of [one, two]) expect((await payApi.accept(U.a, co.A, s.message, existingBody(s, receipt))).state.statusCode).toBe(200);
    await refused(three, () => payApi.accept(U.a, co.A, three.message, existingBody(three, receipt)), 422);
  });

  it('a receipt outside the candidate set or short is 422', async () => {
    const s = await sentPayment(pool, conn);
    for (const over of [{ amount: 500 }, { method: 'contra' }, { date: '2026-08-01' }, { status: 'draft' }]) {
      const receipt = await plantReceipt(pool, over);
      await refused(s, () => payApi.accept(U.a, co.A, s.message, existingBody(s, receipt)), 422);
    }
  });
});

describe('draft: "draft a receipt for it"', () => {
  it('writes one draft receipt IC:<message> allocated to the picked invoice, no journal anywhere', async () => {
    const s = await sentPayment(pool, conn);
    const before = await snapshot(s);
    const res = await payApi.accept(U.a, co.A, s.message, draftBody(s, {}, await offeredOf(s.message)));
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const after = await rows.receipts(pool);
    expect(after).toHaveLength(before.receipts.length + 1);
    const r = after.at(-1)!;
    expect(r).toMatchObject({ status: 'draft', total: 1150, bank_reference: `IC:${s.message}`, payment_method: 'eft', bank_account_id: rbank.a, date: '2026-09-02', created_by: U.a });
    expect(await rows.allocations(pool, r.id)).toEqual([{ invoice_id: s.invoice, amount: 1150 }]);
    expect(await rows.journals(pool, co.A)).toBe(before.aj);
    expect(await rows.journals(pool, co.B)).toBe(before.bj);
    expect(await rows.message(pool, s.message)).toMatchObject({ status: 'accepted', target_doc_id: r.id });
  });

  it('split over two invoices of the customer, summing exactly to the amount', async () => {
    const s = await sentPayment(pool, conn);
    const other = (await plantArInvoice(pool, { status: 'approved' })).id;
    const body = draftBody(s, { allocations: [{ invoiceId: s.invoice, amount: 1000 }, { invoiceId: other, amount: 150 }] }, await offeredOf(s.message));
    expect((await payApi.accept(U.a, co.A, s.message, body)).state.statusCode).toBe(200);
  });

  it('is refused while an exact existing candidate exists (Q2)', async () => {
    const s = await sentPayment(pool, conn);
    await plantReceipt(pool);
    expect(reasonOf(await refused(s, () => payApi.accept(U.a, co.A, s.message, draftBody(s)), 422))).toBe('draft_refused_exact');
  });

  it('each refusal from the request writes nothing', async () => {
    const s = await sentPayment(pool, conn);
    const pre = (await plantArInvoice(pool, { status: 'approved', date: '2025-12-01' })).id;
    const draftInv = (await plantArInvoice(pool, { status: 'draft' })).id;
    const cases: [string, Parameters<typeof draftBody>[1], number, string?][] = [
      ['partial amount', { allocations: [{ invoiceId: s.invoice, amount: 1000 }] }, 422, 'amount_sum'],
      ['fractional cents', { allocations: [{ invoiceId: s.invoice, amount: 1149.995 }] }, 422, 'amount_cents'],
      ['inactive bank account', { bankAccountId: rbank.aInactive }, 422, 'bank_account'],
      ['not a bank account', { bankAccountId: (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable'", [co.A])).rows[0].id }, 422, 'bank_account'],
      ['date before the payment', { paymentDate: '2026-08-31' }, 422, 'date_before_payment'],
      ['date after today', { paymentDate: '2099-01-01' }, 422, 'date_after_today'],
      ['pre-cut-over invoice', { allocations: [{ invoiceId: pre, amount: 1150 }] }, 422, 'pre_cutover_invoice'],
      ['draft (not open) invoice', { allocations: [{ invoiceId: draftInv, amount: 1150 }] }, 422, 'invoice_not_open'],
      ['expected amount differs', { expected: { amount: 1000, state: 'open', invoiceIds: [s.invoice] } }, 409],
      ['expected state differs', { expected: { amount: 1150, state: 'payer_gone', invoiceIds: [s.invoice] } }, 409],
      ['an invoice offered now that the person did not see', { expected: { amount: 1150, state: 'open', invoiceIds: [] } }, 409],
    ];
    const seen = await offeredOf(s.message);
    for (const [name, over, status, reason] of cases) {
      const res = await refused(s, () => payApi.accept(U.a, co.A, s.message, draftBody(s, { expected: { amount: 1150, state: 'open', invoiceIds: seen }, ...over })), status);
      expect(res.state.statusCode, name).toBe(status);
      if (reason) expect(reasonOf(res), name).toBe(reason);
    }
  });

  it('a locked or VAT-locked date is refused, never rolled forward', async () => {
    const s = await sentPayment(pool, conn);
    await pool.query("UPDATE fiscal_periods SET status = 'locked' WHERE company_id = $1", [co.A]);
    try {
      const res = await refused(s, async () => payApi.accept(U.a, co.A, s.message, draftBody(s, {}, await offeredOf(s.message))), 422, /period/i);
      expect(reasonOf(res)).toBe('period_locked');
    } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.A]);
    }
  });

  it('a forced guard refusal after the draft insert leaves no draft (5xx, rolled back)', async () => {
    const s = await sentPayment(pool, conn);
    const seen = await offeredOf(s.message);
    const before = await snapshot(s);
    await pool.query('CREATE TABLE IF NOT EXISTS public.ic_f_guard_on (x int)');
    try {
      const res = await payApi.accept(U.a, co.A, s.message, draftBody(s, {}, seen));
      expect(res.state.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await pool.query('DROP TABLE IF EXISTS public.ic_f_guard_on');
    }
    expect(await snapshot(s)).toEqual(before);
  });
});

describe('who may accept', () => {
  it("the receiver's flag off: 403 before anything", async () => {
    const s = await sentPayment(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    await refused(s, () => payApi.accept(U.a, co.A, s.message, draftBody(s)), 403);
  });

  it('impersonation, a viewer, a manager without create on receipts: 403; another company: 404; not pending: 409', async () => {
    const t = await sentPayment(pool, conn);
    await refused(t, async () => callRoute(acceptRoute, await impersonationToken(pool, U.a, U.ab), co.A, 'POST', draftBody(t),
      `/api/accounting/intercompany/payments/${t.message}/accept`, { id: t.message }), 403);
    await refused(t, () => payApi.accept(U.va, co.A, t.message, draftBody(t)), 403);
    await pool.query("UPDATE company_user_permissions SET can_write = false WHERE company_id = $1 AND user_id = $2 AND module_key = 'customers'", [co.A, U.mab]);
    try {
      await refused(t, () => payApi.accept(U.mab, co.A, t.message, draftBody(t)), 403);
    } finally {
      await pool.query("UPDATE company_user_permissions SET can_write = true WHERE company_id = $1 AND user_id = $2 AND module_key = 'customers'", [co.A, U.mab]);
    }
    await refused(t, () => payApi.accept(U.c, co.C, t.message, draftBody(t)), 404);
    expect((await payApi.accept(U.a, co.A, t.message, draftBody(t, {}, await offeredOf(t.message)))).state.statusCode).toBe(200);
    await refused(t, () => payApi.accept(U.a, co.A, t.message, draftBody(t)), 409);
  });
});

describe('the guard (a direct app_user UPDATE to accepted)', () => {
  const direct = (m: string, target: string | null) => asAppUser(pool, U.a, co.A, async (q) => {
    await q.query('SAVEPOINT x');
    try {
      await q.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2 WHERE id = $1", [m, target]);
      return 'ok';
    } catch (err) {
      return String((err as { code?: string }).code);
    }
  }, true);

  it('no target, a contra receipt, another customer\'s, a P4-D clearing receipt, past its total: 23514', async () => {
    const s = await sentPayment(pool, conn);
    const stranger = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [stranger, co.A, 'IC stranger 3']);
    const targets = [null, await plantReceipt(pool, { method: 'contra' }), await plantReceipt(pool, { client: stranger }),
      await plantReceipt(pool, { method: 'contra', bankReference: `IC:${crypto.randomUUID()}` }), await plantReceipt(pool, { amount: 1000 })];
    for (const t of targets) expect(await direct(s.message, t), String(t)).toBe('23514');
    expect((await rows.message(pool, s.message)).status).toBe('pending');
  });

  it('H-2: a normal draft forged with IC:<message> is refused when the payer voided, the flag is off, the link is gone or the payload is future-dated', async () => {
    const forged = async (s: { message: string }) => plantReceipt(pool, { status: 'draft', bankReference: `IC:${s.message}`, createdBy: U.a,
      alloc: [{ invoice: (s as unknown as { invoice: string }).invoice, amount: 1150 }] });
    const voided = await sentPayment(pool, conn);
    const r1 = await forged(voided);
    await pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [voided.payment]);
    expect(await direct(voided.message, r1)).toBe('23514');
    const off = await sentPayment(pool, conn);
    const r2 = await forged(off);
    expect(await direct(off.message, r2)).toBe('ok');                                          // the control: the forged draft passes while all holds
    const flag = await sentPayment(pool, conn);
    const r3 = await forged(flag);
    await setLoanClearing(pool, [co.A], false);
    expect(await direct(flag.message, r3)).toBe('23514');
    await setLoanClearing(pool, [co.A], true);
    const future = await sentPayment(pool, conn, { date: '2099-01-01' });
    expect(await direct(future.message, await plantReceipt(pool, { status: 'draft', bankReference: `IC:${future.message}`, createdBy: U.a, date: '2099-01-02' }))).toBe('23514');
  });
});

describe('suggestions read R\'s rows only', () => {
  it('no statement of the detail names a payer table or the payer\'s company id', async () => {
    const s = await sentPayment(pool, conn);
    await plantReceipt(pool);
    const seen: string[] = [];
    const orig = Client.prototype.query;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const [text, params] = args as [unknown, unknown];
      const t = typeof text === 'string' ? text : (text as { text?: string })?.text ?? '';
      seen.push(`${t} ${JSON.stringify(params ?? (text as { values?: unknown })?.values ?? null)}`);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof orig;
    try {
      expect((await payApi.get(U.a, co.A, s.message)).state.statusCode).toBe(200);
    } finally {
      Client.prototype.query = orig;
    }
    const payerTables = /\b(supplier_payments|payment_allocations|supplier_invoices|supplier_payment_batches)\b/;
    for (const line of seen) {
      expect(line, line.slice(0, 200)).not.toMatch(payerTables);
      expect(line, line.slice(0, 200)).not.toContain(co.B);
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});
