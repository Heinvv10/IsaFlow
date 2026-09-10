/**
 * K-141 (review r3 L5) — two active rules at the same priority must not let
 * heap order decide which one is suggested.
 *
 * `bankRulesSuggestionPass` ranks candidates with
 * `ROW_NUMBER() OVER (PARTITION BY bt.id ORDER BY r.priority ASC)`. `priority`
 * is not unique, so equal-priority rules were separated by whatever order the
 * scan happened to return — and the row this pass writes is what
 * `autoPostGateService.sweep` posts UNATTENDED. The rows below are inserted
 * NEWEST FIRST so the physical order and the intended order disagree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount = '';
let older = '';
let newer = '';

async function apply(): Promise<void> {
  const c: PoolClient = await admin.connect();
  await c.query('BEGIN');
  try {
    await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never,
      () => applyRules(COMPANY, bankAccount, USER),
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function suggestedAccount(): Promise<string | null> {
  const r = await admin.query(
    `SELECT suggested_gl_account_id FROM bank_transactions WHERE company_id = $1`, [COMPANY]);
  return r.rows[0]?.suggested_gl_account_id ?? null;
}

describeIfDb('K-141 L5 equal-priority suggestion rules resolve deterministically', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K141 L5 Tiebreak Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','K141 L5 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
    const accts = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'6001','K141 L5 Older','expense','default_expense','debit',true),
              ($1,'6002','K141 L5 Newer','expense','default_expense','debit',true)
       RETURNING id`, [COMPANY]);
    older = accts.rows[0].id;
    newer = accts.rows[1].id;
  }, 60000);

  beforeEach(async () => {
    await admin.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-01',-99,'WOOLWORTHS SANDTON','imported')`,
      [COMPANY, bankAccount]);
    // Physical order is newest-first: without the created_at tiebreaker the
    // scan hands the ranking the NEWER rule and it wins.
    await admin.query(
      `INSERT INTO bank_categorisation_rules
         (company_id, rule_name, match_field, match_type, match_pattern,
          gl_account_id, priority, is_active, auto_create_entry, created_at)
       VALUES ($1,'K141 L5 newer','description','contains','WOOLWORTHS',$2,5,true,false,
               NOW() + interval '1 hour'),
              ($1,'K141 L5 older','description','contains','WOOLWORTHS',$3,5,true,false,
               NOW() - interval '1 hour')`,
      [COMPANY, newer, older]);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('the older rule wins the tie, not the one the scan returns first', async () => {
    await apply();
    expect(await suggestedAccount()).toBe(older);
  });

  // Adjacent case: the tiebreaker is a tiebreaker — priority still decides
  // first, even when the higher-priority rule is the newer one.
  it('priority still outranks created_at', async () => {
    await admin.query(
      `UPDATE bank_categorisation_rules SET priority = 1
       WHERE company_id = $1 AND rule_name = 'K141 L5 newer'`, [COMPANY]);
    await apply();
    expect(await suggestedAccount()).toBe(newer);
  });
});
