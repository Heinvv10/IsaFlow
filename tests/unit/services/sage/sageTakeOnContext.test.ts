/**
 * Round 5, item 2: the Retained Earnings account the take-on folds onto is the
 * one the year-end close uses — systemAccountResolver's candidates — not "the
 * first active system row by code". A contested role blocks the import.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), candidates: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountCandidates: m.candidates }));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({ findJournalChainHead: vi.fn() }));

import { readTakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnContext';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { emptyCompany, sageFixture } from './sageFixture';

const holder = (code: string, name: string) => ({ id: `id-${code}`, accountCode: code, accountName: name, accountType: 'equity', accountSubtype: 'retained_earnings', createdAt: 0 });

beforeEach(() => {
  m.sql.mockReset();
  m.sql.mockImplementation(async (s: TemplateStringsArray) => {
    const text = s.join('?');
    // Two active system rows claim retained_earnings; by code, 3100 would win.
    if (text.includes('FROM gl_accounts')) {
      return [
        { account_code: '3100', account_name: 'Old RE', account_type: 'equity', account_subtype: 'retained_earnings', is_system_account: true, is_active: true },
        { account_code: '3200', account_name: 'Retained Earnings', account_type: 'equity', account_subtype: 'retained_earnings', is_system_account: true, is_active: true },
      ];
    }
    if (text.includes('FROM companies')) return [{ functional_currency: 'ZAR' }];
    return [];
  });
});

describe('readTakeOnContext: Retained Earnings', () => {
  it('takes the resolver\'s holder, the one the year-end close posts to', async () => {
    m.candidates.mockResolvedValue([holder('3200', 'Retained Earnings')]);
    const ctx = await readTakeOnContext('co', '2026-10-21');
    expect(m.candidates).toHaveBeenCalledWith('retained_earnings', 'co');
    expect(ctx.existingRoles.retained_earnings).toEqual({ code: '3200', name: 'Retained Earnings', type: 'equity' });
    expect(ctx.contestedRoles).toEqual([]);
  });

  it('a contested role is reported, not picked', async () => {
    m.candidates.mockResolvedValue([holder('3100', 'Old RE'), holder('3200', 'Retained Earnings')]);
    const ctx = await readTakeOnContext('co', '2026-10-21');
    expect(ctx.existingRoles.retained_earnings).toBeUndefined();
    expect(ctx.contestedRoles).toEqual([{ role: 'retained_earnings', codes: ['3100', '3200'] }]);
  });

  it('no holder: the role is left to the take-on to create', async () => {
    m.candidates.mockResolvedValue([]);
    expect((await readTakeOnContext('co', '2026-10-21')).existingRoles.retained_earnings).toBeUndefined();
  });
});

describe('the builder blocks a contested role', () => {
  it('names the accounts and where to fix it', () => {
    const t = buildSageTakeOn(sageFixture(), { ...emptyCompany, contestedRoles: [{ role: 'retained_earnings', codes: ['3100', '3200'] }] });
    expect(t.issues).toContainEqual(expect.objectContaining({
      severity: 'error', area: 'accounts', message: expect.stringMatching(/3100, 3200.*Retained Earnings.*Default Accounts/),
    }));
  });
});
