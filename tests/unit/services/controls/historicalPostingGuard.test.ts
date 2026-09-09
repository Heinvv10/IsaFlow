import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ParentJournalControl } from '@/modules/accounting/services/controls/generatedJournalPermit';
import { isAuthorizedHistoricalPosting } from '@/modules/accounting/services/controls/historicalPostingGuard';
const check = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit', () => ({ assertGeneratedJournal: check }));
beforeEach(() => { check.mockReset(); });
const ctx = {} as ControlTx;
const parent = { parent: { entityType: 'historical_import', entityId: '11111111-1111-4111-8111-111111111111', operation: 'historical_import.post' },
  permit: { accountingDate: '2026-12-31' } } as ParentJournalControl;
const header = { id: 'journal', status: 'draft', source: 'auto_gl_import', entry_number: 'HI-11111111-1111-4111-8111-111111111111', source_record_id:'11111111-1111-4111-8111-111111111111' };
const period = { status: 'closed', start_date:'2026-12-01', end_date: '2026-12-31' };
it('allows only the registered historical child at its approved date', () => {
  expect(isAuthorizedHistoricalPosting(ctx, parent, header, period, '2026-12-31')).toBe(true);
  expect(check).toHaveBeenCalledWith(ctx, parent, 'journal', 'journal.post');
});
it('does not accept a fabricated or unregistered parent capability', () => {
  check.mockImplementation(() => { throw new Error('unregistered'); });
  expect(() => isAuthorizedHistoricalPosting(ctx, parent, header, period, '2026-12-31')).toThrow('unregistered');
});
it.each([
  [{ ...header, source: 'manual' }, period, '2026-12-31'],
  [{ ...header, entry_number: 'HI-wrong' }, period, '2026-12-31'],
  [header, { ...period, status: 'locked' }, '2026-12-31'],
  [header, { ...period, start_date: '2027-01-01' }, '2026-12-31'],
  [header, period, '2026-11-30'],
])('refuses an incompatible year-end child', (journal, target, date) => {
  expect(isAuthorizedHistoricalPosting(ctx, parent, journal, target, date)).toBe(false);
});
it('does not exempt direct journal posting or period-only close', () => {
  expect(isAuthorizedHistoricalPosting(ctx, { ...parent, parent: { ...parent.parent, operation: 'year.periods_close' } },
    header, period, '2026-12-31')).toBe(false);
});
