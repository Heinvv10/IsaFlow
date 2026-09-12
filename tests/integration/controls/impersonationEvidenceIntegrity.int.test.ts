import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {resolveImpersonatingActor} from '@/lib/auth/sessionImpersonation';
import {assertIndependentHumanReview} from '@/modules/accounting/services/controls/independentReview';
import type {GoTrueClaims} from '@/lib/auth/gotrue';
import type {ControlPrincipal} from '@/modules/accounting/services/controls/contracts';

// Migration 691: admin_audit_log and admin_impersonation_stash are the only evidence that a session is
// impersonated (675 control_session_impersonator, 677 impersonation_delegation_live). A tenant session must
// not be able to read, forge or remove that evidence, and no role may rewrite an audit row.
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let f:ForensicFixture;
const admin=randomUUID();
const EVIDENCE={code:'23514',message:expect.stringMatching(/^Impersonation evidence refused/)};
beforeAll(async()=>{f=await provisionForensicFixture(config);});
afterAll(async()=>{await pool.end();});

type Role='app_user'|'platform_admin'|'superuser';
/** `fn` inside one transaction as `role`, with `person` the session's claims; always rolled back unless `commit`. */
async function as<T>(role:Role,person:{sub:string;session_id?:string}|null,fn:(client:PoolClient)=>Promise<T>,commit=false):Promise<T>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  if(role!=='superuser')await client.query(`SET LOCAL ROLE ${role}`);
  if(person)await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
   [JSON.stringify({...person,company_id:f.companyA,role:'authenticated',aal:'aal1'}),f.companyA]);
  const result=await fn(client);
  await client.query(commit?'COMMIT':'ROLLBACK');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** The row the impersonation route writes for a session it minted. */
async function startRow(sessionId:string):Promise<string>{
 return (await pool.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
  VALUES($1::uuid,'impersonation_start','user',$2::uuid,$3::jsonb) RETURNING id`,
  [admin,f.u2.id,JSON.stringify({target_session_id:sessionId,stash_id:randomUUID()})])).rows[0].id as string;
}
const impersonator=async(client:PoolClient)=>(await client.query('SELECT public.control_session_impersonator() AS actor')).rows[0].actor as string|null;

it.each(['admin_audit_log','admin_impersonation_stash'])('keeps %s closed to tenant sessions and immutable for admin roles',async table=>{
 const result=await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
   has_table_privilege('app_user',oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS app_user_writes,
   has_table_privilege('platform_admin',oid,'UPDATE,DELETE,TRUNCATE') AS platform_admin_rewrites,
   (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND 'app_user'=ANY(roles)) AS app_user_policies
  FROM pg_class WHERE oid=to_regclass($1)`,[table]);
 expect(result.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,app_user_writes:false,platform_admin_rewrites:false,app_user_policies:0}]);
});

it('an impersonated session cannot remove its own impersonation_start row, and stays refused as a reviewer',async()=>{
 const sessionId=`impersonation-${randomUUID()}`,rowId=await startRow(sessionId);
 const person={sub:f.u2.id,session_id:sessionId};
 expect(await as('app_user',person,impersonator),'the recorded impersonation is visible to the reader').toBe(admin);
 for(const [text,why] of [['DELETE FROM admin_audit_log WHERE id=$1','delete'],
  ["UPDATE admin_audit_log SET action='impersonation_end' WHERE id=$1",'rewrite'],
  ["UPDATE admin_audit_log SET details=details||'{\"target_session_id\":\"other\"}' WHERE id=$1",'re-point']] as const){
  await expect(as('app_user',person,c=>c.query(text,[rowId]),true),why).rejects.toMatchObject({code:'42501'});
 }
 expect((await pool.query('SELECT action FROM admin_audit_log WHERE id=$1',[rowId])).rows).toEqual([{action:'impersonation_start'}]);
 // The exact path withAuth takes to name the actor, then the kernel's refusal.
 const actor=await as('app_user',person,c=>resolveImpersonatingActor(c,{sub:f.u2.id,session_id:sessionId} as unknown as GoTrueClaims,undefined));
 expect(actor).toBe(admin);
 const principal:ControlPrincipal={personId:f.u2.id,companyId:f.companyA,connectionId:null,grantId:null,actingFirmId:null,
  requestId:randomUUID(),operationId:randomUUID(),authMethod:'cookie',provenance:'human',delegatedByPersonId:null,
  impersonatorPersonId:actor,grantedScopes:null};
 expect(()=>assertIndependentHumanReview(principal,null)).toThrow('An impersonated session cannot record an independent review');
});

