/**
 * Round-9 breaker findings on a real database (b9-a probes B9-C, B9-D, B9-I, ported):
 *   - C: a category name held by an owned category under another Sage id is worded as that;
 *   - D: a container mixing a page and plain rows is refused as a whole, never a dry_run_ok with POs silently dropped;
 *   - I: after a live run the summary says the owned item WAS updated.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { SageExportShapeError } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const run = (f: Row = exportFile(), over: Record<string, unknown> = {}) =>
  runSageMigration(pool, parsedExport(f), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });

describe('B9-C: a category name another Sage category holds', () => {
  it('is refused with the holder named as a Sage category under another Sage id', async () => {
    await pool.query(`INSERT INTO item_categories (company_id, name, external_system, external_ref) VALUES ($1, 'Optics', 'sage', '99')`, [s.companyId]);
    const r = await run(exportFile(), { live: false });
    const x = r.refused.find((y) => y.entity === 'category')!;
    expect(x.code).toBe('category_name_in_use');
    expect(x.reasons.join(' ')).toMatch(/under a different Sage id/);
    expect(x.reasons.join(' ')).not.toMatch(/does not own/);
  });
});

describe('B9-D: a page mixed with a row in one container', () => {
  it('the file is refused as a whole (a shape error), not read as a dry run that drops the page\'s POs', () => {
    const f = exportFile();
    const pos = f.PurchaseOrders as Row[];
    const mixed = { ...f, PurchaseOrders: [{ $totalResults: 9, $startIndex: 0, $resources: pos.slice(0, 9) }, pos[9]] };
    expect(() => parsedExport(mixed)).toThrow(SageExportShapeError);
  });
});

describe('B9-I: the summary of a live run that overwrote an owned item', () => {
  it('says it WAS updated (the dry run says "would be")', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`UPDATE items SET description = 'edited', updated_at = now() WHERE company_id = $1 AND external_ref = '50002'`, [s.companyId]);
    const dry = await run(exportFile(), { live: false });
    expect(summaryLines(dry).find((l) => /FIB-0002/.test(l))).toMatch(/would be updated/);
    const r = await run();
    const line = summaryLines(r).find((l) => /FIB-0002/.test(l))!;
    expect(line).toMatch(/was updated to Sage's values \(an IsaFlow edit of these fields was overwritten\)/);
    expect(line).not.toMatch(/would be updated/);
    expect((await pool.query(`SELECT description FROM items WHERE company_id = $1 AND external_ref = '50002'`, [s.companyId])).rows[0].description).not.toBe('edited');
  });
});
