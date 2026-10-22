/**
 * Supplier <-> payment-batch lock order. The bank-file gate (eft-generate,
 * netcash/submit: batchBankFileGate / supplierBankVerificationGate) takes the
 * BATCH row and then share-locks its payee SUPPLIERS. updateSupplier (a bank
 * detail edit), the take-on overwrite and both supplier merges took the
 * supplier FIRST and then the batches: the opposite order, so the two
 * transactions could deadlock (40P01) and Postgres aborted one of them.
 * One order now (bank/.claude.md): batches, in id order, then suppliers.
 *
 * Judged by OUTCOME, interleaved deterministically: the real eft-generate route
 * is parked while it holds the batch row, the supplier writer is started and
 * waits until ITS backend (by pid) is reported blocked on a lock, then the route
 * is released to take its payee locks. A 40P01 on either side fails the test.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

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
import { importSuppliers } from '@/modules/accounting/services/core/migrationContactService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { SupplierBatchLockTimeoutError, lockBatchesBeforeSuppliers } from '@/modules/accounting/services/ap/batchBeforeSupplierLock';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { cleanupPr5, enforcePay, inRequest, payCompany, payRoutes, plantBatch, plantPayment, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);
const NEW_ACCOUNT = '62000009999';
const BATCHES = 'supplier_payment_batches';

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

type Outcome = { ok: true } | { ok: false; code: string | undefined };
const outcomeOf = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ ok: true as const }), (err: { code?: string }) => ({ ok: false as const, code: err.code }));

/** `fn` on one request transaction; `pid` is its backend, so a wait is attributed to it and to no other session. */
function startWriter(c: string, fn: (client: PoolClient) => Promise<unknown>) {
  let gotPid!: (pid: number) => void;
  const pid = new Promise<number>((res) => { gotPid = res; });
  const outcome = outcomeOf(inRequest(pool, u.a, c, async (client) => {
    gotPid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return fn(client);
  }));
  return { pid, outcome };
}

