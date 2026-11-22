/**
 * Sage migration runner: re-runs, failures and refusals, against a real database through the real MCP registry.
 *   - a re-run of the same export under the same keys replays and changes nothing; a re-run under NEW keys (other batch sizes)
 *     is still a no-op, because the tools are idempotent on the Sage reference;
 *   - a batch whose COMMIT fails is not in the books; the other batches of its phase still run, the next phase does not start,
 *     and running again finishes the job (resume), the finished batches replaying under the same keys;
 *   - rows no tool could take are refused BEFORE sending, with reasons, and the rest of the file goes through.
 * What the company already holds (items, suppliers, categories, PO numbers) and deleted rows are in sage-migration-runner-held.int.test.ts.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, stamps, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;

beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const run = (over: Record<string, unknown> = {}, file = exportFile(), p: Pool = pool) =>
  runSageMigration(p, parsedExport(file), { companyId: s.companyId, userId: s.userId, live: true, ...over });
type Row = Record<string, unknown>;
const rowsOf = (file: Record<string, unknown>) => (file.Items as { $resources: Row[] }).$resources;
const posOf = (file: Record<string, unknown>) => file.PurchaseOrders as Row[];

describe('a re-run', () => {
  it('under the same keys replays every batch and touches no row', async () => {
    const first = await run();
    expect(first.status).toBe('completed');
    const afterFirst = { counts: await booked(pool, s.companyId), stamps: await stamps(pool, s.companyId) };
    const again = await run();
    expect(again.status).toBe('completed');
    expect(again.reconciliation).toMatchObject({ items: { presentBefore: 20, addedByRun: 0 }, purchaseOrders: { presentBefore: 10, addedByRun: 0 }, allSentBooked: true, nothingRefused: true });
    const batches = [...again.live!.items.batches, ...again.live!.purchaseOrders.batches];
    expect(batches.every((b) => b.allRowsAlreadyPresent && b.status === 'ok')).toBe(true);
    expect(batches.map((b) => b.key)).toEqual([...first.live!.items.batches, ...first.live!.purchaseOrders.batches].map((b) => b.key));
    // A replay records nothing: not one new audit row, not one row touched.
    expect(await booked(pool, s.companyId)).toEqual(afterFirst.counts);
    expect(await stamps(pool, s.companyId)).toEqual(afterFirst.stamps);
  });

  it('under NEW keys (other batch sizes) still adds nothing: the Sage reference is the idempotency', async () => {
    await run();
    const before = { counts: await booked(pool, s.companyId), stamps: await stamps(pool, s.companyId) };
    const again = await run({ itemBatchSize: 7, poBatchSize: 3 });
    expect(again.status).toBe('completed');
    expect(again.live!.items.batches).toHaveLength(3);
    expect(again.live!.purchaseOrders.batches).toHaveLength(4);
    expect(again.live!.items.batches[0]!.toolReported).toMatchObject({ counts: { created: 0, updated: 0, unchanged: 7 }, written: false });
    expect(again.live!.purchaseOrders.batches[0]!.toolReported).toMatchObject({ created: 0, already_existed: 3 });
    expect(again.reconciliation).toMatchObject({ items: { addedByRun: 0 }, purchaseOrders: { addedByRun: 0, differenceCents: 0 }, allSentBooked: true, nothingRefused: true });
    const now = await booked(pool, s.companyId);
    expect({ ...now, toolCalls: 0 }).toEqual({ ...before.counts, toolCalls: 0 });
    expect(await stamps(pool, s.companyId)).toEqual(before.stamps);
  });

  it('with skip_budget_check_for_import asked, passes it to the PO tool and still completes', async () => {
    const r = await run({ skipBudgetCheck: true });
    expect(r.status).toBe('completed');
    expect(r.live!.purchaseOrders.batches[0]!.toolReported).toMatchObject({ skip_budget_check_for_import: true, created: 10 });
  });
});

describe('a failed batch', () => {
  it('a PO batch whose COMMIT fails is not booked; its neighbours are; running again finishes it', async () => {
    // Commits: 1-4 categories, 5 the one item batch, 6-9 the PO batches of 3 (197-199, 200-202, 203-205, 206).
    const first = await run({ poBatchSize: 3 }, exportFile(), failingCommitPool(pool, [7]));
    expect(first.status).toBe('failed');
    expect(first.live!.purchaseOrders.batches.map((b) => b.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(first.live!.purchaseOrders.batches[1]!.error).toMatch(/injected: COMMIT 7 failed/);
    const poNumbers = (await pool.query('SELECT po_number FROM purchase_orders WHERE company_id = $1 ORDER BY po_number', [s.companyId])).rows.map((r) => r.po_number);
    expect(poNumbers).toEqual(['PO0000197', 'PO0000198', 'PO0000199', 'PO0000203', 'PO0000204', 'PO0000205', 'PO0000206']);
    expect(first.reconciliation).toMatchObject({ allSentBooked: false, purchaseOrders: { presentAfter: 7, addedByRun: 7 } });
    expect(first.reconciliation.purchaseOrders.differenceCents).toBeGreaterThan(0);
    expect(summaryLines(first).some((l) => l.startsWith('FAILED purchase_order batch 2'))).toBe(true);

    const resumed = await run({ poBatchSize: 3 });
    expect(resumed.status).toBe('completed');
    expect(resumed.live!.purchaseOrders.batches.map((b) => b.allRowsAlreadyPresent)).toEqual([true, false, true, true]);
    expect(resumed.live!.purchaseOrders.batches.map((b) => b.key)).toEqual(first.live!.purchaseOrders.batches.map((b) => b.key));
    expect(resumed.reconciliation).toMatchObject({ allSentBooked: true, purchaseOrders: { presentBefore: 7, presentAfter: 10, addedByRun: 3, differenceCents: 0 } });
    expect((await booked(pool, s.companyId)).pos).toBe(10);
  });

  it('a failed item batch keeps the purchase orders from starting; categories stay; running again finishes', async () => {
    const first = await run({}, exportFile(), failingCommitPool(pool, [5]));
    expect(first.status).toBe('failed');
    expect(first.live!.categories.failed).toBe(0);
    expect(first.live!.items.batches.map((b) => b.status)).toEqual(['failed']);
    expect(first.live!.purchaseOrders.batches).toEqual([]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0, pos: 0 });
    const resumed = await run();
    expect(resumed.status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 10 });
  });

  it('a failed category keeps the items from starting, the other categories still run', async () => {
    const first = await run({}, exportFile(), failingCommitPool(pool, [2]));
    expect(first.status).toBe('failed');
    expect(first.live!.categories.batches.map((b) => b.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(first.live!.items.batches).toEqual([]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 3, items: 0, pos: 0 });
    expect((await run()).status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 10 });
  });
});

describe('rows refused before sending', () => {
  it('are reported with reasons and the rest of the file is booked', async () => {
    const file = exportFile();
    rowsOf(file)[2] = { ...rowsOf(file)[2], TaxTypeIdSales: 9 }; // FIB-0003: tax type unknown
    posOf(file)[1] = { ...posOf(file)[1], SupplierId: 999, SupplierName: 'Nobody Ltd' }; // no such supplier
    posOf(file)[2] = { ...posOf(file)[2], Exclusive: (posOf(file)[2]!.Exclusive as number) + 100, Total: (posOf(file)[2]!.Total as number) + 100 }; // lines do not add up
    posOf(file)[4] = { ...posOf(file)[4], SupplierId: 888, SupplierName: 'Dup Co' }; // two suppliers of that name
    for (let i = 0; i < 2; i++) await pool.query('INSERT INTO suppliers (company_id, name) VALUES ($1, $2)', [s.companyId, 'Dup Co']);
    const parsed = parsedExport(file);

    // What the export holds is not what was booked: asked to expect the export's own figures, the run says it missed them.
    const r = await run({ expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: parsed.exportPoTotalCents } }, file);
    expect(r.status).toBe('completed');
    expect(r.reconciliation.expected).toMatchObject({
      items: { expected: 20, actual: 19, basis: 'booked', ok: false }, purchaseOrders: { expected: 10, actual: 7, ok: false },
      purchaseOrderTotalCents: { ok: false },
    });
    expect(exitCodeFor(r, true)).toBe(1); // allowed refusals do not excuse a missed expectation
    expect(summaryLines(r).filter((l) => l.startsWith('MISMATCH'))).toHaveLength(3);
    expect(r.refused.map((x) => [x.entity, x.label, x.code]).sort()).toEqual([
      ['item', 'FIB-0003', 'invalid_row'],
      ['purchase_order', 'PO0000198', 'supplier_unresolved'],
      ['purchase_order', 'PO0000199', 'tool_refuses'],
      ['purchase_order', 'PO0000201', 'supplier_ambiguous'],
    ]);
    expect(r.refused.find((x) => x.label === 'PO0000199')!.reasons[0]).toMatch(/subtotal/i);
    expect(r.refused.find((x) => x.label === 'FIB-0003')!.reasons[0]).toMatch(/TaxTypeIdSales 9/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 19, pos: 7 });
    const rec = r.reconciliation;
    expect(rec.items).toMatchObject({ inExport: 20, refused: 1, sent: 19, presentAfter: 19 });
    expect(rec.purchaseOrders).toMatchObject({ inExport: 10, refused: 3, sent: 7, presentAfter: 7, differenceCents: 0 });
    expect(rec.purchaseOrders.sentTotalCents + rec.purchaseOrders.notSentTotalCents).toBe(rec.purchaseOrders.exportTotalCents);
    expect(rec.purchaseOrders.notSentTotalCents).toBeGreaterThan(0);
    expect([rec.allSentBooked, rec.nothingRefused]).toEqual([true, false]); // everything sent is booked; four rows were not sent
    expect(summaryLines(r).filter((l) => l.startsWith('refused '))).toHaveLength(4);
    expect(exitCodeFor(r, false)).toBe(1);
  });
});
