import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ParentJournalControl } from '@/modules/accounting/services/controls/generatedJournalPermit';
import { isAuthorizedYearEndPosting } from '@/modules/accounting/services/controls/yearEndPostingGuard';
const check = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit', () => ({ assertGeneratedJournal: check }));
beforeEach(() => { check.mockReset(); });
const ctx = {} as ControlTx;
const parent = { parent: { entityType: 'fiscal_year', entityId: '2026', operation: 'year.close' },
  permit: { accountingDate: '2026-12-31' } } as ParentJournalControl;
const header = { id: 'journal', status: 'draft', source: 'year_end', entry_number: 'YE-2026' };
const period = { status: 'closed', fiscal_year: 2026, end_date: '2026-12-31' };
it('allows only the registered financial-year child at its approved final date', () => {
  expect(isAuthorizedYearEndPosting(ctx, parent, header, period, '2026-12-31')).toBe(true);
  expect(check).toHaveBeenCalledWith(ctx, parent, 'journal', 'journal.post');
});
it('does not accept a fabricated or unregistered parent capability', () => {
  check.mockImplementation(() => { throw new Error('unregistered'); });
  expect(() => isAuthorizedYearEndPosting(ctx, parent, header, period, '2026-12-31')).toThrow('unregistered');
});
it.each([
  [{ ...header, source: 'manual' }, period, '2026-12-31'],
  [{ ...header, entry_number: 'YE-2025' }, period, '2026-12-31'],
  [header, { ...period, status: 'locked' }, '2026-12-31'],
  [header, { ...period, fiscal_year: 2025 }, '2026-12-31'],
  [header, period, '2026-11-30'],
])('refuses an incompatible year-end child', (journal, target, date) => {
  expect(isAuthorizedYearEndPosting(ctx, parent, journal, target, date)).toBe(false);
});
it('does not exempt direct journal posting or period-only close', () => {
  expect(isAuthorizedYearEndPosting(ctx, { ...parent, parent: { ...parent.parent, operation: 'year.periods_close' } },
    header, period, '2026-12-31')).toBe(false);
});
