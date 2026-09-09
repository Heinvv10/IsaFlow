import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {loadApprovalRules,matchApprovalRules} from '@/modules/accounting/services/controls/approvalRuleService';
import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it('provides owned immutable local statement fact intents',async()=>{
 const table='control_bank_statement_attestation_intents';
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 expect((await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0]).toEqual({read:true,create:true,update:false,delete:false});
});
it('requires a persisted independent administrator statement policy',async()=>{
 const table='control_mandatory_statement_policies';
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 expect((await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0]).toEqual({read:true,create:false,update:false,delete:false});
});

it('stores zero-count local evidence with owned parents and authenticated maker only',async()=>{
 const fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 const db=await pool.connect(),account=randomUUID(),document=randomUUID(),foreignDocument=randomUUID(),intent=randomUUID();
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,'SYN-ATTEST','Synthetic statement bank','asset','bank','debit',true,1)",[account,fixture.companyA]);
  for(const [id,company] of [[document,fixture.companyA],[foreignDocument,fixture.companyB]])await db.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status,raw_bytes,raw_bytes_sha256) VALUES($1,$2,'synthetic-statement.pdf','pdf','matched',$3,$4)",[id,company,Buffer.from('Synthetic statement'),'a'.repeat(64)]);
  await db.query('SET LOCAL ROLE app_user');
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u1.id,role:'authenticated',company_id:fixture.companyA}),fixture.companyA]);
  const insert="INSERT INTO control_bank_statement_attestation_intents(company_id,id,requester_person_id,bank_account_id,source_document_id,expected_source_hash,source_fingerprint,period_start,period_end,source_count,opening_balance,closing_balance,currency) VALUES($1,$2,$3,$4,$5,$6,$6,'2026-09-01','2026-09-30',0,-10,-10,'ZAR')";
  const values=[fixture.companyA,intent,fixture.u1.id,account,document,'a'.repeat(64)];
  for(const [index,value] of [[2,fixture.u2.id],[4,foreignDocument]] as const){
   await db.query('SAVEPOINT refusal');const invalid=[...values];invalid[index]=value;
   await expect(db.query(insert,invalid)).rejects.toThrow();await db.query('ROLLBACK TO SAVEPOINT refusal');
  }
  await db.query(insert,values);
  const policies=await withControlRequest({client:db,userId:fixture.u1.id,companyId:fixture.companyA,claims:{}},{personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},async()=>matchApprovalRules(await loadApprovalRules(requireControlTx(),'bank_statement_attestation'),'0',new Map()));
  expect(policies).toHaveLength(1);expect(policies[0]!.approverRole).toBe('admin');
  expect((await db.query('SELECT source_count,opening_balance::text FROM control_bank_statement_attestation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,intent])).rows[0]).toEqual({source_count:0,opening_balance:'-10.00'});
  expect((await db.query('SELECT approver_role,version::int FROM control_mandatory_statement_policies WHERE company_id=$1',[fixture.companyA])).rows).toEqual([{approver_role:'admin',version:1}]);
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:fixture.u3.id,role:'authenticated',company_id:fixture.companyB}),fixture.companyB]);
  expect((await db.query('SELECT id FROM control_bank_statement_attestation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,intent])).rows).toHaveLength(0);
 }finally{await db.query('ROLLBACK');db.release();}
});
