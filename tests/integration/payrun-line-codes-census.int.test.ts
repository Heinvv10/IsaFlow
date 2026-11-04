/**
 * Census: the run page's list of blocking line codes (runWarningCodes.BLOCKING_LINE_CODES) is exactly
 * the set of line codes the approval gate refuses on. Every code the page knows is written alone onto
 * a run's line, and the gate's own preview is asked whether it blocks. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { BLOCKING_LINE_CODES, KNOWN_LINE_CODES } from '../../src/components/payroll/runWarningCodes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, preview } = fx;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

it('the gate refuses on exactly the codes the page calls blocking', async () => {
  const refusedOn: string[] = [];
  for (const code of KNOWN_LINE_CODES) {
    const result = { code, severity: 'error', message: code, rawNet: -10, loans: ['R-LOAN'], missing: ['LOAN'] };
    await pool.query('UPDATE payroll_run_lines SET validation_results = $2::jsonb WHERE run_id = $1', [state.nov, JSON.stringify([result])]);
    if ((await preview(state.nov)).body.data!.blocker) refusedOn.push(code);
  }
  expect(refusedOn.sort()).toEqual([...BLOCKING_LINE_CODES].sort());
});
