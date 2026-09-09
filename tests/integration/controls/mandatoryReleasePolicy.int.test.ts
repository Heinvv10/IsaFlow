import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { loadApprovalRules, matchApprovalRules } from '@/modules/accounting/services/controls/approvalRuleService';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 1 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
afterAll(async () => { await pool.end(); });

async function inspect(person: 'u1' | 'u3') {
  const user = fixture[person], client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: user.id, company_id: user.companyId, role: 'authenticated' }), user.companyId]);
    return await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
      { personId: user.id, companyId: user.companyId, authMethod: 'cookie' }, async () =>
        matchApprovalRules(await loadApprovalRules(requireControlTx(), 'payment_release'), '1', new Map()));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('loads real immutable policy identities under each tenant app_user context', async () => {
  const a = await inspect('u1'), b = await inspect('u3');
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  expect(a[0]).toMatchObject({ policyVersion: 1, approverRole: 'admin', mandatory: true });
  expect(a[0]!.policyId).not.toBe(b[0]!.policyId);
  const saved = await pool.query('SELECT id FROM control_mandatory_release_policies WHERE company_id=$1', [fixture.companyA]);
  expect(a[0]!.policyId).toBe(saved.rows[0].id);
});

it('fails closed for missing immutable policy instead of silently permitting release', async () => {
  await pool.query('DELETE FROM control_mandatory_release_policies WHERE company_id=$1', [fixture.companyB]);
  await expect(inspect('u3')).rejects.toThrow('Mandatory release policy');
  expect(await inspect('u1')).toHaveLength(1);
});
