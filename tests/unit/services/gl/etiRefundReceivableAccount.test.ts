/**
 * The ETI refund receivable (migration 974; wave 5 ET, Hein ruling R-C): a current-asset system role, in every chart
 * template and in the seeder, so the August/February payroll journal can book ETI claimed back (ETI Act s10(1)).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSubtype, isCurrentSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';
import { GL_ACCOUNT_SUBTYPES_BY_TYPE, SYSTEM_RESERVED_SUBTYPES } from '@/modules/accounting/types/glAccountSubtypes';
import { getTemplateLines } from '@/modules/accounting/services/gl/chartOfAccountsImportService';

const SUBTYPE = 'eti_refund_receivable';

describe('eti_refund_receivable', () => {
  it('is a classified current asset, a system role, reserved, and legal only on an asset', () => {
    expect(canonicalSubtype(SUBTYPE)).toBe(SUBTYPE);
    expect(isCurrentSubtype('asset', SUBTYPE)).toBe(true);
    expect(SYSTEM_ACCOUNT_KEYS).toContain(SUBTYPE);
    expect(SYSTEM_RESERVED_SUBTYPES).toContain(SUBTYPE);
    expect(GL_ACCOUNT_SUBTYPES_BY_TYPE.asset as readonly string[]).toContain(SUBTYPE);
    expect(GL_ACCOUNT_SUBTYPES_BY_TYPE.liability as readonly string[]).not.toContain(SUBTYPE);
  });

  it.each(['isaflow_standard', 'xero_compatible', 'sage_compatible'] as const)(
    'template %s carries exactly one, as a system account, and no two rows share a code or display order', (t) => {
      const lines = getTemplateLines(t);
      const eti = lines.filter((l) => l.subtype === SUBTYPE);
      expect(eti).toHaveLength(1);
      expect(eti[0]!.isSystem).toBe(true);
      expect(new Set(lines.map((l) => l.code)).size).toBe(lines.length);
      expect(new Set(lines.map((l) => l.displayOrder)).size).toBe(lines.length);
    });

  it('migration 974 seeds it for new companies (1150) and backfills every company with a chart, idempotently', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts/migrations/sql/974_eti_refund_receivable_account.sql'), 'utf8');
    expect(sql).toMatch(/\('1150', 'ETI refund receivable \(SARS\)',\s+'asset',\s+'eti_refund_receivable',\s+'debit',\s+116, true,\s+'1100'\)/);
    expect(sql).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM public\.gl_accounts g\s+WHERE g\.company_id = c\.id AND g\.account_subtype = 'eti_refund_receivable'\s*\)/);
    expect(sql).toContain("WHERE signature = 'seed_company_chart_of_accounts(uuid)'");
  });
});
