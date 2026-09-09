import { afterAll, beforeAll, expect, it } from 'vitest';
import {randomUUID} from 'node:crypto';
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
        matchApprovalRules(await loadApprovalRules(requireControlTx(), 'invoice_match_override'), '1', new Map()));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('loads real immutable policy identities under each tenant app_user context', async () => {
  const a = await inspect('u1'), b = await inspect('u3');
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  expect(a[0]).toMatchObject({ policyVersion: 1, approverRole: 'admin', mandatory: true });
  expect(a[0]!.policyId).not.toBe(b[0]!.policyId);
  const saved = await pool.query('SELECT id FROM control_mandatory_match_override_policies WHERE company_id=$1', [fixture.companyA]);
  expect(a[0]!.policyId).toBe(saved.rows[0].id);
});

it('fails closed for missing immutable policy instead of silently permitting an override', async () => {
  await pool.query('DELETE FROM control_mandatory_match_override_policies WHERE company_id=$1', [fixture.companyB]);
  await expect(inspect('u3')).rejects.toThrow('Mandatory match override policy');
  expect(await inspect('u1')).toHaveLength(1);
});

it('stores immutable owned override intents with required evidence population',async()=>{
 const table=await pool.query("SELECT to_regclass('control_invoice_match_override_intents')::text AS name");
 expect(table.rows[0].name).toBe('control_invoice_match_override_intents');
 const grants=await pool.query("SELECT has_table_privilege('app_user','control_invoice_match_override_intents','SELECT') AS read,has_table_privilege('app_user','control_invoice_match_override_intents','INSERT') AS create,has_table_privilege('app_user','control_invoice_match_override_intents','UPDATE') AS update,has_table_privilege('app_user','control_invoice_match_override_intents','DELETE') AS delete");
 expect(grants.rows[0]).toEqual({read:true,create:true,update:false,delete:false});
});

it('enforces owned invoice, requester, evidence and tenant visibility at the actual database boundary',async()=>{
 const supplier=randomUUID(),invoice=randomUUID(),intent=randomUUID();
 await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',[supplier,fixture.companyA,'Synthetic override supplier']);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,total_amount,created_by) VALUES($1,$2,$3,$4,'2026-09-09',100,$5)",[invoice,fixture.companyA,supplier,invoice,fixture.u1.id]);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'}),fixture.companyA]);
  const insert='INSERT INTO control_invoice_match_override_intents(company_id,id,requester_person_id,invoice_id,expected_match_fingerprint,reason,evidence_refs) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)';
  const values=[fixture.companyA,intent,fixture.u1.id,invoice,'a'.repeat(64),'Synthetic acceptance',JSON.stringify([{evidenceId:randomUUID()}])];
  for(const changed of [{index:2,value:fixture.u2.id},{index:6,value:'[]'},{index:6,value:'{}'},{index:3,value:randomUUID()}]){
   await client.query('SAVEPOINT refusal');const invalid=[...values];invalid[changed.index]=changed.value;
   await expect(client.query(insert,invalid)).rejects.toThrow();await client.query('ROLLBACK TO SAVEPOINT refusal');
  }
  await client.query(insert,values);
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u3.id,company_id:fixture.companyB,role:'authenticated'}),fixture.companyB]);
  expect((await client.query('SELECT id FROM control_invoice_match_override_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,intent])).rows).toHaveLength(0);
 }finally{await client.query('ROLLBACK');client.release();}
});
