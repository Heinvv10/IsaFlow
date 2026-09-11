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
const insertBatch=(c:PoolClient,company:string,requester:string,id:string,count:number)=>c.query(`INSERT INTO control_historical_import_batches(company_id,id,requester_person_id,requester_auth_method,manifest_envelope,manifest_hash,member_count)
 VALUES($1,$2,$3,'platform_import','{}'::jsonb,$4,$5)`,[company,id,requester,hex(),count]);
const insertMember=(c:PoolClient|Pool,company:string,batch:string,importId:string,position:number)=>c.query(`INSERT INTO control_historical_import_batch_members(company_id,batch_id,import_id,position,member_fingerprint)
 VALUES($1,$2,$3,$4,$5)`,[company,batch,importId,position,hex()]);
/** Batch and members in one transaction, as the kernel will write them; resolves to the batch id once committed. */
async function batch(company:string,requester:string,members:Array<{company?:string;importId:string}>,count=members.length){
 const client=await pool.connect(),id=randomUUID();
 try{
  await client.query('BEGIN');await insertBatch(client,company,requester,id,count);
  for(const [index,m] of members.entries())await insertMember(client,m.company??company,id,m.importId,index+1);
  await client.query('COMMIT');return id;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function as<T>(role:'app_user'|'platform_admin',claims:Record<string,unknown>,company:string|null,fn:(c:PoolClient)=>Promise<T>){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),company??'']);
  return await fn(client);
 }finally{await client.query('ROLLBACK');client.release();}
}
async function approval(entityType:string,operation:string,entityId:string,requester:string){
 const id=randomUUID();
 await pool.query(`INSERT INTO control_operation_approvals(id,company_id,operation_id,operation,entity_type,entity_id,requester_person_id,requester_auth_method,binding,binding_hash,status,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,'platform_import','{}'::jsonb,$8,'pending',clock_timestamp()+interval '1 day')`,[id,f.companyA,randomUUID(),operation,entityType,entityId,requester,hex()]);
 return id;
}

