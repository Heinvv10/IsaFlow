import { describe, expect, it } from 'vitest';
import { DEMO_COMPANY_ID } from '../../../../scripts/lib/demoReseed/constants';
import {
  BALANCE_CACHE_STEP, CASCADE_WITH, KEEP_TABLES, WIPE_STEPS, countSql, crossTenantSql, deleteSql, isAppendOnlyKept, isKept,
} from '../../../../scripts/lib/demoReseed/wipePlan';

const order = (t: string) => WIPE_STEPS.findIndex((s) => s.table === t);

describe('wipe plan', () => {
  it('names no table twice and no table in both lists', () => {
    const names = WIPE_STEPS.map((s) => s.table);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(isKept(n), n).toBe(false);
    expect(new Set(KEEP_TABLES).size).toBe(KEEP_TABLES.length);
  });

  it('scopes every step to the company through $1 and never interpolates the id', () => {
    for (const step of [...WIPE_STEPS, BALANCE_CACHE_STEP]) {
      const del = deleteSql(step);
      expect(del).toMatch(/company_id = \$1::uuid/);
      expect(del).not.toContain(DEMO_COMPANY_ID);
      expect(countSql(step)).toContain(del.replace(/^DELETE FROM \S+ /, ''));
      if (step.via) expect(step.via.length).toBeGreaterThan(0);
    }
  });

  it('orders the steps the triggers need', () => {
    expect(order('gl_journal_lines')).toBeLessThan(order('gl_journal_entries'));
    expect(order('bank_transactions')).toBeLessThan(order('bank_import_batches'));
    expect(order('customer_payment_allocations')).toBeLessThan(order('customer_invoices'));
    expect(order('suppliers')).toBeGreaterThan(order('supplier_invoices'));
  });

  it('keeps setup, identity, calendar and append-only history', () => {
    for (const t of ['cost_centres', 'business_units', 'fiscal_periods', 'fiscal_years', 'gl_accounts', 'audit_log',
      'tax_return_versions', 'entity_changes', 'budget_versions', 'company_document_numbers']) {
      expect(isKept(t), t).toBe(true);
      expect(order(t), t).toBe(-1);
    }
  });

  it('preserves the SARS rows an append-only return version names', () => {
    expect(WIPE_STEPS.find((s) => s.table === 'sars_submissions')?.preserve).toMatch(/tax_return_versions/);
    expect(WIPE_STEPS.find((s) => s.table === 'vat_period_locks')?.preserve).toMatch(/tax_return_versions/);
  });

  it('checks every multi-parent child step for a parent in another company', () => {
    expect(crossTenantSql({ table: 'customers' })).toBeNull();
    expect(crossTenantSql(WIPE_STEPS.find((s) => s.table === 'customer_quote_lines')!)).toBeNull();
    const multi = WIPE_STEPS.filter((s) => (s.via?.length ?? 0) > 1);
    expect(multi.length).toBeGreaterThan(5);
    for (const step of multi) {
      const q = crossTenantSql(step)!;
      for (const [col, parent] of step.via!) expect(q).toContain(`${col} IN (SELECT id FROM ${parent} WHERE company_id <> $1::uuid)`);
      expect(q).not.toContain('00000000-0000-0000-0000-000000000001');
    }
  });

  it('wipes generated AFS documents but keeps the AFS layout, and counts the cascade it cannot keep', () => {
    for (const t of ['afs_documents', 'afs_sections', 'afs_section_comments', 'afs_generation_log']) expect(order(t), t).toBeGreaterThan(-1);
    expect(order('afs_sections')).toBeLessThan(order('afs_documents'));
    expect(isKept('afs_statement_lines')).toBe(true);
    for (const [table] of CASCADE_WITH) expect(isKept(table), table).toBe(true);
  });

  it('treats only the append-only history as unfixable residue', () => {
    for (const t of ['audit_log', 'audit_check_results', 'entity_changes', 'bank_rule_changes', 'tax_return_versions']) expect(isAppendOnlyKept(t), t).toBe(true);
    for (const t of ['budget_versions', 'approval_requests', 'email_log', 'gl_accounts']) expect(isAppendOnlyKept(t), t).toBe(false);
  });
});
