import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:10000});
const hex=()=>randomUUID().replaceAll('-','').repeat(2);
let f:ForensicFixture;let admin:string;let otherAdmin:string;
beforeAll(async()=>{
 f=await provisionForensicFixture(config);admin=randomUUID();otherAdmin=randomUUID();
 for(const id of [admin,otherAdmin])await pool.query("INSERT INTO users(id,email,role,is_active,status) VALUES($1,$2,'super_admin',true,'active')",[id,`${id}@forensic.invalid`]);
},30000);
afterAll(async()=>{await pool.end();});
/** Synthetic intent rows written directly by the trusted fixture; the kernel's own writers are exercised elsewhere. */
async function importRow(company:string,requester:string,authMethod:'platform_import'|'cookie'='platform_import'){
 const source=randomUUID(),id=randomUUID();
 await pool.query(`INSERT INTO control_historical_import_sources(company_id,id,requester_person_id,payload_envelope,content_hash,normalized_hash,mime_type,byte_length,record_count)
  VALUES($1,$2,$3,'{}'::jsonb,$4,$4,'application/json',1,1)`,[company,source,requester,hex()]);
 await pool.query(`INSERT INTO control_historical_imports(company_id,id,requester_person_id,source_id,requester_auth_method,source_system,source_key,kind,mode,accounting_date,currency,amount,payload_envelope,payload_hash)
  VALUES($1,$2,$3,$4,$5,'sage',$6,'customer_invoice','post_journal','2023-02-28','ZAR',1,'{}'::jsonb,$7)`,[company,id,requester,source,authMethod,`batch-schema:${id}`,hex()]);
 return id;
}
async function batchRow(company:string,requester:string){
 const id=randomUUID();
 await pool.query(`INSERT INTO control_historical_import_batches(company_id,id,requester_person_id,requester_auth_method,manifest_envelope,manifest_hash,member_count)
  VALUES($1,$2,$3,'platform_import','{}'::jsonb,$4,1)`,[company,id,requester,hex()]);
 return id;
}
const member=(company:string,batch:string,importId:string,position=1)=>pool.query(`INSERT INTO control_historical_import_batch_members(company_id,batch_id,import_id,position,member_fingerprint)
 VALUES($1,$2,$3,$4,$5)`,[company,batch,importId,position,hex()]);
async function as<T>(role:'app_user'|'platform_admin',claims:Record<string,unknown>,company:string|null,fn:(c:PoolClient)=>Promise<T>){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),company??'']);
  return await fn(client);
 }finally{await client.query('ROLLBACK');client.release();}
}

describe('historical import batch storage: actual PostgreSQL',()=>{
 it.each(['control_historical_import_batches','control_historical_import_batch_members'])('%s is forced-RLS, tenant-readable and immutable to both roles',async table=>{
  const {rows}=await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
   has_table_privilege('app_user',oid,'SELECT') AS app_read,has_table_privilege('app_user',oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS app_write,
   has_table_privilege('platform_admin',oid,'INSERT') AS platform_insert,has_table_privilege('platform_admin',oid,'UPDATE,DELETE,TRUNCATE') AS platform_mutate
   FROM pg_class WHERE oid=to_regclass($1)`,[table]);
  expect(rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,app_read:true,app_write:false,platform_insert:true,platform_mutate:false}]);
 });
 it('lets a tenant member read only its own company batches',async()=>{
  const a=await batchRow(f.companyA,admin),b=await batchRow(f.companyB,admin);
  const seen=await as('app_user',{sub:f.u1.id,company_id:f.companyA,role:'authenticated'},f.companyA,
   async c=>(await c.query('SELECT id FROM control_historical_import_batches WHERE id=ANY($1)',[[a,b]])).rows.map(r=>r.id));
  expect(seen).toEqual([a]);
 });
 it('admits only members prepared by the batch requester on the platform-import path',async()=>{
  const batch=await batchRow(f.companyA,admin);
  await expect(member(f.companyA,batch,await importRow(f.companyA,otherAdmin))).rejects.toThrow(/requester/i);
  await expect(member(f.companyA,batch,await importRow(f.companyA,f.u1.id,'cookie'))).rejects.toThrow(/requester/i);
  // Another tenant's import can never join: the batch does not exist in that tenant.
  await expect(member(f.companyB,batch,await importRow(f.companyB,admin))).rejects.toThrow(/requester/i);
  await expect(member(f.companyA,batch,await importRow(f.companyA,admin))).resolves.toMatchObject({rowCount:1});
 });
 it('refuses one import in two positions of the same batch',async()=>{
  const batch=await batchRow(f.companyA,admin),id=await importRow(f.companyA,admin);
  await member(f.companyA,batch,id,1);
  await expect(member(f.companyA,batch,id,2)).rejects.toMatchObject({code:'23505'});
 });
 it('resolves the platform requester of a batch approval, and no other super admin',async()=>{
  const batch=await batchRow(f.companyA,admin),approval=randomUUID();
  await pool.query(`INSERT INTO control_operation_approvals(id,company_id,operation_id,operation,entity_type,entity_id,requester_person_id,requester_auth_method,binding,binding_hash,status,expires_at)
   VALUES($1,$2,$3,'historical_import_batch.post','historical_import_batch',$4,$5,'platform_import','{}'::jsonb,$6,'pending',clock_timestamp()+interval '1 day')`,[approval,f.companyA,randomUUID(),batch,admin,hex()]);
  const call=(person:string)=>as('platform_admin',{sub:person,role:'authenticated'},f.companyA,
   async c=>(await c.query('SELECT person_id,authority_kind,platform_role,grant_valid FROM public.control_approval_authorities($1,$2)',[f.companyA,approval])).rows);
  expect(await call(admin)).toEqual([{person_id:admin,authority_kind:'platform_import',platform_role:'super_admin',grant_valid:true}]);
  await expect(call(otherAdmin)).rejects.toMatchObject({code:'42501'});
 });
 it('re-runs migration 685 cleanly',async()=>{
  const migration=await readFile('scripts/migrations/sql/685_historical_import_batches.sql','utf8');
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query(migration);await client.query(migration);}
  finally{await client.query('ROLLBACK');client.release();}
 });
});
