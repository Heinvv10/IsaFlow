import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {assertSuppliedApprovalExecutable} from '@/modules/accounting/services/controls/approvalExecutionService';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndCloseService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
/**
 * A preview given an approval answers exactly as the live call would, and is
 * still a preview: it writes nothing, consumes nothing, and takes its locks in
 * the live path's order (control policy, then approval) so it cannot deadlock
 * against a live execution of the same approval.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:5,statement_timeout:15000});
let fixture:ForensicFixture;
const periodId=randomUUID(),otherPeriodId=randomUUID(),retained=randomUUID();
const ref=(id:string):OperationRef=>({entityType:'fiscal_period',entityId:id,operation:'fiscal_period.close'});
async function actor<T>(person:'u1'|'u2',fn:(ctx:ControlTx)=>Promise<T>,label='synthetic-supplied-approval'):Promise<T>{
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true),set_config('application_name',$3,true)",[JSON.stringify(claims),user.companyId,label]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function approval(operation:OperationRef,decision:'approved'|'rejected'='approved'){
 const row=await actor('u1',ctx=>requestOperationApproval(ctx,operation));
 await actor('u2',ctx=>decideOperationApproval(ctx,row.id,decision));return row.id;
}
/** Every row a preview could write, consume or version, for this company. */
async function snapshot(){
 const rows=async(table:string)=>(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE company_id=$1 ORDER BY to_jsonb(t)::text`,[fixture.companyA])).rows;
 return{approvals:await rows('control_operation_approvals'),effects:await rows('control_operation_effects'),
  events:await rows('control_change_events'),periods:await rows('fiscal_periods'),journals:await rows('gl_journal_entries')};
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET financial_year_start=1,default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$3,'Synthetic open period',1,2041,'2041-01-01','2041-01-31','open'),($2,$3,'Synthetic other period',2,2041,'2041-02-01','2041-02-28','open'),
  ($4,$3,'Synthetic closed year',12,2040,'2040-01-01','2040-12-31','closed')`,[periodId,otherPeriodId,fixture.companyA,randomUUID()]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
  VALUES($1,$2,$3,'Synthetic retained','equity','retained_earnings','credit',true,true,3)`,[retained,fixture.companyA,retained.slice(0,12)]);
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,$2,'Synthetic period policy','fiscal_period','amount','any',0,'admin')`,[randomUUID(),fixture.companyA]);
},60000);
afterAll(async()=>{await pool.end();});
it('accepts a valid approval, writing and consuming nothing',async()=>{
 const id=await approval(ref(periodId));
 const before=await snapshot();
 await actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),id));
 expect(await snapshot()).toEqual(before);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].status).toBe('approved');
},60000);
it('refuses an approval the live call would refuse, and writes nothing either way',async()=>{
 const rejected=await approval(ref(periodId),'rejected'),otherEntity=await approval(ref(otherPeriodId));
 const before=await snapshot();
 await expect(actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),randomUUID()))).rejects.toThrow('Approval authorities unavailable');
 await expect(actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),rejected))).rejects.toThrow();
 await expect(actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),otherEntity))).rejects.toThrow();
 expect(await snapshot()).toEqual(before);
},60000);
it('holds no lock once its transaction ends',async()=>{
 const id=await approval(ref(periodId));
 await actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),id));
 const client=await pool.connect();
 try{await client.query('BEGIN');
  const row=await client.query('SELECT id FROM control_operation_approvals WHERE company_id=$1 AND id=$2 FOR UPDATE NOWAIT',[fixture.companyA,id]);
  expect(row.rows).toHaveLength(1);
  const policy=await client.query("SELECT pg_try_advisory_lock(hashtextextended('control-policy:'||$1::text,0)) AS free",[fixture.companyA]);
  expect(policy.rows[0].free).toBe(true);
  await client.query("SELECT pg_advisory_unlock(hashtextextended('control-policy:'||$1::text,0))",[fixture.companyA]);
 }finally{await client.query('ROLLBACK');client.release();}
},60000);
it('takes the control-policy lock before the approval row, as the live path does',async()=>{
 // A live execution holding the policy lock goes on to lock the approval. A
 // preview that locked the approval first and then waited for the policy lock
 // would deadlock it (40P01): here, the approval must still be free to lock.
 const id=await approval(ref(periodId)),label=`synthetic-lock-order-${randomUUID().slice(0,8)}`;
 const live=await pool.connect();let preview:Promise<void>|undefined;
 try{
  await live.query('BEGIN');
  await live.query("SELECT pg_advisory_xact_lock(hashtextextended('control-policy:'||$1::text,0))",[fixture.companyA]);
  preview=actor('u1',ctx=>assertSuppliedApprovalExecutable(ctx,ref(periodId),id),label);
  let waiting=false;
  for(let attempt=0;attempt<100&&!waiting;attempt++){
   waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event='advisory'",[label])).rows.length>0;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,50));
  }
  expect(waiting,'the preview reached the policy lock').toBe(true);
  const locked=await live.query('SELECT id FROM control_operation_approvals WHERE company_id=$1 AND id=$2 FOR UPDATE NOWAIT',[fixture.companyA,id]).then(r=>r.rows.length,(e:{code?:string})=>e.code);
  expect(locked,'the approval row is free while the preview waits for the policy lock').toBe(1);
 }finally{await live.query('ROLLBACK');live.release();}
 await preview;
},60000);
it('a year-close preview checks a supplied approval even when no policy binds the close',async()=>{
 // No fiscal_year policy: the live close still locks and checks any approval
 // it is given, so the preview must refuse the ones the live close refuses.
 const otherOperation=await approval(ref(periodId));
 for(const approvalId of [randomUUID(),otherOperation]){
  const live=await actor('u1',()=>closeFiscalYear(fixture.companyA,'2040',fixture.u1.id,{approvalId})).then(()=>'accepted',(e:Error)=>e.message);
  const previewed=await actor('u1',()=>closeFiscalYear(fixture.companyA,'2040',fixture.u1.id,{approvalId,dryRun:true})).then(()=>'accepted',(e:Error)=>e.message);
  expect(live,'the live close refuses it').not.toBe('accepted');
  expect(previewed,'the preview answers as the live close').toBe(live);
 }
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND operation='year.close'",[fixture.companyA])).rows).toHaveLength(0);
},90000);
