import {afterAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';

/**
 * Migration 687: platform_admin (BYPASSRLS, the platform-import maker) may request and
 * consume an approval but never write a decision, nor rewrite or delete an approval.
 * Each case re-grants what the schema's default privileges gave, applies the file and
 * rolls back, so it proves the migration rather than an earlier run on this fixture.
 */
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:10000});
afterAll(async()=>{await pool.end();});
const TABLES='control_operation_approvals,control_operation_decisions';
async function migrated<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{
 const migration=await readFile('scripts/migrations/sql/687_platform_admin_approval_writes.sql','utf8');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ${TABLES} TO platform_admin`);
  await client.query(migration);await client.query(migration);
  return await fn(client);
 }finally{await client.query('ROLLBACK');client.release();}
}
/** Runs one statement as platform_admin inside a savepoint and returns its SQLSTATE, or 'ok'. */
async function asPlatform(client:PoolClient,statement:string,values:unknown[]=[]):Promise<string>{
 await client.query('SAVEPOINT attempt');
 try{await client.query('SET LOCAL ROLE platform_admin');await client.query(statement,values);return 'ok';}
 catch(error){return (error as {code?:string}).code??'unknown';}
 finally{await client.query('ROLLBACK TO SAVEPOINT attempt');}
}

describe('platform_admin writes on approvals and decisions (migration 687): actual PostgreSQL',()=>{
 it('leaves platform_admin SELECT on both tables, INSERT of the request columns and UPDATE of the consume columns on approvals',async()=>{
  await migrated(async client=>{
   const table=await client.query(`SELECT c.relname,array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS privileges
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relname=ANY($1) AND a.grantee='platform_admin'::regrole GROUP BY 1 ORDER BY 1`,[TABLES.split(',')]);
   expect(table.rows).toEqual([{relname:'control_operation_approvals',privileges:['SELECT']},{relname:'control_operation_decisions',privileges:['SELECT']}]);
   const columns=await client.query(`SELECT c.relname,a.privilege_type,array_agg(att.attname::text) AS columns FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
    CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE c.relname=ANY($1) AND a.grantee='platform_admin'::regrole GROUP BY 1,2 ORDER BY 1,2`,[TABLES.split(',')]);
   expect(columns.rows.map(r=>({...r,columns:[...r.columns].sort()}))).toEqual([
    // Exactly the columns approvalRequestService's request INSERT names.
    {relname:'control_operation_approvals',privilege_type:'INSERT',columns:['binding','binding_hash','company_id','entity_id','entity_type','expires_at','operation','operation_id',
     'requested_at','requester_auth_method','requester_grant_id','requester_granted_scopes','requester_person_id','status']},
    {relname:'control_operation_approvals',privilege_type:'UPDATE',columns:['consumed_at','consumed_effect_id','status']}]);
  });
 });

 it('refuses a platform_admin approval INSERT that sets an id, a decision time or a consumption',async()=>{
  await migrated(async client=>{
   const base='company_id,operation_id,operation,entity_type,entity_id,requester_person_id,binding,binding_hash,status,expires_at';
   const values=[randomUUID(),randomUUID(),'historical_import.post','historical_import',randomUUID(),randomUUID(),'{}','x','consumed'];
   for(const [column,value] of [['consumed_effect_id',randomUUID()],['consumed_at','2026-01-01'],['decided_at','2026-01-01'],['id',randomUUID()]] as const)
    expect({column,code:await asPlatform(client,`INSERT INTO control_operation_approvals(${base},${column}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '1 day',$10)`,[...values,value])})
     .toEqual({column,code:'42501'});
   // The request's own column list passes the privilege check and every CHECK; only the unknown company refuses it.
   expect(await asPlatform(client,`INSERT INTO control_operation_approvals(${base}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '1 day')`,values)).toBe('23503');
  });
 });

 it('refuses a platform_admin INSERT, UPDATE or DELETE of a decision with 42501',async()=>{
  await migrated(async client=>{
   expect(await asPlatform(client,`INSERT INTO control_operation_decisions(company_id,approval_id,policy_id,person_id,decision,evidence_refs,decided_at)
    VALUES($1,$2,$3,$4,'approved','[]'::jsonb,clock_timestamp())`,[randomUUID(),randomUUID(),randomUUID(),randomUUID()])).toBe('42501');
   expect(await asPlatform(client,"UPDATE control_operation_decisions SET decision='approved' WHERE false")).toBe('42501');
   expect(await asPlatform(client,'DELETE FROM control_operation_decisions WHERE false')).toBe('42501');
   expect(await asPlatform(client,'TRUNCATE control_operation_decisions')).toBe('42501');
   expect(await asPlatform(client,'SELECT count(*) FROM control_operation_decisions')).toBe('ok');
  });
 });

 it('refuses a platform_admin rewrite or delete of an approval, and still lets it consume one',async()=>{
  await migrated(async client=>{
   for(const statement of ["UPDATE control_operation_approvals SET requester_person_id='x' WHERE false",
    "UPDATE control_operation_approvals SET binding='{}'::jsonb WHERE false","UPDATE control_operation_approvals SET expires_at=now() WHERE false",
    'UPDATE control_operation_approvals SET decided_at=now() WHERE false','DELETE FROM control_operation_approvals WHERE false','TRUNCATE control_operation_approvals'])
    expect({statement,code:await asPlatform(client,statement)}).toEqual({statement,code:'42501'});
   expect(await asPlatform(client,"UPDATE control_operation_approvals SET status='consumed',consumed_at=now(),consumed_effect_id=NULL WHERE false")).toBe('ok');
   expect(await asPlatform(client,'SELECT id FROM control_operation_approvals WHERE false FOR UPDATE')).toBe('ok');
  });
 });
});
