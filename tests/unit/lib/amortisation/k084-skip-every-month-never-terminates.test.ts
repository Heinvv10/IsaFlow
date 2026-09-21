/**
 * K-084 RED. `amortise`
 * (git show origin/master:src/lib/amortisation/engine.ts, lines 92 and 178)
 * bounds its loop with `p <= totalPeriods + extendedPeriods` and increments
 * `extendedPeriods` on every skipped period when skipMode is EXTEND_TERM. A
 * loan whose recurringSkipMonths covers all twelve calendar months pushes the
 * bound out once per iteration, and the early-termination branch is
 * unreachable because a skipped period pays nothing and the NCA in-duplum cap
 * eventually freezes the balance.
 *
 * CORRECTED TRIGGER — it is not literally endless. The loop escapes only by
 * accident: once addMonths reaches a five-digit year, `calendarMonth`
 * (engine.ts:26) reads `'10000-01-31'.slice(5,7)` as `'-0'`, so isSkipPeriod
 * stops matching and the loan starts amortising. Measured on this baseline:
 * 95,699 rows, last row dated 10000-12-31, ~7s of synchronous CPU per call.
 * The harm is that, not a hang: a request thread blocked for seconds, ~95,700
 * schedule rows persisted by loanScheduleService, and a schedule running to the
 * year 10000.
 *
 * Reachable: POST /api/accounting/loans hands req.body straight to createLoan,
 * and validateCreate (loanService.ts:163-172) checks principal, termMonths,
 * fixedRate and originationFee only — never recurringSkipMonths against
 * skipMode.
 *
 * Run out-of-process so a regression that truly hangs fails this test instead
 * of hanging the suite.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'k084-skip-every-month.runner.mts');

describe('K-084 amortise with every calendar month skipped', () => {
  it('either refuses the loan or returns a bounded schedule, quickly', () => {
    const started = Date.now();
    const result = spawnSync('bun', [runner], { timeout: 15_000, encoding: 'utf8' });
    const elapsed = Date.now() - started;

    expect(result.signal).toBe(null);

    if (result.status === 0) {
      const rows = Number(/^rows=(\d+)$/m.exec(result.stdout)?.[1] ?? NaN);
      // A 12-month loan that skips every month cannot amortise. Whatever the
      // engine returns must stay in the same order of magnitude as the term —
      // 50 years of rows is already far past anything a user asked for.
      expect(rows).toBeLessThanOrEqual(600);
      const lastDate = /^lastDate=(\S+)$/m.exec(result.stdout)?.[1] ?? '';
      expect(lastDate.slice(0, 4) <= '2100').toBe(true);
    } else {
      // Refusing the impossible loan is the other acceptable outcome.
      expect(result.stderr).toMatch(/skip/i);
    }

    expect(elapsed).toBeLessThan(5_000);
  }, 40_000);
});

describe('K-084 amortise term-extension cap', () => {
  const base = {
    principal: 100_000,
    residual: 0,
    startDate: '2026-01-31',
    termMonths: 12,
    rateMode: 'FIXED',
    fixedRate: 12,
    margin: 0,
    dayCount: 'ACTUAL_365',
    repriceMode: 'FIXED_INSTALLMENT',
    skipMode: 'EXTEND_TERM',
    lumpMode: 'REDUCE_INSTALLMENT',
  };

  it('throws rather than extending without bound', async () => {
    const { amortise } = await import('@/lib/amortisation/engine');
    expect(() =>
      amortise({ ...base, recurringSkipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } as never, [], []),
    ).toThrow(/skips more periods/i);
  });

  it('computes the 11-skip-month loan the validator still accepts', async () => {
    // Review H3: the cap and validateCreate must refuse the same inputs. With
    // k months skipped the extension converges to term * k / (12 - k), so 11
    // months costs 11x the term and only 12 never terminates. A cap of 5x
    // threw here, turning a finite 719-row schedule into a 500 for a loan
    // createLoan accepts and getOrComputeSchedule recomputes.
    const { amortise } = await import('@/lib/amortisation/engine');
    const rows = amortise(
      { ...base, termMonths: 60, recurringSkipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } as never,
      [], [],
    );
    expect(rows.length).toBe(719);
    expect(rows[rows.length - 1]!.date.slice(0, 4) < '2100').toBe(true);
  });

  it('accepts every skip count the validator accepts, at every term', async () => {
    const { amortise } = await import('@/lib/amortisation/engine');
    for (const termMonths of [12, 24, 60, 120, 360]) {
      for (let k = 1; k <= 11; k++) {
        const recurringSkipMonths = Array.from({ length: k }, (_, i) => i + 1);
        expect(() =>
          amortise({ ...base, termMonths, recurringSkipMonths } as never, [], []),
        ).not.toThrow();
      }
      expect(() =>
        amortise(
          { ...base, termMonths, recurringSkipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } as never,
          [], [],
        ),
      ).toThrow(/skips more periods/i);
    }
  });

  it('still extends the term for an ordinary two-month payment holiday', async () => {
    const { amortise } = await import('@/lib/amortisation/engine');
    const rows = amortise({ ...base, recurringSkipMonths: [1, 2] } as never, [], []);
    expect(rows.length).toBeGreaterThan(12);
    expect(rows.length).toBeLessThanOrEqual(24);
    expect(rows[rows.length - 1]!.closing).toBeCloseTo(0, 2);
  });
});
