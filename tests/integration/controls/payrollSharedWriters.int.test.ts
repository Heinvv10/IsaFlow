import { afterAll,beforeAll,expect,it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID,randomBytes } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture,validateFixtureTarget,type ForensicFixture } from '../forensic-fixture';
import { withControlRequest,requireControlTx } from '@/modules/accounting/services/controls/context';
import { lockPayrollSources } from '@/modules/accounting/services/controls/payrollSourceMaterial';
import { payrollCalculationHashes } from '@/modules/accounting/services/controls/payrollCalculationReceipt';
import { materializePayrollOperation } from '@/modules/accounting/services/controls/payrollOperationMaterializer';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
let fixture:ForensicFixture;
let syntheticCalculationVersion=0;
const run=randomUUID(),employee=randomUUID(),component=randomUUID(),assignment=randomUUID(),period=randomUUID();
const ref={entityType:'payroll_run',entityId:run,operation:'payroll_run.post' as const};
const accounts=['5200','2140','2150','2160','1110','2175'].map(code=>({id:randomUUID(),code}));
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
  const user=fixture[person],client=await pool.connect();
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
  fixture=await provisionForensicFixture(config);
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
  for(const account of accounts)await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level)
    VALUES($1,$2,$3,'Synthetic payroll account',$4,$5,true,3)`,[account.id,fixture.companyA,account.code,account.code==='5200'?'expense':'liability',account.code==='5200'?'debit':'credit']);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic payroll period',9,2026,'2026-09-01','2026-09-30','open')`,[period,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
    VALUES($1,$2,'SYNTHETIC','Fixture','Payroll','2026-01-01','active')`,[employee,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type)
    VALUES($1,$2,'Synthetic basic','3601','earning')`,[component,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from)
    VALUES($1,$2,$3,100,'2026-01-01')`,[assignment,employee,component]);
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count)
    VALUES($1,$2,9,2026,'calculated',100,10,2,1,0,89,1)`,[run,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,paye,uif_employee,uif_employer,sdl,eti,net_pay)
    VALUES($1,$2,100,10,1,1,1,0,89)`,[run,employee]);
  await seedSyntheticReceipt();
});
afterAll(async()=>{await pool.end();});
async function seedSyntheticReceipt(){
  const hashes=await actor('u1',async ctx=>payrollCalculationHashes(await lockPayrollSources(ctx,run)));
  await pool.query(`INSERT INTO control_payroll_calculations(company_id,run_id,calculation_version,input_hash,output_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`,[fixture.companyA,run,++syntheticCalculationVersion,hashes.input_hash,hashes.output_hash,fixture.u1.id]);
}
const read=()=>actor('u1',ctx=>materializePayrollOperation(ctx,ref));
const hash=(m:Awaited<ReturnType<typeof materializePayrollOperation>>)=>operationBindingHash({...m.binding,policies:[]});
it('derives authoritative exact payroll material without creating history or financial effects',async()=>{
  const material=await read();expect(material.binding).toMatchObject({amount:'102',currency:'ZAR',accountingDate:'2026-09-30'});
  expect(material.versionBasis).toBe('untracked_current_observation');
  expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('fingerprints current employee compensation, employee data, account, period and currency changes',async()=>{
  const original=hash(await read());
  for(const [query,values,restore] of [
    ['UPDATE payroll_employee_components SET amount=101 WHERE id=$1',[assignment],'UPDATE payroll_employee_components SET amount=100 WHERE id=$1'],
    ["UPDATE payroll_employees SET tax_number='SYNTHETIC-CHANGED' WHERE company_id=$1 AND id=$2",[fixture.companyA,employee],'UPDATE payroll_employees SET tax_number=NULL WHERE company_id=$1 AND id=$2'],
    ["UPDATE gl_accounts SET account_subtype='labour' WHERE company_id=$1 AND id=$2",[fixture.companyA,accounts[0]!.id],'UPDATE gl_accounts SET account_subtype=NULL WHERE company_id=$1 AND id=$2'],
    ["UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period],"UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2"],
    ["UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA],"UPDATE companies SET default_currency='ZAR' WHERE id=$1"],
  ] as const){try{await pool.query(query,[...values]);
    if(query.includes('payroll_employee'))await expect(read()).rejects.toThrow('recalculate');
    else if(query.includes('UPDATE companies'))await expect(read()).rejects.toThrow('currency');
    else expect(hash(await read())).not.toBe(original);
  }finally{await pool.query(restore,[...values]);await seedSyntheticReceipt();}}
});
it('refuses another tenant and unreconciled calculated totals',async()=>{
  await expect(actor('u3',ctx=>materializePayrollOperation(ctx,ref))).rejects.toThrow('unavailable');
  try{await pool.query('UPDATE payroll_run_headers SET total_gross=101 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);
    await expect(read()).rejects.toThrow('recalculate');
  }finally{await pool.query('UPDATE payroll_run_headers SET total_gross=100 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);}
});
it('refuses active account gaps and uncovered periods without invented defaults',async()=>{
  try{await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,accounts[0]!.id]);
    await expect(read()).rejects.toThrow('account');
  }finally{await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,accounts[0]!.id]);}
  try{await pool.query("UPDATE fiscal_periods SET end_date='2026-09-29' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
    await expect(read()).rejects.toThrow('missing');
  }finally{await pool.query("UPDATE fiscal_periods SET end_date='2026-09-30' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);}
});

it('refuses legacy calculated output without an immutable calculation receipt',async()=>{
  const legacy=randomUUID();
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_net,employee_count)
    VALUES($1,$2,8,2026,'calculated',100,100,1)`,[legacy,fixture.companyA]);
  await pool.query(`INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,net_pay) VALUES($1,$2,100,100)`,[legacy,employee]);
  await expect(actor('u1',ctx=>materializePayrollOperation(ctx,{...ref,entityId:legacy}))).rejects.toThrow('recalculate');
});

