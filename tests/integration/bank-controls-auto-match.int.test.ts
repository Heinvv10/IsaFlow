/**
 * Bank controls step 2 (blind review #684 round 3, MEDIUM-A): auto-match acts
 * for the person who triggered it (A3's rule). Under manual_journal
 * enforcement it skips — and counts — a pair where that person imported the
 * statement line AND created the journal: matching it would book the line's
 * cash to their own journal, which `match` already refuses them (403). A pair
 * with someone else's journal, someone else's run, or the sole approver on the
 * admin floor matches as before. Both entrances: bank-transactions-action
 * `auto_match` and MCP `perform_bank_reconciliation`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { performBankReconciliationTool } from '../../src/lib/mcp/tools/writeBankReconciliation';
import { autoMatchTransactions } from '../../src/modules/accounting/services/bank/bankAutoMatchService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { journalRoutes, plantJournal } from './r035-pr6.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, plantBatch, plantLine, refusalOf, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
const j = journalRoutes(tokens);
const mcp = mcpCaller(pool, [performBankReconciliationTool]);

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET matched_journal_line_id = NULL, reconciliation_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

/** A line a imported, and a posted R500 journal by `journalBy` that auto-match pairs it with; manual_journal enforced. */
async function pair(journalBy: string, members: [string, string][] = [[a, 'admin'], [b, 'admin']]) {
  const f: BankCompany = await bankCompany(pool, members, companies);
  await enforce(pool, f.c, a, ['manual_journal']);
  const line = await plantLine(pool, f, await plantBatch(pool, f, a), 500);
  const je = await plantJournal(pool, f, journalBy, { amount: 500 });
  expect((await j.post(journalBy, f.c, je)).state.statusCode).toBe(200);
  const leg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [je, f.bank]))
    .rows[0].id as string;
  return { f, line, leg };
}
const autoMatch = async (user: string, f: BankCompany) => {
  const res = await act(user, f.c, { action: 'auto_match', bankAccountId: f.bank });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ matched: number; skippedImporter?: number }>(res);
};

describe('auto_match acts for the person who ran it', () => {
  it("the importer's own line and own journal: skipped and counted, as `match` refuses it; another member's run matches it", async () => {
    const { f, line, leg } = await pair(a);
    expect(refusalOf(await act(a, f.c, { action: 'match', bankTransactionId: line, journalLineId: leg })))
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
    expect(await autoMatch(a, f)).toMatchObject({ matched: 0, skippedImporter: 1 });
    expect(await lineStatus(pool, line)).toBe('imported');
    expect(await autoMatch(b, f)).toMatchObject({ matched: 1 });
    expect(await lineStatus(pool, line)).toBe('matched');
  });

  it('the importer matches their line to a journal someone else created; the sole approver matches their own', async () => {
    const theirs = await pair(b);
    expect(await autoMatch(a, theirs.f)).toMatchObject({ matched: 1 });
    const sole = await pair(a, [[a, 'admin'], [b, 'viewer']]);
    expect(await autoMatch(a, sole.f)).toMatchObject({ matched: 1 });
  });

  it('MCP perform_bank_reconciliation skips the same pair for the token\'s user', async () => {
    const { f, line } = await pair(a);
    const res = await mcp(a, f.c, 'perform_bank_reconciliation', {
      bank_account_id: f.bank, statement_date: '2026-09-30', statement_balance: 0, idempotency_key: `bc-a-am-${f.c}`,
    });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ auto_matched: 0, skipped_importer: 1 });
    expect(await lineStatus(pool, line)).toBe('imported');
  });

  it('a run that names no person is refused before it reads anything (fails closed)', async () => {
    const { f, line } = await pair(a);
    await expect(asToken(pool, a, f.c, () => autoMatchTransactions(f.c, f.bank, undefined, undefined as unknown as string)))
      .rejects.toThrow(/the person who ran it \(triggeredBy\) is required/);
    expect(await lineStatus(pool, line)).toBe('imported');
  });
});
