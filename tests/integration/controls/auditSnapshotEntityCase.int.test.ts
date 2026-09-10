import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {ledgerSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotCaptureQueries';
import {invoiceSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotInvoiceQueries';
import {loadInvoiceRiskPopulation} from '@/modules/accounting/services/controls/invoiceRiskQueries';
import {actorAs,appendEntityVersion,type Identity} from './intentReceiptRows';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:10000});
let fixture:ForensicFixture,user:Identity;
const hash='a'.repeat(64),cutoff='2026-12-31';
beforeAll(async()=>{fixture=await provisionForensicFixture(config);user={id:fixture.u1.id,companyId:fixture.companyA};});
afterAll(async()=>{await pool.end();});
/** Appends a receipt spelled as legacy source spelled it; no retained row is edited. */
async function appendEffect(entityType:string,entityId:string,operation:string){
 const id=randomUUID();
 await pool.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
  VALUES($1,$2,gen_random_uuid(),$3,$4,$5,$6,'{}'::jsonb,clock_timestamp())`,[fixture.companyA,id,operation,entityType,entityId,hash]);
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
async function wholeSource(name:string){
 const rows=await actorAs(pool,user,ctx=>source(name).page(ctx,cutoff,null)),counts=await actorAs(pool,user,ctx=>source(name).counts(ctx,cutoff));
 return{rows,count:counts.count};
}
it('a forked bank transaction is one snapshot row and binds its canonical lineage',async()=>{
 const account=await bankAccount(),tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',10,'Synthetic forked bank line','imported')",[tx,fixture.companyA,account]);
 await fork('bank_transaction',tx,1,7);
 const {rows,count}=await wholeSource('bank_transaction');
 expect(rows.filter(row=>row.id===tx)).toHaveLength(1);
 expect(rows).toHaveLength(count);
 expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
 expect(Number(rows.find(row=>row.id===tx)!.version)).toBe(1);
});
it('a forked attestation with twin receipts is one snapshot row naming its canonical receipt',async()=>{
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
 expect(Number(mine[0]!.version)).toBe(2);
 expect((mine[0]!.data as Record<string,unknown>).execution_effect_id).toBe(canonical);
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
 expect(Number(risk.rows.find(row=>row.id===invoice)!.version)).toBe(1);
});