/** The statement backend `pid` is blocked on, once it waits on a lock. */
async function blockedStatement(pid: number): Promise<string> {
  for (let i = 0; i < 500; i += 1) {
    const res = await pool.query(
      "SELECT query FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
    if (res.rowCount) return res.rows[0].query as string;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

const accountOf = async (id: string) =>
  (await pool.query('SELECT bank_account_number FROM suppliers WHERE id = $1', [id])).rows[0].bank_account_number as string;

/** A payment of `supplierId` placed in `batchId`: the only way a batch gains a payee. */
const joinBatch = (db: Pool | PoolClient, c: string, supplierId: string, batchId: string) => db.query(
  `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,status,batch_id,created_by)
   VALUES($1,$2,DATE '2026-09-01',10,'eft','draft',$3,$4)`, [c, supplierId, batchId, u.a]);

/** True while some other session holds `id`'s row (a NOWAIT lock attempt fails, and holds nothing itself). */
const isLocked = (table: typeof BATCHES | 'suppliers', id: string) =>
  pool.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
    .then(() => false, (e: { code?: string }) => { if (e.code === '55P03') return true; throw e; });

describe('supplier writers against the bank-file gate: batch, then supplier', () => {
  it('a bank-detail edit of a payee and an eft-generate of its batch do not deadlock', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const { file, release } = await startParkedFileRequest(c, b.id, 'before'); // route holds the batch row
    const edit = startWriter(c, () => updateSupplier(c, supplierId, { bankAccountNumber: NEW_ACCOUNT }, u.a));
    expect(await blockedStatement(await edit.pid)).toContain(BATCHES);
    release(); // the route now share-locks the payees
    const [res, edited] = await Promise.all([file, edit.outcome]);

    expect({ gate: gate.errorCode, edit: edited }).toEqual({ gate: undefined, edit: { ok: true } });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await accountOf(supplierId)).toBe(NEW_ACCOUNT);
  });

  it('a supplier merge moving a payee and an eft-generate of its batch do not deadlock', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const primary = await plantSupplier(pool, c);
    const { file, release } = await startParkedFileRequest(c, b.id, 'before');
    const merge = startWriter(c, () => mergeEntities(c, 'supplier', primary, supplierId, u.a));
    expect(await blockedStatement(await merge.pid)).toContain(BATCHES);
    release();
    const [res, merged] = await Promise.all([file, merge.outcome]);

    expect({ gate: gate.errorCode, merge: merged }).toEqual({ gate: undefined, merge: { ok: true } });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });

  it('batch BEFORE supplier: a bank edit waits at the batch row, not the payee, while a file request holds both', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const before = await accountOf(supplierId);
    const { file, release } = await startParkedFileRequest(c, b.id, 'after'); // gate passed, payees share-locked
    const edit = startWriter(c, () => updateSupplier(c, supplierId, { bankAccountNumber: NEW_ACCOUNT }, u.a));
    // The supplier lock would also be refused here (the request holds it FOR SHARE); the order is which one it waits on.
    expect(await blockedStatement(await edit.pid)).toContain(BATCHES);
    expect(await accountOf(supplierId)).toBe(before); // not racing the file
    release();
    const [res, edited] = await Promise.all([file, edit.outcome]);

    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(edited).toEqual({ ok: true });
    expect(await accountOf(supplierId)).toBe(NEW_ACCOUNT); // landed only after the request committed
  });

  // Holds in EITHER order (it passed before the fix too): a guard that the fix adds no wait where there was none.
  it('regression guard: an edit that touches no bank detail takes no batch lock', async () => {
    const { c, b, supplierId } = await approvedBatch();
    const { file, release } = await startParkedFileRequest(c, b.id, 'before'); // batch row held, no payee lock yet
    const renamed = await startWriter(c, async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      return updateSupplier(c, supplierId, { name: 'Renamed Supplier' }, u.a);
    }).outcome;
    release();
    expect(renamed).toEqual({ ok: true });
    expect((await file).state.statusCode).toBe(200);
  });
});

describe('the take-on import: one id-ordered set, not a batch lock per row', () => {
  it('an import whose rows run against id order does not deadlock with an id-ordered writer', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
    const one = await plantBatch(pool, c, u.a, bank, [1000]);
    const two = await plantBatch(pool, c, u.a, bank, [2000]);
    const [lo, hi] = one.id < two.id ? [one, two] : [two, one];
    const names = { lo: 'Alpha Traders', hi: 'Zulu Holdings' };
    for (const k of ['lo', 'hi'] as const) await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [({ lo, hi })[k].members[0]!.supplierId, names[k]]);
    const session = await inRequest(pool, u.a, c, () => createSession(c, 'sage', u.a));
    const rows = [names.hi, names.lo].map((name) => ({ name, bankAccountNumber: NEW_ACCOUNT })); // the HIGH batch first

    // A writer that has the LOW batch (as an id-ordered writer does first), then asks for the high one and the rows.
    const writer: PoolClient = await pool.connect();
    let writerCode: string | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [lo.id]);
      // importSuppliers catches a row's failure into `errors`, so a deadlock victim shows there, not as a rejection.
      let result: Awaited<ReturnType<typeof importSuppliers>> | undefined;
      const imp = startWriter(c, async () => { result = await importSuppliers(c, session.id, rows, 'overwrite', u.a); });
      await blockedStatement(await imp.pid); // the import waits for the low batch
      try {
        await writer.query('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [hi.id]);
        await writer.query('SELECT id FROM suppliers WHERE id = ANY($1) ORDER BY id FOR UPDATE',
          [[lo.members[0]!.supplierId, hi.members[0]!.supplierId]]);
        await writer.query('COMMIT');
      } catch (err) {
        writerCode = (err as { code?: string }).code;
        await writer.query('ROLLBACK');
      }
      expect({ writer: writerCode, import: await imp.outcome }).toEqual({ writer: undefined, import: { ok: true } });
      expect({ imported: result?.imported, errors: result?.errors }).toEqual({ imported: 2, errors: [] });
    } finally {
      writer.release();
    }
    expect(await accountOf(lo.members[0]!.supplierId)).toBe(NEW_ACCOUNT);
    expect(await accountOf(hi.members[0]!.supplierId)).toBe(NEW_ACCOUNT);
  });
});

