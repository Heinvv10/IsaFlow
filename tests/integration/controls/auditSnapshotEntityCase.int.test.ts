import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {ledgerSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotCaptureQueries';
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
const source=(name:string)=>ledgerSnapshotSources.find(row=>row.source===name)!;
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
