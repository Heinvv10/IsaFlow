/**
 * The supplier's "subject to DRC VAT" flag is written by the one service the
 * REST route and the MCP tools share. Before this, nothing could set it on a
 * supplier (only customers had a toggle), so DRC eligibility could not use it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

const flag = async (id: string) => ((await sql`
  SELECT subject_to_drc_vat FROM suppliers WHERE id = ${id}::UUID`) as { subject_to_drc_vat: boolean }[])[0]!
  .subject_to_drc_vat;

describeIfDb('supplier subject_to_drc_vat — create and update', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates suppliers.');
    fx = await seedFixture('SDF', DATABASE_URL!);
  }, 120000);

  afterAll(async () => { await dropFixture(fx); }, 120000);

  it('defaults to false, is set on create, and changes only when an update names it', async () => {
    const plain = await inTx(fx, () => createSupplier(fx.companyId, { name: `Plain ${fx.tag}` }));
    expect(plain.subject_to_drc_vat).toBe(false);

    const drc = await inTx(fx, () => createSupplier(fx.companyId, { name: `DRC ${fx.tag}`, subjectToDrcVat: true }));
    expect(drc.subject_to_drc_vat).toBe(true);

    // An update that does not mention the flag leaves it alone.
    await inTx(fx, () => updateSupplier(fx.companyId, String(drc.id), { notes: 'x' }));
    expect(await flag(String(drc.id))).toBe(true);
    // An explicit false clears it.
    const off = await inTx(fx, () => updateSupplier(fx.companyId, String(drc.id), { subjectToDrcVat: false }));
    expect(off!.subject_to_drc_vat).toBe(false);
  });
});
