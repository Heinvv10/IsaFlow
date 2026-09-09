import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
import {checkBankStatementCompleteness} from '@/modules/accounting/services/controls/bankStatementCompletenessChecks';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture,period:string,debit:string,credit:string;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeEach(async()=>{
 fixture=await provisionForensicFixture(config);period=randomUUID();debit=randomUUID();credit=randomUUID();
 await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level)
 VALUES($1::uuid,$3,left($1::text,12),'Synthetic debit','asset','debit',3),($2::uuid,$3,left($2::text,12),'Synthetic credit','liability','credit',3)`,[debit,credit,fixture.companyA]);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
 VALUES($1,$2,'Synthetic period',1,2026,'2026-08-01','2026-09-30','closed')`,[period,fixture.companyA]);
});
afterAll(()=>pool.end());
async function journal(amount='100',accountingDate='2026-09-09',actualAt='2026-09-09T10:00:00Z'){
 const id=randomUUID();await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by,posted_by,posted_at,created_at)
 VALUES($1,$2,$3,$4,'manual','posted',$5,$5,$6,$6)`,[id,fixture.companyA,accountingDate,period,fixture.u1.id,actualAt]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 VALUES($1,$2,$3,$5,0),($1,$2,$4,0,$5)`,[id,fixture.companyA,debit,credit,amount]);return id;
}
it('reads actual posting time, counts journals once, and isolates company plus current report authority',async()=>{
 await journal('100','2026-08-31','2026-09-09T20:00:00Z');
 const result=await actor(ctx=>checkJournalRisks(ctx,{}));expect(result.populationCount).toBe(1);expect(result.findingCount).toBe(1);
 expect(result.amountTotals).toEqual({ZAR:'100'});expect(result.findings[0]?.message).toContain('outside_business_hours');
 expect(result.findings[0]?.message).toContain('backdated_accounting_date');expect(result.findings[0]?.classification).toBe('candidate');expect(result.missingSources).toContain('historical_period_state_unavailable');
 expect((await actor(ctx=>checkJournalRisks(ctx,{}),'u3')).populationCount).toBe(0);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[fixture.companyA,fixture.u1.id]);
 await expect(actor(ctx=>checkJournalRisks(ctx,{}))).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
});
it('counts121 findings beyond page20 and binds cursor to source and tenant',async()=>{
 for(let i=0;i<121;i++)await journal('100','2026-08-31');
 const first=await actor(ctx=>checkJournalRisks(ctx,{limit:20}));expect(first.findingCount).toBe(121);expect(first.findings).toHaveLength(20);expect(first.amountTotals).toEqual({ZAR:'12100'});
 expect((await actor(ctx=>checkJournalRisks(ctx,{limit:20,cursor:first.nextCursor!}))).findingCount).toBe(121);
 await expect(actor(ctx=>checkJournalRisks(ctx,{cursor:first.nextCursor!}),'u3')).rejects.toThrow('cursor');
 await journal('1','2026-08-31');await expect(actor(ctx=>checkJournalRisks(ctx,{cursor:first.nextCursor!}))).rejects.toThrow('changed');
});
it('uses a recorded close interval and excludes a later reopened interval, not current closed status alone',async()=>{
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'fiscal_period',entityId:period,previousVersion:null,newVersion:1,action:'fiscal_period.close',
 accountingDate:'2026-09-09',before:{status:'open'},after:{status:'closed'},bindingHash:null,protectedEvidenceRef:null}));
 const first=await journal();await pool.query('UPDATE gl_journal_entries SET posted_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[fixture.companyA,first]);
 expect((await actor(ctx=>checkJournalRisks(ctx,{}))).findings[0]?.message).toContain('write_after_recorded_period_close');
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'fiscal_period',entityId:period,previousVersion:1,newVersion:2,action:'fiscal_period.reopen',
 accountingDate:'2026-09-09',before:{status:'closed'},after:{status:'open'},bindingHash:null,protectedEvidenceRef:null}));
 const second=await journal();await pool.query('UPDATE gl_journal_entries SET posted_at=clock_timestamp() WHERE company_id=$1 AND id=$2',[fixture.companyA,second]);
 const result=await actor(ctx=>checkJournalRisks(ctx,{}));
 expect(result.findings.find(f=>f.entities[0]?.entityId===first)?.message).toContain('write_after_recorded_period_close');
 expect(result.findings.find(f=>f.entities[0]?.entityId===second)?.message??'').not.toContain('write_after_recorded_period_close');
});
it('compares actual source statement counts and balances and never upgrades OCR metadata to confirmed completeness',async()=>{
 await pool.query("UPDATE gl_accounts SET account_subtype='bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 const doc=randomUUID(),statement=randomUUID(),bytes=Buffer.from('Synthetic independently held August bank statement'),hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status) VALUES($1,$2,'statement.pdf','pdf','matched')`,[doc,fixture.companyA]);
 await capturedStorage().seed(pool,fixture.companyA,doc,bytes);
 await pool.query(`INSERT INTO bank_statement_imports(id,company_id,bank_account_id,source_document_id,period_start,period_end,row_count,opening_balance,closing_balance,status)
 VALUES($1,$2,$3,$4,'2026-08-01','2026-08-31',10,1000,1500,'committed')`,[statement,fixture.companyA,debit,doc]);
 for(let i=0;i<9;i++)await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
 VALUES($1,$2,$3,'2026-08-09',$4,'Synthetic','imported')`,[randomUUID(),fixture.companyA,debit,i===0?400:0]);
 const result=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(result.findingCount).toBe(1);expect(result.amountTotals).toEqual({ZAR:'100'});
 expect(result.findings[0]?.classification).toBe('candidate');expect(result.findings[0]?.evidence[0]?.hash).toBe(hash);
 expect(result.missingSources).toContain('independent_statement_review_unavailable');
 capturedStorage().put(fixture.companyA,doc,Buffer.from('tampered'));
 const changed=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(changed.status).toBe('unknown');expect(changed.findings).toEqual([]);
 expect(changed.missingSources).toContain('source_statement_bytes_unavailable_or_changed');
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{}),'u3')).populationCount).toBe(0);
});
it('returns unknown for a bank without independent statements even when imported dates have no gaps',async()=>{
 await pool.query("UPDATE gl_accounts SET account_subtype='bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 for(let i=1;i<=10;i++)await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
 VALUES($1,$2,$3,$4,0,'Synthetic quiet period','imported')`,[randomUUID(),fixture.companyA,debit,`2026-08-${String(i).padStart(2,'0')}`]);
 const result=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(result.status).toBe('unknown');expect(result.findingCount).toBe(0);expect(result.populationCount).toBe(1);
 expect(result.missingSources).toContain('source_statement_period_unavailable');
});
it('retains source-event amendments during closure after a later reopen and ordinary amendment',async()=>{
 const id=await journal();
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'fiscal_period',entityId:period,previousVersion:null,newVersion:1,action:'fiscal_period.close',
 accountingDate:'2026-09-09',before:{status:'open'},after:{status:'closed'},bindingHash:null,protectedEvidenceRef:null}));
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'journal_entry',entityId:id,previousVersion:null,newVersion:1,action:'journal.amended',
 accountingDate:'2026-09-09',before:{amount:'100'},after:{amount:'100'},bindingHash:null,protectedEvidenceRef:null}));
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'fiscal_period',entityId:period,previousVersion:1,newVersion:2,action:'fiscal_period.reopen',
 accountingDate:'2026-09-09',before:{status:'closed'},after:{status:'open'},bindingHash:null,protectedEvidenceRef:null}));
 await actor(ctx=>recordCommittedChange(ctx,{entityType:'journal_entry',entityId:id,previousVersion:1,newVersion:2,action:'journal.amended',
 accountingDate:'2026-09-09',before:{amount:'100'},after:{amount:'100'},bindingHash:null,protectedEvidenceRef:null}));
 const result=await actor(ctx=>checkJournalRisks(ctx,{}));expect(result.findings[0]?.message).toContain('change_after_recorded_period_close');
 expect(result.sourceVersions[0]?.version).toBe(2);
});
it('uses actual owned current journal threshold and reports a6000+6000 lead without line double counting',async()=>{
 const policy=randomUUID();await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
 VALUES($1,$2,'Synthetic threshold','journal_entry','amount','greater_than','10000','admin',true)`,[policy,fixture.companyA]);
 const first=await journal('6000');expect((await actor(ctx=>checkJournalRisks(ctx,{}))).findingCount).toBe(0);
 await journal('6000');const result=await actor(ctx=>checkJournalRisks(ctx,{}));expect(result.findingCount).toBe(2);expect(result.amountTotals).toEqual({ZAR:'12000'});
 expect(result.findings[0]?.message).toContain(`possible_threshold_split:${policy}:v1`);
 const reverse=await journal('100');await pool.query('UPDATE gl_journal_entries SET reversal_of_id=$1 WHERE company_id=$2 AND id=$3',[first,fixture.companyA,reverse]);
 expect((await actor(ctx=>checkJournalRisks(ctx,{}))).findings.find(f=>f.entities[0]?.entityId===reverse)?.entities)
 .toContainEqual({entityType:'journal_entry',entityId:first});
});
it('respects strict and inclusive policy boundaries for two exact-threshold journals',async()=>{
 const policy=randomUUID();await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
 VALUES($1,$2,'Synthetic exact threshold','journal_entry','amount','greater_than','10000','admin',true)`,[policy,fixture.companyA]);
 await journal('10000');expect((await actor(ctx=>checkJournalRisks(ctx,{}))).findingCount).toBe(0);
 await journal('10000');const strict=await actor(ctx=>checkJournalRisks(ctx,{}));expect(strict.findingCount).toBe(2);
 expect(strict.amountTotals).toEqual({ZAR:'20000'});expect(strict.findings.every(f=>f.message.includes(`possible_threshold_split:${policy}:v1`))).toBe(true);
 await pool.query("UPDATE approval_rules SET condition_operator='greater_equal' WHERE company_id=$1 AND id=$2",[fixture.companyA,policy]);
 expect((await actor(ctx=>checkJournalRisks(ctx,{}))).findingCount).toBe(0);
});
it('counts121 statement discrepancies beyond20 and rejects a cursor when equal-value imported identities change',async()=>{
 await pool.query("UPDATE gl_accounts SET account_subtype='bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 const bytes=Buffer.from('Synthetic candidate source statement'),doc=randomUUID();
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status) VALUES($1,$2,'statement.pdf','pdf','matched')`,[doc,fixture.companyA]);
 await capturedStorage().seed(pool,fixture.companyA,doc,bytes);
 //121 roots still prove full-population counts; one object keeps this under the separate100-object scan bound.
 for(let i=0;i<121;i++){
  await pool.query(`INSERT INTO bank_statement_imports(company_id,bank_account_id,source_document_id,period_start,period_end,row_count,opening_balance,closing_balance,status)
  VALUES($1,$2,$3,'2026-08-01','2026-08-31',10,1000,1500,'committed')`,[fixture.companyA,debit,doc]);
 }
 const tx=randomUUID();await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
 VALUES($1,$2,$3,'2026-08-09',400,'Synthetic','imported')`,[tx,fixture.companyA,debit]);
 const first=await actor(ctx=>checkBankStatementCompleteness(ctx,{limit:20}));expect(first.populationCount).toBe(121);expect(first.findingCount).toBe(121);
 expect(first.findings).toHaveLength(20);expect(first.amountTotals).toEqual({ZAR:'12100'});
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{limit:20,cursor:first.nextCursor!}))).findingCount).toBe(121);
 await pool.query('UPDATE bank_transactions SET id=$1 WHERE company_id=$2 AND id=$3',[randomUUID(),fixture.companyA,tx]);
 await expect(actor(ctx=>checkBankStatementCompleteness(ctx,{cursor:first.nextCursor!}))).rejects.toThrow('changed');
});
it.each(['account','document'] as const)('retains an owned statement with a corrupt foreign %s parent as unknown without leaking that parent',async kind=>{
 await pool.query("UPDATE gl_accounts SET account_subtype='bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,debit]);
 const foreign=randomUUID(),doc=randomUUID(),statement=randomUUID(),bytes=Buffer.from('Synthetic foreign parent source'),hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level)
 VALUES($1::uuid,$2,left($1::text,12),'Foreign synthetic bank','asset','bank','debit',3)`,[foreign,fixture.companyB]);
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status) VALUES($1,$2,'source.pdf','pdf','matched')`,[doc,kind==='document'?fixture.companyB:fixture.companyA]);
 await capturedStorage().seed(pool,kind==='document'?fixture.companyB:fixture.companyA,doc,bytes);
 await pool.query(`INSERT INTO bank_statement_imports(id,company_id,bank_account_id,source_document_id,period_start,period_end,row_count,opening_balance,closing_balance,status)
 VALUES($1,$2,$3,$4,'2026-08-01','2026-08-31',10,1000,1500,'committed')`,[statement,fixture.companyA,kind==='account'?foreign:debit,doc]);
 const result=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(result.status).toBe('unknown');expect(result.populationCount).toBeGreaterThan(0);
 expect(result.missingSources).toContain(kind==='account'?'owned_bank_account_unavailable':'source_statement_bytes_unavailable_or_changed');
 expect(JSON.stringify(result)).not.toContain(kind==='account'?foreign:doc);
});
