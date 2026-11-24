/**
 * Intercompany F (k) H-3 / Q1 / M-4: the confirm gate on an F draft, the discard (D4) and the payer's unsent read. Confirming an IC draft is R's
 * normal receipt Confirm (DR bank / CR AR) and posts only while the message is `target_ok` with this draft as target; a normal draft carrying
 * `IC:<m>` is refused at create and at confirm. Discarding cancels the draft and returns the message to `pending` with no target (one audit row);
 * the invoice is open again. P lists a cash-paid linked bill that has no message of either kind; R and C list nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import createRoute from '../../../pages/api/accounting/customer-payments';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { runIntegrityChecks } from '../../../src/modules/accounting/services/gl/integrityChecks';
import { partyLedgerCheckTool } from '../../../src/lib/mcp/tools/partyLedgerCheck';
import { asAppUser, count, tokens, withoutTrigger } from './intercompany.helpers';
import { asService, mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments, plantBill, plantPaid } from './allocation.helpers';
import {
  cashConnect, clearReceipts, co, connectBC, dataOf, draftBody, errorText, offeredOf, party, payApi, paymentSetup, plantReceipt, rbank, rows, sentPayment, U,
} from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

async function drafted() {
  const s = await sentPayment(pool, conn);
  const res = await payApi.accept(U.a, co.A, s.message, draftBody(s, {}, await offeredOf(s.message)));
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return { ...s, draft: dataOf<{ receiptId: string }>(res).receiptId };
}
const receiptStatus = async (id: string) => String((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [id])).rows[0].status);

describe('the confirm gate', () => {
  it('the creator, and another approver, confirm an IC draft whose message is target_ok: DR bank / CR AR posts', async () => {
    for (const user of [U.a, U.ab]) {
      const d = await drafted();
      const before = await rows.journals(pool, co.A);
      const res = await payApi.confirmReceipt(user, co.A, d.draft);
      expect(res.state.statusCode, errorText(res)).toBe(200);
      expect(await receiptStatus(d.draft)).toBe('confirmed');
      expect(await rows.journals(pool, co.A)).toBe(before + 1);
      expect(await rows.open(pool, d.invoice)).toBeCloseTo(0, 2);
    }
  });

  it("refused (nothing written) with the receiver's flag off, the payer gone or the link gone", async () => {
    const breakers: [string, (d: Awaited<ReturnType<typeof drafted>>) => Promise<unknown>, () => Promise<unknown>][] = [
      ['flag off', () => setLoanClearing(pool, [co.A], false), () => setLoanClearing(pool, [co.A], true)],
      ['payer gone', (d) => pool.query("UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1", [d.payment]), async () => undefined],
      ['link gone', (d) => withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard',
        (q) => q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [d.link])), async () => undefined],
    ];
    for (const [name, breakIt, mend] of breakers) {
      const d = await drafted();
      await breakIt(d);
      const before = await rows.journals(pool, co.A);
      const res = await payApi.confirmReceipt(U.a, co.A, d.draft);
      expect(res.state.statusCode, name).toBeGreaterThanOrEqual(400);
      expect(await receiptStatus(d.draft), name).toBe('draft');
      expect(await rows.journals(pool, co.A), name).toBe(before);
      await mend();
    }
  });

  it('a normal draft carrying IC:<m> is refused at create, and (planted past the create) at confirm', async () => {
    const s = await sentPayment(pool, conn);
    const res = await callRoute(createRoute, tokens[U.a]!, co.A, 'POST', {
      clientId: party.aCustomer, paymentDate: '2026-09-02', totalAmount: 1150, paymentMethod: 'eft', bankReference: `IC:${s.message}`,
      bankAccountId: rbank.a, allocations: [{ invoiceId: s.invoice, amount: 1150 }],
    }, '/api/accounting/customer-payments');
    expect(res.state.statusCode).toBe(400);
    expect(await count(pool, "SELECT count(*) AS n FROM customer_payments WHERE company_id = $1 AND bank_reference LIKE 'IC:%'", [co.A])).toBe(0);
    const forged = await plantReceipt(pool, { status: 'draft', bankReference: `IC:${s.message}`, createdBy: U.a, alloc: [{ invoice: s.invoice, amount: 1150 }] });
    expect((await payApi.confirmReceipt(U.a, co.A, forged)).state.statusCode).toBeGreaterThanOrEqual(400);
    expect(await receiptStatus(forged)).toBe('draft');
  });
});

describe('discard (D4)', () => {
  it('cancels the draft, returns the message to pending with no target, reopens the invoice, one audit row; a re-accept drafts again', async () => {
    const d = await drafted();
    const res = await payApi.discard(U.a, co.A, d.message, { paymentId: d.draft, reason: 'wrong bank account' });
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(await receiptStatus(d.draft)).toBe('cancelled');
    expect(await rows.message(pool, d.message)).toMatchObject({ status: 'pending', target_doc_type: null, target_doc_id: null, handled_by: null, manual_only: true });
    expect(await count(pool, `SELECT count(*) AS n FROM audit_log WHERE company_id = $1 AND entity_id = $2 AND entity_type = 'customer_payment' AND action = 'update'
                               AND changes -> 'metadata' ->> 'event' = 'ic_payment_draft_discarded' AND changes -> 'metadata' ->> 'messageId' = $3`, [co.A, d.draft, d.message])).toBe(1);
    const again = await payApi.accept(U.a, co.A, d.message, draftBody(d, { bankAccountId: rbank.a2 }, await offeredOf(d.message)));
    expect(again.state.statusCode, errorText(again)).toBe(200);
  });

  it('refuses a confirmed draft (not_draft), a receipt that is not the message\'s IC draft, and a user without Approve; nothing written', async () => {
    const d = await drafted();
    expect((await payApi.confirmReceipt(U.a, co.A, d.draft)).state.statusCode).toBe(200);
    const confirmed = await payApi.discard(U.a, co.A, d.message, { paymentId: d.draft, reason: 'x' });
    expect(confirmed.state.statusCode).toBe(409);
    expect(await receiptStatus(d.draft)).toBe('confirmed');
    const e = await drafted();
    const other = await plantReceipt(pool, { status: 'draft' });
    expect((await payApi.discard(U.a, co.A, e.message, { paymentId: other, reason: 'x' })).state.statusCode).toBe(409);
    expect((await payApi.discard(U.mab, co.A, e.message, { paymentId: e.draft, reason: 'x' })).state.statusCode).toBe(403);
    expect((await payApi.discard(U.b, co.B, e.message, { paymentId: e.draft, reason: 'x' })).state.statusCode).toBe(404);
    expect(await receiptStatus(e.draft)).toBe('draft');
    expect((await rows.message(pool, e.message)).status).toBe('accepted');
  });

  it('D4 itself refuses a user without Approve on Customers & AR and a viewer (forbidden), whatever the route did', async () => {
    const e = await drafted();
    for (const user of [U.mab, U.va]) {
      const r = await asAppUser(pool, user, co.A, async (q) => (await q.query('SELECT ok, reason FROM public.intercompany_discard_payment_draft($1, $2, $3)', [e.message, e.draft, 'x'])).rows[0]);
      expect(r, user).toEqual({ ok: false, reason: 'forbidden' });
    }
    expect(await receiptStatus(e.draft)).toBe('draft');
  });

  it('a concurrent confirm and discard end with exactly one outcome', async () => {
    const d = await drafted();
    const [c, x] = await Promise.all([payApi.confirmReceipt(U.ab, co.A, d.draft), payApi.discard(U.a, co.A, d.message, { paymentId: d.draft, reason: 'race' })]);
    const ok = [c.state.statusCode, x.state.statusCode].filter((n) => n === 200).length;
    expect(ok).toBe(1);
    const st = await receiptStatus(d.draft);
    expect(['confirmed', 'cancelled']).toContain(st);
    expect((await rows.message(pool, d.message)).status).toBe(st === 'confirmed' ? 'accepted' : 'pending');
  });

  it('after a discard every integrity check and the party ledger check are as clean as before: no journal, no allocation counted as pending', async () => {
    const d = await drafted();
    const integrity = () => asService(pool, U.a, co.A, () => runIntegrityChecks(co.A, { asAt: '2026-12-31' }));
    const ctx = { companyId: co.A, userId: U.a, scopes: ['read:reports', 'read:invoices'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const ledger = () => asService(pool, U.a, co.A, () => partyLedgerCheckTool.handler({ party_type: 'customer', party_id: party.aCustomer, as_at: '2026-12-31', detail: 'full' }, ctx as never))
      .then((x) => JSON.stringify(x));
    const before = { checks: await integrity(), ledger: await ledger() };
    expect((await payApi.discard(U.a, co.A, d.message, { paymentId: d.draft, reason: 'clean' })).state.statusCode).toBe(200);
    const after = await integrity();
    expect(after.failingRowsTotal).toBe(before.checks.failingRowsTotal);
    expect(after.checksErrored).toEqual(before.checks.checksErrored);
    expect(await ledger()).not.toMatch(/cancelled_payment_journal_stands/);
    expect(await count(pool, "SELECT count(*) AS n FROM customer_payments WHERE id = $1 AND gl_journal_entry_id IS NULL AND status = 'cancelled'", [d.draft])).toBe(1);
    expect(await count(pool, `SELECT count(*) AS n FROM customer_payment_allocations a JOIN customer_payments p ON p.id = a.payment_id
                               WHERE a.invoice_id = $1 AND p.status = 'draft'`, [d.invoice])).toBe(0);
  });
});

describe('the payer\'s unsent read', () => {
  it('lists a cash-paid linked bill that has no message; the receiver and the third company see nothing', async () => {
    const b = await plantBill(pool, conn);
    const p = await plantPaid(pool, b.bill);                                                   // no message: the flag was off at send
    await connectBC(pool);
    const res = await payApi.unsent(U.b, co.B);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(dataOf<{ state: string; items: { allocationId: string }[] }>(res)).toMatchObject({ state: 'ok', items: [{ allocationId: p.allocation }] });
    for (const [user, company] of [[U.a, co.A], [U.c, co.C]] as const) {
      const other = dataOf<{ items: unknown[] }>(await payApi.unsent(user, company));
      expect(other.items, company).toHaveLength(0);
    }
  });

  it('cannot_determine (with a sentence) when the payer has an active cash group connection but no current group membership it can see', async () => {
    await pool.query('ALTER TABLE company_group_members DISABLE TRIGGER trg_intercompany_group_membership');
    try {
      await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
      const res = dataOf<{ state: string; sentence: string | null; items: unknown[] }>(await payApi.unsent(U.b, co.B));
      expect(res.state).toBe('cannot_determine');
      expect(res.sentence).toMatch(/cannot be checked/);
      expect(res.items).toEqual([]);
    } finally {
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
      await pool.query('ALTER TABLE company_group_members ENABLE ALWAYS TRIGGER trg_intercompany_group_membership');
    }
  });

  it('flag off is 403; a viewer is 403', async () => {
    await setLoanClearing(pool, [co.B], false);
    expect((await payApi.unsent(U.b, co.B)).state.statusCode).toBe(403);
    await setLoanClearing(pool, [co.B], true);
    expect((await payApi.unsent(U.avb, co.B)).state.statusCode).toBe(403);
  });
});

describe('the receipt chip', () => {
  it('a receipt a payment message targets says the state word; another says nothing', async () => {
    const d = await drafted();
    expect(dataOf<{ messageId: string; state: string } | null>(await payApi.receiptState(U.a, co.A, d.draft))).toMatchObject({ messageId: d.message, state: 'target_ok' });
    const plain = await plantReceipt(pool, { bankReference: `IC:${d.message}` });
    expect(dataOf(await payApi.receiptState(U.a, co.A, plain))).toBeNull();
  });
});
