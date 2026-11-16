/**
 * WP2 row 5 (carried from row 6, round 2): MCP bulk allocate now posts an account line onto a BANK account as a
 * transfer. A batch that posts transfer AB and then AC would hold the journal-number lock from AB's journal when it
 * asks for AC's pair lock, while another request holds AC's pair lock and waits for that number: a deadlock (40P01)
 * the pair lock itself introduced. The bulk path takes every pair lock it will need, sorted, BEFORE its first
 * journal, so no request ever waits for a pair while holding a number.
 *
 * Forced: a sleeping trigger (named to fire AFTER the numbering trigger) keeps X inside AB's journal INSERT, number
 * lock held, while Y starts; both then run to the end. A deadlock shows as X's AC line "locked by another request"
 * (skipped as retryable) or Y refused, so the test asserts both fully posted AND that the database broke no deadlock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { actionRoute, asToken, bankCompany, cleanupBankControlsA, mcpCaller, plantLine, type BankCompany } from './bank-controls-a.helpers';
import { applyRules } from '../../src/modules/accounting/services/bank/bankRulesMatchingService';
import { transferPairKey } from '../../src/modules/accounting/services/bank/transferPairLock';
import { callRoute } from './r035-approval.helpers';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let f: BankCompany;
let bankC = '';
let marker = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlocks = async () => Number((await pool.query(
  'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
type Reply = { isError?: boolean; content: { text: string }[] };
const body = (r: Reply) => JSON.parse(r.content[0]!.text) as { posted: number; skipped: Array<{ reason: string }>; lines: unknown[] };

beforeAll(async () => {
  user = await createUser(pool, tokens);
  f = await bankCompany(pool, [[user, 'admin']], companies);
  bankC = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,'BC Bank 3','asset','debit',true,'bank') RETURNING id`, [f.c, `B3${f.c.slice(0, 6)}`])).rows[0].id as string;
  marker = `btpb_sleeper_${f.c}`;
  await pool.query(`CREATE FUNCTION btpb_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE prior text := current_setting('application_name');
    BEGIN
      IF NEW.company_id = '${f.c}' AND NEW.description = 'BTPB X first' THEN
        PERFORM set_config('application_name', '${marker}', false); PERFORM pg_sleep(2);
        PERFORM set_config('application_name', prior, false);
      END IF;
      RETURN NEW;
    END $$`);
  // 'zzz' sorts after trg_gl_je_entry_number: the journal number (and its lock) is taken before the sleep.
  await pool.query(`CREATE TRIGGER zzz_btpb_sleep BEFORE INSERT ON gl_journal_entries
    FOR EACH ROW EXECUTE FUNCTION btpb_sleep()`);
}, 60000);

afterAll(async () => {
  await pool.query('DROP TRIGGER IF EXISTS zzz_btpb_sleep ON gl_journal_entries');
  await pool.query('DROP FUNCTION IF EXISTS btpb_sleep()');
  await pool.query('UPDATE bank_transactions SET allocation_batch_id = NULL WHERE company_id = $1', [f.c]);
  await cleanupBankControlsA(pool, companies, [user]); // ends the pool
}, 60000);

describe('bulk transfer allocation takes every pair lock before its first journal', () => {
  it('X posts AB then AC while Y posts AC: no deadlock, both fully post', async () => {
    // X's two lines, the AB one first in transaction-id order (the batch posts in that order).
    const [t1, t2] = [await plantLine(pool, f, null, -111), await plantLine(pool, f, null, -222)].sort();
    const y = await plantLine(pool, f, null, -333);
    const dl0 = await deadlocks();
    const x = mcp(user, f.c, 'bulk_allocate_bank_transactions', {
      allocations: [
        { transaction_id: t1, alloc_type: 'account', contra_account_id: f.bank2, description: 'BTPB X first' },
        { transaction_id: t2, alloc_type: 'account', contra_account_id: bankC, description: 'BTPB X second' },
      ],
      idempotency_key: `btpb-x-${Date.now()}`,
    });
    let asleep = false;
    for (let i = 0; i < 200 && !asleep; i++) {
      asleep = ((await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()
           AND application_name = $1 AND pid <> pg_backend_pid()`, [marker])).rowCount ?? 0) > 0;
      if (!asleep) await sleep(25);
    }
    expect(asleep, 'X never reached the sleeping journal trigger').toBe(true);
    const yReply = await mcp(user, f.c, 'bulk_allocate_bank_transactions', {
      allocations: [{ transaction_id: y, alloc_type: 'account', contra_account_id: bankC, description: 'BTPB Y' }],
      idempotency_key: `btpb-y-${Date.now()}`,
    });
    const xReply = await x;
    expect(xReply.isError, xReply.content[0]!.text).toBeFalsy();
    expect(yReply.isError, yReply.content[0]!.text).toBeFalsy();
    expect(body(xReply)).toMatchObject({ posted: 2, skipped: [] });
    expect(body(yReply)).toMatchObject({ posted: 1, skipped: [] });
    const n = (await pool.query(`SELECT count(*)::int AS n FROM gl_journal_entries
      WHERE company_id = $1 AND source = 'auto_bank_transfer' AND status = 'posted'`, [f.c])).rows[0].n as number;
    expect(n).toBe(3);
    expect(await deadlocks() - dl0, 'the database broke a deadlock (40P01)').toBe(0);
  }, 60000);
});

/** Waits (bounded) until X is asleep in its first journal's INSERT, number lock held. */
async function xAsleep(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()
      AND application_name = $1 AND pid <> pg_backend_pid()`, [marker])).rowCount ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error('X never reached the sleeping journal trigger');
}
const transferJournals = async () => (await pool.query(`SELECT count(*)::int AS n FROM gl_journal_entries
  WHERE company_id = $1 AND source = 'auto_bank_transfer' AND status = 'posted'`, [f.c])).rows[0].n as number;
const lineOn = async (id: string, amount: number, description: string) => (await pool.query(
  `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status)
   VALUES($1,$2,$3,DATE '2026-09-01',$4,$5,'imported') RETURNING id`, [id, f.c, f.bank, amount, description])).rows[0].id as string;
/** Two ids in ascending order: AB first, AC second, in every sweep's id order. */
const ordered = () => [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];

describe('the rule sweep and the confidence gate take every pair lock before their first journal', () => {
  it('the rule sweep posts AB then AC while a person posts AC: no deadlock, both post', async () => {
    const [ab, ac] = ordered();
    await pool.query(`INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern,
       gl_account_id, auto_create_entry, created_by, priority, description_template) VALUES
       ($1,'RSX one','description','contains','RSX ONE',$2,true,$4,0,'BTPB X first'),
       ($1,'RSX two','description','contains','RSX TWO',$3,true,$4,1,NULL)`, [f.c, f.bank2, bankC, user]);
    await lineOn(ab, -411, 'RSX ONE'); await lineOn(ac, -422, 'RSX TWO');
    const y = await plantLine(pool, f, null, -433);
    const before = await transferJournals();
    const dl0 = await deadlocks();
    const x = callRoute(bankRulesAction as never, tokens[user]!, f.c, 'POST', { action: 'apply', bankAccountId: f.bank },
      '/api/accounting/bank-rules-action');
    await xAsleep();
    const yRes = await actionRoute(tokens)(user, f.c,
      { action: 'allocate', bankTransactionId: y, allocationType: 'account', contraAccountId: bankC });
    const xRes = await x;
    expect(yRes.state.statusCode, JSON.stringify(yRes.state.body)).toBe(200);
    expect(xRes.state.statusCode, JSON.stringify(xRes.state.body)).toBe(200);
    expect((xRes.state.body as { data: Record<string, number> }).data).toMatchObject({ applied: 2, autoPostSkippedLocked: 0 });
    expect(await transferJournals()).toBe(before + 3);
    expect(await deadlocks() - dl0, 'the database broke a deadlock (40P01)').toBe(0);
    await pool.query('UPDATE bank_categorisation_rules SET is_active = false WHERE company_id = $1', [f.c]);
  }, 60000);

  it('the gate posts AB then AC while a person posts AC: no deadlock, both post', async () => {
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())
      ON CONFLICT (company_id) DO NOTHING`, [f.c]);
    const [ab, ac] = ordered();
    await lineOn(ab, -511, 'BTPB X first'); await lineOn(ac, -522, 'GATE TWO');
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [ab, f.bank2]);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [ac, bankC]);
    const y = await plantLine(pool, f, null, -533);
    const before = await transferJournals();
    const dl0 = await deadlocks();
    const gate = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
      res.status(200).json({ data: await sweep(req.companyId, [ab, ac], 'categorization', req.user.id, req.user.id) });
    });
    const x = callRoute(gate as never, tokens[user]!, f.c, 'POST', {}, '/api/accounting/smart-categorize');
    await xAsleep();
    const yRes = await actionRoute(tokens)(user, f.c,
      { action: 'allocate', bankTransactionId: y, allocationType: 'account', contraAccountId: bankC });
    const xRes = await x;
    expect(yRes.state.statusCode, JSON.stringify(yRes.state.body)).toBe(200);
    expect((xRes.state.body as { data: { posted: number; skipped: unknown[] } }).data).toMatchObject({ posted: 2, skipped: [] });
    expect(await transferJournals()).toBe(before + 3);
    expect(await deadlocks() - dl0, 'the database broke a deadlock (40P01)').toBe(0);
  }, 60000);
});

