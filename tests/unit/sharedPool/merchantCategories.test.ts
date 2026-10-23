import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MERCHANT_CATEGORIES, MERCHANT_CATEGORY_LIST_VERSION, normaliseAccountName,
} from '@/modules/accounting/services/sharedPool/merchantCategories';
import { proposeAutoMappings, type MappingAccount } from '@/modules/accounting/services/sharedPool/categoryMappingService';

describe('MERCHANT_CATEGORIES', () => {
  it('has about thirty unique codes in the code shape the table accepts', () => {
    expect(MERCHANT_CATEGORIES.length).toBeGreaterThanOrEqual(30);
    const codes = MERCHANT_CATEGORIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-z][a-z_]{1,39}$/);
  });

  it('salaries is mappable but never poolable', () => {
    expect(MERCHANT_CATEGORIES.find((c) => c.code === 'salaries')).toMatchObject({ poolable: false });
    expect(MERCHANT_CATEGORIES.filter((c) => !c.poolable).map((c) => c.code)).toEqual(['salaries']);
  });

  it('aliases are written in normalised form (so auto-map can match them)', () => {
    for (const c of MERCHANT_CATEGORIES) for (const a of c.aliases) expect(normaliseAccountName(a)).toBe(a);
  });

  it('is exactly what migration 905 seeds (code, label, poolable, order, list version)', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts/migrations/sql/905_merchant_category_mappings.sql'), 'utf8');
    const seeded = [...sql.matchAll(/\('([a-z_]+)', '((?:[^']|'')+)', (\d+), (true|false), (\d+)\)/g)]
      .map((m) => ({ code: m[1], label: m[2]!.replace(/''/g, "'"), version: Number(m[3]), poolable: m[4] === 'true', order: Number(m[5]) }));
    expect(seeded).toEqual(MERCHANT_CATEGORIES.map((c, i) => ({
      code: c.code, label: c.label, version: MERCHANT_CATEGORY_LIST_VERSION, poolable: c.poolable, order: i + 1,
    })));
  });
});

describe('normaliseAccountName', () => {
  it('upper-cases, spells & as AND, and drops punctuation', () => {
    expect(normaliseAccountName('Rent & Premises')).toBe('RENT AND PREMISES');
    expect(normaliseAccountName('  telephone/fax ')).toBe('TELEPHONE FAX');
    expect(normaliseAccountName('Salaries & Wages')).toBe('SALARIES AND WAGES');
  });
});

describe('proposeAutoMappings', () => {
  const acct = (id: string, accountName: string): MappingAccount => ({ id, accountCode: null, accountName });

  it('maps the isaflow_standard and 476 chart names by name', () => {
    const r = proposeAutoMappings([
      acct('a1', 'Bank Charges'), acct('a2', 'Rent & Premises'), acct('a3', 'Transport & Fuel'),
      acct('a4', 'Salaries & Wages'), acct('a5', 'Interest Expense'), acct('a6', 'Administrative Expenses'),
    ], new Set());
    expect(r.proposals).toEqual([
      { categoryCode: 'fuel', glAccountId: 'a3' },
      { categoryCode: 'bank_charges', glAccountId: 'a1' },
      { categoryCode: 'interest_paid', glAccountId: 'a5' },
      { categoryCode: 'rent', glAccountId: 'a2' },
      { categoryCode: 'salaries', glAccountId: 'a4' },
    ]);
    expect(r.ambiguous).toEqual([]);
  });

  it('a category two accounts match is ambiguous and left for a person', () => {
    const r = proposeAutoMappings([acct('a1', 'Telephone'), acct('a2', 'Cellphones')], new Set());
    expect(r.proposals.find((p) => p.categoryCode === 'telephone')).toBeUndefined();
    expect(r.ambiguous).toContain('telephone');
  });

  it('never proposes for a category already mapped', () => {
    const r = proposeAutoMappings([acct('a1', 'Fuel')], new Set(['fuel']));
    expect(r.proposals).toEqual([]);
  });

  it('a near-miss name is not matched (exact alias only)', () => {
    const r = proposeAutoMappings([acct('a1', 'Fuel for directors car'), acct('a2', 'Bank')], new Set());
    expect(r.proposals).toEqual([]);
  });
});
