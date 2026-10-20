/**
 * D10 O9 — a statement line that a bank-first provisional journal X books (`provisional_je_id`, no matched journal
 * line) is not reset while X stands, from any entrance: bank reversal (`bank-transactions-action` reverse and MCP
 * `reverse_bank_allocation`), unmatch and exclude are refused pre-write with a typed refusal naming the real undo —
 * Dismiss for an un-evidenced X, approve the bill then Unapply + Void for an evidenced one. On master the evidenced
 * line went to 'imported' / 'excluded' with X still booking the cash, and a later approval settled X against it.
 * The approval settles X only while its line is still 'matched' (or reconciled). A line whose X the GL already took
 * out is freed by the bank reversal, posting nothing. Plus the race: an approval holding X while a reversal arrives.
 */
import { describe, expect, it } from 'vitest';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { als } from '@/lib/als';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';
import {
  bankGl, callRoute, company, inTx, invoiceState, pool, seedDoc, seedInvoice, seedProvisional, today, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();
const route = bankTransactionsAction as (req: never, res: never) => unknown;
const VERBS = {
  reverse: (bt: string) => ({ action: 'reverse', bankTransactionId: bt }),
  unmatch: (bt: string) => ({ action: 'unmatch', bankTransactionId: bt }),
  exclude: (bt: string) => ({ action: 'exclude', bankTransactionId: bt }),
};
const line = async (bt: string) => (await pool.query(
  'SELECT status, provisional_je_id::TEXT AS prov, excluded_reason FROM bank_transactions WHERE id = $1', [bt])).rows[0];
const xState = async (x: string) => (await pool.query(`SELECT reversed_at IS NOT NULL AS reversed,
  (SELECT count(*)::int FROM gl_journal_entries r WHERE r.reversal_of_id = x.id) AS contras FROM gl_journal_entries x WHERE id = $1`, [x])).rows[0];
const settlements = async (x: string) => (await pool.query(
  "SELECT id FROM supplier_payments WHERE company_id = $1 AND settles_provisional_je_id = $2 AND status <> 'cancelled'", [company, x])).rows;
const text = (r: { body: unknown }) => JSON.stringify(r.body);

async function scenario(evidenced: boolean) {
  const doc = await seedDoc();
  const { je: x, bt } = await seedProvisional({ totalAmount: 115, ...(evidenced ? { evidencedBy: doc } : {}) });
  const bill = await seedInvoice({ documentId: doc, totalAmount: 115 });
  return { doc, x, bt, bill };
}

describe('D10 O9: a provisional\'s statement line is not reset while its journal stands', () => {
  for (const [verb, body] of Object.entries(VERBS)) {
    it(`evidenced: ${verb} refused 400 naming approve + Unapply + Void; nothing changed; the approval still settles`, async () => {
      const s = await scenario(true);
      const before = await line(s.bt);
      const r = await callRoute(route as never, '/api/accounting/bank-transactions-action', body(s.bt));
      expect(r.statusCode, text(r)).toBe(400);
      expect(text(r)).toMatch(/approve the supplier bill/i);
      expect(text(r)).toMatch(/Unapply/);
      expect(await line(s.bt)).toEqual(before);
      expect(await xState(s.x)).toEqual({ reversed: false, contras: 0 });
      await inTx(() => approveSupplierInvoice(company, s.bill, user));
      expect(await settlements(s.x)).toHaveLength(1);
      expect((await line(s.bt)).status).toBe('matched');
    });

    it(`un-evidenced: ${verb} refused 400 naming Dismiss; nothing changed`, async () => {
      const s = await scenario(false);
      const before = await line(s.bt);
      const r = await callRoute(route as never, '/api/accounting/bank-transactions-action', body(s.bt));
      expect(r.statusCode, text(r)).toBe(400);
      expect(text(r)).toMatch(/Dismiss/);
      expect(await line(s.bt)).toEqual(before);
      expect(await xState(s.x)).toEqual({ reversed: false, contras: 0 });
    });
  }

  for (const evidenced of [true, false]) {
    it(`${evidenced ? 'evidenced' : 'un-evidenced'}: match to another journal's line refused 400; nothing changed`, async () => {
      const s = await scenario(evidenced);
      const other = await seedProvisional({ totalAmount: 50 });
      const [target] = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0', [other.je])).rows;
      const before = await line(s.bt);
      const r = await callRoute(route as never, '/api/accounting/bank-transactions-action',
        { action: 'match', bankTransactionId: s.bt, journalLineId: String(target.id) });
      expect(r.statusCode, text(r)).toBe(400);
      expect(text(r)).toMatch(evidenced ? /approve the supplier bill/i : /Dismiss/);
      expect(await line(s.bt)).toEqual(before);
    });
  }

  it('MCP reverse_bank_allocation on an un-evidenced provisional\'s line: a refusal-coded throw naming Dismiss', async () => {
    const s = await scenario(false);
    const ctx = { companyId: company, userId: user, scopes: ['write:bank', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    // The tool throws (no catch: the registry's savepoint must see it); the registry answers a refusal-coded throw
    // with its own message, so the agent reads the Dismiss remedy.
    const err = await inTx(() => reverseBankAllocationTool.handler({ transaction_id: s.bt, idempotency_key: crypto.randomUUID() }, ctx as never))
      .then(() => null, (e: unknown) => e);
    expect(isRefusalCoded(err), String(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/Dismiss/);
    expect((await line(s.bt)).status).toBe('provisional');
  });

  it('the GL already took X out: bank reversal frees the line and clears the link, posting nothing; approval settles nothing', async () => {
    const s = await scenario(true);
    await inTx(() => reverseJournalEntry(company, s.x, user));
    const r = await callRoute(route as never, '/api/accounting/bank-transactions-action', VERBS.reverse(s.bt));
    expect(r.statusCode, text(r)).toBe(200);
    expect(await line(s.bt)).toMatchObject({ status: 'imported', prov: null });
    expect((await xState(s.x)).contras).toBe(1);
    await inTx(() => approveSupplierInvoice(company, s.bill, user));
    expect(await settlements(s.x)).toHaveLength(0);
    expect((await invoiceState(s.bill)).paid).toBe(0);
  });

  it('a line already reset while still linked (pre-fix data): the approval does not settle X against it', async () => {
    const s = await scenario(true);
    await pool.query("UPDATE bank_transactions SET status = 'imported' WHERE id = $1", [s.bt]);
    await inTx(() => approveSupplierInvoice(company, s.bill, user));
    expect(await settlements(s.x)).toHaveLength(0);
    expect((await invoiceState(s.bill)).paid).toBe(0);
  });

  it('race: a bank reversal arriving while the approval holds X is refused; the settlement and its matched line stand', async () => {
    const s = await scenario(true);
    const cl = await pool.connect();
    const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
    let other: { ok: boolean; error?: string } | null = null;
    (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const out = await orig(...a);
      const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
      if (!other && /FOR UPDATE OF je/.test(t)) {
        other = await inTx(() => reverseReconciledTransaction(company, s.bt, user)).then(() => ({ ok: true }),
          (e: Error) => ({ ok: false, error: e.message }));
      }
      return out;
    };
    await orig('BEGIN');
    try {
      await als.run({ client: cl, userId: user, companyId: company, claims: {} } as never, () => approveSupplierInvoice(company, s.bill, user));
      await orig('COMMIT');
    } catch (err) {
      await orig('ROLLBACK');
      throw err;
    } finally {
      (cl as unknown as { query: unknown }).query = orig;
      cl.release();
    }
    expect(other, JSON.stringify(other)).toMatchObject({ ok: false });
    expect(await settlements(s.x)).toHaveLength(1);
    expect((await line(s.bt)).status).toBe('matched');
  });

  // F2 (brk-d10): cancelling an in-progress reconciliation reset every 'matched' line it held — an evidenced
  // provisional's line too (status 'matched', no matched journal line), with X standing and the link kept. Such a line
  // exists independently of the session, like an allocated one: it is detached only. The cancel stays usable.
  it('reconciliation cancel detaches an evidenced provisional\'s line (stays matched, linked) and still reverts a real match', async () => {
    const s = await scenario(true);
    const [rec] = (await pool.query(`INSERT INTO bank_reconciliations (company_id, bank_account_id, statement_date, statement_balance,
      status, started_by) VALUES ($1, $2, CURRENT_DATE, 0, 'in_progress', $3) RETURNING id`, [company, bankGl, user])).rows;
    const other = await seedProvisional({ totalAmount: 60 });
    const [leg] = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [other.je, bankGl])).rows;
    // A real match in the same session: a second journal's bank leg, as matchTransaction leaves it.
    const [plain] = (await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
      status, matched_journal_line_id, reconciliation_id) VALUES ($1, $2, $3, -60, 'd10 plain match', 'matched', $4, $5) RETURNING id`,
    [company, bankGl, today, leg.id, rec.id])).rows;
    await pool.query('UPDATE bank_transactions SET provisional_je_id = NULL WHERE id = $1', [other.bt]);
    await pool.query('UPDATE bank_transactions SET reconciliation_id = $1 WHERE id = $2', [rec.id, s.bt]);
    const r = await callRoute(bankReconciliationsAction as never, '/api/accounting/bank-reconciliations-action',
      { action: 'cancel', reconciliationId: String(rec.id) });
    expect(r.statusCode, text(r)).toBe(200);
    expect(await line(s.bt)).toMatchObject({ status: 'matched', prov: s.x });
    expect((await pool.query('SELECT reconciliation_id FROM bank_transactions WHERE id = $1', [s.bt])).rows[0].reconciliation_id).toBeNull();
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [plain.id])).rows[0].status).toBe('imported');
    await inTx(() => approveSupplierInvoice(company, s.bill, user));
    expect(await settlements(s.x)).toHaveLength(1);
  });

  // O-a (brk-d10): a SECOND statement line matched to a standing provisional's bank leg — at k = 0 X itself, at k = 2
  // the head R2 that carries X again — while X's own line still holds that cash through provisional_je_id.
  for (const k of [0, 2]) {
    it(`a second line matched to the bank leg of a standing provisional's chain (k=${k}) is refused; nothing changed`, async () => {
      const s = await scenario(true);
      let target = s.x;
      for (let i = 0; i < k; i++) target = String((await inTx(() => reverseJournalEntry(company, target, user))).id);
      const [leg] = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [target, bankGl])).rows;
      const [l2] = (await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
        VALUES ($1, $2, $3, ${k % 2 === 0 ? -115 : 115}, 'd10 second line', 'imported') RETURNING id`, [company, bankGl, today])).rows;
      const r = await callRoute(route as never, '/api/accounting/bank-transactions-action',
        { action: 'match', bankTransactionId: String(l2.id), journalLineId: String(leg.id) });
      expect(r.statusCode, text(r)).toBe(400);
      expect(text(r)).toMatch(/provisional/i);
      expect((await pool.query('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [l2.id])).rows[0])
        .toEqual({ status: 'imported', matched_journal_line_id: null });
    });
  }
});
