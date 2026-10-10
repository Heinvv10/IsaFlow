/**
 * BREAKER #684 — REPRO 3. Importer ≠ allocator (decision 2) is refused on
 * allocate/split at ANY amount while the arm's type is enforced. But a
 * manual journal under the rule's threshold posts with nobody approving, and
 * a statement line can be MATCHED to a posted journal line
 * (bank-transactions-action `match`, bank-match-confirm `journal_line`) with
 * no importer check. So the importer writes DR expense / CR bank for their
 * own line's amount, posts it themselves, and matches their own line to it —
 * the exact outcome the allocate refusal forbids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import { journalRoutes, plantJournal } from './r035-pr6.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, refusalOf } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
const j = journalRoutes(tokens);

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

describe('the importer settles their own statement line by matching it to a journal they posted', () => {
  it('allocate is refused (403); post-own-journal + match lands the same posting', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    await plantRule(pool, f.c, 'owner', { documentType: 'manual_journal', operator: 'greater_than', value: 1000 });
    await enforce(pool, f.c, b, ['manual_journal']);
    const line = await plantLine(pool, f, await plantBatch(pool, f, a), -500);
    // Sanity: the importer may not allocate their own line.
    expect(refusalOf(await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA })))
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });

    // a drafts DR expA / CR bank R500 and posts it (under the R1 000 rule: no approval needed).
    const je = await plantJournal(pool, f, a, { amount: 500 });
    const posted = await j.post(a, f.c, je);
    expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(200);
    const bankLeg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [je, f.bank])).rows[0].id as string;

    const res = await act(a, f.c, { action: 'match', bankTransactionId: line, journalLineId: bankLeg });
    // REQUIRED (decision 2): the importer may not settle their own statement line on the manual-journal arm.
    expect({ status: res.state.statusCode, line: await lineStatus(pool, line) }).toEqual({ status: 403, line: 'imported' });
    expect(refusalOf(res)).toMatchObject({ reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
    // FIXED (slice a): bank-match-confirm's journal_line confirm refuses the same, before any write.
    const confirm = await callRoute(bankMatchConfirm as never, tokens[a]!, f.c, 'POST',
      { bankTransactionId: line, candidateType: 'journal_line', candidateId: bankLeg }, '/api/accounting/bank-match-confirm');
    expect({ ...refusalOf(confirm), line: await lineStatus(pool, line) })
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE', line: 'imported' });
    // Matching to a journal SOMEONE ELSE created stays allowed.
    const theirs = await plantJournal(pool, f, b, { amount: 500 });
    expect((await j.post(b, f.c, theirs)).state.statusCode).toBe(200);
    const theirLeg = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [theirs, f.bank])).rows[0].id as string;
    expect((await act(a, f.c, { action: 'match', bankTransactionId: line, journalLineId: theirLeg })).state.statusCode).toBe(200);
    expect(await lineStatus(pool, line)).toBe('matched');
  });
});
