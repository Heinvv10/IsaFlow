/**
 * Intercompany P4-D, fix round 1: the 1027 guard, condition by condition (blind M2, breaker M4, F6). The exact clearing of a live message is
 * accepted by a direct UPDATE; each tamper of ONE condition is refused 23514: the receipt not confirmed, not contra, allocated to another invoice
 * of the right amount, its journal not posted, reversed, its credit not on the receivable control, debit and credit swapped, sharing the journal
 * of another accepted clearing, confirmed by someone else than the acting user, dated before the payment or the invoice, the receiver's loan
 * account not a loan class, the journal cap; and the guard waits on the payer's advisory locks. The clearing needs a person's own session
 * (breaker M2), a payment's Reject needs Approve (breaker M3), the Accept body takes no other key (L2), and no role but the intended ones may
 * execute a 1027 function: any other role found is revoked (deploy-safe, a WARNING when it cannot be), PUBLIC stops it (m5).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { settleDocumentByContra } from '../../../src/modules/accounting/services/core/contraSettlementPosting';
import { acceptAllocation } from '../../../src/modules/accounting/services/intercompany/allocationClearService';
import { withReceiverTx } from '../../../src/modules/accounting/services/intercompany/receiverTx';
import { acct, asAppUser, co, outcome, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup, plantArInvoice, rawReverseJournal } from './mirror.helpers';
import { bank, clearPayments, plantBatchRow, plantBill, plantPaid, plantPaymentJournal, sendFor } from './allocation.helpers';
import { allocationsApi } from './allocation-live.helpers';
import { lockWaiter } from './ledger.helpers';
import { accept, acceptAs, bodyFor, clearConnect, clearSetup, ledger, loan, outcomeOf, sentClearable } from './allocation-clear.helpers';
import { holdCapLock, sessionlessToken, withLedgerUnfrozen } from './allocation-clear-round1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';
const MIGRATION_1027 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1027_intercompany_p4d_allocation_clearing.sql'), 'utf8');

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1", [acct.bLoan]);
  conn = await clearConnect(pool);
});

async function exactClearing(invoice: string, amount: number, message: string, date = '2026-09-01'): Promise<string> {
  const posted = await asService(pool, U.a, co.A, () => settleDocumentByContra({
    companyId: co.A, subledger: 'ar', documentId: invoice, contraAccountId: acct.aLoan, amount, date, reason: 'by hand',
    actor: { userId: U.a, approverUserId: U.a, postingAgent: 'mcp:settle_by_contra:v1' },
  }));
  await pool.query('UPDATE customer_payments SET bank_reference = $2 WHERE id = $1', [posted.paymentId, `IC:${message}`]);
  return posted.paymentId;
}
const acceptDirect = (q: PoolClient, message: string, target: string) => outcome(q,
  "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2 WHERE id = $1", [message, target]);
const REFUSED = /^23514: an allocation message is accepted with the clearing posted for it/;
const journalOf = async (payment: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_payments WHERE id = $1', [payment])).rows[0].je as string;

describe('the guard, one condition at a time', () => {
  it('the untampered exact clearing is accepted (the control case)', async () => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    const exact = await exactClearing(s.invoice, 400, s.message);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, s.message, exact)).toBe('ok'); });
  });

  const tampers: Array<[string, (payment: string, s: Awaited<ReturnType<typeof sentClearable>>) => Promise<unknown>]> = [
    ['not confirmed', (p) => pool.query("UPDATE customer_payments SET status = 'draft' WHERE id = $1", [p])],
    ['not contra', (p) => pool.query("UPDATE customer_payments SET payment_method = 'eft' WHERE id = $1", [p])],
    ['allocated to another invoice of the right amount', async (p) => pool.query('UPDATE customer_payment_allocations SET invoice_id = $2 WHERE payment_id = $1',
      [p, (await plantArInvoice(pool, { status: 'approved' })).id])],
    ['journal not posted', async (p) => withLedgerUnfrozen(pool, async (q) => q.query("UPDATE gl_journal_entries SET status = 'draft' WHERE id = $1", [await journalOf(p)]))],
    ['journal reversed', async (p) => rawReverseJournal(pool, await journalOf(p))],
    ['credit not on the receivable control', async (p) => withLedgerUnfrozen(pool, async (q) => q.query(
      'UPDATE gl_journal_lines SET gl_account_id = $2 WHERE journal_entry_id = $1 AND credit > 0', [await journalOf(p), loan.a2]))],
    ['debit and credit swapped', async (p) => withLedgerUnfrozen(pool, async (q) => q.query(
      'UPDATE gl_journal_lines SET debit = credit, credit = debit WHERE journal_entry_id = $1', [await journalOf(p)]))],
    ['the loan line a credit (the receivable credit kept)', async (p) => withLedgerUnfrozen(pool, async (q) => {
      await q.query('SET LOCAL session_replication_role = replica');   // (the deferred balance check would refuse the unbalanced journal at commit)
      await q.query('UPDATE gl_journal_lines SET credit = debit, debit = 0 WHERE journal_entry_id = $1 AND gl_account_id = $2', [await journalOf(p), acct.aLoan]);
    })],
    ['confirmed by another user', (p) => pool.query('UPDATE customer_payments SET confirmed_by = $2 WHERE id = $1', [p, U.ab])],
    ['created by another user', (p) => pool.query('UPDATE customer_payments SET created_by = $2 WHERE id = $1', [p, U.ab])],
    ['dated before the payment (the invoice earlier still)', async (p, s) => {
      await pool.query("UPDATE customer_invoices SET invoice_date = DATE '2026-08-15' WHERE id = $1", [s.invoice]);
      await pool.query("UPDATE customer_payments SET payment_date = DATE '2026-08-31' WHERE id = $1", [p]);
    }],
    ['dated before the invoice', (_p, s) => pool.query("UPDATE customer_invoices SET invoice_date = DATE '2026-09-02' WHERE id = $1", [s.invoice])],
    ["the receiver's loan account no loan class", () => pool.query("UPDATE gl_accounts SET account_type = 'equity', account_subtype = 'equity' WHERE id = $1", [acct.aLoan])],
    ["the payer's loan account of the receiver's type", async () => {
      await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.bLoan]);
    }],
  ];
  it.each(tampers)('refused: %s', async (_what, tamper) => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    const exact = await exactClearing(s.invoice, 400, s.message);
    await tamper(exact, s);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, s.message, exact)).toMatch(REFUSED); });
  });

  it('refused: the receipt shares the journal of another accepted clearing', async () => {
    const one = await sentClearable(pool, conn, { amount: 400 });
    const first = outcomeOf(await accept(one.message, bodyFor(one)));
    const two = await sentClearable(pool, conn, { amount: 400 });
    const exact = await exactClearing(two.invoice, 400, two.message);
    await pool.query('UPDATE customer_payments SET gl_journal_entry_id = $2 WHERE id = $1', [exact, first.journalEntryId]);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, two.message, exact)).toMatch(REFUSED); });
  });

  it('refused: a batch member beyond the journal cap, by its exact clearing', async () => {
    const journal = await plantPaymentJournal(pool, 800, { leg: acct.bLoan });
    const batch = await plantBatchRow(pool, { journal });
    const members = [];
    for (const amount of [400, 400, 300]) {
      const b = await plantBill(pool, conn);
      const p = await plantPaid(pool, b.bill, { batch, amount, memberBank: bank.b });
      members.push({ ...b, amount, message: (await sendFor(pool, p.allocation)).message_id as string });
    }
    for (const m of members.slice(0, 2)) expect(outcomeOf(await accept(m.message, bodyFor(m)))).toMatchObject({ accepted: true });
    const exact = await exactClearing(members[2]!.invoice, 300, members[2]!.message);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await acceptDirect(q, members[2]!.message, exact)).toMatch(REFUSED); });
  });

  it("the guard waits on the payer's advisory locks before judging the caps", async () => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    const exact = await exactClearing(s.invoice, 400, s.message);
    const held = await holdCapLock(pool, s.message);
    const direct = asAppUser(pool, U.a, co.A, (q) => acceptDirect(q, s.message, exact));
    expect(await lockWaiter(pool, 'advisory')).toBe(true);
    await held.release();
    expect(await direct).toBe('ok');
  });
});

describe("the person: their own session, Approve to reject, the preview's keys only", () => {
  it('a receiver transaction (no session id) and a bearer-like token are refused, nothing written', async () => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    const input = bodyFor(s);
    await expect(withReceiverTx({ userId: U.a, companyId: co.A }, () => acceptAllocation({ companyId: co.A, messageId: s.message, userId: U.a, input })))
      .rejects.toMatchObject({ status: 403 });
    const res = await acceptAs(U.a, co.A, s.message, input, await sessionlessToken(U.a));
    expect([401, 403]).toContain(res.state.statusCode);
    expect(await ledger.message(pool, s.message)).toMatchObject({ status: 'pending', error: null });
  });

  it('a manager without Approve on Customers & AR cannot reject a payment; an owner can', async () => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    const res = await allocationsApi.reject(U.mab, co.A, s.message, { reason: 'not ours' });
    expect(res.state.statusCode).toBe(403);
    expect(JSON.stringify(res.state.body)).toMatch(/Approve/);
    expect(await ledger.message(pool, s.message)).toMatchObject({ status: 'pending' });
    expect((await allocationsApi.reject(U.a, co.A, s.message, { reason: 'not ours' })).state.statusCode).toBe(200);
  });

  it('an Accept body with any other key is a 400', async () => {
    const s = await sentClearable(pool, conn, { amount: 400 });
    expect((await accept(s.message, { ...bodyFor(s), approverUserId: U.ab })).state.statusCode).toBe(400);
  });

  const NEW_FUNCTIONS = ['public.intercompany_allocation_message_live(uuid)', 'public.intercompany_allocation_cap_lock(uuid)',
    'public.intercompany_is_loan_class(text, text, boolean)', 'public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid)'];
  const reaches = async (q: PoolClient, role: string) => (await q.query(
    "SELECT f AS fn, has_function_privilege($1, f, 'EXECUTE') AS can FROM unnest($2::text[]) f ORDER BY f", [role, NEW_FUNCTIONS])).rows as Array<{ fn: string; can: boolean }>;

  it('deploy-safe: a default privilege granting EXECUTE to anon (as Supabase can carry) is revoked by the migration, which still finishes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'anon'")).rows.length > 0;
      if (!exists) await client.query('CREATE ROLE anon NOLOGIN');
      await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon');
      await client.query(MIGRATION_1027);
      expect((await reaches(client, 'anon')).filter((r) => r.can)).toEqual([]);
      expect((await reaches(client, 'app_user')).every((r) => r.can)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a direct grant to another role is revoked too, and the migration finishes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE ROLE ic_p4d_probe NOLOGIN');
      await client.query('GRANT EXECUTE ON FUNCTION public.intercompany_allocation_target_ok(uuid, jsonb, uuid, uuid, text, uuid) TO ic_p4d_probe');
      await client.query(MIGRATION_1027);
      expect((await reaches(client, 'ic_p4d_probe')).filter((r) => r.can)).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('PUBLIC holding EXECUTE still stops the migration (strict)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // the helpers are CREATE OR REPLACEd (their grants survive a re-apply): a PUBLIC grant the file no longer revokes reaches the check
      await client.query('GRANT EXECUTE ON FUNCTION public.intercompany_allocation_cap_lock(uuid) TO PUBLIC');
      const text = MIGRATION_1027.replace('REVOKE ALL ON FUNCTION public.intercompany_allocation_cap_lock(uuid) FROM PUBLIC;', '');
      await expect(client.query(text)).rejects.toThrow(/1027: PUBLIC can execute/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
