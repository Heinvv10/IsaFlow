/**
 * An FK on gl_accounts(id) ALONE does not keep a join in-tenant: a bank line can point at another company's GL
 * account, and a user who belongs to both companies sees both through RLS. Across such an edge scope only flows when
 * BOTH aliases are seeded with the caller's company_id.
 */
import { describe, it, expect } from 'vitest';
import { enforceTenantScope } from '@/modules/accounting/services/core/nlQueryScopeGuard';

const A = '11111111-1111-4111-8111-111111111111';

describe('enforceTenantScope — id-only FK edges need both sides seeded', () => {
  it('refuses a GL account seeded to the caller joined to an unseeded bank line (sums another company\'s line)', () => {
    const sql = `SELECT SUM(bt.amount) FROM gl_accounts ga JOIN bank_transactions_posted bt ON bt.bank_account_id = ga.id
      WHERE ga.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(false);
  });

  it('refuses a bank line seeded to the caller joined to an unseeded GL account (leaks its name)', () => {
    const sql = `SELECT ga.account_name, bt.amount FROM bank_transactions_posted bt JOIN gl_accounts ga ON ga.id = bt.bank_account_id
      WHERE bt.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(false);
  });

  it.each([
    ['matched_journal_line_id', 'gl_journal_lines jl', 'jl.id = bt.matched_journal_line_id'],
    ['provisional_je_id', 'gl_journal_entries je', 'je.id = bt.provisional_je_id'],
  ])('refuses an unseeded %s parent', (_c, table, on) => {
    const sql = `SELECT bt.amount FROM bank_transactions_posted bt JOIN ${table} ON ${on} WHERE bt.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(false);
  });

  it('accepts the same joins when both sides carry the caller\'s company_id', () => {
    const sql = `SELECT ga.account_name, SUM(bt.amount) FROM bank_transactions_posted bt
      JOIN gl_accounts ga ON ga.id = bt.bank_account_id
      WHERE bt.company_id = '${A}' AND ga.company_id = '${A}' GROUP BY ga.account_name`;
    expect(enforceTenantScope(sql, A).ok).toBe(true);
  });

  it('keeps an ordinary FK edge propagating (customer -> invoice seeded on one side only)', () => {
    const sql = `SELECT c.name, ci.total_amount FROM customer_invoices ci JOIN customers c ON c.id = ci.customer_id
      WHERE ci.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(true);
  });
});
