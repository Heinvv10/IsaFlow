/**
 * A-15 — nl-query reads bank lines only through the `bank_transactions_posted`
 * view (migration 675), so a pending or removed feed row can never reach an
 * LLM-written total. The base table is off the allowlist.
 */
import { describe, expect, it } from 'vitest';
import { validateGeneratedSQL } from '@/modules/accounting/services/core/nlQueryValidationService';
import { enforceTenantScope } from '@/modules/accounting/services/core/nlQueryScopeGuard';

const CO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('nl-query — bank lines through the posted-only view', () => {
  it('accepts the view and scopes it by company_id', () => {
    const sql = `SELECT SUM(amount) FROM bank_transactions_posted WHERE company_id = '${CO}'`;
    const v = validateGeneratedSQL(sql);
    expect(v.valid).toBe(true);
    expect(enforceTenantScope(v.sanitizedSQL, CO).ok).toBe(true);
  });

  it('rejects the base table', () => {
    const v = validateGeneratedSQL(`SELECT SUM(amount) FROM bank_transactions WHERE company_id = '${CO}'`);
    expect(v.valid).toBe(false);
  });

  it('keeps the view joinable to its GL account', () => {
    const sql = `SELECT ga.account_name, SUM(bt.amount) FROM bank_transactions_posted bt
      JOIN gl_accounts ga ON ga.id = bt.bank_account_id
      WHERE bt.company_id = '${CO}' AND ga.company_id = '${CO}' GROUP BY ga.account_name`;
    const v = validateGeneratedSQL(sql);
    expect(v.valid).toBe(true);
    expect(enforceTenantScope(v.sanitizedSQL, CO).ok).toBe(true);
  });
});
