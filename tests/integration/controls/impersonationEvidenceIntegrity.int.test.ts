import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {assertImpersonationReaderDeployed,resolveImpersonatingActor} from '@/lib/auth/sessionImpersonation';
import {IMPERSONATION_UNVERIFIED} from '@/lib/auth/impersonationState';
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
beforeAll(async()=>{
 f=await provisionForensicFixture(config);
 // The stash's admin_user_id is an FK to users; this is the platform administrator doing the impersonating.
 await pool.query("INSERT INTO users(id,email,role,is_active,status) VALUES($1,$2,'super_admin',true,'active')",
  [admin,`${admin}@forensic.invalid`]);
});
afterAll(async()=>{await pool.end();});

type Role='app_user'|'platform_admin'|'login_role';
/**
 * `fn` inside one transaction as `role`, with `person` the session's claims; always rolled back unless `commit`.
 * `owner` runs first, before the role switch, for the ALTER FUNCTION downgrades a tenant role cannot perform -
 * the blinding has to be real, and it has to be visible to the query that follows it in the same transaction.
 */
async function as<T>(role:Role,person:{sub:string;session_id?:string}|null,fn:(client:PoolClient)=>Promise<T>,
 commit=false,owner?:string):Promise<T>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  if(owner)await client.query(owner);
  if(role!=='login_role')await client.query(`SET LOCAL ROLE ${role}`);
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
/** The deploy gate's row shape, so its SQL can be run against this fixture. */
type ReaderGateRow={reader:boolean;liveness:boolean;reader_exec:boolean|null;liveness_exec:boolean|null;
 reader_sees:boolean|null;liveness_sees:boolean|null;reader_sentinel:boolean|null;login_role?:string};
const principalOf=(actor:string|null):ControlPrincipal=>({personId:f.u2.id,companyId:f.companyA,connectionId:null,
 grantId:null,actingFirmId:null,requestId:randomUUID(),operationId:randomUUID(),authMethod:'cookie',
 provenance:'human',delegatedByPersonId:null,impersonatorPersonId:actor,grantedScopes:null});

