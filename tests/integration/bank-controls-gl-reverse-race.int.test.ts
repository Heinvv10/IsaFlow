/**
 * Bank controls step 2 (security review of abcba178f, TOCTOU): the GL
 * reversal's bank-allocation check must judge the statement lines it LOCKED,
 * not an unlocked read. The race: a person reverses a posted manual journal J
 * from Journal Entries under manual_journal enforcement; J books no statement
 * line yet, so the check passes — and right then a colleague matches a
 * statement line to J and commits. Reversed now, J's cash would leave the
 * books past the gate (decision 4) and strand the line against a reversed
 * journal. The check runs on the set `lockJournalCashForGlReversal` locked; a
 * line tied after that read is refused under the reversal's claim (a typed
 * retry), and the retry is refused 409. Driven by a client wrapper that commits
 * the match right after the entrance's chain-cash SELECT returns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { lockJournalCashForGlReversal } from '../../src/modules/accounting/services/bank/bankReversalGate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { plantJournal } from './r035-pr6.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

const isChainCashRead = (t: string) => t.includes('bt.provisional_je_id IN (SELECT id FROM walk)');

/** The GL reversal of `je` as `user` in their own session, on one client; `onHit` runs after the first chain-cash read. */
async function glReverseWithHook(f: BankCompany, user: string, je: string, onHit: () => Promise<void>): Promise<unknown> {
  const cl: PoolClient = await pool.connect();
  const orig = cl.query.bind(cl) as (...q: unknown[]) => Promise<unknown>;
  let fired = false;
  (cl as unknown as { query: unknown }).query = async (...q: unknown[]) => {
    const out = await orig(...q);
    const t = typeof q[0] === 'string' ? q[0] : (q[0] as { text?: string } | undefined)?.text ?? '';
    if (!fired && isChainCashRead(t)) { fired = true; await onHit(); }
    return out;
  };
  try {
    await orig('BEGIN');
    await orig('SET LOCAL ROLE app_user');
    const claims = { sub: user, role: 'authenticated', company_id: f.c, session_id: crypto.randomUUID() };
    await orig("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await orig("SELECT set_config('app.current_company_id', $1, true)", [f.c]);
    const out = await als.run({ client: cl, userId: user, companyId: f.c, claims } as never, async () => {
      const cashLinesLocked = await lockJournalCashForGlReversal(f.c, je);
      return reverseJournalEntry(f.c, je, user, { cashLinesLocked });
    }).then(() => 'reversed', (e: unknown) => e);
    await orig(out === 'reversed' ? 'COMMIT' : 'ROLLBACK');
    return out;
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

describe('a statement line matched to the journal while its GL reversal is being decided', () => {
  it('is seen: the reversal is refused (a retry, under the claim), nothing reversed; the retry is refused 409', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    const je = await plantJournal(pool, f, a, { amount: 1500 }); // DR expA / CR bank, a's manual journal
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
    const bankLeg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [je, f.bank])).rows[0].id as string;
    const line = await plantLine(pool, f, await plantBatch(pool, f, null), -1500);
    await enforce(pool, f.c, a, ['manual_journal']);

    // The colleague's match lands — committed — between the entrance's read and the reversal.
    const out = await glReverseWithHook(f, a, je, async () => {
      const res = await actionRoute(tokens)(b, f.c, { action: 'match', bankTransactionId: line, journalLineId: bankLeg });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    });
    expect(out).toMatchObject({ code: 'ROW_LOCK_TIMEOUT' }); // typed retry: a bank line of this journal appeared
    const contras = async () =>
      (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n as number;
    expect([await contras(), await lineStatus(pool, line)]).toEqual([0, 'matched']);

    // The retry sees the line and is refused: reverse it from the bank line.
    const retry = await glReverseWithHook(f, a, je, async () => undefined);
    expect(retry).toMatchObject({ code: 'REVERSE_FROM_BANK_LINE' });
    expect(await contras()).toBe(0);
  });
});
