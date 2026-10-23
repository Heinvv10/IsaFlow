/**
 * The central VAT-period-lock refusal: which journals it refuses, and the order
 * in which it asks.
 *
 * "Moves a VAT figure" is decided per line, on the basis the lock's figures
 * were RECORDED from (reports/vatBoxBasis): a VAT type other than 'no_vat', or
 * an account whose canonical subtype is one of VAT_TAX_SUBTYPES (vat_input,
 * vat_output). The account wins over a 'no_vat' tag because a tax leg is read
 * by its account; an untagged generic 'tax' account is in no box.
 *
 * The integration behaviour (a real lock, a real post) is pinned in
 * tests/integration/vat-period-lock-posting.int.test.ts. This file pins the
 * classification and the query order with a recorded sql mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: string[] = [];
let responder: (text: string) => unknown[] = () => [];

vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: readonly string[]) => {
    const text = strings.join('?');
    queries.push(text);
    return Promise.resolve(responder(text));
  }),
}));

// An uncovered date's fiscal year is the registry's (March-based unless a test sets fakeRegistry).
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../helpers/fiscalYearSqlFake')).registryMock());

import {
  VatPeriodLockedError,
  assertJournalVatPeriodOpen,
  lineMovesVatFigure,
} from '@/modules/accounting/services/gl/journalVatLockGuard';
import { earliestPostableDate, makeAutoCreatable } from '@/modules/accounting/services/gl/journalEntryReversalVatRoll';

import { fakeRegistry, resetFakeRegistry } from '../../helpers/fiscalYearSqlFake';

const CO = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const LOCK = { id: 'lock-1', period_start: '2026-05-01', period_end: '2026-06-30' };

beforeEach(() => {
  queries.length = 0;
  responder = () => [];
  resetFakeRegistry();
});

describe('lineMovesVatFigure', () => {
  it.each([
    ['standard', null, true],
    ['zero_rated', 'default_expense', true],
    ['no_vat', null, false],
    [null, 'vat_input', true],
    [null, 'vat_output', true],
    // Untagged generic 'tax' (PAYE, income tax) is in no VAT201 box — vatBoxBasis.
    [null, 'tax', false],
    ['standard', 'tax', true],
    [null, 'VAT Output', true],
    ['no_vat', 'vat_input', true],
    [null, 'bank', false],
    [null, 'receivable', false],
    [undefined, null, false],
  ] as const)('vat_type %s on subtype %s -> %s', (vatType, subtype, expected) => {
    expect(lineMovesVatFigure(vatType, subtype)).toBe(expected);
  });
});

describe('assertJournalVatPeriodOpen', () => {
  it('takes the SHARED per-company advisory lock before it reads the locks', async () => {
    await assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC, vatType: 'standard' }]);
    expect(queries[0]).toMatch(/pg_advisory_xact_lock_shared\(hashtextextended\(\?::text, 570\)\)/);
    expect(queries[1]).toMatch(/FROM vat_period_locks/);
    expect(queries[1]).toMatch(/unlocked_at IS NULL/);
  });

  it('allows any journal when no active lock covers the date, without classifying it', async () => {
    await expect(assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC, vatType: 'standard' }]))
      .resolves.toBeUndefined();
    expect(queries.some((q) => /FROM gl_accounts/.test(q))).toBe(false);
  });

  it('refuses a VAT-typed line inside an active lock, naming the period and the remedy', async () => {
    responder = (t) => (/FROM vat_period_locks/.test(t) ? [LOCK] : []);
    const err = await assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC, vatType: 'standard' }])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    const e = err as VatPeriodLockedError;
    expect(e.code).toBe('VAT_PERIOD_LOCKED');
    expect(e.periodStart).toBe('2026-05-01');
    expect(e.periodEnd).toBe('2026-06-30');
    expect(e.message).toContain('2026-05-01 to 2026-06-30');
    expect(e.message).toMatch(/owner or admin can unlock/);
  });

  it('refuses an untagged line on a VAT tax-leg account inside an active lock', async () => {
    responder = (t) => (/FROM vat_period_locks/.test(t) ? [LOCK]
      : /FROM gl_accounts/.test(t) ? [{ id: ACC, account_subtype: 'vat_output' }] : []);
    await expect(assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC }]))
      .rejects.toBeInstanceOf(VatPeriodLockedError);
  });

  it('allows an untagged generic tax-subtype line (PAYE) inside an active lock', async () => {
    responder = (t) => (/FROM vat_period_locks/.test(t) ? [LOCK]
      : /FROM gl_accounts/.test(t) ? [{ id: ACC, account_subtype: 'tax' }] : []);
    await expect(assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC }])).resolves.toBeUndefined();
  });

  it('allows a journal with no VAT line inside an active lock', async () => {
    responder = (t) => (/FROM vat_period_locks/.test(t) ? [LOCK]
      : /FROM gl_accounts/.test(t) ? [{ id: ACC, account_subtype: 'default_expense' }] : []);
    await expect(assertJournalVatPeriodOpen(CO, '2026-06-10', [{ glAccountId: ACC, vatType: 'no_vat' }]))
      .resolves.toBeUndefined();
  });

  it('accepts a Date entry date and reads it as the local calendar day', async () => {
    responder = (t) => (/FROM vat_period_locks/.test(t) ? [LOCK] : []);
    await expect(assertJournalVatPeriodOpen(CO, new Date(2026, 5, 10), [{ glAccountId: ACC, vatType: 'standard' }]))
      .rejects.toBeInstanceOf(VatPeriodLockedError);
  });
});

describe('earliestPostableDate (the reversal roll)', () => {
  const open = [{ start: '2026-01-01', end: '2026-12-31', open: true }];
  const lock = [{ start: '2026-05-01', end: '2026-06-30' }];

  it('returns the date itself when no lock covers it', async () => {
    expect(await earliestPostableDate('2026-07-05', '2026-09-24', lock, open)).toBe('2026-07-05');
  });

  it('rolls to the day after the covering lock', async () => {
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', lock, open)).toBe('2026-07-01');
  });

  it('rolls through back-to-back locks', async () => {
    const locks = [{ start: '2026-07-01', end: '2026-08-31' }, ...lock];
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', locks, open)).toBe('2026-09-01');
  });

  it('skips a CLOSED period to the next open one', async () => {
    const periods = [
      { start: '2026-01-01', end: '2026-06-30', open: true },
      { start: '2026-07-01', end: '2026-07-31', open: false },
      { start: '2026-08-01', end: '2026-08-31', open: true },
    ];
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', lock, periods)).toBe('2026-08-01');
  });

  it('treats an UNCOVERED date as postable when its period would be auto-created, and not otherwise', async () => {
    const periods = [{ start: '2026-01-01', end: '2026-06-30', open: true }];
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', lock, periods, () => true)).toBe('2026-07-01');
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', lock, periods, () => false)).toBeNull();
    // An async predicate (the registry lookup) is awaited.
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', lock, periods, async () => true)).toBe('2026-07-01');
  });

  it('returns null when nothing up to the ceiling is postable', async () => {
    expect(await earliestPostableDate('2026-06-10', '2026-06-20', lock, open)).toBeNull();
  });
});

describe('makeAutoCreatable — exactly when ensureFiscalPeriodForDate would generate a period', () => {
  const TODAY = new Date(2026, 8, 24);

  it('an uncovered date whose registry year is inside the window and open is creatable', async () => {
    fakeRegistry.templateMonth = 1;
    expect(await makeAutoCreatable(CO, TODAY)('2027-01-15')).toBe(true);
  });

  it('a GAP inside an existing OPEN year IS creatable (the generator fills the missing month)', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31' }];
    expect(await makeAutoCreatable(CO, TODAY)('2026-07-15')).toBe(true);
  });

  it('a date in a CLOSED or LOCKED year is NOT', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', status: 'closed' }];
    expect(await makeAutoCreatable(CO, TODAY)('2026-07-15')).toBe(false);
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', status: 'locked' }];
    expect(await makeAutoCreatable(CO, TODAY)('2026-07-15')).toBe(false);
  });

  it('the window is tested on the registry label, not the calendar year', async () => {
    fakeRegistry.templateMonth = 3;
    // TODAY is 2026-09-24, so the window ends with label 2028. 2028-01-15 is FY2028; 2028-06-15 is FY2029.
    expect(await makeAutoCreatable(CO, TODAY)('2028-01-15')).toBe(true);
    expect(await makeAutoCreatable(CO, TODAY)('2028-06-15')).toBe(false);
  });

  it('a year outside the auto-create window is NOT', async () => {
    fakeRegistry.templateMonth = 1;
    expect(await makeAutoCreatable(CO, TODAY)('2035-01-15')).toBe(false);
  });

  it('an unparseable date is NOT, and is never sent to the registry', async () => {
    const { fiscalYearForDate } = await import('@/modules/accounting/services/gl/fiscalYearRegistry');
    vi.mocked(fiscalYearForDate).mockClear();
    expect(await makeAutoCreatable(CO, TODAY)('not-a-date')).toBe(false);
    expect(await makeAutoCreatable(CO, TODAY)('2026-02-30')).toBe(false);
    expect(fiscalYearForDate).not.toHaveBeenCalled();
  });

  it('the roll lands on the first date in an open gap: the gap is postable now', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31' }];
    const periods = [
      { start: '2026-01-01', end: '2026-06-30', open: true },
      { start: '2026-09-01', end: '2026-12-31', open: true },
    ];
    expect(await earliestPostableDate('2026-06-10', '2026-09-24', [{ start: '2026-05-01', end: '2026-06-30' }], periods,
      makeAutoCreatable(CO, TODAY))).toBe('2026-07-01');
  });
});
