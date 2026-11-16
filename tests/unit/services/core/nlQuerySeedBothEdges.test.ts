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

  it('refuses a single-seeded id-only edge that is not a bank pair (a credit note into a customer)', () => {
    const sql = `SELECT c.name, cn.total_amount FROM credit_notes cn JOIN customers c ON c.id = cn.client_id
      WHERE cn.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(false);
  });

  it('refuses a single-seeded customer -> invoice join in either direction', () => {
    const fromInvoice = `SELECT c.name FROM customer_invoices ci JOIN customers c ON c.id = ci.customer_id WHERE ci.company_id = '${A}'`;
    const fromCustomer = `SELECT ci.total_amount FROM customers c JOIN customer_invoices ci ON ci.customer_id = c.id WHERE c.company_id = '${A}'`;
    expect(enforceTenantScope(fromInvoice, A).ok).toBe(false);
    expect(enforceTenantScope(fromCustomer, A).ok).toBe(false);
  });

  it('accepts a legitimate multi-table query when every alias is seeded', () => {
    const sql = `SELECT c.name, ci.invoice_number, ga.account_name FROM customer_invoices ci
      JOIN customers c ON c.id = ci.customer_id
      JOIN customer_payments cp ON cp.client_id = c.id
      JOIN gl_accounts ga ON ga.id = cp.bank_account_id
      WHERE ci.company_id = '${A}' AND c.company_id = '${A}' AND cp.company_id = '${A}' AND ga.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(true);
  });

  it('still lets scope reach a child table that has no company_id of its own (invoice items)', () => {
    const sql = `SELECT cii.description FROM customer_invoices ci JOIN customer_invoice_items cii ON cii.invoice_id = ci.id
      WHERE ci.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(true);
  });

  it('lets scope flow across a composite (id, company_id) FK from one seeded side', () => {
    const sql = `SELECT jl.debit FROM gl_accounts ga JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
      WHERE ga.company_id = '${A}'`;
    expect(enforceTenantScope(sql, A).ok).toBe(true);
  });
});