describe('lockBatchesBeforeSuppliers', () => {
  it('locks the batches first, then the supplier; a batch that appears in between is taken before the supplier too', async () => {
    const { c, bank, b, supplierId } = await approvedBatch();
    const late = await plantBatch(pool, c, u.a, bank, []);
    const seen: { attempt: number; batch: boolean; late: boolean; supplier: boolean }[] = [];
    await inRequest(pool, u.a, c, async (client) => {
      const calls = { n: 0 };
      await lockBatchesBeforeSuppliers(c, [supplierId], ['draft', 'approved'], async () => {
        calls.n += 1;
        // At the moment the supplier lock is asked for: the batches this attempt knows are held, the supplier is NOT.
        seen.push({
          attempt: calls.n, batch: await isLocked(BATCHES, b.id), late: await isLocked(BATCHES, late.id),
          supplier: await isLocked('suppliers', supplierId),
        });
        // Commits between the first read and the supplier lock of the first attempt.
        if (calls.n === 1) await plantPayment(pool, c, u.a, bank, { supplierId, batchId: late.id });
        await client.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [supplierId]);
      });
      expect(await isLocked('suppliers', supplierId)).toBe(true);
      expect(await isLocked(BATCHES, late.id)).toBe(true);
    });
    expect(seen).toEqual([
      { attempt: 1, batch: true, late: false, supplier: false },
      // The retry: the supplier lock of attempt 1 was given back (false), both batches are held before it is asked for again.
      { attempt: 2, batch: true, late: true, supplier: false },
    ]);
  });

  it('with the supplier held, no payment can join a batch for it (the foreign key waits)', async () => {
    const { c, bank, supplierId } = await approvedBatch();
    const fresh = await plantBatch(pool, c, u.a, bank, []); // a batch nobody holds: only the supplier lock can stop the insert
    const blocked = await inRequest(pool, u.a, c, async (client) => {
      await lockBatchesBeforeSuppliers(c, [supplierId], ['draft', 'approved'], async () => {
        await client.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [supplierId]);
      });
      const other = await pool.connect();
      try {
        await other.query("SET lock_timeout = '300ms'");
        return await joinBatch(other, c, supplierId, fresh.id).then(() => 'inserted', (e: { code?: string }) => e.code);
      } finally {
        other.release();
      }
    });
    expect(blocked).toBe('55P03');
    await joinBatch(pool, c, supplierId, fresh.id); // the supplier released: it goes in
  });

  it('gives up with a retryable lock timeout (503 + Retry-After), not a loop or a 500, when the set keeps growing', async () => {
    const { c, bank, supplierId } = await approvedBatch();
    let calls = 0;
    const failure = await inRequest(pool, u.a, c, () => lockBatchesBeforeSuppliers(c, [supplierId], ['draft', 'approved'], async () => {
      calls += 1;
      const extra = await plantBatch(pool, c, u.a, bank, []);
      await plantPayment(pool, c, u.a, bank, { supplierId, batchId: extra.id });
    })).then(() => null, (e: unknown) => e);
    expect(calls).toBe(5);
    expect(failure).toBeInstanceOf(SupplierBatchLockTimeoutError);
    const { res, state, headers } = response();
    expect(respondIfLockTimeout(res, failure)).toBe(true);
    expect(state.statusCode).toBe(503);
    expect(headers.get('retry-after')).toBe('2');
  });
});
