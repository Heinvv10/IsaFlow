/**
 * The take-on import (importSuppliers, overwrite) writes several suppliers in ONE request transaction, so its lock
 * order is the whole import's: the batches of every overwritten supplier, then those supplier rows, as one id-ordered
 * set up front. A batch lock per row, taken while an earlier row's supplier is held, deadlocked with an id-ordered
 * writer (40P01). Contention is rethrown (503), never recorded as a per-row error with the import carrying on, and a
 * row that fails for any other reason leaves the transaction usable. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { importSuppliers } from '@/modules/accounting/services/core/migrationContactService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr5, inRequest, payCompany, plantBatch } from './r035-pr5.helpers';
import { lockOrderKit } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const { startWriter, blockedStatement, accountOf } = lockOrderKit(pool, () => user);
const NEW_ACCOUNT = '62000009999';
type Result = Awaited<ReturnType<typeof importSuppliers>>;

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupPr5(pool, companies, [user]));

/** Two single-member batches, named suppliers, a migration session; `lo` / `hi` by batch id order. */
async function setUp() {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  const one = await plantBatch(pool, c, user, bank, [1000]);
  const two = await plantBatch(pool, c, user, bank, [2000]);
  const [lo, hi] = one.id < two.id ? [one, two] : [two, one];
  const names = { lo: 'Alpha Traders', hi: 'Zulu Holdings' };
  await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [lo.members[0]!.supplierId, names.lo]);
  await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [hi.members[0]!.supplierId, names.hi]);
  const session = await inRequest(pool, user, c, () => createSession(c, 'sage', user));
  return { c, session: session.id, lo, hi, names, supplier: { lo: lo.members[0]!.supplierId, hi: hi.members[0]!.supplierId } };
}

describe('importSuppliers (overwrite)', () => {
  it('rows running against id order do not deadlock with an id-ordered writer', async () => {
    const t = await setUp();
    const rows = [t.names.hi, t.names.lo].map((name) => ({ name, bankAccountNumber: NEW_ACCOUNT })); // the HIGH batch first
    // The writer has the LOW batch (as an id-ordered writer takes it first), then asks for the high one and the rows.
    const writer: PoolClient = await pool.connect();
    let writerCode: string | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [t.lo.id]);
      let result: Result | undefined; // a deadlock victim row shows in `errors`, not as a rejection, without the rethrow
      const imp = startWriter(t.c, async () => { result = await importSuppliers(t.c, t.session, rows, 'overwrite', user); });
      await blockedStatement(await imp.pid); // the import waits for the low batch
      try {
        await writer.query('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [t.hi.id]);
        await writer.query('SELECT id FROM suppliers WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[t.supplier.lo, t.supplier.hi]]);
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
    expect([await accountOf(t.supplier.lo), await accountOf(t.supplier.hi)]).toEqual([NEW_ACCOUNT, NEW_ACCOUNT]);
  });

  it('a held row is rethrown and the whole import rolls back, not recorded as a row error', async () => {
    const t = await setUp();
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [t.supplier.lo]); // a no-bank row's only lock
      const before = await accountOf(t.supplier.hi);
      const out = await startWriter(t.c, async (client) => {
        await client.query("SET LOCAL lock_timeout = '300ms'");
        // Row 1 (bank column) goes through; row 2 (no bank column) waits on the held supplier and times out.
        await importSuppliers(t.c, t.session, [{ name: t.names.hi, bankAccountNumber: NEW_ACCOUNT }, { name: t.names.lo, email: 'a@example.com' }], 'overwrite', user);
      }).outcome;
      expect(out).toEqual({ ok: false, code: '55P03' });
      expect(await accountOf(t.supplier.hi)).toBe(before); // row 1 did not commit behind the failure
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('a row that fails for another reason is a row error and the next row still imports', async () => {
    const t = await setUp();
    let result: Result | undefined;
    const out = await startWriter(t.c, async () => {
      result = await importSuppliers(t.c, t.session, [
        { name: 'Brand New Supplier', paymentTerms: 'abc' as unknown as number }, // INSERT fails (22P02)
        { name: t.names.hi, bankAccountNumber: NEW_ACCOUNT },
      ], 'overwrite', user);
    }).outcome;
    expect(out).toEqual({ ok: true });
    expect({ imported: result?.imported, skipped: result?.skipped, failed: result?.errors.map((e) => e.row) }).toEqual({ imported: 1, skipped: 1, failed: [0] });
    expect(await accountOf(t.supplier.hi)).toBe(NEW_ACCOUNT);
  });
});
