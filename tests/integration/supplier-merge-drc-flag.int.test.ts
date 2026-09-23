/**
 * A supplier merge must not change which bills are eligible for DRC VAT.
 *
 * DRC eligibility reads the SUPPLIER's `subject_to_drc_vat` flag. Merging an
 * unflagged supplier into a flagged one re-parents its zero-VAT bills
 * (zero-rated, exempt, foreign) under a flagged supplier, making them DRC
 * candidates; the reverse silently drops eligible bills. The merge refuses
 * when the flags differ, before moving anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  SupplierMergeRefusal, assertSupplierMergeKeepsDrcFlag, mergeEntities,
} from '@/modules/accounting/services/core/duplicateMergeService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let flagged: string;
let plain: string;
let plain2: string;

const billsOn = async (id: string) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE supplier_id = ${id}::UUID`) as { n: number }[])[0]!.n);
const deleted = async (id: string) => ((await sql`
  SELECT deleted_at IS NOT NULL AS d FROM suppliers WHERE id = ${id}::UUID`) as { d: boolean }[])[0]!.d;

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SupplierMergeRefusal);
  return (err as Error).message;
}

describeIfDb('supplier merge — DRC flags must agree', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test merges suppliers.');
    fx = await seedFixture('SMD', DATABASE_URL!);
    other = await seedFixture('SMX', DATABASE_URL!);
    flagged = await seedSupplier(fx, 'Flagged');
    plain = await seedSupplier(fx, 'Plain');
    plain2 = await seedSupplier(fx, 'Plain two');
    await sql`UPDATE suppliers SET subject_to_drc_vat = true WHERE id = ${flagged}::UUID`;
    await seedBill(fx, { number: 'SMD-1', date: '2026-05-01', total: 100, supplierId: plain });
  }, 120000);

  afterAll(async () => { for (const f of [fx, other]) await dropFixture(f); }, 120000);

  it('refuses in either direction, naming the flag, and moves nothing', async () => {
    for (const [primary, dup] of [[flagged, plain], [plain, flagged]]) {
      const msg = await refusal(inTx(fx, () => mergeEntities(fx.companyId, 'supplier', primary!, dup!, fx.userId)));
      expect(msg).toContain('Subject to DRC VAT');
    }
    expect(await billsOn(plain)).toBe(1);
    expect(await deleted(plain)).toBe(false);
    expect(await deleted(flagged)).toBe(false);
  });

  it('the shared guard passes when the flags agree, and the merge goes ahead', async () => {
    await inTx(fx, () => assertSupplierMergeKeepsDrcFlag(fx.companyId, plain, plain2));
    await inTx(fx, () => mergeEntities(fx.companyId, 'supplier', plain2, plain, fx.userId));
    expect(await billsOn(plain2)).toBe(1);
  });

  it('reads flags only within the company: a foreign supplier id is not a match', async () => {
    const foreign = await seedSupplier(other, 'Foreign');
    const msg = await refusal(inTx(fx, () => assertSupplierMergeKeepsDrcFlag(fx.companyId, flagged, foreign)));
    expect(msg).toContain('not found');
  });
});
