import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {ledgerSnapshotSources,type SnapshotRow} from '@/modules/accounting/services/controls/auditSnapshotCaptureQueries';
import {AUDIT_JOB_LIMITS} from '@/modules/accounting/services/controls/auditJobContract';
import {captureAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotCapture';
import {loadBankStatementCompleteness} from '@/modules/accounting/services/controls/bankStatementCompletenessQueries';
import {checkBankStatementCompleteness} from '@/modules/accounting/services/controls/bankStatementCompletenessChecks';
import type {ControlFinding} from '@/modules/accounting/services/controls/contracts';
import {invoiceSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotInvoiceQueries';
import {loadInvoiceRiskPopulation} from '@/modules/accounting/services/controls/invoiceRiskQueries';
import {actorAs,appendEntityVersion,type Identity} from './intentReceiptRows';
import {rewriteApprovalUnguarded} from './approvalGuardBypass';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:10000});
let fixture:ForensicFixture,user:Identity;
const hash='a'.repeat(64),cutoff='2026-12-31';
beforeAll(async()=>{fixture=await provisionForensicFixture(config);user={id:fixture.u1.id,companyId:fixture.companyA};});
afterAll(async()=>{await pool.end();});
/** Appends a receipt spelled as legacy source spelled it; no retained row is edited. */
async function appendEffect(entityType:string,entityId:string,operation:string,result:Record<string,unknown>={}){
 const id=randomUUID();
 await pool.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
  VALUES($1,$2,gen_random_uuid(),$3,$4,$5,$6,$7::jsonb,clock_timestamp())`,[fixture.companyA,id,operation,entityType,entityId,hash,JSON.stringify(result)]);
 return id;
}
const source=(name:string)=>[...ledgerSnapshotSources,...invoiceSnapshotSources].find(row=>row.source===name)!;
async function bankAccount(){
 const account=randomUUID();
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,'Synthetic snapshot bank','asset','bank','debit',true,true,3)",[account,fixture.companyA,account.slice(0,12)]);
 return account;
}
it('the audit snapshot reports the effect and version of an attestation retained under another spelling',async()=>{
 const intent=randomUUID(),account=await bankAccount(),document=randomUUID();
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type) VALUES($1,$2,'synthetic-statement.csv','text/csv')",[document,fixture.companyA]);
 await pool.query(`INSERT INTO control_bank_statement_attestation_intents(company_id,id,requester_person_id,bank_account_id,source_document_id,
  expected_source_hash,source_fingerprint,period_start,period_end,source_count,opening_balance,closing_balance,currency)
  VALUES($1,$2,$3,$4,$5,$6,$6,'2026-08-01','2026-08-31',3,0,100,'ZAR')`,[fixture.companyA,intent,fixture.u1.id,account,document,hash]);
 const effectId=await appendEffect('bank_statement_attestation_intent',intent.toUpperCase(),'bank_statement.attest');
 await appendEntityVersion(pool,user,'bank_statement_attestation_intent',intent.toUpperCase(),2);
 const rows=await actorAs(pool,user,ctx=>source('bank_statement_attestation_intent').page(ctx,cutoff,null));
 const row=rows.find(entry=>entry.id===intent);
 expect(row,'the attestation is in the snapshot population').toBeDefined();
 expect(Number(row!.version)).toBe(2);
 expect((row!.data as Record<string,unknown>).execution_effect_id).toBe(effectId);
});
it('the audit snapshot reports a bank transaction version retained under another spelling',async()=>{
 const account=await bankAccount(),tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',123.45,'Synthetic snapshot bank line','imported')",[tx,fixture.companyA,account]);
 await appendEntityVersion(pool,user,'bank_transaction',tx.toUpperCase(),3);
 const rows=await actorAs(pool,user,ctx=>source('bank_transaction').page(ctx,cutoff,null));
 const row=rows.find(entry=>entry.id===tx);
 expect(row,'the bank transaction is in the snapshot population').toBeDefined();
 expect(Number(row!.version)).toBe(3);
});
// Fork fixtures: one entity retained under its canonical spelling and a legacy one. Every projection must
// return the entity once — a second row kills the snapshot job ("keyset did not advance") and inflates risk counts.
async function fork(entityType:string,id:string,canonical:number,legacy:number){
 await appendEntityVersion(pool,user,entityType,id,canonical);
 await appendEntityVersion(pool,user,entityType,id.toUpperCase(),legacy);
}
/** Reads a source the way capture does - keyset pages until exhausted - so the check holds past one page. */
async function wholeSource(name:string){
 const rows:SnapshotRow[]=[];let after:string|null=null;
 for(;;){
  const page:SnapshotRow[]=await actorAs(pool,user,ctx=>source(name).page(ctx,cutoff,after));
  rows.push(...page);if(page.length<AUDIT_JOB_LIMITS.pageSize)break;after=page.at(-1)!.id;
 }
 return{rows,count:(await actorAs(pool,user,ctx=>source(name).counts(ctx,cutoff))).count};
}
it('a forked bank transaction is one snapshot row reporting its most advanced lineage',async()=>{
 const account=await bankAccount(),tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',10,'Synthetic forked bank line','imported')",[tx,fixture.companyA,account]);
 await fork('bank_transaction',tx,1,7);
 const {rows,count}=await wholeSource('bank_transaction');
 expect(rows.filter(row=>row.id===tx)).toHaveLength(1);
 expect(rows).toHaveLength(count);
 expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
 expect(Number(rows.find(row=>row.id===tx)!.version)).toBe(7);
});
it('a forked attestation with twin receipts is one flagged snapshot row naming its canonical receipt',async()=>{
 const intent=randomUUID(),account=await bankAccount(),document=randomUUID();
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type) VALUES($1,$2,'synthetic-fork.csv','text/csv')",[document,fixture.companyA]);
 await pool.query(`INSERT INTO control_bank_statement_attestation_intents(company_id,id,requester_person_id,bank_account_id,source_document_id,
  expected_source_hash,source_fingerprint,period_start,period_end,source_count,opening_balance,closing_balance,currency)
  VALUES($1,$2,$3,$4,$5,$6,$6,'2026-07-01','2026-07-31',3,0,100,'ZAR')`,[fixture.companyA,intent,fixture.u1.id,account,document,hash]);
 const canonical=await appendEffect('bank_statement_attestation_intent',intent,'bank_statement.attest');
 await appendEffect('bank_statement_attestation_intent',intent.toUpperCase(),'bank_statement.attest');
 await fork('bank_statement_attestation_intent',intent,2,5);
 const {rows,count}=await wholeSource('bank_statement_attestation_intent');
 const mine=rows.filter(row=>row.id===intent);
 expect(mine).toHaveLength(1);expect(rows).toHaveLength(count);
 expect(Number(mine[0]!.version)).toBe(5);
 expect((mine[0]!.data as Record<string,unknown>).execution_effect_id).toBe(canonical);
 // A twin receipt is evidence of a second execution: the record says so rather than silently deduping it.
 expect((mine[0]!.data as Record<string,unknown>).control_receipt_twinned).toBe(true);
});
it('a forked supplier invoice is one snapshot row and one risk population member',async()=>{
 const supplier=randomUUID(),invoice=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic forked supplier')",[supplier,fixture.companyA]);
 await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,$4,'2026-09-01',$5)",[invoice,fixture.companyA,supplier,invoice.slice(0,12),fixture.u1.id]);
 await fork('supplier_invoice',invoice,1,6);
 const snapshot=await wholeSource('supplier_invoice');
 expect(snapshot.rows.filter(row=>row.id===invoice)).toHaveLength(1);expect(snapshot.rows).toHaveLength(snapshot.count);
 const risk=await actorAs(pool,user,ctx=>loadInvoiceRiskPopulation(ctx,null));
 expect(risk.rows.filter(row=>row.id===invoice)).toHaveLength(1);
 expect(risk.populationCount).toBe(risk.rows.length);
 expect(Number(risk.rows.find(row=>row.id===invoice)!.version)).toBe(6);
});
/** Records an approval consumed by one named receipt, in the retained legacy shape (no binding) that 688 no longer lets be born. */
async function consumeApproval(entityType:string,entityId:string,operation:string,effectId:string){
 const [effect]=(await pool.query('SELECT operation_id,binding_hash FROM control_operation_effects WHERE company_id=$1 AND id=$2',[fixture.companyA,effectId])).rows;
 await rewriteApprovalUnguarded(pool,`INSERT INTO control_operation_approvals(company_id,operation_id,operation,entity_type,entity_id,requester_person_id,requester_auth_method,
  binding,binding_hash,status,requested_at,expires_at,consumed_at,consumed_effect_id)
  VALUES($1,$2,$3,$4,$5,$6,'cookie','{}'::jsonb,$7,'consumed',clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp(),$8)`,
  [fixture.companyA,effect.operation_id,operation,entityType,entityId,fixture.u1.id,effect.binding_hash,effectId]);
}
async function attestation(period:string){
 const intent=randomUUID(),account=await bankAccount(),document=randomUUID();
 await pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type) VALUES($1,$2,'synthetic-twin.csv','text/csv')",[document,fixture.companyA]);
 await pool.query(`INSERT INTO control_bank_statement_attestation_intents(company_id,id,requester_person_id,bank_account_id,source_document_id,
  expected_source_hash,source_fingerprint,period_start,period_end,source_count,opening_balance,closing_balance,currency)
  VALUES($1,$2,$3,$4,$5,$6,$6,$7::date,($7::date+interval '27 days')::date,3,0,100,'ZAR')`,[fixture.companyA,intent,fixture.u1.id,account,document,hash,period]);
 return intent;
}
/** Every finding of the check, following its cursor, so a finding past the first page is not missed. */
async function allCompletenessFindings(){
 const findings:ControlFinding[]=[];let cursor:string|undefined,status:string;
 do{const page=await actorAs(pool,user,ctx=>checkBankStatementCompleteness(ctx,{limit:100,...(cursor?{cursor}:{})}));
  findings.push(...page.findings);status=page.status;cursor=page.nextCursor??undefined;}while(cursor);
 return{findings,status};
}
it('statement completeness reviews an attestation with twin receipts once, through the receipt that consumed its approval, and fails on the twin',async()=>{
 const intent=await attestation('2026-05-01'),plain=await attestation('2026-04-01');
 const unconsumed=await appendEffect('bank_statement_attestation_intent',intent,'bank_statement.attest',{twin:'unconsumed'});
 const consumed=await appendEffect('bank_statement_attestation_intent',intent.toUpperCase(),'bank_statement.attest',{twin:'consumed'});
 await appendEffect('bank_statement_attestation_intent',plain,'bank_statement.attest');
 await consumeApproval('bank_statement_attestation_intent',intent,'bank_statement.attest',consumed);
 const completeness=await actorAs(pool,user,ctx=>loadBankStatementCompleteness(ctx,null));
 const mine=completeness.rows.filter(row=>row.id===intent);
 expect(mine).toHaveLength(1);expect(completeness.populationCount).toBe(completeness.rows.length);
 expect((mine[0] as unknown as {review_result:{twin:string}}).review_result.twin).toBe('consumed');
 // Reviewing through the consumed receipt must not make the second execution disappear from the check.
 const check=await allCompletenessFindings();
 const twin=check.findings.filter(row=>row.kind==='control_receipt_twinned'&&row.entities.some(entity=>entity.entityId===intent));
 expect(twin,'the attestation executed twice is a finding').toHaveLength(1);
 expect(twin[0]!.entities).toEqual(expect.arrayContaining([{entityType:'control_operation_effect',entityId:unconsumed},{entityType:'control_operation_effect',entityId:consumed}]));
 expect(twin[0]!.message).toContain(unconsumed);expect(twin[0]!.message).toContain(consumed);
 expect(check.status).toBe('fail');
 expect(check.findings.some(row=>row.kind==='control_receipt_twinned'&&row.entities.some(entity=>entity.entityId===plain))).toBe(false);
 expect(mine[0]!.twinReceiptIds).toEqual([consumed,unconsumed].sort());
 expect('twinReceiptIds' in completeness.rows.find(row=>row.id===plain)!).toBe(false);
});
/** Two retained spellings of one id, neither canonical. */
const nonCanonical=(id:string)=>{const upper=id.toUpperCase(),letter=upper.search(/[A-F]/);
 return[upper,`${upper.slice(0,letter)}${upper[letter]!.toLowerCase()}${upper.slice(letter+1)}`];};
it('a captured snapshot flags only forked, tied and twinned records and lists them as gaps, not coverage',async()=>{
 const account=await bankAccount(),plain=randomUUID(),forked=randomUUID(),tied=randomUUID();
 for(const id of [plain,forked,tied])await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',10,'Synthetic flag bank line','imported')",[id,fixture.companyA,account]);
 await appendEntityVersion(pool,user,'bank_transaction',plain,2);
 await fork('bank_transaction',forked,1,7);
 // A top-version tie with no canonical spelling: writers refuse this entity until someone adjudicates it.
 for(const spelling of nonCanonical(tied))await appendEntityVersion(pool,user,'bank_transaction',spelling,3);
 const intent=await attestation('2026-03-01');
 await appendEffect('bank_statement_attestation_intent',intent,'bank_statement.attest');
 await appendEffect('bank_statement_attestation_intent',intent.toUpperCase(),'bank_statement.attest');
 const snapshot=await actorAs(pool,user,ctx=>captureAuditSnapshot(ctx,{snapshotId:randomUUID(),
  request:{cutoff,sources:['bank'],checks:[],idempotencyKey:`fork-flag-${randomUUID()}`}}),'repeatable read');
 const record=(id:string,from='bank_transaction')=>snapshot.records.find(row=>row.source===from&&row.id===id)!;
 // A reviewer reads the gaps for problems; a double execution or a fork is a problem, not coverage.
 for(const gap of ['forked_lineage:bank_transaction','twinned_receipt:bank_statement_attestation_intent','unresolvable_lineage_tie:bank_transaction']){
  expect(snapshot.missingSources,gap).toContain(gap);expect(snapshot.coverage,gap).not.toContain(gap);
 }
 expect(record(forked).data.control_lineage_forked).toBe(true);expect(record(forked).version).toBe(7);
 expect('control_lineage_tie_unresolvable' in record(forked).data,'a fork writers can resolve is not a tie').toBe(false);
 expect(record(tied).data.control_lineage_forked).toBe(true);
 expect(record(tied).data.control_lineage_tie_unresolvable,'the tie writers refuse is named apart from a resolvable fork').toBe(true);
 expect('control_lineage_forked' in record(plain).data).toBe(false);expect('control_lineage_tie_unresolvable' in record(plain).data).toBe(false);
 expect(record(plain).version).toBe(2);
 expect(record(intent,'bank_statement_attestation_intent').data.control_receipt_twinned).toBe(true);
});
