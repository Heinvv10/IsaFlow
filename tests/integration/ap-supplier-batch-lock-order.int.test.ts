/**
 * Supplier <-> payment-batch lock order. The bank-file gate (eft-generate,
 * netcash/submit: batchBankFileGate / supplierBankVerificationGate) takes the
 * BATCH row and then share-locks its payee SUPPLIERS. updateSupplier (a bank
 * detail edit), the take-on overwrite and both supplier merges took the
 * supplier FIRST and then the batches paying it: the opposite order, so the two
 * transactions could deadlock (40P01) and Postgres aborted one of them.
 * One order now (bank/.claude.md): batches, in id order, then suppliers.
 *
 * Judged by OUTCOME, interleaved deterministically: the real eft-generate route
 * is parked while it holds the batch row, the supplier writer is started and
 * waits until Postgres reports it blocked on a lock, then the route is released
 * to take its payee locks. A 40P01 on either side fails the test. Disposable
 * fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gate = vi.hoisted(() => ({
  /** Parks the route while it holds the batch row, before (`before`) or after (`after`) the payee locks. */
  park: null as null | { when: 'before' | 'after'; entered: () => void; hold: Promise<void> },
  errorCode: undefined as string | undefined,
}));
vi.mock('@/modules/accounting/services/ap/batchBankFileGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/batchBankFileGate')>();
  return {
    ...actual,
    assertBatchMayBeSent: async (...a: Parameters<typeof actual.assertBatchMayBeSent>) => {
      const park = gate.park;
      const parkNow = async (when: 'before' | 'after') => {
        if (park?.when !== when) return;
        gate.park = null;
        park.entered();
        await park.hold;
      };
      await parkNow('before');
      try {
        await actual.assertBatchMayBeSent(...a);
      } catch (err) {
        gate.errorCode = (err as { code?: string }).code;
        throw err;
      }
      await parkNow('after');
    },
  };
});

import eftGenerate from '../../pages/api/accounting/eft-generate';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { lockBatchesBeforeSuppliers } from '@/modules/accounting/services/ap/supplierPaymentAuthors';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import {
  cleanupPr5, enforcePay, inRequest, payCompany, payRoutes, plantBatch, plantPayment, plantSupplier,
} from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);
const NEW_ACCOUNT = '62000009999';

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  gate.park = null;
  gate.errorCode = undefined;
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

/** An approved batch of a company with payment_batch enforcement on, so the gate takes the payee locks. */
async function approvedBatch() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  for (const type of ['supplier_payment', 'payment_batch'] as const) await plantRule(pool, c, 'owner', { documentType: type });
  await enforcePay(pool, c, 'payment_batch', u.b);
  const b = await plantBatch(pool, c, u.a, bank);
  await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
  expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
  return { c, bank, b, supplierId: b.members[0]!.supplierId };
}

/** The route, parked while it holds the batch row; resolves with the park's controls. */
async function startParkedFileRequest(c: string, batchId: string, when: 'before' | 'after') {
  let release!: () => void;
  let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate.park = { when, entered, hold: new Promise<void>((res) => { release = res; }) };
  const file = callRoute(eftGenerate, tokens[u.a]!, c, 'POST', { batchId, bank: 'fnb' }, '/api/accounting/eft-generate');
  await inGate;
  return { file, release };
}

/** Resolves once a backend of this database waits on a lock while running a statement over `table`. */
async function waitsOnLock(table: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const res = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${table}%`]);
    if (res.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nothing waited on a ${table} lock`);
}

type Outcome = { ok: true } | { ok: false; code: string | undefined };
const outcomeOf = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ ok: true as const }), (err: { code?: string }) => ({ ok: false as const, code: err.code }));

const accountOf = async (id: string) =>
  (await pool.query('SELECT bank_account_number FROM suppliers WHERE id = $1', [id])).rows[0].bank_account_number as string;

