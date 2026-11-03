/**
 * The low-interest loan benefit (SARS 3801, non-cash) end to end through the real routes: ten
 * months calculated and APPROVED with the benefit, then the eleventh. Each month's line is taxed on
 * the benefit and SDL-levied on it but does not pay it in cash; gross_pay / total_gross stay cash
 * only, the benefit is the breakdown's `isNonCash` item, and the SDL threshold (s4(b), R500 000 a
 * year) reads those items back from the approved months.
 *
 * R41 000 cash + R1 000 benefit a month from January: (10 x R42 000 + R42 000) / 11 elapsed months
 * x 12 = R504 000, levied. Cash gross alone read (10 x R41 000 + R42 000) / 11 x 12 = R493 090.91,
 * and the employer came out exempt. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { approvedMonths, benefitFromJanuary } from './payrun-noncash-benefit.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, header, recalculate } = fx;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(async () => { vi.restoreAllMocks(); await fx.dropCompany(); });
afterAll(fx.tearDown);

describe('a non-cash 3801 benefit through approved pay runs', () => {
  it('is taxed and levied each month, never paid in cash, and counts toward the SDL threshold from the approved months', async () => {
    await benefitFromJanuary(pool, fx);
    await approvedMonths(pool, fx, 10);

    await recalculate(state.nov);
    const nov = await line(state.nov);
    expect(nov.gross).toBe(41_000);
    expect(nov.taxable).toBe(42_000);
    // Paid in cash: the salary less the R100 instalment, PAYE and UIF. Not the R1 000 benefit.
    expect(nov.net).toBeCloseTo(41_000 - 100 - nov.paye - nov.uif, 2);
    // UIF on the salary only (above the R17 712 ceiling either way): 1% of the ceiling.
    expect(nov.uif).toBe(177.12);
    // 1% of R42 000: levied, since R504 000 > R500 000. On cash gross history it was nil.
    expect(nov.sdl).toBe(420);
    expect(await header(state.nov)).toMatchObject({ gross: 41_000 });
  });
});