it.each(['admin_audit_log','admin_impersonation_stash'])('keeps %s closed to tenant sessions and immutable for admin roles',async table=>{
 const result=await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
   has_table_privilege('app_user',oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS app_user_writes,
   has_table_privilege('platform_admin',oid,'UPDATE,DELETE,TRUNCATE') AS platform_admin_rewrites,
   (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND 'app_user'=ANY(roles)) AS app_user_policies
  FROM pg_class WHERE oid=to_regclass($1)`,[table]);
 expect(result.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true,app_user_writes:false,platform_admin_rewrites:false,app_user_policies:0}]);
});

// With RLS on the tables, the readers' SECURITY DEFINER and their owner's BYPASSRLS stop being cosmetic: lose
// either and the evidence is invisible to the only code that consults it. The deploy gate asserts the same pair.
it.each(['control_session_impersonator','impersonation_delegation_live'])('keeps %s able to see the evidence: definer, owned by a BYPASSRLS role',async fn=>{
 const result=await pool.query(`SELECT p.prosecdef,r.rolbypassrls AS owner_bypassrls,pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname=$1`,[fn]);
 expect(result.rows).toEqual([{prosecdef:true,owner_bypassrls:true,owner:'migration_admin'}]);
 const gate=await assertImpersonationReaderDeployed(async text=>(await pool.query<ReaderGateRow>(text)).rows)
  .then(()=>'passed',error=>String(error));
 expect(gate).toBe('passed');
});

// The failure this migration introduced the risk of: a reader that can no longer see the evidence used to answer
// NULL, which resolveImpersonatingActor reads as "nobody is impersonating" - clearing the session rather than
// refusing it. Proved by actually breaking the property, not by asserting the fix's own shape.
it.each([['its owner loses BYPASSRLS','ALTER FUNCTION public.control_session_impersonator() OWNER TO app_user'],
 ['it loses SECURITY DEFINER','ALTER FUNCTION public.control_session_impersonator() SECURITY INVOKER']] as const)(
 'refuses the session as unverified, never as unimpersonated, when the reader is blinded because %s',async(_why,downgrade)=>{
 const sessionId=`impersonation-${randomUUID()}`;await startRow(sessionId);
 const person={sub:f.u2.id,session_id:sessionId};
 expect(await as('app_user',person,impersonator),'live impersonation before the downgrade').toBe(admin);
 const actor=await as('app_user',person,
  c=>resolveImpersonatingActor(c,{sub:f.u2.id,session_id:sessionId} as unknown as GoTrueClaims,undefined),false,downgrade);
 // Unverified, not null: the review kernel refuses rather than recording the member as an independent reviewer.
 expect(actor).toBe(IMPERSONATION_UNVERIFIED);
 expect(()=>assertIndependentHumanReview(principalOf(actor),null))
  .toThrow('Impersonation state is unverified; an independent review cannot be recorded');
 // And the deploy gate refuses to serve that state at all.
 const gate=await as('login_role',null,
  c=>assertImpersonationReaderDeployed(async text=>(await c.query<ReaderGateRow>(text)).rows).then(()=>'passed',error=>String(error)),
  false,downgrade);
 expect(gate).toMatch(/control_session_impersonator\(\) cannot read the impersonation evidence/);
});

// A reader whose owner keeps BYPASSRLS but loses SELECT on the table gets past a rolbypassrls-only check and then
// raises 42501 from its own query - inside withAuth's transaction, the 500 the sentinel design exists to avoid.
it('answers the sentinel, and never raises, when the reader owner loses SELECT on the evidence table',async()=>{
 const sessionId=`impersonation-${randomUUID()}`;await startRow(sessionId);
 const person={sub:f.u2.id,session_id:sessionId};
 const actor=await as('app_user',person,
  c=>resolveImpersonatingActor(c,{sub:f.u2.id,session_id:sessionId} as unknown as GoTrueClaims,undefined),
  false,'REVOKE SELECT ON admin_audit_log FROM migration_admin');
 expect(actor).toBe(IMPERSONATION_UNVERIFIED);
 // Same transaction, so the revoke is still in force: the reader answered rather than poisoning it.
 const gate=await as('login_role',null,
  c=>assertImpersonationReaderDeployed(async text=>(await c.query<ReaderGateRow>(text)).rows).then(()=>'passed',error=>String(error)),
  false,'REVOKE SELECT ON admin_audit_log FROM migration_admin');
 expect(gate).toMatch(/control_session_impersonator\(\) cannot read the impersonation evidence/);
});

// A SET search_path that omits pg_temp does not exclude it: Postgres searches pg_temp FIRST for relation names,
// so an unqualified catalogue reference inside the reader's control-flow gate is shadowable by any tenant session -
// the impersonated party included. Both directions were live before the qualification: a shadow view the definer
// may not read raised inside withAuth's transaction, and one the tenant granted itself SELECT on made the reader
// answer NULL, which reads as no impersonation.
it.each([['healthy',undefined],['blinded','ALTER FUNCTION public.control_session_impersonator() OWNER TO app_user']] as const)(
 'ignores a tenant temp view shadowing the catalogue, in the %s state',async(state,downgrade)=>{
 const sessionId=`impersonation-${randomUUID()}`;await startRow(sessionId);
 const answer=await as('app_user',{sub:f.u2.id,session_id:sessionId},async c=>{
  // Exactly what a tenant session can do for itself: the view claims the executing role bypasses RLS.
  await c.query(`CREATE TEMP VIEW pg_roles AS SELECT '${state==='blinded'?'app_user':'migration_admin'}'::name AS rolname,true AS rolbypassrls`);
  await c.query('GRANT SELECT ON pg_roles TO app_user');
  return impersonator(c);
 },false,downgrade);
 // Healthy: the real evidence, no raise. Blinded: the sentinel, never NULL.
 expect(answer).toBe(state==='blinded'?IMPERSONATION_UNVERIFIED:admin);
});

// The whole shadowable class, across every function the impersonation path reaches: no unqualified relation
// reference in any of them, and pg_temp pinned last in the three that 691 owns. 677's liveness function is in the
// qualification half but not the pinning half - every relation it names is already schema-qualified, so nothing in
// it is shadowable, and editing 677 to pin pg_temp would cost a second checksum conflict on every database for a
// property this test already enforces directly. If it ever gains an unqualified reference, the loop below fails.
const PINS_PG_TEMP=['control_session_impersonator','impersonation_evidence_visible','impersonation_evidence_append_only'];
it('leaves no unqualified relation reference in any function the impersonation path reaches',async()=>{
 // pg_temp is never searched for functions, so has_table_privilege() and auth.uid() are not exposed; relations are.
 const bodies=await pool.query<{proname:string;prosrc:string;config:string[]|null}>(
  `SELECT proname,prosrc,proconfig AS config FROM pg_proc WHERE proname IN
    ('control_session_impersonator','impersonation_evidence_visible','impersonation_evidence_append_only','impersonation_delegation_live')`);
 expect(bodies.rows.map(row=>row.proname).sort()).toEqual(['control_session_impersonator','impersonation_delegation_live',
  'impersonation_evidence_append_only','impersonation_evidence_visible']);
 for(const row of bodies.rows){
  const relations=row.prosrc.match(/\b(?:FROM|JOIN|INTO)\s+(?!v_|STRICT\b)([a-z_][a-z0-9_.]*)/gi)??[];
  for(const reference of relations){
   const name=reference.split(/\s+/)[1]!;
   // A local plpgsql variable target (SELECT ... INTO v_actor) is not a relation reference.
   if(name.startsWith('v_'))continue;
   expect(name,`${row.proname}: ${reference}`).toMatch(/^(pg_catalog|public|auth|app)\./);
  }
  if(PINS_PG_TEMP.includes(row.proname))expect(row.config?.join(','),`${row.proname} search_path`).toMatch(/pg_temp$/);
 }
});

// 675 used to define this reader too. Re-running it after 691 - resolve-checksum-conflicts.ts on an amended
// migration, a rebuilt database, the pending renumbering - would reinstate the body that answers an unreadable
// table with NULL, with every other property the gate checks still true. The deploy gate is what catches it.
const PRE_FIX_READER=`CREATE OR REPLACE FUNCTION public.control_session_impersonator()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $body$
 SELECT l.admin_user_id::text FROM public.admin_audit_log l
 WHERE l.action='impersonation_start' AND l.target_type='user' AND l.target_id::text=auth.uid()
   AND l.details->>'target_session_id'=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')
 ORDER BY l.created_at DESC LIMIT 1 $body$`;
it('fails the deploy when an older migration reinstates the sentinel-less reader',async()=>{
 const gate=await as('login_role',null,
  c=>assertImpersonationReaderDeployed(async text=>(await c.query<ReaderGateRow>(text)).rows).then(()=>'passed',error=>String(error)),
  false,PRE_FIX_READER);
 expect(gate).toMatch(/has been reverted to a body that reports an unreadable evidence table as "no impersonation"/);
 // Everything else the gate checks is still true of that body, which is why the body itself has to be asserted.
 const intact=await as('login_role',null,async c=>{
  await c.query(PRE_FIX_READER);
  return (await c.query(`SELECT p.prosecdef,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid=to_regprocedure('public.control_session_impersonator()')`)).rows;
 });
 expect(intact).toEqual([{prosecdef:true,rolbypassrls:true}]);
});

it('leaves migration 691 as the only definition of the reader, so apply order cannot decide the answer',async()=>{
 const {readdirSync,readFileSync}=await import('node:fs');
 const dir='scripts/migrations/sql';
 const defining=readdirSync(dir).filter(name=>name.endsWith('.sql')
  && /(CREATE|REPLACE)\s+FUNCTION\s+public\.control_session_impersonator/i.test(readFileSync(`${dir}/${name}`,'utf8')));
 expect(defining).toEqual(['691_impersonation_evidence_integrity.sql']);
});

// The sentinel is a string literal in 691 and a constant in TypeScript; drift between them would silently turn
// the blinded reader back into "nobody is impersonating".
it('answers with exactly the unverified sentinel the auth path compares against',async()=>{
 const answered=await as('app_user',{sub:f.u1.id},impersonator,false,
  'ALTER FUNCTION public.control_session_impersonator() SECURITY INVOKER');
 expect(answered).toBe(IMPERSONATION_UNVERIFIED);
});

// 677's liveness function gates the MFA bypass for impersonated sessions and reads the stash, which now has
// forced RLS. Its blind failure mode is a bare false, so it is exercised directly rather than inferred.
it('honours a live delegation through the reader, and refuses it once the reader is blinded',async()=>{
 const sessionId=`impersonation-${randomUUID()}`;await startRow(sessionId);
 const stash=(await pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[admin,f.u2.id])).rows[0].stash_id;
 const live=(c:PoolClient)=>c.query<{live:boolean}>('SELECT public.impersonation_delegation_live($1::uuid,$2,$3,$4) AS live',
  [stash,admin,f.u2.id,sessionId]).then(r=>r.rows[0]!.live);
 try{
  // The calling session cannot see one row of either table itself; the delegation is still honoured.
  expect(await as('app_user',{sub:f.u2.id},async c=>({
   live:await live(c),
   stashRows:(await c.query('SELECT stash_id FROM admin_impersonation_stash')).rowCount}))).toEqual({live:true,stashRows:0});
  // An end for that session kills it - the audit row, not the stash's absence, is what ends a delegation.
  await pool.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
   VALUES($1::uuid,'impersonation_end','user',$2::uuid,$3::jsonb)`,[admin,f.u2.id,JSON.stringify({target_session_id:sessionId})]);
  expect(await as('app_user',{sub:f.u2.id},live)).toBe(false);
 }finally{await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);}
});

