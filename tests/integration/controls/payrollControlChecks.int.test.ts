import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {checkPayrollControls} from '@/modules/accounting/services/controls/payrollControlChecks';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:15000});
let fixture:ForensicFixture;
const run=randomUUID(),employee=randomUUID(),otherEmployee=randomUUID(),journal=randomUUID();
const accounts=['5200','2140','2150','2160','1110','2175'].map(code=>({id:randomUUID(),code}));
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u3'='u1'){
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);
 for(const account of accounts)await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level) VALUES($1,$2,$3,'Synthetic payroll detective',$4,$5,true,3)",[account.id,fixture.companyA,account.code,account.code==='5200'?'expense':account.code==='1110'?'asset':'liability',account.code==='5200'||account.code==='1110'?'debit':'credit']);
 for(const id of [employee,otherEmployee])await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status) VALUES($1,$2,$3,'Private','Synthetic','2020-01-01','active')",[id,fixture.companyA,id.slice(0,12)]);
 await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_taxable,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,9,2026,'approved',100,100,8,2,1,0,91,1)",[run,fixture.companyA]);
 await pool.query("INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,uif_employee,uif_employer,sdl,eti,net_pay) VALUES($1,$2,100,100,8,1,1,1,0,91)",[run,employee]);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,source_record_id,status,created_by) VALUES($1,$2,'PAYROLL-DETECTIVE','2026-09-30','Synthetic posted evidence','auto_payroll',$3,'posted',$4)",[journal,fixture.companyA,run,fixture.u1.id]);
 const values=[['5200',102,0],['2140',0,8],['2150',0,2],['2160',0,1],['1110',0,91]] as const;
 for(const [code,debit,credit] of values)await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,$5)',[fixture.companyA,journal,accounts.find(a=>a.code===code)!.id,debit,credit]);
 await pool.query('UPDATE payroll_run_headers SET journal_entry_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,run,journal]);
});
afterAll(async()=>{await pool.end();});
it('reconciles actual owned totals and journal without asserting absent external settlement',async()=>{
 const result=await actor(ctx=>checkPayrollControls(ctx));expect(result.populationCount).toBe(1);expect(result.findingCount).toBe(0);
 expect(result.status).toBe('unknown');expect(result.missingSources).toContain('independent_employee_settlement_evidence_unavailable');
 expect(JSON.stringify(result)).not.toContain('Private');
});
it('detects actual header and liability tampering across complete findings pagination',async()=>{
 await pool.query('UPDATE payroll_run_headers SET employee_count=2 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);
 await pool.query("UPDATE payroll_employees SET end_date='2026-08-31',status='terminated' WHERE company_id=$1 AND id=$2",[fixture.companyA,employee]);
 try{const result=await actor(ctx=>checkPayrollControls(ctx,{limit:1}));expect(result.findingCount).toBe(2);expect(result.findings).toHaveLength(1);expect(result.amountTotals.ZAR).toBe('191');expect(result.nextCursor).not.toBeNull();
  const next=await actor(ctx=>checkPayrollControls(ctx,{limit:1,cursor:result.nextCursor!}));expect(next.findingCount).toBe(2);expect(next.findings[0]!.key).not.toBe(result.findings[0]!.key);
 }finally{await pool.query('UPDATE payroll_run_headers SET employee_count=1 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);await pool.query("UPDATE payroll_employees SET end_date=NULL,status='active' WHERE company_id=$1 AND id=$2",[fixture.companyA,employee]);}
 await pool.query('UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,journal]);
 try{expect((await actor(ctx=>checkPayrollControls(ctx))).findings.map(f=>f.kind)).toContain('payroll_journal_mismatch');}
 finally{await pool.query('UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,journal]);}
});
it('detects owned shared accounts as candidates without exposing bank secrets',async()=>{
 for(const id of [employee,otherEmployee])await pool.query("INSERT INTO payroll_bank_details(employee_id,bank_name,account_number,branch_code,effective_from) VALUES($1,'Private bank','1234567890','123456','2020-01-01')",[id]);
 try{const result=await actor(ctx=>checkPayrollControls(ctx));expect(result.findings.find(f=>f.kind==='payroll_beneficiary_reuse')?.classification).toBe('candidate');
  expect(JSON.stringify(result)).not.toMatch(/1234567890|123456|Private bank/);
 }finally{await pool.query('DELETE FROM payroll_bank_details WHERE employee_id=ANY($1::uuid[])',[[employee,otherEmployee]]);}
});
it('isolates foreign payroll and rechecks current read authority',async()=>{
 const foreign=await actor(ctx=>checkPayrollControls(ctx),'u3');expect(foreign.populationCount).toBe(0);expect(JSON.stringify(foreign)).not.toContain(run);
 await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[fixture.companyA,fixture.u1.id,'payroll']);
 try{await expect(actor(ctx=>checkPayrollControls(ctx))).rejects.toThrow(/permission/i);}
 finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[fixture.companyA,fixture.u1.id,'payroll']);}
 const old=(await pool.query('SELECT is_active FROM users WHERE id=$2 AND EXISTS(SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2)',[fixture.companyA,fixture.u1.id])).rows[0].is_active;
 await pool.query("UPDATE users SET is_active=false WHERE id=$2 AND EXISTS(SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(ctx=>checkPayrollControls(ctx))).rejects.toThrow(/permission|scope|payroll/i);}
 finally{await pool.query('UPDATE users SET is_active=$3 WHERE id=$2 AND EXISTS(SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2)',[fixture.companyA,fixture.u1.id,old]);}
});
it('compares actual recorded salary components and distinguishes unchanged recurring pay',async()=>{
 const next=randomUUID(),component=randomUUID(),breakdown=[{componentId:component,amount:100}];
 await pool.query('UPDATE payroll_run_lines SET component_breakdown=$2::jsonb WHERE run_id=$1',[run,JSON.stringify(breakdown)]);
 await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_taxable,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,10,2026,'calculated',100,100,8,2,1,0,91,1)",[next,fixture.companyA]);
 await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,uif_employee,uif_employer,sdl,eti,net_pay,component_breakdown) VALUES($1,$2,100,100,8,1,1,1,0,91,$3::jsonb)',[next,employee,JSON.stringify(breakdown)]);
 try{expect((await actor(ctx=>checkPayrollControls(ctx))).findings.map(f=>f.kind)).not.toContain('payroll_component_change');
  await pool.query('UPDATE payroll_run_lines SET component_breakdown=$2::jsonb WHERE run_id=$1',[next,JSON.stringify([{componentId:component,amount:110}])]);
  const result=await actor(ctx=>checkPayrollControls(ctx));expect(result.findings.find(f=>f.kind==='payroll_component_change')?.classification).toBe('candidate');
 }finally{await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1',[next]);await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1 AND id=$2',[fixture.companyA,next]);await pool.query("UPDATE payroll_run_lines SET component_breakdown='[]'::jsonb WHERE run_id=$1",[run]);}
});
it('reconciles actual UIF declaration and alternate bank settlement then identifies changed settlement',async()=>{
 const declaration=randomUUID(),paymentJournal=randomUUID(),alternate=randomUUID();
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,'1115','Synthetic alternate bank','asset','bank','debit',true,3)",[alternate,fixture.companyA]);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by) VALUES($1,$2,'UIF-DETECTIVE','2026-10-01','Synthetic UIF evidence','auto_payroll','posted',$3)",[paymentJournal,fixture.companyA,fixture.u1.id]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,2,0),($1,$2,$4,0,2)',[fixture.companyA,paymentJournal,accounts.find(a=>a.code==='2150')!.id,alternate]);
 await pool.query("INSERT INTO uif_declarations(id,company_id,period_year,period_month,total_employee_contribution,total_employer_contribution,status,journal_entry_id) VALUES($1,$2,2026,9,1,1,'paid',$3)",[declaration,fixture.companyA,paymentJournal]);
 try{expect((await actor(ctx=>checkPayrollControls(ctx))).findings.map(f=>f.kind)).not.toContain('payroll_uif_settlement_mismatch');
  await pool.query('UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,paymentJournal]);
  expect((await actor(ctx=>checkPayrollControls(ctx))).findings.map(f=>f.kind)).toContain('payroll_uif_settlement_mismatch');
 }finally{await pool.query('DELETE FROM uif_declarations WHERE company_id=$1 AND id=$2',[fixture.companyA,declaration]);await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,paymentJournal]);await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,paymentJournal]);await pool.query('DELETE FROM gl_accounts WHERE company_id=$1 AND id=$2',[fixture.companyA,alternate]);}
});
it('rejects a stale cursor and keeps foreign-party corruption isolated under dual membership',async()=>{
 await pool.query('UPDATE payroll_run_headers SET employee_count=2 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);
 await pool.query("UPDATE payroll_employees SET end_date='2026-08-31' WHERE company_id=$1 AND id=$2",[fixture.companyA,employee]);
 try{const before=await actor(ctx=>checkPayrollControls(ctx,{limit:1}));expect(before.nextCursor).not.toBeNull();
  await pool.query('UPDATE payroll_run_headers SET total_gross=101 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);
  await expect(actor(ctx=>checkPayrollControls(ctx,{limit:1,cursor:before.nextCursor!}))).rejects.toThrow(/population changed/i);
 }finally{await pool.query('UPDATE payroll_run_headers SET total_gross=100,employee_count=1 WHERE company_id=$1 AND id=$2',[fixture.companyA,run]);await pool.query('UPDATE payroll_employees SET end_date=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,employee]);}
 const foreign=randomUUID();await pool.query("INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date) VALUES($1,$2,'FOREIGN','Private foreign','Employee','2020-01-01')",[foreign,fixture.companyB]);
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[fixture.companyB,fixture.u1.id]);
 await pool.query('UPDATE payroll_run_lines SET employee_id=$2 WHERE run_id=$1',[run,foreign]);
 try{const result=await actor(ctx=>checkPayrollControls(ctx));expect(result.missingSources).toContain('payroll_employee_ownership_unavailable');expect(JSON.stringify(result)).not.toContain(foreign);}
 finally{await pool.query('UPDATE payroll_run_lines SET employee_id=$2 WHERE run_id=$1',[run,employee]);await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyB,fixture.u1.id]);await pool.query('DELETE FROM payroll_employees WHERE company_id=$1 AND id=$2',[fixture.companyB,foreign]);}
});
it('keeps complete source totals and counts when bounded material requires an async scan',async()=>{
 await pool.query("INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,status) SELECT $1,'BOUNDED-'||n,'Synthetic','Bounded','2020-01-01','active' FROM generate_series(1,10000)n",[fixture.companyA]);
 try{const result=await actor(ctx=>checkPayrollControls(ctx,{limit:1}));expect(result.status).toBe('unknown');expect(result.findingCount).toBe(0);
  expect(result.missingSources).toContain('async_scan_required:payroll_population_exceeds_10000');expect(result.coverage).toContain('source_employee_count:10002');
  expect(result.coverage).toContain('source_total:headerGross:100.00');expect(result.coverage).toContain('source_total:lineNet:91.00');
 }finally{await pool.query("DELETE FROM payroll_employees WHERE company_id=$1 AND employee_number LIKE 'BOUNDED-%'",[fixture.companyA]);}
});
