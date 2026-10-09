/**
 * Bank controls step 2 (Hein, decision 4): undoing an auto-post run is a
 * reversal, judged at the RUN level before any row (bank-auto-post POST undo).
 * Under manual_journal enforcement the person who ran it (its created_by) may
 * not undo it — 403 ALLOCATOR_MAY_NOT_REVERSE, nothing written — another
 * member does, audited; the sole approver undoes their own; an import's run
 * (the zero uuid, the system user) is nobody's, so even its importer undoes
 * it; an agent or a job is refused; enforcement off undoes as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import { undoRun } from '../../src/modules/accounting/services/bank/autoPostUndoService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
});
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

/** A run created by `runBy` holding one line `runBy` allocated (as the categorisation sweep does), then manual_journal enforced. */
async function run(opts: { members?: [string, string][]; enforced?: boolean } = {}) {
  const f: BankCompany = await bankCompany(pool, opts.members ?? [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, null));
  const res = await actionRoute(tokens)(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const runId = (await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id, source, min_confidence, amount_cap, posted_count, created_by)
     VALUES($1,'categorization',0.9,0,1,$2) RETURNING id`, [f.c, a])).rows[0].id as string;
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2 WHERE id = $1', [line, runId]);
  if (opts.enforced !== false) await enforce(pool, f.c, a, ['manual_journal']);
  return { f, line, runId };
}
const undo = (user: string, c: string, runId: string) =>
  callRoute(bankAutoPost as never, tokens[user]!, c, 'POST', { action: 'undo', runId }, '/api/accounting/bank-auto-post');
const runUndone = async (runId: string) =>
  (await pool.query('SELECT undone_at IS NOT NULL AS undone FROM bank_auto_post_runs WHERE id = $1', [runId])).rows[0].undone as boolean;
const audits = async (c: string) => (await pool.query(
  "SELECT user_id, entity_type, changes->'metadata'->>'allocator' AS allocator FROM audit_log WHERE company_id = $1 AND action = 'reverse' ORDER BY entity_type",
  [c])).rows as { user_id: string; entity_type: string; allocator: string }[];

describe('the person who ran an auto-post run may not undo it', () => {
  it('refused 403 with nothing written; another member undoes it, audited for the run and the line', async () => {
    const { f, line, runId } = await run();
    const refused = refusalOf(await undo(a, f.c, runId));
    expect(refused).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect(refused.message).toBe('You ran this auto-post run, so while manual-journal approval is on you cannot undo it yourself. '
      + 'Ask another member to undo it.');
    expect([await lineStatus(pool, line), await runUndone(runId)]).toEqual(['allocated', false]);
    const res = await undo(b, f.c, runId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect([await lineStatus(pool, line), await runUndone(runId)]).toEqual(['imported', true]);
    expect(await audits(f.c)).toEqual([
      { user_id: b, entity_type: 'bank_auto_post_run', allocator: a },
      { user_id: b, entity_type: 'bank_transaction', allocator: a },
    ]);
  });

  it('an agent or a job is refused, whoever ran the run', async () => {
    const { f, line, runId } = await run();
    await expect(asToken(pool, b, f.c, () => undoRun(f.c, runId, b))).rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' });
    expect(await lineStatus(pool, line)).toBe('allocated');
  });

  it('the sole approver undoes their own run; enforcement off, anyone does, unaudited', async () => {
    const sole = await run({ members: [[a, 'admin'], [b, 'viewer']] });
    expect((await undo(a, sole.f.c, sole.runId)).state.statusCode).toBe(200);
    expect(await lineStatus(pool, sole.line)).toBe('imported');
    const off = await run({ enforced: false });
    expect((await undo(a, off.f.c, off.runId)).state.statusCode).toBe(200);
    expect(await audits(off.f.c)).toEqual([]);
  });
});

describe("an import's run is the system user's", () => {
  it('its importer undoes it under enforcement: the zero uuid is nobody', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    const { rows: [sup] } = await pool.query("INSERT INTO suppliers(company_id,name) VALUES($1,'Acmeprov Holdings') RETURNING id", [f.c]);
    await pool.query('INSERT INTO supplier_coding_history(company_id,supplier_id,gl_account_id,posted_by) VALUES($1,$2,$3,$4)',
      [f.c, sup.id, f.expA, a]);
    const imported = await callRoute(bulkCommit as never, tokens[a]!, f.c, 'POST', {
      bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'sept.csv', fileType: 'csv',
      statementDate: '2026-09-30', bankFormat: 'generic', csvContent: 'Date,Description,Amount\n2026-09-08,Acmeprov Holdings,-500.00',
    }, '/api/accounting/bank-transactions-bulk-commit');
    expect(imported.state.statusCode, JSON.stringify(imported.state.body)).toBe(200);
    const { rows: [r] } = await pool.query('SELECT id, created_by::TEXT AS by FROM bank_auto_post_runs WHERE company_id = $1', [f.c]);
    expect(r.by).toBe('00000000-0000-0000-0000-000000000000');
    await enforce(pool, f.c, a, ['manual_journal']);
    const res = await undo(a, f.c, r.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((res.state.body as { data: { reversed: number } }).data.reversed).toBe(1);
  });
});
