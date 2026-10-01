/**
 * K-141 — RED. `toSqlPattern` (bankRulesMatchingHelpers.ts:19-27 on
 * origin/master) wraps a rule's `match_pattern` in `%` and hands it to
 * `description ILIKE ${pattern}` (same file, line 60) without escaping the
 * LIKE metacharacters `_` and `%` the user's own pattern may contain.
 *
 * This is NOT injection — the pattern is a bound parameter. It is over-matching:
 * `_` is ILIKE's single-character wildcard, so a rule keyed on a reference like
 * `SALARY_JAN` also claims `SALARYXJAN`, and the `exact` match type is not
 * exact for any pattern containing one. `applyRules` then auto-posts a journal
 * for every row `findMatchingTxs` returns, so an over-match is a posted
 * misallocation, not a display glitch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import {
  findMatchingTxs,
  toSqlPattern,
} from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let bankAccount: string;

async function ids(pattern: string, matchType: string): Promise<string[]> {
  const c = await admin.connect();
  try {
    const rows = await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never,
      () => findMatchingTxs(COMPANY, bankAccount, 'description', toSqlPattern(matchType, pattern)),
    );
    return rows.map(r => String(r.description)).sort();
  } finally {
    c.release();
  }
}

describeIfDb('K-141 a rule pattern must not act as an ILIKE wildcard', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K141 Rule Pattern Fixture', true)`,
      [COMPANY]);
    const acct = await admin.query(
      `INSERT INTO gl_accounts
         (company_id, account_code, account_name, account_type, account_subtype,
          normal_balance, is_active)
       VALUES ($1, '1000', 'K141 Bank', 'asset', 'bank', 'debit', true)
       RETURNING id`, [COMPANY]);
    bankAccount = acct.rows[0].id;

    // The row the rule is FOR, and the row it must not touch.
    await admin.query(
      `INSERT INTO bank_transactions
         (company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1,$2,'2026-03-01',-15000,'SALARY_JAN','imported'),
              ($1,$2,'2026-03-02',-22,'SALARYXJAN','imported'),
              ($1,$2,'2026-03-03',-33,'DISCOUNT 50% OFF','imported'),
              ($1,$2,'2026-03-04',-44,'DISCOUNT 50ANYTHING OFF','imported'),
              ($1,$2,'2026-03-05',-55,'REF\\PATH 001','imported')`,
      [COMPANY, bankAccount]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM bank_transactions WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('exact matches only the identical description', async () => {
    expect(await ids('SALARY_JAN', 'exact')).toEqual(['SALARY_JAN']);
  });

  it('contains treats _ as a literal underscore', async () => {
    expect(await ids('SALARY_JAN', 'contains')).toEqual(['SALARY_JAN']);
  });

  it('starts_with treats _ as a literal underscore', async () => {
    expect(await ids('SALARY_', 'starts_with')).toEqual(['SALARY_JAN']);
  });

  it('contains treats % as a literal percent sign', async () => {
    expect(await ids('50% OFF', 'contains')).toEqual(['DISCOUNT 50% OFF']);
  });

  // Adjacent case: the escape character itself. Escaping `_` and `%` with a
  // backslash only works if a backslash the operator typed is escaped first.
  it('treats a backslash in the pattern as a literal backslash', async () => {
    expect(await ids('REF\\PATH', 'contains')).toEqual(['REF\\PATH 001']);
    expect(await ids('REF\\_PATH', 'contains')).toEqual([]);
  });

  // Adjacent case: the ordinary pattern must be untouched by the escaping —
  // the correction must not stop rules that never had a metacharacter.
  it('still matches a pattern with no metacharacters in it', async () => {
    expect(await ids('SALARY', 'contains').then(r => r.sort()))
      .toEqual(['SALARYXJAN', 'SALARY_JAN'].sort());
  });
});
