/**
 * #1079 round 3 (breaker M4/M5): the retryable 409 TAX_DIRECTIVE_SPLIT_CHANGED
 * for an account deactivated mid-payment is answered ONLY when every account
 * the GL refused is a mapped labour account of this split, used by nothing
 * else in the journal — the one case the retry's read fixes (it routes that
 * labour to 5200). Anything else is the same refusal as before, never a 409
 * that promises a retry which then fails:
 *  - a mapped 5210 AND 2140 deactivated together;
 *  - labour mapped to the bank account 1110 and 1110 deactivated (the bank
 *    credit line still needs it).
 * The window is a rival claim on the directive's payment row, so both
 * deactivations commit after the payment's re-read. Real routes on the
 * disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { applyStandalone, approvedDirective, cleanSeveranceFixtures, seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: SeveranceFixture;
let acct5210 = '';
const centre = crypto.randomUUID();
let seq = 0;
const number = () => `78${String(++seq).padStart(8, '0')}`;
const deactivate = (code: string) =>
  pool.query('UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = $2', [f.company, code]);
const mapTo = (account: string) =>
  pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $3 WHERE company_id = $1 AND cost_centre_id = $2', [f.company, centre, account]);
const payments = async (directive: string) => Number((await pool.query(
  'SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [directive])).rows[0]!.n);

/** Pays `directive` while a rival holds its claim, running `meanwhile` once the payment waits there (after its re-read). */
async function payInWindow(directive: string, meanwhile: () => Promise<unknown>) {
  const rival = await pool.connect();
  try {
    await rival.query('BEGIN');
    await rival.query(`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount)
                       VALUES ($1,$2,'2026-09-15',1000,180,820)`, [f.company, directive]);
    const paying = applyStandalone(f, directive);
    for (let i = 0; ; i++) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO tax_directive_payments%'`)).rows[0]!.n;
      if (n > 0) break;
      if (i > 100) throw new Error('the payment never waited on the claim');
      await new Promise((r) => setTimeout(r, 50));
    }
    await meanwhile();
    await rival.query('ROLLBACK');
    return await paying;
  } finally {
    await rival.query('ROLLBACK').catch(() => undefined);
    rival.release();
  }
}

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-08-31', 'cc1 directive mixed inactive');
  acct5210 = (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1,'5210','Site labour','expense','debit',1) RETURNING id`, [f.company])).rows[0]!.id;
  await pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,'MIX-A','MIX-A','cc1',true)", [centre, f.company]);
  await pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [f.company, centre, acct5210]);
  await pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,100)',
    [f.company, f.employee, centre]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE gl_accounts SET is_active = true WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM cost_centre_gl_mappings WHERE company_id = $1', [f.company]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM tax_directive_payments WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [f.company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [f.company]);
    await cleanSeveranceFixtures(pool, [f]);
  } finally { await pool.end(); }
});

describe('a retry is promised only when the retry can succeed', () => {
  it('M4: a mapped 5210 and 2140 deactivated together are the plain refusal, not a 409', async () => {
    await mapTo(acct5210);
    try {
      const directive = await approvedDirective(f, 1000, 0.18, '2026-08-31', number());
      const refused = await payInWindow(directive, async () => { await deactivate('5210'); await deactivate('2140'); });
      expect(refused.statusCode).not.toBe(409);
      expect(JSON.stringify(refused.body)).toContain('Cannot post to deactivated GL account');
      expect(JSON.stringify(refused.body)).toContain('2140');
      expect(await payments(directive)).toBe(0);
    } finally {
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE company_id = $1', [f.company]);
    }
  });

  it('M5: labour mapped to the bank 1110, and 1110 deactivated, is the plain refusal, not a 409', async () => {
    const bank = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '1110'", [f.company])).rows[0]!.id;
    await mapTo(bank);
    try {
      const directive = await approvedDirective(f, 1000, 0.18, '2026-08-31', number());
      const refused = await payInWindow(directive, () => deactivate('1110'));
      expect(refused.statusCode).not.toBe(409);
      expect(JSON.stringify(refused.body)).toContain('1110');
      expect(await payments(directive)).toBe(0);
    } finally {
      await mapTo(acct5210);
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE company_id = $1', [f.company]);
    }
  });

  it('control: the mapped 5210 alone is still the retryable 409, and the retry posts to 5200', async () => {
    await mapTo(acct5210);
    try {
      const directive = await approvedDirective(f, 1000, 0.18, '2026-08-31', number());
      const refused = await payInWindow(directive, () => deactivate('5210'));
      expect(refused.statusCode).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('TAX_DIRECTIVE_SPLIT_CHANGED');
      expect((await applyStandalone(f, directive)).statusCode).toBe(200);
    } finally {
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE company_id = $1', [f.company]);
    }
  });
});
