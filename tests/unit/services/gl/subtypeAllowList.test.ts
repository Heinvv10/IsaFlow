/**
 * The subtypes system accounts actually carry fit their type — one map
 * (GL_ACCOUNT_SUBTYPES_BY_TYPE) feeds the health check, the resolver's
 * typeFitsSubtype, update_gl_account's enum and the contra-settlement
 * classifier, so they can no longer disagree.
 *
 * chart_of_accounts_health reported 2140/2150/2160/2170/2175
 * (payroll_liability), 5810 (finance_cost), 1130 (cash), BL1024
 * (long_term_liability) and 2215 (current_liability) as
 * subtype_does_not_fit_type, although every one is canonical in
 * accountSubtypeVocabulary.
 */
import { describe, expect, it } from 'vitest';
import { classifyAccount, type ChartAccount } from '@/modules/accounting/services/gl/chartOfAccountsHealth';
import { typeFitsSubtype } from '@/modules/accounting/services/gl/systemAccountResolver';
import { subtypeErrorFor } from '@/modules/accounting/services/gl/accountSubtypeRules';
import { canonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { GL_ACCOUNT_SUBTYPES, GL_ACCOUNT_SUBTYPES_BY_TYPE } from '@/modules/accounting/types/glAccountSubtypes';
import { updateGlAccountTool } from '@/lib/mcp/tools/writeGlAccounts';

const SYSTEM_SHAPES: [string, string, string][] = [
  ['2140', 'liability', 'payroll_liability'],
  ['2170', 'liability', 'payroll_liability'],
  ['5810', 'expense', 'finance_cost'],
  ['1130', 'asset', 'cash'],
  ['BL1024', 'liability', 'long_term_liability'],
  ['2215', 'liability', 'current_liability'],
];

const acct = (code: string, type: string, subtype: string): ChartAccount => ({
  id: code, accountCode: code, accountName: code, accountType: type, accountSubtype: subtype,
  isActive: true, isSystemAccount: true, importedFrom: null, postedLines: 1, balance: 0,
});

describe('subtype allow-list', () => {
  it.each(SYSTEM_SHAPES)('%s (%s / %s) is not flagged subtype_does_not_fit_type', (code, type, subtype) => {
    expect(classifyAccount(acct(code, type, subtype))).not.toContain('subtype_does_not_fit_type');
    expect(typeFitsSubtype(type, subtype)).toBe(true);
    expect(subtypeErrorFor({ accountType: type as never }, subtype)).toBeNull();
  });

  it('update_gl_account offers every allowed subtype (the enum is derived from the same map)', () => {
    const props = (updateGlAccountTool.inputSchema as { properties: Record<string, { enum?: unknown[] }> }).properties;
    const subtypeEnum = Object.values(props).find((p) => Array.isArray(p.enum) && p.enum.includes('payroll_liability'));
    expect(subtypeEnum?.enum).toEqual(expect.arrayContaining(['cash', 'finance_cost', 'long_term_liability', 'current_liability']));
  });

  it('every allowed subtype is canonical vocabulary, except the system-role spellings the resolver keys on', () => {
    const resolverOnly = new Set(['tax', 'default_revenue', 'default_expense', 'disposal_profit_loss', 'other']);
    for (const s of GL_ACCOUNT_SUBTYPES) {
      if (resolverOnly.has(s)) continue;
      expect(canonicalSubtype(s), s).not.toBeNull();
    }
  });

  it('still refuses a subtype on the wrong type', () => {
    expect(typeFitsSubtype('asset', 'payroll_liability')).toBe(false);
    expect(typeFitsSubtype('liability', 'finance_cost')).toBe(false);
    expect((GL_ACCOUNT_SUBTYPES_BY_TYPE.asset as readonly string[]).includes('long_term_liability')).toBe(false);
  });
});
