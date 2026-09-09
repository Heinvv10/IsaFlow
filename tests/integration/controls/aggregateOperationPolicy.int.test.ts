import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { matchOperationPolicies } from '@/modules/accounting/services/controls/aggregateOperationPolicy';
import { reserveOperationExposure, type OperationMaterial } from '@/modules/accounting/services/controls/operationMaterializer';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 2 });
let fixture: ForensicFixture;
let day: string;
const ruleId = randomUUID(), supplierA = randomUUID(), supplierB = randomUUID();
const rule = { id: ruleId, document_type: 'payment', condition_field: 'amount', condition_operator: 'greater_than',
  condition_value: '10000', approver_role: 'admin', control_version: 1, is_active: true,
  aggregate_window_days: 1, aggregate_by: 'supplier' };
beforeAll(async () => {
  fixture = await provisionForensicFixture(config);
  day = (await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day")).rows[0].day;
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,
    condition_value,approver_role,aggregate_window_days,aggregate_by) VALUES($1,$2,'Synthetic daily suppliers','payment','amount','greater_than',10000,'admin',1,'supplier')`,
  [ruleId, fixture.companyA]);
});
afterAll(async () => { await pool.end(); });
function material(): OperationMaterial {
  return { supplierId: '', rules: [rule], observedSources: [], windowStart: day, bindingHash: 'synthetic-observation',
    versionBasis: 'untracked_current_observation', binding: { companyId: fixture.companyA,
      entityType: 'supplier_payment_batch', entityId: randomUUID(), entityVersion: 1,
      operation: 'supplier_payment_batch.process', accountingDate: day, amount: '12000', currency: 'ZAR',
      sourceVersions: [], policies: [], beneficiaries: [supplierA, supplierB].map(entityId => ({ entityType: 'supplier',
        entityId, beneficiaryId: randomUUID(), version: 1, fingerprint: 'synthetic-fingerprint', amount: '6000', currency: 'ZAR' })) } };
}
async function request<T>(person: 'u1' | 'u3', fn: (ctx: ControlTx) => Promise<T>) {
  const user = fixture[person], client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: user.id, company_id: user.companyId, role: 'authenticated' }), user.companyId]);
    const result = await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
      { personId: user.id, companyId: user.companyId, authMethod: 'cookie' }, async () => {
        const ctx = requireControlTx();
        await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${user.companyId}`},0))`;
        return fn(ctx);
      });
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
it('serializes concurrent mixed batches and persists exact exposure per supplier once', async () => {
  const first = material(), second = material();
  const run = (value: OperationMaterial) => request('u1', async ctx => {
    const policies = await matchOperationPolicies(ctx, [rule], value, day);
    await reserveOperationExposure(ctx, value, null, 'committed');
    return policies.length;
  });
  expect((await Promise.all([run(first), run(second)])).sort()).toEqual([0, 1]);
  await request('u1', ctx => reserveOperationExposure(ctx, first, null, 'committed'));
  const rows = await pool.query(`SELECT beneficiary_key,sum(amount)::text AS amount,count(*)::int AS entries
    FROM control_policy_exposure WHERE company_id=$1 AND policy_id=$2 GROUP BY beneficiary_key ORDER BY beneficiary_key`,
  [fixture.companyA, ruleId]);
  expect(rows.rows).toHaveLength(2);
  for (const row of rows.rows) { expect(Number(row.amount)).toBe(12000); expect(row.entries).toBe(2); }
});
it('does not include another tenant exposure and rolls back a failed reservation', async () => {
  const value = material();
  expect(await request('u3', ctx => matchOperationPolicies(ctx, [rule], value, day))).toEqual([]);
  await expect(request('u1', async ctx => {
    await reserveOperationExposure(ctx, value, null, 'committed'); throw new Error('Synthetic rollback');
  })).rejects.toThrow('Synthetic rollback');
  expect((await pool.query('SELECT entity_id FROM control_policy_exposure WHERE company_id=$1 AND entity_id=$2',
    [fixture.companyA, value.binding.entityId])).rows).toHaveLength(0);
});
