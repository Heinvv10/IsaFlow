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

import {
  VatPeriodLockedError,
  assertJournalVatPeriodOpen,
  lineMovesVatFigure,
} from '@/modules/accounting/services/gl/journalVatLockGuard';
import { earliestPostableDate, makeAutoCreatable } from '@/modules/accounting/services/gl/journalEntryReversalVatRoll';

const CO = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const LOCK = { id: 'lock-1', period_start: '2026-05-01', period_end: '2026-06-30' };

beforeEach(() => {
  queries.length = 0;
  responder = () => [];
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

  it('returns the date itself when no lock covers it', () => {
    expect(earliestPostableDate('2026-07-05', '2026-09-24', lock, open)).toBe('2026-07-05');
  });

  it('rolls to the day after the covering lock', () => {
    expect(earliestPostableDate('2026-06-10', '2026-09-24', lock, open)).toBe('2026-07-01');
  });

  it('rolls through back-to-back locks', () => {
    const locks = [{ start: '2026-07-01', end: '2026-08-31' }, ...lock];
    expect(earliestPostableDate('2026-06-10', '2026-09-24', locks, open)).toBe('2026-09-01');
  });

  it('skips a CLOSED period to the next open one', () => {
    const periods = [
      { start: '2026-01-01', end: '2026-06-30', open: true },
      { start: '2026-07-01', end: '2026-07-31', open: false },
      { start: '2026-08-01', end: '2026-08-31', open: true },
    ];
    expect(earliestPostableDate('2026-06-10', '2026-09-24', lock, periods)).toBe('2026-08-01');
  });

  it('treats an UNCOVERED date as postable when its year would be auto-created, and not otherwise', () => {
    const periods = [{ start: '2026-01-01', end: '2026-06-30', open: true }];
    expect(earliestPostableDate('2026-06-10', '2026-09-24', lock, periods, () => true)).toBe('2026-07-01');
    expect(earliestPostableDate('2026-06-10', '2026-09-24', lock, periods, () => false)).toBeNull();
  });

  it('returns null when nothing up to the ceiling is postable', () => {
    expect(earliestPostableDate('2026-06-10', '2026-06-20', lock, open)).toBeNull();
  });
});

describe('makeAutoCreatable — exactly when createFiscalYear would succeed', () => {
  const TODAY = new Date(2026, 8, 24);
  const fy2026 = [
    { fiscalYear: 2026, start: '2026-01-01', end: '2026-06-30' },
    { fiscalYear: 2026, start: '2026-09-01', end: '2026-12-31' },
  ];

  it('an uncovered date in a year with no periods, inside the window, is creatable', () => {
    expect(makeAutoCreatable(1, fy2026, TODAY)('2027-01-15')).toBe(true);
  });

  it('a GAP inside an existing fiscal year is NOT (createFiscalYear: "already exists")', () => {
    expect(makeAutoCreatable(1, fy2026, TODAY)('2026-07-15')).toBe(false);
  });

  it('a year that already has ANY row under its label is NOT, even with no overlap ("already exists")', () => {
    // Mislabelled data: a 2026 row dated 2020. createFiscalYear checks the label first.
    expect(makeAutoCreatable(1, [{ fiscalYear: 2026, start: '2020-01-01', end: '2020-01-31' }], TODAY)('2026-07-15'))
      .toBe(false);
  });

  it('a year whose range overlaps an existing period of another year label is NOT (overlap refusal)', () => {
    // March start: FY2027 = 2026-03-01..2027-02-28, overlapping the calendar-2026 rows.
    expect(makeAutoCreatable(3, fy2026, TODAY)('2027-01-15')).toBe(false);
  });

  it('a year outside the auto-create window is NOT', () => {
    expect(makeAutoCreatable(1, [], TODAY)('2035-01-15')).toBe(false);
  });

  it('the roll skips the gap to the next open period', () => {
    const periods = fy2026.map((p) => ({ ...p, open: true }));
    expect(earliestPostableDate('2026-06-10', '2026-09-24', [{ start: '2026-05-01', end: '2026-06-30' }], periods,
      makeAutoCreatable(1, fy2026, TODAY))).toBe('2026-09-01');
  });
});
