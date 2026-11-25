/**
 * Migration 1018 against the payroll journal: approving a pay run posts and links its journal, reopening and reversing
 * it links the contra, a second approval posts the new one. Real routes (withAuth: a request transaction as app_user,
 * never the fixture superuser, so is_superuser is off and the ledger rules bind).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let a: Awaited<ReturnType<typeof rig>>;

beforeAll(async () => {
  a = await rig('lcf-pay');
  await a.setup();
  await a.employee(25000);
  await a.employee(18000);
}, 240_000);
afterAll(async () => { if (a) await a.teardown(); });

describe('ledger column immutability: the payroll journal through its real routes (migration 1018)', () => {
  it('approve posts and links the journal; reopen, reverse links the contra; a re-approval posts the new journal', async () => {
    const run = await a.calculatedRun(1);
    expect((await a.api.approve(run)).statusCode).toBe(200);
    const je = String((await a.header(run)).journal_entry_id);
    expect(je).not.toBe('null');
    expect((await a.api.reopen(run)).statusCode).toBe(200);
    expect((await a.api.reverse(je)).statusCode).toBe(200);
    const contra = await a.contraOf(je);
    expect((await a.pool.query('SELECT reversal_of_id FROM gl_journal_entries WHERE id = $1', [contra])).rows[0].reversal_of_id).toBe(je);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    expect((await a.api.approve(run)).statusCode).toBe(200);
    const again = String((await a.header(run)).journal_entry_id);
    expect(again).not.toBe(je);
  }, 120_000);
});
