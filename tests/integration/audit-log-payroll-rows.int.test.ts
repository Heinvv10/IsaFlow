/**
 * #1656 rounds 8 and 9: getAuditLog / getEntityHistory leave the payroll audit rows out for a person without Payroll read, on a real
 * database: the payroll entity types, the pay-run approval request (written by 872's definer under 'approval_request', its subject in
 * metadata.documentType) and the reveal of a payroll entity change (under 'entity_change', its subject in metadata.entityType). Rows and
 * count agree, so a page is never short.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getAuditLog, getEntityHistory, logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, dropFixtureMember, seedFixture, seedFixtureMember, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
let fx: Fixture;
const ids = { emp: crypto.randomUUID(), payRunReq: crypto.randomUUID(), billReq: crypto.randomUUID(), revealEmp: crypto.randomUUID(), revealSup: crypto.randomUUID(), bill: crypto.randomUUID(), garnishee: crypto.randomUUID() };

const write = (entityType: string, entityId: string, metadata?: Record<string, string>) => logAuditOrThrow({
  companyId: fx.companyId, userId: fx.userId, action: 'update', entityType, entityId,
  ...(metadata ? { changes: { fields: [], metadata } } : {}),
});
const seen = async (payrollRead: boolean) => (await getAuditLog(fx.companyId, { payrollRead, limit: 100 })).items.map((i) => i.entityId).sort();

describe.skipIf(!DATABASE_URL)('the audit log without Payroll read (real database)', () => {
  beforeAll(async () => {
    assertNotProductionDb('audit log payroll rows');
    fx = await seedFixture('AUDPR', DATABASE_URL!);
    await seedFixtureMember(fx);
    await write('payroll_employee', ids.emp, { email: 'thandi@example.test' });
    await write('payroll_garnishee_order', ids.garnishee, { total_debt: '9000' });
    await write('approval_request', ids.payRunReq, { documentType: 'pay_run', documentId: ids.emp });
    await write('approval_request', ids.billReq, { documentType: 'supplier_invoice', documentId: ids.bill });
    await write('entity_change', ids.revealEmp, { revealed: 'id_number', entityType: 'payroll_employee', entityId: ids.emp });
    await write('entity_change', ids.revealSup, { revealed: 'bank_account_number', entityType: 'supplier', entityId: ids.bill });
    await write('supplier_invoice', ids.bill);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`.catch(() => undefined);
    await dropFixtureMember(fx);
    await dropFixture(fx);
  }, 120000);

  it('with Payroll read every row is there', async () => {
    const all = await seen(true);
    expect(all).toEqual([ids.emp, ids.garnishee, ids.payRunReq, ids.billReq, ids.revealEmp, ids.revealSup, ids.bill].sort());
  });

  it('without it the payroll entity types, the pay-run approval request and the payroll reveal are gone; the rest stays; rows and count agree', async () => {
    const page = await getAuditLog(fx.companyId, { payrollRead: false, limit: 100 });
    expect(page.items.map((i) => i.entityId).sort()).toEqual([ids.billReq, ids.revealSup, ids.bill].sort());
    expect(page.total).toBe(3);
    const small = await getAuditLog(fx.companyId, { payrollRead: false, limit: 2 });
    expect([small.items.length, small.total]).toEqual([2, 3]);
  });

  it('the entity history of an approval request or a reveal leaves the payroll ones out too', async () => {
    expect(await getEntityHistory(fx.companyId, 'approval_request', ids.payRunReq, false)).toEqual([]);
    expect(await getEntityHistory(fx.companyId, 'approval_request', ids.payRunReq, true)).toHaveLength(1);
    expect(await getEntityHistory(fx.companyId, 'entity_change', ids.revealEmp, false)).toEqual([]);
    expect(await getEntityHistory(fx.companyId, 'entity_change', ids.revealEmp, true)).toHaveLength(1);
    expect(await getEntityHistory(fx.companyId, 'approval_request', ids.billReq, false)).toHaveLength(1);
    expect(await getEntityHistory(fx.companyId, 'entity_change', ids.revealSup, false)).toHaveLength(1);
  });
});
