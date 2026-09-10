import { afterAll,beforeAll,expect,it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID,randomBytes } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture,validateFixtureTarget,type ForensicFixture } from '../forensic-fixture';
import { withControlRequest,requireControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx,OperationRef } from '@/modules/accounting/services/controls/contracts';
// A retried payroll posting must prove present approval authority, as the sibling
// historical-import/bank-transfer receipts do through replayKnownOperationEffect.
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
let fixture:ForensicFixture;
type Person={id:string;companyId:string};
const u4:Person={id:randomUUID(),companyId:''};
const employee=randomUUID(),component=randomUUID(),policyId=randomUUID();
const accounts=['5200','2140','2150','2160','1110','2175'].map(code=>({id:randomUUID(),code}));
async function actor<T>(user:Person,fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
    const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
    const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
      {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
    const outcome=await client.query('COMMIT');if(outcome.command!=='COMMIT')throw new Error('Transaction did not commit');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
  fixture=await provisionForensicFixture(config);u4.companyId=fixture.companyA;
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[u4.id,`${u4.id}@forensic.invalid`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[fixture.companyA,u4.id]);
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
  for(const account of accounts)await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level)
    VALUES($1,$2,$3,'Synthetic payroll account',$4,$5,true,3)`,[account.id,fixture.companyA,account.code,account.code==='5200'?'expense':'liability',account.code==='5200'?'debit':'credit']);
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
    VALUES($1,$2,'SYNTHETIC','Fixture','Payroll','2026-01-01','active')`,[employee,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type)
    VALUES($1,$2,'Synthetic basic','3601','earning')`,[component,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from)
    VALUES($1,$2,$3,100,'2026-01-01')`,[randomUUID(),employee,component]);
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Synthetic payroll policy','payroll_run','amount','any',0,'admin')`,[policyId,fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
let runCount=0;
async function calculatedRun(){
  // Each case needs its own period and this file runs more than twelve, so they continue into 2027.
  const index=runCount++,year=2026+Math.floor(index/12),month=index%12+1,id=randomUUID();
  const end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic revocation period',$3,$6,$4,$5,'open')`,[randomUUID(),fixture.companyA,month,`${year}-${String(month).padStart(2,'0')}-01`,end,year]);
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,$4,'draft')`,[id,fixture.companyA,month,year]);
  const {calculatePayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunService');
  await actor(fixture.u1,()=>calculatePayrollRun(id,fixture.companyA));
  return {id,ref:{entityType:'payroll_run',entityId:id,operation:'payroll_run.post'} as OperationRef};
}
async function approve(ref:OperationRef,requester:Person,reviewer:Person){
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const request=await actor(requester,ctx=>requestOperationApproval(ctx,ref));
  await actor(reviewer,ctx=>decideOperationApproval(ctx,request.id,'approved'));return request.id;
}
async function post(runId:string,approvalId?:string){
  const {approvePayrollRun}=await import('@/modules/accounting/services/payroll/payrollApprovalService');
  return actor(fixture.u1,()=>approvePayrollRun(fixture.companyA,runId,fixture.u1.id,approvalId?{approvalId}:undefined));
}
const settle=<T>(p:Promise<T>)=>p.then(value=>({ok:true as const,value}),(error:unknown)=>({ok:false as const,error:error instanceof Error?error.message:String(error)}));
async function ledger(runId:string){
  const journals=await pool.query(`SELECT id,status FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2 ORDER BY id`,[fixture.companyA,runId]);
  const totals=await pool.query(`SELECT COALESCE(SUM(debit),0)::text AS debit,COALESCE(SUM(credit),0)::text AS credit,COUNT(*)::int AS lines FROM gl_journal_lines
    WHERE company_id=$1 AND journal_entry_id IN(SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2)`,[fixture.companyA,runId]);
  const effects=await pool.query(`SELECT id FROM control_operation_effects WHERE company_id=$1 AND lower(entity_id)=lower($2) AND operation='payroll_run.post'`,[fixture.companyA,runId]);
  const events=await pool.query(`SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='payroll_run.post'`,[fixture.companyA,runId]);
  return {journals:journals.rows,totals:totals.rows[0],effects:effects.rows.length,events:events.rows.length};
}
async function withRole<T>(person:Person,role:string,fn:()=>Promise<T>):Promise<T>{
  await pool.query('UPDATE company_users SET role=$3 WHERE company_id=$1 AND user_id=$2',[fixture.companyA,person.id,role]);
  try{return await fn();}finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,person.id]);}
}
async function withoutPolicy<T>(fn:()=>Promise<T>):Promise<T>{
  await pool.query('UPDATE approval_rules SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,policyId]);
  try{return await fn();}finally{await pool.query('UPDATE approval_rules SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,policyId]);}
}
const services=async()=>({...await import('@/modules/accounting/services/controls/approvalRequestService'),
  ...await import('@/modules/accounting/services/payroll/payrollApprovalService')});

it('replays an unrevoked effected payroll posting exactly once on retry, with and without the approval id',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  const first=await post(current.id,approvalId),before=await ledger(current.id);
  expect(before.journals).toEqual([{id:first.journalEntryId,status:'posted'}]);expect(before.effects).toBe(1);
  expect(await post(current.id)).toEqual(first);
  expect(await post(current.id,approvalId)).toEqual(first);
  expect(await ledger(current.id)).toEqual(before);
  expect(before.totals.debit).toBe(before.totals.credit);expect(Number(before.totals.debit)).toBeGreaterThan(0);
});

it('refuses a retried payroll posting after the independent reviewer is revoked, without a second GL effect',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  const first=await post(current.id,approvalId),before=await ledger(current.id);
  const [withId,withoutId]=await withRole(fixture.u2,'viewer',async()=>[await settle(post(current.id,approvalId)),await settle(post(current.id))] as const);
  expect(await ledger(current.id)).toEqual(before);
  expect(before.journals).toEqual([{id:first.journalEntryId,status:'posted'}]);
  // Kernel path (approval id supplied) is the sibling behaviour: the revoked reviewer voids replay.
  expect(withId).toMatchObject({ok:false,error:expect.stringMatching(/no longer valid/)});
  // Fresh retry of the same run must refuse too; a returned receipt here is the defect.
  expect(withoutId,'fresh retry returned the stored receipt despite revoked reviewer').toEqual({ok:false,error:'Approval authority is no longer valid'});
});

it('refuses a retried payroll posting after the original requester is revoked, without a second GL effect',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,u4,fixture.u2);
  const first=await post(current.id,approvalId),before=await ledger(current.id);
  const [withId,withoutId]=await withRole(u4,'viewer',async()=>[await settle(post(current.id,approvalId)),await settle(post(current.id))] as const);
  expect(await ledger(current.id)).toEqual(before);
  expect(before.journals).toEqual([{id:first.journalEntryId,status:'posted'}]);
  expect(withId).toMatchObject({ok:false,error:expect.stringMatching(/no longer valid/)});
  expect(withoutId,'fresh retry returned the stored receipt despite revoked requester').toEqual({ok:false,error:'Approval authority is no longer valid'});
});

it('replays an uppercase-ID retry of a posted run exactly once, ledger unchanged',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  const first=await post(current.id,approvalId),before=await ledger(current.id),upper=current.id.toUpperCase();
  expect(await settle(post(upper)),'uppercase fresh retry').toEqual({ok:true,value:first});
  expect(await settle(post(upper,approvalId)),'uppercase kernel retry').toEqual({ok:true,value:first});
  expect(await ledger(current.id)).toEqual(before);
});

it('replays a legacy receipt stored under an uppercase entity id, and refuses a case-only duplicate receipt',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  const first=await post(current.id,approvalId);
  await pool.query(`UPDATE control_operation_effects SET entity_id=upper(entity_id)
    WHERE company_id=$1 AND entity_id=$2 AND operation='payroll_run.post'`,[fixture.companyA,current.id]);
  const before=await ledger(current.id);
  expect(await settle(post(current.id)),'legacy uppercase receipt').toEqual({ok:true,value:first});
  await pool.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
    SELECT company_id,gen_random_uuid(),operation_id,operation,entity_type,lower(entity_id),binding_hash,result,committed_at
    FROM control_operation_effects WHERE company_id=$1 AND entity_id=upper($2) AND operation='payroll_run.post'`,[fixture.companyA,current.id]);
  expect(await settle(post(current.id)),'case-only duplicate').toEqual({ok:false,error:'Ambiguous payroll posting receipt'});
  expect((await ledger(current.id)).journals).toEqual(before.journals);
});

