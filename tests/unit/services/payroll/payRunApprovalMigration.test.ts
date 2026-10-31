import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve('scripts/migrations/sql/951_pay_run_approval.sql'), 'utf8');

describe('migration 951 pay-run approval contract', () => {
  it('makes every existing and future company enforce the fixed all-runs rule', () => {
    expect(migration).toContain("'All pay runs', 'pay_run', 'total', 'any'");
    expect(migration).toContain('AFTER INSERT ON public.companies');
    expect(migration).toContain('trg_pay_run_enforcement_immutable');
  });

  it('keeps fixed rows immutable while allowing an owning-company cascade', () => {
    expect(migration).toMatch(/approval_rules_company_id_fkey[\s\S]*ON DELETE CASCADE/);
    expect(migration).toMatch(/approval_enforcement_company_id_fkey[\s\S]*ON DELETE CASCADE/);
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)');
  });

  it('uses the last calculator, including bureau staff, as the content author', () => {
    expect(migration).toContain('ARRAY[h.prepared_by]');
    expect(migration).toContain("p_document_type = 'pay_run'");
    expect(migration).toContain('AND h.prepared_by IS NOT NULL AND h.approval_plan_hash IS NOT NULL');
  });

  it('grandfathers only historical approved and paid runs', () => {
    expect(migration).toContain("WHERE status IN ('approved', 'paid')");
    expect(migration).not.toMatch(/WHERE status IN \([^)]*calculated/);
  });

  it('binds R-035 to payroll planHash through the durable digest', () => {
    expect(migration).toContain('h.approval_plan_hash');
    expect(migration).toContain('approval_document_digest_pre_payroll_951');
  });

  it('documents a rollback that can retain pay-run request history', () => {
    expect(migration).toContain("set pay_run approval requests' rule_id to NULL");
    expect(migration).toContain('drop uq_approval_rules_one_pay_run');
    expect(migration).toContain('drop all three 951 triggers');
  });
});
