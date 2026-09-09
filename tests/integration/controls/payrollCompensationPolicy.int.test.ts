import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {loadApprovalRules,matchApprovalRules} from '@/modules/accounting/services/controls/approvalRuleService';
import {assertOperationRequester} from '@/modules/accounting/services/controls/operationRequester';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:1});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(person:'u1'|'u3',fn:(ctx:ControlTx)=>Promise<T>){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,company_id:user.companyId,role:'authenticated'}),user.companyId]);
  return await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
 }finally{await client.query('ROLLBACK');client.release();}
}
it('loads distinct actual mandatory policies for each tenant even at zero compensation exposure',async()=>{
 const inspect=(person:'u1'|'u3')=>actor(person,async ctx=>matchApprovalRules(await loadApprovalRules(ctx,'payroll_compensation'),'0',new Map()));
 const a=await inspect('u1'),b=await inspect('u3');
 expect(a).toHaveLength(1);expect(b).toHaveLength(1);expect(a[0]).toMatchObject({mandatory:true,approverRole:'admin',policyVersion:1});
 expect(a[0]!.policyId).not.toBe(b[0]!.policyId);
 await pool.query('DELETE FROM control_mandatory_compensation_policies WHERE company_id=$1',[fixture.companyB]);
 await expect(inspect('u3')).rejects.toThrow('Mandatory compensation policy');expect(await inspect('u1')).toHaveLength(1);
});
it('retains immutable original maker and rejects a proxy requester',async()=>{
 await actor('u1',async ctx=>{
  const id=randomUUID(),payload={version:1,source:{kind:'manual'},actions:[{kind:'assign',assignmentId:randomUUID()}]};
  await ctx.sql`INSERT INTO control_payroll_compensation_intents(company_id,id,requester_person_id,effective_date,amount,currency,payload,source_fingerprint)
   VALUES(${fixture.companyA}::uuid,${id}::uuid,${fixture.u1.id},'2026-09-09',0,'ZAR',${JSON.stringify(payload)}::jsonb,${'a'.repeat(64)})`;
  const ref={entityType:'payroll_compensation_intent',entityId:id,operation:'payroll_compensation.change' as const};
  await assertOperationRequester(ctx,ref,fixture.u1.id);
  await expect(assertOperationRequester(ctx,ref,fixture.u2.id)).rejects.toThrow('Original intent requester');
  await expect(ctx.sql`UPDATE control_payroll_compensation_intents SET requester_person_id=${fixture.u2.id}
   WHERE company_id=${fixture.companyA}::uuid AND id=${id}::uuid`).rejects.toMatchObject({code:'42501'});
 });
});
it('refuses foreign tenant intent insertion at the storage boundary',async()=>{
 await actor('u3',async ctx=>{
  await expect(ctx.sql`INSERT INTO control_payroll_compensation_intents(company_id,id,requester_person_id,effective_date,amount,currency,payload,source_fingerprint)
   VALUES(${fixture.companyA}::uuid,${randomUUID()}::uuid,${fixture.u3.id},'2026-09-09',0,'ZAR',
    ${JSON.stringify({version:1,source:{kind:'manual'},actions:[{}]})}::jsonb,${'a'.repeat(64)})`).rejects.toMatchObject({code:'42501'});
 });
});