let nextMonth=0;
async function calculatedRun(){
  const month=++nextMonth,id=randomUUID(),periodId=randomUUID(),end=new Date(Date.UTC(2026,month,0)).toISOString().slice(0,10);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic writer period',$3,2026,$4,$5,'open')`,[periodId,fixture.companyA,month,`2026-${String(month).padStart(2,'0')}-01`,end]);
  await pool.query(`INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,notes) VALUES($1,$2,$3,2026,'draft','Existing fixture note')`,[id,fixture.companyA,month]);
  const {calculatePayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunService');
  await actor('u1',()=>calculatePayrollRun(id,fixture.companyA));
  return {id,periodId,end,ref:{...ref,entityId:id}};
}
async function approve(ref:Parameters<typeof materializePayrollOperation>[1]){
  const {requestOperationApproval,decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const request=await actor('u1',ctx=>requestOperationApproval(ctx,ref));
  await expect(actor('u1',ctx=>decideOperationApproval(ctx,request.id,'approved'))).rejects.toThrow();
  await actor('u2',ctx=>decideOperationApproval(ctx,request.id,'approved'));return request.id;
}
it('calculates a real receipt, gates approval and direct posting, and replays one exact journal effect',async()=>{
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Synthetic payroll policy','payroll_run','amount','any',0,'admin')`,[randomUUID(),fixture.companyA]);
  const current=await calculatedRun();
  const {approvePayrollRun}=await import('@/modules/accounting/services/payroll/payrollApprovalService');
  const {postPayrollRunJournal}=await import('@/modules/accounting/services/payroll/payrollJournalPostingService');
  await expect(actor('u1',()=>approvePayrollRun(fixture.companyA,current.id,fixture.u1.id))).rejects.toThrow('approval');
  await expect(actor('u1',()=>postPayrollRunJournal(fixture.companyA,current.id,fixture.u1.id))).rejects.toThrow('approval');
  const approvalId=await approve(current.ref);
  const result=await actor('u1',()=>approvePayrollRun(fixture.companyA,current.id,fixture.u1.id,{approvalId}));
  expect(await actor('u1',()=>postPayrollRunJournal(fixture.companyA,current.id,fixture.u1.id,{approvalId}))).toBe(result.journalEntryId);
  const journals=await pool.query('SELECT id,status FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,current.id]);
  expect(journals.rows).toEqual([{id:result.journalEntryId,status:'posted'}]);
  expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,current.id])).rows).toHaveLength(1);
  expect((await pool.query('SELECT calculation_version FROM control_payroll_calculations WHERE company_id=$1 AND run_id=$2',[fixture.companyA,current.id])).rows).toEqual([{calculation_version:'2'}]);
  const events=await pool.query('SELECT before_values,after_values FROM control_change_events WHERE company_id=$1 AND entity_type=$2 AND entity_id=$3',[fixture.companyA,'payroll_run',current.id]);
  expect(JSON.stringify(events.rows)).not.toContain('gross');expect(JSON.stringify(events.rows)).not.toContain('employee');
});
it('requires recalculation for changed compensation before a new approval and invalidates old approval after recalculation',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref);
  const {requestOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const {calculatePayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunService');
  const {approvePayrollRun}=await import('@/modules/accounting/services/payroll/payrollApprovalService');
  try{
    await pool.query('UPDATE payroll_employee_components SET amount=101 WHERE id=$1',[assignment]);
    await expect(actor('u1',ctx=>requestOperationApproval(ctx,current.ref))).rejects.toThrow('recalculate');
    await actor('u1',()=>calculatePayrollRun(current.id,fixture.companyA));
    await expect(actor('u1',()=>approvePayrollRun(fixture.companyA,current.id,fixture.u1.id,{approvalId}))).rejects.toThrow('material');
  }finally{await pool.query('UPDATE payroll_employee_components SET amount=100 WHERE id=$1',[assignment]);}
});
it('reopens through one approved contra and retains original provenance, then permits recalculation and a new posting',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref);
  const {approvePayrollRun}=await import('@/modules/accounting/services/payroll/payrollApprovalService');
  const {reopenPayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunLock');
  const {calculatePayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunService');
  const first=await actor('u1',()=>approvePayrollRun(fixture.companyA,current.id,fixture.u1.id,{approvalId}));
  const reopenId=await approve({...current.ref,operation:'payroll_run.reopen'});
  await actor('u1',()=>reopenPayrollRun({companyId:fixture.companyA,runId:current.id,userId:fixture.u1.id,reason:'Synthetic correction',approvalId:reopenId}));
  expect((await pool.query('SELECT journal_entry_id,status FROM payroll_run_headers WHERE company_id=$1 AND id=$2',[fixture.companyA,current.id])).rows)
    .toEqual([{journal_entry_id:first.journalEntryId,status:'calculated'}]);
  expect((await pool.query('SELECT notes FROM payroll_run_headers WHERE company_id=$1 AND id=$2',[fixture.companyA,current.id])).rows[0].notes)
    .toBe('Existing fixture note\nSynthetic correction');
  const evidence=(await pool.query(`SELECT e.before_values,e.after_values,p.key_id,p.envelope_version,p.ciphertext
    FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id
    WHERE e.company_id=$1 AND e.entity_id=$2 AND e.action='payroll_run.reopen'`,[fixture.companyA,current.id])).rows[0];
  const {openProtectedChange}=await import('@/modules/accounting/services/controls/changeProtection');
  expect(JSON.stringify(openProtectedChange({version:evidence.envelope_version,keyId:evidence.key_id,ciphertext:evidence.ciphertext}))).toContain('Synthetic correction');
  expect(JSON.stringify([evidence.before_values,evidence.after_values])).not.toContain('Synthetic correction');
  const balance=await pool.query(`SELECT gl_account_id,SUM(debit-credit)::text AS balance FROM gl_journal_lines
    WHERE company_id=$1 AND journal_entry_id IN(SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2) GROUP BY gl_account_id`,[fixture.companyA,current.id]);
  expect(balance.rows.every(row=>Number(row.balance)===0)).toBe(true);
  await actor('u1',()=>calculatePayrollRun(current.id,fixture.companyA));
  const freshId=await approve(current.ref);
  const second=await actor('u1',()=>approvePayrollRun(fixture.companyA,current.id,fixture.u1.id,{approvalId:freshId}));
  expect(second.journalEntryId).not.toBe(first.journalEntryId);
});
it('rolls back posted journal, payroll status, effect and child events after outer failure',async()=>{
  const current=await calculatedRun(),approvalId=await approve(current.ref);
  const {approvePayrollRun}=await import('@/modules/accounting/services/payroll/payrollApprovalService');
  await expect(actor('u1',async()=>{await approvePayrollRun(fixture.companyA,current.id,fixture.u1.id,{approvalId});throw new Error('synthetic rollback');})).rejects.toThrow('synthetic rollback');
  expect((await pool.query('SELECT status,journal_entry_id FROM payroll_run_headers WHERE company_id=$1 AND id=$2',[fixture.companyA,current.id])).rows).toEqual([{status:'calculated',journal_entry_id:null}]);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,current.id])).rows).toHaveLength(0);
  expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,current.id])).rows).toHaveLength(0);
});
it('serializes new employee-component inserts behind a locked material snapshot',async()=>{
  const current=await calculatedRun(),insertId=randomUUID();
  let release!:()=>void,ready!:()=>void,writerReady!:()=>void,pid=0;
  const hold=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;}),started=new Promise<void>(resolve=>{writerReady=resolve;});
  const reading=actor('u1',async ctx=>{await materializePayrollOperation(ctx,current.ref);ready();await hold;});
  await locked;
  const writing=actor('u2',async ctx=>{
    const rows=await ctx.sql`SELECT pg_backend_pid() AS pid` as {pid:number}[];pid=rows[0]!.pid;writerReady();
    await ctx.sql`INSERT INTO payroll_employee_components(id,employee_id,component_id,amount,effective_from)
      VALUES(${insertId}::uuid,${employee}::uuid,${component}::uuid,0,'2026-01-01')`;
  });
  try{
    await started;let waiting=false;
    for(let attempt=0;attempt<30;attempt++){
      const row=(await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
      if(row?.wait_event_type==='Lock'){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(waiting).toBe(true);release();await reading;await writing;
    await expect(actor('u1',ctx=>materializePayrollOperation(ctx,current.ref))).rejects.toThrow('recalculate');
  }finally{
    release();await Promise.allSettled([reading,writing]);
    await pool.query('DELETE FROM payroll_employee_components WHERE id=$1 AND employee_id=$2',[insertId,employee]);
  }
});
