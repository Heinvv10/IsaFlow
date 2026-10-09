/**
 * BREAKER #684 — REPRO 2. A person can post a bank line provisionally
 * (POST /api/accounting/provisional/outstanding → postProvisional as them: the
 * journal's created_by is that person) and then reverse their own allocation
 * with POST /api/accounting/provisional/[jeId]/dismiss — reverseJournalEntry
 * plus a reset of the line — under manual_journal enforcement. Dismiss never
 * asks bankReversalGate (decision 4: the allocator may not reverse; audited).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import outstanding from '../../pages/api/accounting/provisional/outstanding';
import dismiss from '../../pages/api/accounting/provisional/[jeId]/dismiss';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_coding_history WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

describe('the allocator reverses their own provisional allocation through Dismiss', () => {
  it('a posts the line provisionally, then dismisses (reverses) it under manual_journal enforcement', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    await enforce(pool, f.c, b, ['manual_journal']);
    const supplierName = (await pool.query('SELECT name FROM suppliers WHERE id = $1', [f.supplier])).rows[0].name as string;
    for (let i = 0; i < 3; i += 1) {
      await pool.query(`INSERT INTO supplier_coding_history(company_id, supplier_id, gl_account_id, vat_code, posted_by)
        VALUES($1,$2,$3,'none','seed')`, [f.c, f.supplier, f.expA]);
    }
    // A statement line imported by b (so a is not the importer: a's allocation is allowed).
    const line = await plantLine(pool, f, await plantBatch(pool, f, b));
    await pool.query('UPDATE bank_transactions SET description = $2 WHERE id = $1', [line, supplierName]);

    const post = await callRoute(outstanding as never, tokens[a]!, f.c, 'POST', { bankTxIds: [line] },
      '/api/accounting/provisional/outstanding');
    expect(post.state.statusCode, JSON.stringify(post.state.body)).toBe(200);
    const je = dataOf<{ results: { journalEntryId: string | null; skipped?: string }[] }>(post).results[0]!;
    expect(je.journalEntryId, JSON.stringify(je)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await pool.query('SELECT created_by::TEXT AS by FROM gl_journal_entries WHERE id = $1', [je.journalEntryId])).rows[0].by)
      .toBe(a);

    const res = await callRoute(dismiss as never, tokens[a]!, f.c, 'POST', undefined,
      `/api/accounting/provisional/${je.journalEntryId}/dismiss`, { jeId: je.journalEntryId! });
    const contras = (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id = $2',
      [f.c, je.journalEntryId])).rows[0].n as number;
    // REQUIRED (decision 4): the allocator may not reverse their own allocation — 403, nothing written.
    expect({ status: res.state.statusCode, contras, line: await lineStatus(pool, line) })
      .toEqual({ status: 403, contras: 0, line: 'provisional' });
    expect((res.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('ALLOCATOR_MAY_NOT_REVERSE');

    // FIXED (slice a): another member dismisses it, and the reversal is audited.
    const ok = await callRoute(dismiss as never, tokens[b]!, f.c, 'POST', undefined,
      `/api/accounting/provisional/${je.journalEntryId}/dismiss`, { jeId: je.journalEntryId! });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await lineStatus(pool, line)).toBe('imported');
    const audit = (await pool.query(
      "SELECT user_id, entity_id::TEXT AS line, changes->'metadata'->>'allocator' AS allocator FROM audit_log WHERE company_id = $1 AND action = 'reverse'",
      [f.c])).rows;
    expect(audit).toEqual([{ user_id: b, line, allocator: a }]);
  });
});
