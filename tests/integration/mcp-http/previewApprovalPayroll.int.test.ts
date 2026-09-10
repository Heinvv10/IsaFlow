import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {lockPayrollSources} from '@/modules/accounting/services/controls/payrollSourceMaterial';
import {payrollCalculationHashes} from '@/modules/accounting/services/controls/payrollCalculationReceipt';
import type {RpcReply} from './client';
/**
 * A single-document preview must not report an operation the live call refuses
 * for want of an independent approval. The pay run below is bound by a company
 * payroll_run policy, so both payroll previews must refuse.
 */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
const run=randomUUID(),posted=randomUUID(),unbuildable=randomUUID(),employee=randomUUID(),component=randomUUID();
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
async function seedReceipt(company:string,person:string,runId:string){
 const client=await f.pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({sub:person,company_id:company,role:'authenticated'}),company]);
  const hashes=await withControlRequest({client,userId:person,companyId:company,claims:{sub:person,company_id:company,role:'authenticated'}},
   {personId:person,companyId:company,authMethod:'cookie'},async()=>payrollCalculationHashes(await lockPayrollSources(requireControlTx(),runId)));
  await client.query('COMMIT');
  await f.pool.query('INSERT INTO control_payroll_calculations(company_id,run_id,calculation_version,input_hash,output_hash,created_by) VALUES($1,$2,1,$3,$4,$5)',
   [company,runId,hashes.input_hash,hashes.output_hash,person]);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 const company=f.fixture.companyA,person=f.fixture.u1.id;
 await f.pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[company]);
 for(const code of ['5200','2140','2150','2160','1110','2175'])await f.pool.query(
  "INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level) VALUES($1,$2,$3,'Synthetic payroll account',$4,$5,true,3)",
  [randomUUID(),company,code,code==='5200'?'expense':'liability',code==='5200'?'debit':'credit']);
 await f.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic payroll period',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),company]);
 await f.pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,'SYNTHETIC','Fixture','Payroll','2026-01-01','active')",[employee,company]);
 await f.pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Synthetic basic','3601','earning')",[component,company]);
 await f.pool.query("INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from) VALUES($1,$2,$3,100,'2026-01-01')",[randomUUID(),employee,component]);
 await f.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,9,2026,'calculated',100,10,2,1,0,89,1)",[run,company]);
 await f.pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,paye,uif_employee,uif_employer,sdl,eti,net_pay) VALUES($1,$2,100,10,1,1,1,0,89)',[run,employee]);
 await f.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,8,2026,'approved',100,10,2,1,0,89,1)",[posted,company]);
 await f.pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,paye,uif_employee,uif_employer,sdl,eti,net_pay) VALUES($1,$2,100,10,1,1,1,0,89)',[posted,employee]);
 await f.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic payroll period 8',8,2026,'2026-08-01','2026-08-31','open')",[randomUUID(),company]);
 await seedReceipt(company,person,run);
 await seedReceipt(company,person,posted);
 await f.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,7,2026,'calculated',100,10,2,1,0,89,1)",[unbuildable,company]);
 await f.pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,paye,uif_employee,uif_employer,sdl,eti,net_pay) VALUES($1,$2,100,10,1,1,1,0,89)',[unbuildable,employee]);
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic payroll policy','payroll_run','amount','any',0,'admin')",[randomUUID(),company]);
},60000);
afterAll(async()=>{if(f)await f.close();});
it('refuses both payroll previews for an approval-bound run, and the live call agrees',async()=>{
 const token=await f.scopedToken(['write:payroll','write:post']);
 const outcomes:string[]=[];
 for(const [tool,id] of [['approve_pay_run',run],['post_payroll_journal',posted]] as const){
  const preview=await f.rpcToken(token,tool,{run_id:id,dry_run:true,idempotency_key:randomUUID()});
  const live=await f.rpcToken(token,tool,{run_id:id,idempotency_key:randomUUID()});
  outcomes.push(`${tool} preview: ${preview.result?.isError?`refused (${/approval/i.test(text(preview))?'names the approval':'other'})`:'previewed'}`);
  outcomes.push(`${tool} live: ${live.result?.isError?'refused':'posted'}`);
 }
 const rows=(await f.pool.query<{status:string}>('SELECT status FROM payroll_run_headers WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY period_month',[f.fixture.companyA,[run,posted]])).rows;
 const status=rows.map(row=>row.status).join(',');
 expect({outcomes,status}).toEqual({status:'approved,calculated',outcomes:[
  'approve_pay_run preview: refused (names the approval)','approve_pay_run live: refused',
  'post_payroll_journal preview: refused (names the approval)','post_payroll_journal live: refused']});
},180000);
it('says a run could not be previewed rather than blaming an approval it cannot see',async()=>{
 const token=await f.scopedToken(['write:payroll','write:post']);
 const preview=await f.rpcToken(token,'approve_pay_run',{run_id:unbuildable,dry_run:true,idempotency_key:randomUUID()});
 expect(preview.result?.isError,text(preview)).toBe(true);
 expect(text(preview)).toContain('could not be previewed');
 expect(text(preview),'must not instruct an approval request for a material failure').not.toContain('Request one with');
},120000);