/** From ANOTHER connection: is the pair free right now? (try-lock in its own transaction, released at once). */
const pairFree = async (x: string, y: string) => (await pool.query(
  'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free', [transferPairKey(f.c, x, y)])).rows[0].free as boolean;

describe('a sweep pre-locks only the transfers it will attempt (round 2, M4)', () => {
  it('a transfer rule that matches no line takes no pair: a person\'s transfer on that pair is not held up', async () => {
    await pool.query('UPDATE bank_categorisation_rules SET is_active = false WHERE company_id = $1', [f.c]);
    await pool.query(`INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern,
       gl_account_id, auto_create_entry, created_by, priority) VALUES
       ($1,'M4 expense','description','contains','M4 EXPENSE',$2,true,$4,0),
       ($1,'M4 to C, matches nothing','description','contains','M4 NOTHING MATCHES',$3,true,$4,1)`, [f.c, f.expA, bankC, user]);
    await lineOn(crypto.randomUUID(), -611, 'M4 EXPENSE');
    const seen = await asToken(pool, user, f.c, async () => {
      const r = await applyRules(f.c, f.bank, user);
      return { applied: r.applied, acFree: await pairFree(f.bank, bankC) }; // X still open, its locks held
    }, { session: true });
    expect(seen).toEqual({ applied: 1, acFree: true });
    await pool.query('UPDATE bank_categorisation_rules SET is_active = false WHERE company_id = $1', [f.c]);
  }, 60000);

  it('a transfer rule that matches a line holds its pair until the sweep ends (the control)', async () => {
    await pool.query(`INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern,
       gl_account_id, auto_create_entry, created_by, priority) VALUES ($1,'M4 to C','description','contains','M4 TO C',$2,true,$3,0)`,
    [f.c, bankC, user]);
    await lineOn(crypto.randomUUID(), -612, 'M4 TO C');
    const acFree = await asToken(pool, user, f.c, async () => { await applyRules(f.c, f.bank, user); return pairFree(f.bank, bankC); },
      { session: true });
    expect(acFree).toBe(false);
    await pool.query('UPDATE bank_categorisation_rules SET is_active = false WHERE company_id = $1', [f.c]);
  }, 60000);

  it('the gate takes no pair for a row evaluate() skips (below the confidence floor)', async () => {
    const low = await lineOn(crypto.randomUUID(), -613, 'M4 GATE LOW');
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.10 WHERE id = $1', [low, bankC]);
    const seen = await asToken(pool, user, f.c, async () => {
      const r = await sweep(f.c, [low], 'categorization', user, user);
      return { posted: r.posted, acFree: await pairFree(f.bank, bankC) };
    }, { session: true });
    expect(seen).toEqual({ posted: 0, acFree: true });
  }, 60000);
});