describe('supplier writers against the bank-file gate: batch, then supplier', () => {
  it('a bank-detail edit of a payee and an eft-generate of its batch do not deadlock', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const { file, release } = await startParkedFileRequest(c, b.id, 'before'); // route holds the batch row
    const edit = outcomeOf(inRequest(pool, u.a, c, () => updateSupplier(c, supplierId, { bankAccountNumber: NEW_ACCOUNT }, u.a)));
    await waitsOnLock('supplier_payment_batches');
    release(); // the route now share-locks the payees
    const [res, edited] = await Promise.all([file, edit]);

    expect({ gate: gate.errorCode, edit: edited }).toEqual({ gate: undefined, edit: { ok: true } });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await accountOf(supplierId)).toBe(NEW_ACCOUNT);
  });

  it('a supplier merge moving a payee and an eft-generate of its batch do not deadlock', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const primary = await plantSupplier(pool, c);
    const { file, release } = await startParkedFileRequest(c, b.id, 'before');
    const merge = outcomeOf(inRequest(pool, u.a, c, () => mergeEntities(c, 'supplier', primary, supplierId, u.a)));
    await waitsOnLock('supplier_payment_batches');
    release();
    const [res, merged] = await Promise.all([file, merge]);

    expect({ gate: gate.errorCode, merge: merged }).toEqual({ gate: undefined, merge: { ok: true } });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('the safety property holds: a bank edit cannot land while the file request holds the payee locks', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const before = await accountOf(supplierId);
    const { file, release } = await startParkedFileRequest(c, b.id, 'after'); // gate passed, payees share-locked
    const edit = outcomeOf(inRequest(pool, u.a, c, () => updateSupplier(c, supplierId, { bankAccountNumber: NEW_ACCOUNT }, u.a)));
    await waitsOnLock('supplier'); // the edit is blocked (on the batch row or the payee), not racing the file
    expect(await accountOf(supplierId)).toBe(before);
    release();
    const [res, edited] = await Promise.all([file, edit]);

    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(edited).toEqual({ ok: true });
    expect(await accountOf(supplierId)).toBe(NEW_ACCOUNT); // landed only after the request committed
  });

  it('an edit that touches no bank detail takes no batch lock: a file request holding the batch row does not hold it up', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const { file, release } = await startParkedFileRequest(c, b.id, 'before'); // batch row held, no payee lock yet
    const renamed = await outcomeOf(inRequest(pool, u.a, c, async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      return updateSupplier(c, supplierId, { name: 'Renamed Supplier' }, u.a);
    }));
    release();
    expect(renamed).toEqual({ ok: true });
    expect((await file).state.statusCode).toBe(200);
  });
});

describe('lockBatchesBeforeSuppliers', () => {
  const lockedNow = async (table: 'supplier_payment_batches' | 'suppliers', id: string) =>
    pool.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]).then(() => false, (e: { code?: string }) => e.code === '55P03');

  it('a batch that starts paying the supplier after the peek is locked too, still before the supplier', async () => {
    const { c, bank, b, supplierId } = await approvedBatch();
    const late = await plantBatch(pool, c, u.a, bank, []);
    let calls = 0;
    await inRequest(pool, u.a, c, async () => {
      await lockBatchesBeforeSuppliers(c, [supplierId], ['draft', 'approved'], async () => {
        calls += 1;
        // Committed between the peek and the supplier lock on the first attempt.
        if (calls === 1) await plantPayment(pool, c, u.a, bank, { supplierId, batchId: late.id });
      });
      expect(calls).toBe(2);
      expect(await lockedNow('supplier_payment_batches', b.id)).toBe(true);
      expect(await lockedNow('supplier_payment_batches', late.id)).toBe(true);
    });
  });

  it('gives up with an error, not a loop, when the set keeps growing', async () => {
    const { c, bank, supplierId } = await approvedBatch();
    let calls = 0;
    const result = outcomeOf(inRequest(pool, u.a, c, () => lockBatchesBeforeSuppliers(c, [supplierId], ['draft', 'approved'], async () => {
      calls += 1;
      const extra = await plantBatch(pool, c, u.a, bank, []);
      await plantPayment(pool, c, u.a, bank, { supplierId, batchId: extra.id });
    })));
    expect(await result).toMatchObject({ ok: false });
    expect(calls).toBe(5);
  });
});
