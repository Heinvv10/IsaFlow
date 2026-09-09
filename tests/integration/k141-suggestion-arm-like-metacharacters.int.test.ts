/**
 * K-141 (review H-1) — RED before the fix. `applyRules` has TWO matching arms
 * and only the auto-create one escaped its pattern.
 *
 * The SUGGESTION arm built its ILIKE in SQL from the raw column:
 *
 *   WHEN 'contains' THEN '%' || r.match_pattern || '%'  …  ELSE r.match_pattern
 *
 * so `_` and `%` stayed live wildcards there and `exact` was not exact. That is
 * not a display path: the UPDATE writes `suggested_gl_account_id`,
 * `suggested_supplier_id`, `suggested_client_id` and `suggested_vat_code`, and
 * `autoPostGateService.sweep`'s non-import branch posts exactly those
 * suggestions UNATTENDED — so the over-match still arrived as a posted
 * misallocation, through the gate instead of through the rule.
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
let expenseAccount = '';

/** Run `applyRules` inside one request transaction, as the route does. */
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

/** Descriptions of the rows that came away carrying a suggestion. */
async function suggested(): Promise<string[]> {
  const r = await admin.query(
    `SELECT description FROM bank_transactions
     WHERE company_id = $1 AND suggested_gl_account_id IS NOT NULL
     ORDER BY description`, [COMPANY]);
  return r.rows.map((x: { description: string }) => x.description);
}

async function rule(name: string, matchType: string, pattern: string): Promise<void> {
  await admin.query(
    `INSERT INTO bank_categorisation_rules
       (company_id, rule_name, match_field, match_type, match_pattern,
        gl_account_id, priority, is_active, auto_create_entry)
     VALUES ($1,$2,'description',$3,$4,$5,1,true,false)`,
    [COMPANY, name, matchType, pattern, expenseAccount]);
}

describeIfDb('K-141 H-1 the suggestion arm must escape LIKE metacharacters too', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K141 H1 Suggestion Fixture',true)`, [COMPANY]);
    const bank = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'1000','K141 Bank','asset','bank','debit',true) RETURNING id`, [COMPANY]);
    bankAccount = bank.rows[0].id;
    const exp = await admin.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
         account_subtype, normal_balance, is_active)
       VALUES ($1,'6000','K141 Expense','expense','default_expense','debit',true) RETURNING id`, [COMPANY]);
    expenseAccount = exp.rows[0].id;
  }, 60000);

  beforeEach(async () => {
    await admin.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-01',-15000,'SALARY_JAN','imported'),
              ($1,$2,'2026-03-02',-22,'SALARYXJAN','imported'),
              ($1,$2,'2026-03-03',-33,'DISCOUNT 50% OFF','imported'),
              ($1,$2,'2026-03-04',-44,'DISCOUNT 50ANYTHING OFF','imported')`,
      [COMPANY, bankAccount]);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('exact suggests only the identical description', async () => {
    await rule('K141 exact underscore', 'exact', 'SALARY_JAN');
    await apply();
    expect(await suggested()).toEqual(['SALARY_JAN']);
  });

  it('contains treats _ as a literal underscore', async () => {
    await rule('K141 contains underscore', 'contains', 'SALARY_JAN');
    await apply();
    expect(await suggested()).toEqual(['SALARY_JAN']);
  });

  it('contains treats % as a literal percent sign', async () => {
    await rule('K141 contains percent', 'contains', '50% OFF');
    await apply();
    expect(await suggested()).toEqual(['DISCOUNT 50% OFF']);
  });

  // Adjacent case: the escaping must not break the ordinary rules. A pattern
  // with no metacharacter in it still matches everything it always did.
  it('still suggests on a pattern with no metacharacters', async () => {
    await rule('K141 plain', 'contains', 'SALARY');
    await apply();
    // Sorted in JS rather than compared to the query's own DB-collation order.
    expect([...await suggested()].sort()).toEqual(['SALARYXJAN', 'SALARY_JAN'].sort());
  });

  // Adjacent case: a rule belonging to ANOTHER company must not reach these
  // rows — the unnest join carries the rule id, and the company predicate has
  // to survive that rewrite.
  it('never applies a rule from another company', async () => {
    const other = randomUUID();
    await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'K141 Other',true)`, [other]);
    await admin.query(
      `INSERT INTO bank_categorisation_rules
         (company_id, rule_name, match_field, match_type, match_pattern, priority, is_active, auto_create_entry)
       VALUES ($1,'K141 foreign','description','contains','SALARY',1,true,false)`, [other]);
    try {
      await apply();
      expect(await suggested()).toEqual([]);
    } finally {
      await admin.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [other]);
      await admin.query('DELETE FROM companies WHERE id = $1', [other]);
    }
  });
});
