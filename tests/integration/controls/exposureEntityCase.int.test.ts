import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {matchOperationPolicies} from '@/modules/accounting/services/controls/aggregateOperationPolicy';
import {reserveOperationExposure,type OperationMaterial} from '@/modules/accounting/services/controls/operationMaterializer';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture,day:string;
const ruleId=randomUUID(),supplier=randomUUID();
const rule={id:ruleId,document_type:'payment',condition_field:'amount',condition_operator:'greater_than',
 condition_value:'10000',approver_role:'admin',control_version:1,is_active:true,aggregate_window_days:1,aggregate_by:'supplier'};
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 day=(await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day")).rows[0].day;
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,
  condition_value,approver_role,aggregate_window_days,aggregate_by)
  VALUES($1,$2,'Synthetic exposure identity','payment','amount','greater_than',10000,'admin',1,'supplier')`,[ruleId,fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
function material(entityId:string):OperationMaterial{
 return{supplierId:'',rules:[rule],observedSources:[],windowStart:day,bindingHash:'synthetic-observation',
  versionBasis:'untracked_current_observation',binding:{companyId:fixture.companyA,entityType:'supplier_payment_batch',
   entityId,entityVersion:1,operation:'supplier_payment_batch.process',accountingDate:day,amount:'6000',currency:'ZAR',
   sourceVersions:[],policies:[],beneficiaries:[{entityType:'supplier',entityId:supplier,beneficiaryId:randomUUID(),
    version:1,fingerprint:'synthetic-fingerprint',amount:'6000',currency:'ZAR'}]}};
}
async function request<T>(fn:(ctx:ControlTx)=>Promise<T>){
 const user=fixture.u1,client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({sub:user.id,company_id:user.companyId,role:'authenticated'}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},async()=>{
    const ctx=requireControlTx();
    await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${user.companyId}`},0))`;
    return fn(ctx);
   });
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
it('an operation is not aggregated against its own exposure retained under another spelling',async()=>{
 const entityId=randomUUID();
 // Legacy source retained this operation's own exposure with the caller's uppercase spelling.
 await request(ctx=>reserveOperationExposure(ctx,material(entityId.toUpperCase()),null,'committed'));
 expect(await request(ctx=>matchOperationPolicies(ctx,[rule],material(entityId),day))).toEqual([]);
});
it('a different operation of the same beneficiary still aggregates', async()=>{
 await request(ctx=>reserveOperationExposure(ctx,material(randomUUID()),null,'committed'));
 const policies=await request(ctx=>matchOperationPolicies(ctx,[rule],material(randomUUID()),day));
 expect(policies).toEqual([{policyId:ruleId,policyVersion:1,approverRole:'admin',mandatory:false}]);
});
