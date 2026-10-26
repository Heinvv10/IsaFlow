/**
 * Budgets P1 (migration 947): nl-query reads budget amounts only through the
 * `budget_primary_month_amounts` view, so an LLM-written SUM never adds drafts,
 * reforecasts and scenarios together. The base table is off the allowlist and
 * its FK pair moved to the view.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_TABLES, validateGeneratedSQL } from '@/modules/accounting/services/core/nlQueryValidationService';
import { FK_PAIRS } from '@/modules/accounting/services/core/nlQueryFkPairs';
import { enforceTenantScope } from '@/modules/accounting/services/core/nlQueryScopeGuard';

const CO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('nl-query — budget amounts through the primary-version view', () => {
  it('allowlists the view and not the base table', () => {
    expect(ALLOWED_TABLES.has('budget_primary_month_amounts')).toBe(true);
    expect(ALLOWED_TABLES.has('budget_month_amounts')).toBe(false);
    expect(ALLOWED_TABLES.has('budget_versions')).toBe(false);
  });

  it('carries the view\'s account edge, and no edge of the base table', () => {
    expect(FK_PAIRS.has('budget_primary_month_amounts.gl_account_id|gl_accounts.id')).toBe(true);
    expect([...FK_PAIRS].filter((p) => p.includes('budget_month_amounts.'))).toEqual([]);
  });

  it('rejects a query over the base table', () => {
    expect(validateGeneratedSQL(`SELECT SUM(amount) FROM budget_month_amounts WHERE company_id = '${CO}'`).valid).toBe(false);
  });

  it('accepts the view joined to its account, scoped by company', () => {
    const sql = `SELECT ga.account_name, SUM(b.amount) FROM budget_primary_month_amounts b
      JOIN gl_accounts ga ON ga.id = b.gl_account_id
      WHERE b.company_id = '${CO}' AND ga.company_id = '${CO}' GROUP BY ga.account_name`;
    const v = validateGeneratedSQL(sql);
    expect(v.valid).toBe(true);
    expect(enforceTenantScope(v.sanitizedSQL, CO).ok).toBe(true);
  });
});
