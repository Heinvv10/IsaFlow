/**
 * Revenue and expense accounts must carry a subtype at creation.
 *
 * The income statement bands on `account_subtype`: `cost_of_sales` sits
 * above gross profit, everything else below it, and NULL is silently
 * "everything else". Velocity Fibre's Sage import wrote 77 revenue/expense
 * accounts with no subtype at all, so R82.7m of direct costs sat under
 * operating expenses and gross margin read 96.6% instead of about −1.9%.
 * Nothing on any create path refused the blank — this file is that refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/cache', () => ({ cache: { invalidatePrefix: vi.fn() }, cacheThrough: vi.fn() }));

import { sql } from '@/lib/neon';
import { missingSubtypeError } from '@/modules/accounting/services/gl/accountSubtypeRules';
import { createAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { templateLinesFor } from '@/modules/accounting/services/gl/chartOfAccountsImportService';

const CO = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { vi.clearAllMocks(); });

describe('missingSubtypeError', () => {
  it('refuses a blank subtype on revenue and expense accounts', () => {
    expect(missingSubtypeError('expense', undefined)).toContain('required');
    expect(missingSubtypeError('expense', '')).toContain('required');
    expect(missingSubtypeError('revenue', null)).toContain('required');
  });
  it('allows a blank subtype on balance-sheet accounts', () => {
    expect(missingSubtypeError('asset', undefined)).toBeNull();
    expect(missingSubtypeError('liability', '')).toBeNull();
    expect(missingSubtypeError('equity', null)).toBeNull();
  });
  it('is satisfied by any present value — validity is subtypeErrorFor’s job', () => {
    expect(missingSubtypeError('expense', 'cost_of_sales')).toBeNull();
    expect(missingSubtypeError('revenue', 'revenue')).toBeNull();
  });
});

describe('createAccount', () => {
  it('refuses an expense account with no subtype before touching the database', async () => {
    await expect(createAccount(CO, {
      accountCode: '5999', accountName: 'Sundry', accountType: 'expense', normalBalance: 'debit',
    })).rejects.toThrow(/subtype.*required/i);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('chart templates', () => {
  it('seed every revenue and expense line with a subtype', () => {
    for (const template of ['isaflow_standard', 'xero_compatible', 'sage_compatible'] as const) {
      const bare = templateLinesFor(template)
        .filter(l => (l.type === 'revenue' || l.type === 'expense') && !l.subtype)
        .map(l => `${template}:${l.code}`);
      expect(bare).toEqual([]);
    }
  });
});