it('refuses every delegation proof when the liveness reader is blinded, and the deploy gate refuses that state',async()=>{
 const sessionId=`impersonation-${randomUUID()}`;
 const stash=(await pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[admin,f.u2.id])).rows[0].stash_id;
 try{
  const blinded=await as('app_user',{sub:f.u2.id},
   c=>c.query<{live:boolean}>('SELECT public.impersonation_delegation_live($1::uuid,$2,$3,$4) AS live',
    [stash,admin,f.u2.id,sessionId]).then(r=>r.rows[0]!.live),
   false,'ALTER FUNCTION public.impersonation_delegation_live(uuid,text,text,text) OWNER TO app_user');
  // false is the closed direction for a boolean answer: the proof is refused, the MFA bypass switches off.
  expect(blinded).toBe(false);
  const gate=await as('login_role',null,
   c=>assertImpersonationReaderDeployed(async text=>(await c.query<ReaderGateRow>(text)).rows).then(()=>'passed',error=>String(error)),
   false,'ALTER FUNCTION public.impersonation_delegation_live(uuid,text,text,text) OWNER TO app_user');
  expect(gate).toMatch(/impersonation_delegation_live\(.*\) cannot read the impersonation evidence/);
 }finally{await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);}
});

// loadStash runs on the login role in end-impersonation; if forced RLS blinded it, an administrator would be
// stranded mid-impersonation. Covered here because the only other coverage needs a live GoTrue.
it('still lets the login role read a stash row that platform_admin wrote',async()=>{
 const stash=await as('platform_admin',{sub:admin},async c=>(await c.query(
  `INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
   VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[admin,f.u2.id])).rows[0].stash_id as string,true);
 try{
  const read=await pool.query('SELECT admin_user_id,target_user_id FROM admin_impersonation_stash WHERE stash_id=$1 AND expires_at>NOW()',[stash]);
  expect(read.rows).toEqual([{admin_user_id:admin,target_user_id:f.u2.id}]);
 }finally{await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash]);}
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
 expect(()=>assertIndependentHumanReview(principalOf(actor),null)).toThrow('An impersonated session cannot record an independent review');
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

it('a tenant session cannot forge evidence or wipe it: no INSERT, no TRUNCATE, on either table',async()=>{
 const person={sub:f.u1.id};
 // Attempted as app_user, not only asserted in the catalogue: the grant is the first line of defence and the
 // append-only trigger the second, so the refusal must be the privilege one.
 for(const table of ['admin_audit_log','admin_impersonation_stash']){
  await expect(as('app_user',person,c=>c.query(`TRUNCATE ${table}`),true),`truncate ${table}`).rejects.toMatchObject({code:'42501'});
 }
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

// The role here is the DATABASE_URL login role the application itself connects as - postgres, rolsuper=f on the
// Supabase cluster - with no SET LOCAL ROLE and BYPASSRLS, so RLS is not what refuses these. On this fixture that
// same connection happens to be a real superuser, which makes the coverage stronger, not weaker: triggers fire for
// superusers too. What a superuser (supabase_admin in production) can do is lift the guard - ALTER TABLE ...
// DISABLE TRIGGER, DROP TRIGGER, or session_replication_role='replica' - not write through it.
it('audit rows are append-only for the role the application connects as; the stash refuses rewrites but still releases on exit',async()=>{
 const rowId=await startRow(`impersonation-${randomUUID()}`);
 expect((await pool.query('SELECT current_user AS role,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls')).rows)
  .toEqual([{role:'postgres',bypassrls:true}]);
 for(const [text,params] of [["UPDATE admin_audit_log SET action='impersonation_end' WHERE id=$1",[rowId]],
  ['UPDATE admin_audit_log SET created_at=created_at-interval \'1 day\' WHERE id=$1',[rowId]],
  ['DELETE FROM admin_audit_log WHERE id=$1',[rowId]],['TRUNCATE admin_audit_log',[]],
  ["UPDATE admin_impersonation_stash SET expires_at=NOW()+interval '1 day'",[]],['TRUNCATE admin_impersonation_stash',[]]] as const){
  await expect(as('login_role',null,c=>c.query(text,[...params])),text).rejects.toMatchObject(EVIDENCE);
 }
 // end-impersonation deletes the consumed stash so the admin's tokens cannot be restored twice; that DELETE
 // runs on the login role and stays allowed. The impersonation_end row, not the delete, is what ends the delegation.
 const stash=(await pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
  VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[f.u1.id,f.u2.id])).rows[0].stash_id;
 expect((await pool.query('DELETE FROM admin_impersonation_stash WHERE stash_id=$1',[stash])).rowCount).toBe(1);
});
