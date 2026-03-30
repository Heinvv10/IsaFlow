// RED phase — written before implementation
/**
 * Unit tests for migration validation logic — pure/extractable functions only.
 *
 * DB-backed validation (validateMigration, checkTrialBalance etc.) require
 * integration tests. This file tests:
 *   - matchContact helper (migrationImportService.ts) — pure, no DB
 *   - Opening balance imbalance detection (pure logic extracted for testability)
 *   - Status derivation logic used in AR/AP import
 *   - COA sort order (accounts without parents before those with parents)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock DB and all service dependencies so module-level sql call doesn't throw
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
  clearSystemAccountCache: vi.fn(),
  validateSystemAccounts: vi.fn(),
}));
vi.mock('@/modules/accounting/services/migrationService', () => ({
  updateSession: vi.fn(),
}));

import { matchContact } from '@/modules/accounting/services/migrationImportService';

// ── matchContact ─────────────────────────────────────────────────────────────

describe('matchContact — exact matching', () => {
  const candidates = [
    { id: 'cust-001', name: 'Acme Corp' },
    { id: 'cust-002', name: 'Beta Supplies' },
    { id: 'cust-003', name: 'Gamma Trading' },
  ];

  it('matches exact name (case-insensitive)', () => {
    const id = matchContact('Acme Corp', candidates);
    expect(id).toBe('cust-001');
  });

  it('matches case-insensitively', () => {
    const id = matchContact('acme corp', candidates);
    expect(id).toBe('cust-001');
  });

  it('matches with leading/trailing whitespace', () => {
    const id = matchContact('  Beta Supplies  ', candidates);
    expect(id).toBe('cust-002');
  });

  it('returns null for no match', () => {
    const id = matchContact('Unknown Company', candidates);
    expect(id).toBeNull();
  });

  it('returns null for empty candidates array', () => {
    const id = matchContact('Acme Corp', []);
    expect(id).toBeNull();
  });

  it('returns null for empty name', () => {
    const id = matchContact('', candidates);
    expect(id).toBeNull();
  });
});

describe('matchContact — fuzzy matching (dice coefficient >= 0.7)', () => {
  const candidates = [
    { id: 'cust-001', name: 'Acme Enterprises' },
    { id: 'cust-002', name: 'Widget Factory' },
    { id: 'cust-003', name: 'Delta Construction' },
  ];

  it('matches near-duplicate name (typo)', () => {
    // 'Acme Enterpriises' should fuzzy-match 'Acme Enterprises'
    const id = matchContact('Acme Enterpriises', candidates);
    expect(id).toBe('cust-001');
  });

  it('matches abbreviated name above threshold', () => {
    // 'Widget Factori' (close enough via dice)
    const id = matchContact('Widget Factori', candidates);
    expect(id).toBe('cust-002');
  });

  it('does not match very different names', () => {
    const id = matchContact('Totally Unrelated XYZ', candidates);
    expect(id).toBeNull();
  });

  it('picks the better match when multiple candidates qualify', () => {
    const candidates2 = [
      { id: 'cust-001', name: 'Acme Corp' },
      { id: 'cust-002', name: 'Acme Corporation' },
    ];
    // Exact match on 'Acme Corp' should win
    const id = matchContact('Acme Corp', candidates2);
    expect(id).toBe('cust-001');
  });
});

// ── Opening balance imbalance detection ──────────────────────────────────────
// Tests the business rule: throw when |totalDebit - totalCredit| > 0.01

describe('Opening balance imbalance detection logic', () => {
  function checkBalance(balances: Array<{ debit: number; credit: number }>): boolean {
    const totalDebit  = balances.reduce((s, b) => s + (b.debit ?? 0), 0);
    const totalCredit = balances.reduce((s, b) => s + (b.credit ?? 0), 0);
    return Math.abs(totalDebit - totalCredit) <= 0.01;
  }

  it('accepts balanced trial balance (debit === credit)', () => {
    const balances = [
      { debit: 100000, credit: 0 },
      { debit: 0,      credit: 100000 },
    ];
    expect(checkBalance(balances)).toBe(true);
  });

  it('accepts trial balance within 0.01 tolerance', () => {
    const balances = [
      { debit: 100000.00, credit: 0 },
      { debit: 0,         credit: 99999.995 },
    ];
    expect(checkBalance(balances)).toBe(true);
  });

  it('rejects imbalanced trial balance by more than 0.01', () => {
    const balances = [
      { debit: 100000, credit: 0 },
      { debit: 0,      credit: 99900 },
    ];
    expect(checkBalance(balances)).toBe(false);
  });

  it('accepts empty balance array as balanced (zero equals zero)', () => {
    expect(checkBalance([])).toBe(true);
  });

  it('rejects when only debit entries exist', () => {
    const balances = [{ debit: 50000, credit: 0 }];
    expect(checkBalance(balances)).toBe(false);
  });

  it('rejects when only credit entries exist', () => {
    const balances = [{ debit: 0, credit: 50000 }];
    expect(checkBalance(balances)).toBe(false);
  });

  it('handles multiple rows that sum correctly', () => {
    const balances = [
      { debit: 30000, credit: 0 },
      { debit: 20000, credit: 0 },
      { debit: 0,     credit: 50000 },
    ];
    expect(checkBalance(balances)).toBe(true);
  });

  it('handles floating point amounts without rounding errors', () => {
    const balances = [
      { debit: 1234.56, credit: 0 },
      { debit: 0,       credit: 1234.56 },
    ];
    expect(checkBalance(balances)).toBe(true);
  });
});

// ── Invoice status derivation (AR/AP) ────────────────────────────────────────
// Tests the business rule for determining invoice status from amounts paid

describe('Invoice status derivation logic', () => {
  function deriveStatus(totalAmount: number, amountPaid: number): string {
    const balance = totalAmount - (amountPaid ?? 0);
    if (balance <= 0) return 'paid';
    if (amountPaid > 0) return 'partially_paid';
    return 'approved';
  }

  it('returns "paid" when fully paid', () => {
    expect(deriveStatus(11500, 11500)).toBe('paid');
  });

  it('returns "paid" when overpaid (credit note scenario)', () => {
    expect(deriveStatus(11500, 12000)).toBe('paid');
  });

  it('returns "partially_paid" when partially paid', () => {
    expect(deriveStatus(11500, 5000)).toBe('partially_paid');
  });

  it('returns "approved" when no payment made', () => {
    expect(deriveStatus(11500, 0)).toBe('approved');
  });

  it('returns "approved" for zero amount paid on large invoice', () => {
    expect(deriveStatus(100000, 0)).toBe('approved');
  });

  it('returns "paid" for zero total and zero paid', () => {
    expect(deriveStatus(0, 0)).toBe('paid');
  });
});

// ── COA sort order (parent-first hierarchy) ───────────────────────────────────
// Tests that accounts without parents sort before those with parents

describe('COA sort order — parents before children', () => {
  interface AccountRow { accountCode: string; parentCode?: string }

  function sortAccounts(accounts: AccountRow[]): AccountRow[] {
    return [
      ...accounts.filter(a => !a.parentCode),
      ...accounts.filter(a => a.parentCode),
    ];
  }

  it('places root accounts (no parentCode) before child accounts', () => {
    const accounts: AccountRow[] = [
      { accountCode: '1100', parentCode: '1000' },
      { accountCode: '1000' },
      { accountCode: '2000' },
      { accountCode: '2100', parentCode: '2000' },
    ];
    const sorted = sortAccounts(accounts);
    const rootCodes = sorted.filter(a => !a.parentCode).map(a => a.accountCode);
    const childCodes = sorted.filter(a => a.parentCode).map(a => a.accountCode);
    expect(rootCodes).toContain('1000');
    expect(rootCodes).toContain('2000');
    expect(childCodes).toContain('1100');
    expect(childCodes).toContain('2100');
    // All roots appear before all children in the sorted array
    const lastRootIndex = Math.max(...rootCodes.map(c => sorted.findIndex(a => a.accountCode === c)));
    const firstChildIndex = Math.min(...childCodes.map(c => sorted.findIndex(a => a.accountCode === c)));
    expect(lastRootIndex).toBeLessThan(firstChildIndex);
  });

  it('preserves all accounts when sorting', () => {
    const accounts: AccountRow[] = [
      { accountCode: '1100', parentCode: '1000' },
      { accountCode: '1000' },
      { accountCode: '1110', parentCode: '1100' },
    ];
    const sorted = sortAccounts(accounts);
    expect(sorted).toHaveLength(3);
  });

  it('handles all root accounts (no children)', () => {
    const accounts: AccountRow[] = [
      { accountCode: '1000' },
      { accountCode: '2000' },
    ];
    const sorted = sortAccounts(accounts);
    expect(sorted).toHaveLength(2);
    expect(sorted.every(a => !a.parentCode)).toBe(true);
  });

  it('handles all child accounts (unusual but valid)', () => {
    const accounts: AccountRow[] = [
      { accountCode: '1100', parentCode: '1000' },
      { accountCode: '1110', parentCode: '1100' },
    ];
    const sorted = sortAccounts(accounts);
    expect(sorted).toHaveLength(2);
    expect(sorted.every(a => a.parentCode)).toBe(true);
  });

  it('handles empty array', () => {
    expect(sortAccounts([])).toHaveLength(0);
  });
});

// ── System account subtype mapping ────────────────────────────────────────────
// Tests that systemAccountMap correctly identifies system accounts by code

describe('System account subtype mapping logic', () => {
  const systemAccountMap = {
    bank: '1110',
    receivable: '1120',
    payable: '2110',
    vat_input: '1140',
    vat_output: '2120',
    retained_earnings: '3200',
    default_revenue: '4100',
    default_expense: '5100',
    admin_expense: '5200',
  };

  function resolveSubtype(accountCode: string): { subtype: string; isSystem: boolean } | null {
    const entry = Object.entries(systemAccountMap).find(([, code]) => code === accountCode);
    if (!entry) return null;
    return { subtype: entry[0], isSystem: true };
  }

  it('identifies bank account by code', () => {
    const result = resolveSubtype('1110');
    expect(result).not.toBeNull();
    expect(result!.subtype).toBe('bank');
    expect(result!.isSystem).toBe(true);
  });

  it('identifies receivable account', () => {
    const result = resolveSubtype('1120');
    expect(result!.subtype).toBe('receivable');
  });

  it('identifies payable account', () => {
    const result = resolveSubtype('2110');
    expect(result!.subtype).toBe('payable');
  });

  it('identifies VAT input account', () => {
    const result = resolveSubtype('1140');
    expect(result!.subtype).toBe('vat_input');
  });

  it('identifies VAT output account', () => {
    const result = resolveSubtype('2120');
    expect(result!.subtype).toBe('vat_output');
  });

  it('returns null for non-system account codes', () => {
    expect(resolveSubtype('9999')).toBeNull();
    expect(resolveSubtype('1000')).toBeNull();
  });

  it('returns null for empty code', () => {
    expect(resolveSubtype('')).toBeNull();
  });

  it('identifies retained earnings', () => {
    const result = resolveSubtype('3200');
    expect(result!.subtype).toBe('retained_earnings');
  });

  it('identifies default revenue', () => {
    const result = resolveSubtype('4100');
    expect(result!.subtype).toBe('default_revenue');
  });

  it('identifies default expense', () => {
    const result = resolveSubtype('5100');
    expect(result!.subtype).toBe('default_expense');
  });
});

// ── Sage Cloud 3-digit code validation ───────────────────────────────────────

describe('Account code format validation', () => {
  function isSageCloudCode(code: string): boolean {
    // Sage Cloud uses 3-digit codes (1-999)
    return /^\d{3}$/.test(code);
  }

  function isSage50Code(code: string): boolean {
    // Sage 50/Pastel uses 7-digit codes
    return /^\d{7}$/.test(code);
  }

  it('recognizes Sage Cloud 3-digit codes', () => {
    expect(isSageCloudCode('100')).toBe(true);
    expect(isSageCloudCode('410')).toBe(true);
    expect(isSageCloudCode('999')).toBe(true);
  });

  it('rejects non-3-digit codes as Sage Cloud', () => {
    expect(isSageCloudCode('1000')).toBe(false);
    expect(isSageCloudCode('10')).toBe(false);
    expect(isSageCloudCode('1000000')).toBe(false);
  });

  it('recognizes Sage 50 7-digit codes', () => {
    expect(isSage50Code('1000000')).toBe(true);
    expect(isSage50Code('4100000')).toBe(true);
    expect(isSage50Code('9999999')).toBe(true);
  });

  it('rejects non-7-digit codes as Sage 50', () => {
    expect(isSage50Code('100')).toBe(false);
    expect(isSage50Code('10000')).toBe(false);
    expect(isSage50Code('100000000')).toBe(false);
  });

  it('Sage Cloud and Sage 50 are mutually exclusive', () => {
    const codes = ['100', '1000', '1000000'];
    for (const code of codes) {
      const isSageC = isSageCloudCode(code);
      const isSage5 = isSage50Code(code);
      expect(isSageC && isSage5).toBe(false);
    }
  });
});
