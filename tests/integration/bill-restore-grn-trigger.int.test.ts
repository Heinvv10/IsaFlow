/**
 * The restore's mapping of 1021's grn-live trigger (review of c2110f585e, L3), real PostgreSQL, as app_user. The undo checks the
 * same rule first (assertBillRestorableGrn, under the note hold), so from the app the trigger never refuses a restore; the mapping
 * stays because the undo route answers anything unmapped as a 500 (pages/api/accounting/soft-delete.ts), never reaching the central
 * 409. Here that check is bypassed (mocked to pass), so the restore UPDATE meets the trigger: the caller gets the typed
 * SoftDeleteRefusalError and the bill stays deleted.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropGrnExtras, dropMaintExtras, grnArgs, seedQtyPo } from './helpers/grnHarness';
import { createGoodsReceivedTool as create } from '@/lib/mcp/tools/writeCreateGoodsReceived';
import { cancelGoodsReceivedTool as cancel } from '@/lib/mcp/tools/writeCancelGoodsReceived';
import { restoreRow } from '@/modules/accounting/services/core/softDeleteRowOps';
import { SoftDeleteRefusalError } from '@/modules/accounting/services/core/softDeleteErrors';

vi.mock('../../src/modules/accounting/services/ap/billGoodsReceivedLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/accounting/services/ap/billGoodsReceivedLink')>()),
  assertBillRestorableGrn: async () => undefined,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'grn-restore-trigger'); }, 60_000);
afterAll(async () => {
  try { await dropGrnExtras(pool, f); await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

describe('a restore that skips its own note check meets the grn-live trigger', () => {
  it('answers SoftDeleteRefusalError and leaves the bill deleted', async () => {
    const po = await seedQtyPo(pool, f, { lines: [{ qty: 4, price: 10 }] });
    const made = await callTool(pool, f, create, grnArgs(po, [[0, 4]]));
    expect(made.isError, made.text).toBe(false);
    const grn = String(made.body.grn_id);
    const bill = await seedBill(pool, f, { status: 'draft', lines: [40] });
    await pool.query('UPDATE supplier_invoices SET grn_id = $2, deleted_at = now() WHERE id = $1', [bill.id, grn]);
    expect((await callTool(pool, f, cancel, { grn_id: grn, reason: 'cancelled while the bill was deleted' })).isError).toBe(false);

    const req = await openRequest(pool, f, f.owner);
    const out = await req.run(() => restoreRow('supplier_invoice', bill.id, f.co)).then(
      (r) => r, (e: unknown) => e);
    await req.rollback();
    expect(out).toBeInstanceOf(SoftDeleteRefusalError);
    expect((out as Error).message).toContain('cannot be restored');
    expect((await pool.query('SELECT deleted_at IS NOT NULL AS d FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].d).toBe(true);
  });
});
