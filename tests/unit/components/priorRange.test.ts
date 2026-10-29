import { expect, it } from 'vitest';
import { priorRange } from '@/components/accounting/reportControls/useIncomeStatementReport';

it.each([
  ['a 31-day month', '2026-03-01', '2026-03-31', '2026-01-29', '2026-02-28'],
  ['a leap-year February prior', '2028-03-01', '2028-03-31', '2028-01-30', '2028-02-29'],
  ['a single day', '2026-03-01', '2026-03-01', '2026-02-28', '2026-02-28'],
  ['a cross-year range', '2026-01-01', '2026-03-31', '2025-10-03', '2025-12-31'],
  ['a 30-day month', '2026-04-01', '2026-04-30', '2026-03-02', '2026-03-31'],
  ['a prior spanning the US spring-forward (2026-03-08)', '2026-03-10', '2026-03-20', '2026-02-27', '2026-03-09'],
  ['a prior spanning the US fall-back (2026-11-01)', '2026-11-05', '2026-11-15', '2026-10-25', '2026-11-04'],
])('%s: %s..%s -> %s..%s', (_n, start, end, ps, pe) => {
  expect(priorRange(start, end)).toEqual({ start: ps, end: pe });
});