describe('historical import batch storage: actual PostgreSQL',()=>{
 it.each(['control_historical_import_batches','control_historical_import_batch_members'])('%s is forced-RLS, tenant-readable and append-only',async table=>{
  const {rows}=await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
   has_table_privilege('app_user',oid,'SELECT') AS app_read,has_table_privilege('app_user',oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS app_write,
   has_table_privilege('platform_admin',oid,'INSERT') AS platform_insert
   FROM pg_class WHERE oid=to_regclass($1)`,[table]);
  expect(rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,app_read:true,app_write:false,platform_insert:true}]);
 });
 it.each(['control_historical_import_batches','control_historical_import_batch_members','control_historical_imports','control_historical_import_sources'])(
  'grants UPDATE/DELETE/TRUNCATE on %s to no role but its owner and migration_admin',async table=>{
  const migration=await readFile('scripts/migrations/sql/685_historical_import_batches.sql','utf8');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // What the schema's default privileges give platform_admin, so the 685 text itself must take it back (app_user's lost it in 639).
   await client.query(`GRANT UPDATE,DELETE,TRUNCATE ON ${table} TO platform_admin`);
   await client.query(migration);
   const {rows}=await client.query(`SELECT DISTINCT COALESCE(r.rolname,'PUBLIC') AS rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.oid=to_regclass($1) AND a.privilege_type IN('UPDATE','DELETE','TRUNCATE')
    AND a.grantee<>c.relowner ORDER BY 1`,[table]);
   expect(rows.map(r=>r.rolname)).toEqual(['migration_admin']);
   // has_table_privilege also counts PUBLIC and, for an INHERIT role, the roles it belongs to. On this fixture both roles are INHERIT and members of no role.
   const effective=await client.query(`SELECT has_table_privilege('platform_admin',to_regclass($1),'UPDATE,DELETE,TRUNCATE') AS platform,
    has_table_privilege('app_user',to_regclass($1),'UPDATE,DELETE,TRUNCATE') AS app`,[table]);
   expect(effective.rows).toEqual([{platform:false,app:false}]);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('lets a tenant member read only its own company batches and members',async()=>{
  const importA=await importRow(f.companyA,admin),importB=await importRow(f.companyB,admin);
  const a=await batch(f.companyA,admin,[{importId:importA}]),b=await batch(f.companyB,admin,[{importId:importB}]);
  const seen=await as('app_user',{sub:f.u1.id,company_id:f.companyA,role:'authenticated'},f.companyA,async c=>({
   batches:(await c.query('SELECT id FROM control_historical_import_batches WHERE id=ANY($1)',[[a,b]])).rows.map(r=>r.id),
   members:(await c.query('SELECT batch_id FROM control_historical_import_batch_members WHERE batch_id=ANY($1)',[[a,b]])).rows.map(r=>r.batch_id)}));
  expect(seen).toEqual({batches:[a],members:[a]});
 });
 it('admits only members prepared by the batch requester on the platform-import path, in the batch tenant',async()=>{
  await expect(batch(f.companyA,admin,[{importId:await importRow(f.companyA,otherAdmin)}])).rejects.toThrow(/requester/i);
  await expect(batch(f.companyA,admin,[{importId:await importRow(f.companyA,admin,'cookie')}])).rejects.toThrow(/requester/i);
  await expect(batch(f.companyA,admin,[{company:f.companyB,importId:await importRow(f.companyB,admin)}])).rejects.toThrow(/requester/i);
  await expect(batch(f.companyA,admin,[{importId:await importRow(f.companyA,admin)}])).resolves.toMatch(/^[0-9a-f-]{36}$/);
 });
 it('applies the member guard under the real platform_admin writer role',async()=>{
  const good=await importRow(f.companyA,admin),bad=await importRow(f.companyA,otherAdmin);
  for(const [importId,ok] of [[good,true],[bad,false]] as const){
   const run=as('platform_admin',{sub:admin,role:'authenticated'},f.companyA,async c=>{
    const id=randomUUID();await insertBatch(c,f.companyA,admin,id,1);await insertMember(c,f.companyA,id,importId,1);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');return id;
   });
   if(ok)await expect(run).resolves.toBeTruthy();else await expect(run).rejects.toThrow(/requester/i);
  }
 });
 it('freezes the member set at the creating commit',async()=>{
  const committed=await batch(f.companyA,admin,[{importId:await importRow(f.companyA,admin)}]);
  await expect(insertMember(pool,f.companyA,committed,await importRow(f.companyA,admin),2)).rejects.toThrow(/declared batch size/i);
  await expect(insertMember(pool,f.companyA,committed,await importRow(f.companyA,admin),1)).rejects.toMatchObject({code:'23505'});
  await expect(batch(f.companyA,admin,[{importId:await importRow(f.companyA,admin)}],2)).rejects.toThrow(/exactly its declared members/i);
  await expect(batch(f.companyA,admin,[],1)).rejects.toThrow(/exactly its declared members/i);
  // Neither an early IMMEDIATE check nor a rolled-back savepoint can commit an incomplete batch.
  for(const mode of ['immediate','savepoint'] as const){
   const importId=await importRow(f.companyA,admin),client=await pool.connect(),id=randomUUID();
   try{
    await client.query('BEGIN');await insertBatch(client,f.companyA,admin,id,1);
    if(mode==='immediate')await expect(client.query('SET CONSTRAINTS control_historical_import_batch_complete IMMEDIATE')).rejects.toThrow(/exactly its declared members/i);
    else{
     await client.query('SAVEPOINT members');await insertMember(client,f.companyA,id,importId,1);await client.query('ROLLBACK TO SAVEPOINT members');
     await expect(client.query('COMMIT')).rejects.toThrow(/exactly its declared members/i);
    }
   }finally{await client.query('ROLLBACK');client.release();}
   expect((await pool.query('SELECT 1 FROM control_historical_import_batches WHERE company_id=$1 AND id=$2',[f.companyA,id])).rowCount).toBe(0);
  }
 });
 it('refuses one import in two positions of the same batch',async()=>{
  const id=await importRow(f.companyA,admin);
  await expect(batch(f.companyA,admin,[{importId:id},{importId:id}])).rejects.toMatchObject({code:'23505'});
 });
 describe('batch approval authorities',()=>{
  const call=(approvalId:string,claims:Record<string,unknown>)=>as('platform_admin',claims,f.companyA,
   async c=>(await c.query('SELECT person_id,authority_kind,platform_role,grant_valid FROM public.control_approval_authorities($1,$2)',[f.companyA,approvalId])).rows);
  it('resolves the platform requester of its own batch or import approval, whatever the entity id case',async()=>{
   const importId=await importRow(f.companyA,admin),id=await batch(f.companyA,admin,[{importId}]);
   const expected=[{person_id:admin,authority_kind:'platform_import',platform_role:'super_admin',grant_valid:true}];
   for(const approvalId of [await approval('historical_import_batch','historical_import_batch.post',id,admin),
    await approval('historical_import_batch','historical_import_batch.post',id.toUpperCase(),admin),
    await approval('historical_import','historical_import.post',importId.toUpperCase(),admin)])
    expect(await call(approvalId,{sub:admin,role:'authenticated'})).toEqual(expected);
  });
  it('refuses another super admin, another requester\'s batch, a mismatched entity type, no subject and a non-UUID entity',async()=>{
   const mine=await batch(f.companyA,admin,[{importId:await importRow(f.companyA,admin)}]);
   const theirs=await batch(f.companyA,otherAdmin,[{importId:await importRow(f.companyA,otherAdmin)}]);
   const importId=await importRow(f.companyA,admin);
   const cases=[
    [await approval('historical_import_batch','historical_import_batch.post',mine,admin),{sub:otherAdmin,role:'authenticated'}],
    [await approval('historical_import_batch','historical_import_batch.post',theirs,admin),{sub:admin,role:'authenticated'}],
    [await approval('historical_import','historical_import_batch.post',importId,admin),{sub:admin,role:'authenticated'}],
    [await approval('historical_import_batch','historical_import.post',importId,admin),{sub:admin,role:'authenticated'}],
    [await approval('historical_import_batch','historical_import_batch.post',mine,admin),{role:'authenticated'}],
    [await approval('historical_import','historical_import.post',importId,admin),{role:'authenticated'}],
    [await approval('historical_import_batch','historical_import_batch.post','not-a-uuid',admin),{sub:admin,role:'authenticated'}],
   ] as const;
   for(const [approvalId,claims] of cases)await expect(call(approvalId,claims)).rejects.toMatchObject({code:'42501'});
  });
 });
 it('re-runs migration 685 cleanly',async()=>{
  const migration=await readFile('scripts/migrations/sql/685_historical_import_batches.sql','utf8');
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query(migration);await client.query(migration);}
  finally{await client.query('ROLLBACK');client.release();}
 });
});
