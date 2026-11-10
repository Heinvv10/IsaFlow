/**
 * HD: the anchor is re-verified under the locks. The employee-component writers do not take the approval or run-header locks, so
 * a writer can add a second hours row between the anchor read and the write; the whole anchor (component AND duplicate) is
 * compared again after this component's rows are locked, and a move is a 409 that writes nothing. The mid-request write is made
 * from the reader: the third read of the employee's components in the request (anchor, the row lock's reader, the re-check).
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hook = vi.hoisted(() => ({ on: 0, run: null as null | (() => Promise<void>) }));
vi.mock('../../src/modules/accounting/services/payroll/payrollComponentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/accounting/services/payroll/payrollComponentService')>();
  return {
    ...actual,
    getEmployeeComponents: async (...args: Parameters<typeof actual.getEmployeeComponents>) => {
      if (hook.on > 0 && --hook.on === 0 && hook.run) await hook.run();
      return actual.getEmployeeComponents(...args);
    },
  };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { hoursFixture } from './payrun-run-hours.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const { fx, ctx, hours, makeHourly, stored, each } = hoursFixture(pool);
const { state } = fx;

beforeAll(fx.setUp);
beforeEach(each);
afterEach(async () => { hook.on = 0; hook.run = null; await fx.dropCompany(); });
afterAll(fx.tearDown);

describe('a second hours row (same component) appearing between the anchor read and the write', () => {
  it('is a 409 and the write does not happen', async () => {
    await makeHourly();
    expect((await hours(state.nov, 160)).statusCode).toBe(200);
    hook.on = 3;
    hook.run = async () => {
      await pool.query(
        `INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
         VALUES ($1, $2, 100, 8, 'hour', '2026-11-01', '2026-11-30', FALSE)`, [state.employee, ctx.basic]); // same component: only the duplicate flag moves
    };
    const res = await hours(state.nov, 150, 160);
    expect(hook.on).toBe(0);
    expect(res.statusCode).toBe(409);
    expect(await stored()).toEqual([{ amount: 13680, quantity: 160, unit: 'hour' }]); // the anchor's row is as it was
  });
});
