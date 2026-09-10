// Runner for tests/unit/lib/amortisation/k084-skip-every-month-never-terminates.test.ts.
// Deliberately NOT a *.test.ts file: it is executed as a separate process so a
// non-terminating amortise() can be killed by a timeout instead of hanging the
// suite. Prints the row count on success.
import { amortise } from '../../../../src/lib/amortisation/engine';

const rows = amortise(
  {
    principal: 100000,
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
    recurringSkipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  } as never,
  [],
  [],
);
process.stdout.write(`rows=${rows.length}\n`);
process.stdout.write(`lastDate=${rows[rows.length - 1]?.date}\n`);
