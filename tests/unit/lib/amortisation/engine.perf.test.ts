/**
 * PRD-03 §12 performance criterion:
 *   "100k loan rows re-amortised in < 60 seconds (batch queue)"
 *
 * The engine is pure — this test hits the amortise() function directly
 * with 1 000 synthetic loans (average 120 rows each ≈ 120k rows total)
 * and asserts wall-clock under 60 s. Runs on every CI — if the engine
 * regresses past the budget, the build fails.
 */
import { describe, it, expect } from 'vitest';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanInputs, RatePoint } from '@/lib/amortisation/types';

const CURVE: RatePoint[] = [{ effectiveDate: '2026-01-01', rate: 10.25 }];
const LOAN_COUNT = 1_000;
const BUDGET_MS = 60_000;

function makeLoan(i: number): LoanInputs {
  // Mix of term lengths to get realistic row totals: roughly 60, 120, 180 mo.
  const terms = [60, 120, 180];
  return {
    id: `perf-${i}`,
    principal: 100_000 + (i % 100) * 1_000,
    startDate: '2026-03-15',
    termMonths: terms[i % terms.length]!,
    rateMode: 'PRIME_PLUS',
    margin: 2 + (i % 5) * 0.5,
    residual: 0,
    recurringSkipMonths: i % 3 === 0 ? [12, 1] : [],
    dayCount: 'ACTUAL_365',
    repriceMode: 'RESOLVE_ON_RATE_CHANGE',
    skipMode: 'MAINTAIN_TERM',
    lumpMode: 'REDUCE_INSTALLMENT',
  };
}

describe('amortise – performance budget', () => {
  it(`amortises ${LOAN_COUNT} loans (~100k rows) in under ${BUDGET_MS / 1000}s`, () => {
    const start = performance.now();
    let totalRows = 0;
    for (let i = 0; i < LOAN_COUNT; i++) {
      const rows = amortise(makeLoan(i), [], CURVE);
      totalRows += rows.length;
    }
    const elapsedMs = performance.now() - start;

    expect(totalRows).toBeGreaterThan(50_000);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, BUDGET_MS + 5_000);
});