it('replays a payroll receipt that had no linked approval exactly once on retry',async()=>{
  const current=await calculatedRun();
  const [first,before,retry,after]=await withoutPolicy(async()=>{
    const first=await post(current.id),before=await ledger(current.id);
    return [first,before,await settle(post(current.id)),await ledger(current.id)] as const;
  });
  const approvals=await pool.query('SELECT id FROM control_operation_approvals WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,current.id]);
  expect(approvals.rows).toEqual([]);expect(before.effects).toBe(1);
  expect(retry).toEqual({ok:true,value:first});expect(after).toEqual(before);
});

it('replays a no-approval receipt whose own request also requested approval for another run',async()=>{
  const other=await calculatedRun(),current=await calculatedRun(),{requestOperationApproval,approvePayrollRun}=await services();
  const [first,before,retry]=await withoutPolicy(async()=>{
    const first=await actor(fixture.u1,async ctx=>{await requestOperationApproval(ctx,other.ref);return approvePayrollRun(fixture.companyA,current.id,fixture.u1.id);});
    return [first,await ledger(current.id),await settle(post(current.id))] as const;
  });
  const shared=await pool.query(`SELECT a.id FROM control_operation_effects e JOIN control_operation_approvals a
    ON a.company_id=e.company_id AND a.operation_id=e.operation_id WHERE e.company_id=$1 AND e.entity_id=$2`,[fixture.companyA,current.id]);
  expect(shared.rows,'effect shares its operation id with the other run approval').toHaveLength(1);
  expect(retry).toEqual({ok:true,value:first});expect(await ledger(current.id)).toEqual(before);
});

it('replays a consumed approval whose request also requested another run approval, still rechecking revocation',async()=>{
  const current=await calculatedRun(),other=await calculatedRun(),{requestOperationApproval,decideOperationApproval}=await services();
  const approvalId=await actor(fixture.u1,async ctx=>{const own=await requestOperationApproval(ctx,current.ref);await requestOperationApproval(ctx,other.ref);return own.id;});
  await actor(fixture.u2,ctx=>decideOperationApproval(ctx,approvalId,'approved'));
  const first=await post(current.id,approvalId),before=await ledger(current.id);
  expect(await settle(post(current.id)),'fresh retry with shared request').toEqual({ok:true,value:first});
  expect(await withRole(fixture.u2,'viewer',()=>settle(post(current.id))),'revoked reviewer').toEqual({ok:false,error:'Approval authority is no longer valid'});
  expect(await ledger(current.id)).toEqual(before);
});

it('grants app_user update on only the approval columns the replay join does not trust',async()=>{
  // The join's second arm compares entity_id and operation_id; a tenant able to edit those
  // could re-point an approval and defeat the linkage check the arm exists to make.
  const {rows}=await pool.query(`SELECT column_name FROM information_schema.column_privileges
    WHERE table_schema='public' AND table_name='control_operation_approvals' AND grantee='app_user'
      AND privilege_type='UPDATE' ORDER BY column_name`);
  expect(rows.map(row=>row.column_name)).toEqual(['consumed_at','consumed_effect_id','decided_at','status']);
});

// The same request requests approval for a run, then posts that run without it (no policy applies).
async function unconsumedSameRunApproval(storeUppercase:boolean){
  const current=await calculatedRun(),{requestOperationApproval,approvePayrollRun}=await services();
  return withoutPolicy(async()=>{
    const approvalId=await actor(fixture.u1,async ctx=>{const own=await requestOperationApproval(ctx,current.ref);
      await approvePayrollRun(fixture.companyA,current.id,fixture.u1.id);return own.id;});
    if(storeUppercase)await pool.query('UPDATE control_operation_approvals SET entity_id=upper(entity_id) WHERE company_id=$1 AND id=$2',[fixture.companyA,approvalId]);
    const [approval]=(await pool.query('SELECT status,consumed_effect_id FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,approvalId])).rows;
    const before=await ledger(current.id);
    return {approval,before,retry:await settle(post(current.id)),after:await ledger(current.id)};
  });
}

it('fails closed when the same request left an unconsumed approval for the same run',async()=>{
  const {approval,before,retry,after}=await unconsumedSameRunApproval(false);
  expect(approval).toEqual({status:'approved',consumed_effect_id:null});expect(before.effects).toBe(1);
  expect(retry).toEqual({ok:false,error:'Approval effect linkage is invalid'});expect(after).toEqual(before);
});

it('fails closed when that unconsumed same-run approval stores an uppercase entity id',async()=>{
  const {approval,before,retry,after}=await unconsumedSameRunApproval(true);
  expect(approval).toEqual({status:'approved',consumed_effect_id:null});
  expect(retry).toEqual({ok:false,error:'Approval effect linkage is invalid'});expect(after).toEqual(before);
});

it('refuses a fresh retry after the consumed approval link is erased, instead of skipping the revocation recheck',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  await post(current.id,approvalId);const before=await ledger(current.id);
  await pool.query('UPDATE control_operation_approvals SET consumed_effect_id=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,approvalId]);
  expect(await withRole(fixture.u2,'viewer',()=>settle(post(current.id))),'erased link with revoked reviewer').toEqual({ok:false,error:'Approval effect linkage is invalid'});
  expect(await ledger(current.id)).toEqual(before);
});

it('refuses an approval-id retry deterministically when a case-only duplicate effect exists',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref,fixture.u1,fixture.u2);
  await post(current.id,approvalId);const before=await ledger(current.id);
  await pool.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
    SELECT company_id,gen_random_uuid(),operation_id,operation,entity_type,upper(entity_id),binding_hash,result,committed_at
    FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='payroll_run.post'`,[fixture.companyA,current.id]);
  expect(await settle(post(current.id,approvalId)),'kernel retry with case-only duplicate').toEqual({ok:false,error:'Committed operation effect is ambiguous'});
  expect((await ledger(current.id)).journals).toEqual(before.journals);
});
