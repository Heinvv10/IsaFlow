/**
 * A supplier coding rule cannot be switched to auto_publish while it has no default GL account
 * (autoPublishGateService would publish a bill with nothing to post it to). Refused as a 400 from a read, before the
 * upsert writes, on both rules routes. A rule that holds an account, or that is given one in the same request, still
 * enables it. The MCP tools cannot set the flag.
 *
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { callRoute } from './helpers/vatLateClaimRoutes';
import {
  dropSupplierDefaultsFixture, seedSupplierDefaultsFixture, type SupplierDefaultsFixture,
} from './helpers/supplierDefaultsFixture';
import supplierRules from '../../pages/api/accounting/supplier-rules/index';
import supplierRuleDetail from '../../pages/api/accounting/supplier-rules/[supplierId]';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let s: SupplierDefaultsFixture;

describeIfDb('supplier rules: auto_publish needs a default GL account', () => {
  beforeAll(async () => { s = await seedSupplierDefaultsFixture('SRA', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropSupplierDefaultsFixture(s); }, 120000);

  const post = (supplierId: string, body: Record<string, unknown>) =>
    callRoute(s.fx, s.token, supplierRules, { supplierId, ...body });
  const patch = (supplierId: string, body: Record<string, unknown>) =>
    callRoute(s.fx, s.token, supplierRuleDetail, body, { supplierId }, 'PATCH');
  const rule = async (supplierId: string) => ((await sql`
    SELECT auto_publish, default_gl_account_id::TEXT AS gl, default_cc2_id::TEXT AS cc2
    FROM supplier_coding_rules WHERE supplier_id = ${supplierId}::UUID`) as Row[])[0];

  it('POST with autoPublish and no account on a supplier with no rule is a 400 that writes nothing', async () => {
    const sup = await s.newSupplier();
    const res = await post(sup, { autoPublish: true });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Auto-publish needs a default GL account');
    expect(await rule(sup)).toBeUndefined();
  });

  it('POST and PATCH on a dimensions-only rule are refused and leave it as it was, dimensions in the same body included', async () => {
    const sup = await s.newSupplier();
    await s.setRule(sup, { cc2: s.PF });
    for (const [name, call] of [['POST', post], ['PATCH', patch]] as const) {
      const res = await call(sup, { autoPublish: true, defaultBuId: s.BU1 });
      expect(res.statusCode, name).toBe(400);
      expect(await rule(sup), name).toMatchObject({ auto_publish: false, gl: null, cc2: s.PF });
    }
    const bu = ((await sql`SELECT default_bu_id FROM supplier_coding_rules WHERE supplier_id = ${sup}::UUID`) as Row[])[0]!.default_bu_id;
    expect(bu).toBeNull();
  });

  it('PATCH with autoPublish on a supplier with no rule is a 400 that writes nothing', async () => {
    const sup = await s.newSupplier();
    expect((await patch(sup, { autoPublish: true })).statusCode).toBe(400);
    expect(await rule(sup)).toBeUndefined();
  });

  it('an account in the same request lets it through, and so does an account the rule already holds', async () => {
    const inBody = await s.newSupplier();
    const created = await post(inBody, { autoPublish: true, defaultGlAccountId: s.fx.expenseId });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(await rule(inBody)).toMatchObject({ auto_publish: true, gl: s.fx.expenseId });

    const held = await s.newSupplier();
    await s.setRule(held, { cc2: s.PF });
    await sql`UPDATE supplier_coding_rules SET default_gl_account_id = ${s.fx.expenseId}::UUID WHERE supplier_id = ${held}::UUID`;
    const res = await patch(held, { autoPublish: true });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await rule(held)).toMatchObject({ auto_publish: true, gl: s.fx.expenseId, cc2: s.PF });
  });

  it('autoPublish false is never refused', async () => {
    const sup = await s.newSupplier();
    expect((await post(sup, { autoPublish: false, defaultCc2Id: s.PF })).statusCode).toBe(201);
    expect((await patch(sup, { autoPublish: false })).statusCode).toBe(200);
  });
});
