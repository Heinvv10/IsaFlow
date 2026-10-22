/**
 * AP-10 round 2 — eft-generate judges a batch's status, then builds the file.
 * With the batch row read unlocked, a cancelBatch committing between the two
 * still got a file: the status judged ('approved') was no longer true.
 *
 * Made deterministic: the request is parked just after assertBatchMayBeSent
 * has judged the status, cancelBatch is started, and the request is released
 * only once cancelBatch has either finished (the defect: it was not held back)
 * or is waiting on the batch row's lock. Judged by outcome: whether cancelBatch
 * could commit while the request sat between its judgement and its file.
 * Everything else is the real chain (withAuth, RLS, Postgres). Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gate = vi.hoisted(() => ({ hold: null as null | Promise<void>, entered: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/ap/batchBankFileGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/batchBankFileGate')>();
  return {
    ...actual,
    assertBatchMayBeSent: async (...a: Parameters<typeof actual.assertBatchMayBeSent>) => {
      await actual.assertBatchMayBeSent(...a);
      if (gate.hold) { const hold = gate.hold; gate.hold = null; gate.entered?.(); await hold; }
    },
  };
});

import eftGenerate from '../../pages/api/accounting/eft-generate';
import { cancelBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => {
  user = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, [user])); // ends the pool

/** 'waiting' once a backend of this database waits on a lock while running a statement over `table`. */
async function waitsOnLock(table: string): Promise<'waiting'> {
  for (let i = 0; i < 500; i += 1) {
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${table}%`]);
    if (r.rowCount) return 'waiting';
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`nothing finished and nothing waited on a ${table} lock`);
}

describe('eft-generate vs cancelBatch', () => {
  it('a cancel cannot commit between the status the request judged and the file it builds', async () => {
    const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
    const batch = await plantApprovedBatch(pool, c, user, bank);
    await pool.query("UPDATE supplier_payment_batches SET status = 'approved' WHERE id = $1", [batch.id]);

    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const entered = new Promise<void>((r) => { gate.entered = r; });
    const fileP = callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId: batch.id, bank: 'fnb' }, '/api/accounting/eft-generate');
    await entered; // status judged 'approved'; the file is not built yet
    const cancelP = cancelBatch(c, batch.id).then(() => 'cancelled' as const);
    const state = await Promise.race([cancelP.then(() => 'finished' as const), waitsOnLock('supplier_payment_batches')]);
    release();
    const [file] = await Promise.all([fileP, cancelP]);

    // The cancel waited for the request that had judged the batch, so the file is of an approved batch.
    expect(state).toBe('waiting');
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    const after = (await pool.query('SELECT status FROM supplier_payment_batches WHERE id = $1', [batch.id])).rows[0].status;
    expect(after).toBe('cancelled');
  });
});
