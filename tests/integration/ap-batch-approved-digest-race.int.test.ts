/**
 * Migration 922, the race: a payee bank-detail edit concurrent with eft-generate of an approved batch (enforcement
 * off). Either the file waits for the edit and is refused (BATCH_CHANGED_SINCE_APPROVAL), or the edit waits for the
 * file — built from the approved details — and lands after it. Never a file with details nobody approved.
 *
 * Interleaved deterministically: the other backend is waited for until Postgres reports it blocked by the holder
 * (pg_blocking_pids / pg_stat_activity), never by sleeping; eft-generate is parked after its bank-file gate by
 * wrapping assertBatchMayBeSent. Judged by the file's content and the supplier row. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gate = vi.hoisted(() => ({
  /** Parks eft-generate AFTER the bank-file gate passed: it holds the batch row and its payees' share locks. */
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/batchBankFileGate', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/batchBankFileGate')>();
  return {
    ...actual,
    assertBatchMayBeSent: async (...a: Parameters<typeof actual.assertBatchMayBeSent>) => {
      await actual.assertBatchMayBeSent(...a);
      const park = gate.park;
      if (!park) return;
      gate.park = null;
      park.entered();
      await park.hold;
    },
  };
});

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, reasonOf } from './r035-approval.helpers';
import { cleanupPr5, digestOf } from './r035-pr5.helpers';
import { lockOrderKit } from './ap-supplier-batch-lock-order.helpers';
import { CHANGED, NEW_ACCOUNT, OLD_ACCOUNT, digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const { r, eft, fixture, approve, exportRecords, storedDigest, contentOf } = digestKit(pool, u, tokens, companies);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => { gate.park = null; });
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

describe('a bank-detail edit racing eft-generate: never a file with unapproved details', () => {
  const { startWriter, blockedStatement, accountOf } = lockOrderKit(pool, () => u.a);
  /** Resolves once some backend is blocked by `holderPid`. */
  async function blockedBy(holderPid: number) {
    for (let i = 0; i < 500; i += 1) {
      const { rowCount } = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid]);
      if (rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`nothing ever waited on backend ${holderPid}`);
  }

  it('edit first: the file waits for it, then is refused', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      const holder = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await held.query('UPDATE suppliers SET bank_account_number = $2 WHERE id = $1', [supplierId, NEW_ACCOUNT]);
      const generating = eft(c, b.id);
      await blockedBy(holder); // the file request waits on the payee row
      await held.query('COMMIT');
      const res = await generating;
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(reasonOf(res)).toBe(CHANGED);
      expect(await exportRecords(b.id)).toBe(0);
    } finally {
      held.release(true); // destroyed, not pooled: a failure above may leave its transaction open
    }
  });

  it('file first: the edit waits until the file (with the approved details) is served, and lands after it', async () => {
    const { c, b, supplierId } = await fixture();
    await approve(c, b.id);
    let release!: () => void;
    let entered!: () => void;
    const inGate = new Promise<void>((res) => { entered = res; });
    gate.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
    const generating = eft(c, b.id);
    await inGate; // gate passed: batch row and payee share locks held
    const edit = startWriter(c, () => updateSupplier(c, supplierId, { bankAccountNumber: NEW_ACCOUNT }, u.a));
    expect(await blockedStatement(await edit.pid)).toMatch(/supplier_payment_batches|suppliers/);
    expect(await accountOf(supplierId)).toBe(OLD_ACCOUNT);
    release();
    const [res, edited] = await Promise.all([generating, edit.outcome]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(contentOf(res)).toContain(OLD_ACCOUNT);
    expect(contentOf(res)).not.toContain(NEW_ACCOUNT);
    expect(edited).toEqual({ ok: true });
    expect(await accountOf(supplierId)).toBe(NEW_ACCOUNT);
    // And the next file is refused: the details are no longer the approved ones.
    expect(reasonOf(await eft(c, b.id))).toBe(CHANGED);
  });

  it('approve waits for a bank edit in flight and stores the digest of what it then sees: the file goes to the new details', async () => {
    const { c, b, supplierId } = await fixture();
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      const holder = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await held.query('UPDATE suppliers SET bank_account_number = $2 WHERE id = $1', [supplierId, NEW_ACCOUNT]);
      const approving = r.batch(u.a, c, 'approve', b.id);
      await blockedBy(holder); // approve waits on the payee row before it computes the digest
      await held.query('COMMIT');
      expect((await approving).state.statusCode).toBe(200);
    } finally {
      held.release(true);
    }
    expect(await storedDigest(b.id)).toBe(await digestOf(pool, c, 'payment_batch', b.id));
    const file = await eft(c, b.id);
    expect(file.state.statusCode, JSON.stringify(file.state.body)).toBe(200);
    expect(contentOf(file)).toContain(NEW_ACCOUNT);
  });
});