it('a tenant session sees no admin evidence at all, while the admin path still lists it',async()=>{
 const sessionId=`impersonation-${randomUUID()}`;await startRow(sessionId);
 const stash=(await pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[f.u1.id,f.u2.id])).rows[0].stash_id;
 try{
  for(const person of [{sub:f.u1.id},{sub:f.u2.id,session_id:sessionId}]){
   const seen=await as('app_user',person,async c=>({
    audit:(await c.query('SELECT id FROM admin_audit_log')).rowCount,
    own:(await c.query("SELECT id FROM admin_audit_log WHERE details->>'target_session_id'=$1",[sessionId])).rowCount,
    stash:(await c.query('SELECT stash_id FROM admin_impersonation_stash')).rowCount}));
   expect(seen).toEqual({audit:0,own:0,stash:0});
  }
  const listed=await as('platform_admin',{sub:admin},async c=>({
   audit:(await c.query("SELECT id FROM admin_audit_log WHERE details->>'target_session_id'=$1",[sessionId])).rowCount,
   stash:(await c.query('SELECT stash_id FROM admin_impersonation_stash WHERE stash_id=$1',[stash])).rowCount}));
  expect(listed).toEqual({audit:1,stash:1});
 }finally{await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);}
});

it('a tenant session cannot forge evidence: no INSERT into either table',async()=>{
 const person={sub:f.u1.id};
 await expect(as('app_user',person,c=>c.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'x','x',$2,NOW()+interval '1 hour')`,[f.u1.id,f.u2.id]),true),'stash').rejects.toMatchObject({code:'42501'});
 await expect(as('app_user',person,c=>c.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
  VALUES($1::uuid,'impersonation_end','user',$2::uuid,'{}'::jsonb)`,[admin,f.u2.id]),true),'audit').rejects.toMatchObject({code:'42501'});
});

it('the admin path still writes both, and can rewrite neither',async()=>{
 const written=await as('platform_admin',{sub:admin},async c=>{
  const stash=(await c.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
   VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[f.u1.id,f.u2.id])).rows[0].stash_id;
  const audit=(await c.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
   VALUES($1::uuid,'impersonation_start','user',$2::uuid,'{}'::jsonb) RETURNING id`,[admin,f.u2.id])).rows[0].id;
  return {stash,audit};
 });
 expect(written).toMatchObject({stash:expect.any(String),audit:expect.any(String)});
 const rowId=await startRow(`impersonation-${randomUUID()}`);
 for(const text of ['DELETE FROM admin_audit_log WHERE id=$1',"UPDATE admin_audit_log SET action='x' WHERE id=$1",
  'DELETE FROM admin_impersonation_stash WHERE stash_id=$1',"UPDATE admin_impersonation_stash SET expires_at=NOW()+interval '1 day' WHERE stash_id=$1"]){
  await expect(as('platform_admin',{sub:admin},c=>c.query(text,[rowId]),true),text).rejects.toMatchObject({code:'42501'});
 }
});

it('audit rows are append-only for every role; the stash refuses rewrites but still releases on exit',async()=>{
 const rowId=await startRow(`impersonation-${randomUUID()}`);
 for(const [text,params] of [["UPDATE admin_audit_log SET action='impersonation_end' WHERE id=$1",[rowId]],
  ['UPDATE admin_audit_log SET created_at=created_at-interval \'1 day\' WHERE id=$1',[rowId]],
  ['DELETE FROM admin_audit_log WHERE id=$1',[rowId]],['TRUNCATE admin_audit_log',[]],
  ["UPDATE admin_impersonation_stash SET expires_at=NOW()+interval '1 day'",[]],['TRUNCATE admin_impersonation_stash',[]]] as const){
  await expect(as('superuser',null,c=>c.query(text,[...params])),text).rejects.toMatchObject(EVIDENCE);
 }
 // end-impersonation deletes the consumed stash so the admin's tokens cannot be restored twice; that DELETE
 // runs on the login role and stays allowed. The impersonation_end row, not the delete, is what ends the delegation.
 const stash=(await pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[f.u1.id,f.u2.id])).rows[0].stash_id;
 expect((await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash])).rowCount).toBe(1);
});
