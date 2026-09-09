import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx,makeControlPrincipal} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {claimAuditJob,claimAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {openProtectedChange,protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const oauthApp=randomUUID(),oauthGrant=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['read:reports'] WHERE company_id=$1 AND user_id=$2 AND id=$3",
  [fixture.companyA,fixture.u1.id,fixture.u1.tokens[0]!.id]);
 await pool.query(`INSERT INTO oauth_apps(id,name,redirect_uris,client_id,client_secret_hash,client_secret_prefix,owner_user_id)
  VALUES($1,'Synthetic job delegation',$2,$3,$4,'synthetic',$5)`,
 [oauthApp,['https://forensic.invalid/callback'],oauthApp,`synthetic-${oauthApp}`,fixture.u1.id]);
 await pool.query(`INSERT INTO oauth_authorisations(id,oauth_app_id,user_id,company_id,scopes,access_token_expires_at,refresh_token_hash,refresh_token_prefix,refresh_token_expires_at)
  VALUES($1,$2,$3,$4,ARRAY['read:reports'],clock_timestamp()+interval '1 day',$5,'synthetic',clock_timestamp()+interval '1 day')`,
 [oauthGrant,oauthApp,fixture.u1.id,fixture.companyA,`synthetic-${oauthGrant}`]);
});
afterAll(()=>pool.end());
async function actor<T>(mode:'cookie'|'pat'|'oauth'|AuditJobLease,fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const store={client,userId:user.id,companyId:user.companyId,claims};
  const value=typeof mode==='object'?await withControlJobRequest(store,mode,fn):await withControlRequest(store,
   {personId:user.id,companyId:user.companyId,authMethod:mode,...(mode==='pat'?{connectionId:user.tokens[0]!.id,grantId:user.tokens[0]!.id,grantedScopes:['read:reports']}:
    mode==='oauth'?{connectionId:oauthGrant,grantId:oauthGrant,grantedScopes:['read:reports']}: {})},fn);
  await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function leased(mode:'cookie'|'pat'|'oauth'='cookie'){
 const job=await actor(mode,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const lease=await actor(mode,()=>claimAuditJob(requireControlTx(),job.id));expect(lease).not.toBeNull();return lease!;
}
it('issues real job provenance with saved read-only source authority, never an invented cookie',async()=>{
 const lease=await leased();
 await actor(lease,async()=>{
  const ctx=requireControlTx();expect(ctx.principal.authMethod).toBe('job');expect(ctx.principal.provenance).toBe('job');
  expect(ctx.principal.delegatedByPersonId).toBe(fixture.u1.id);
  await assertEffectivePermission(ctx,'read:reports');
  await expect(assertEffectivePermission(ctx,'write:post')).rejects.toThrow(/permissions/);
  await expect(assertEffectivePermission(ctx,'read:payroll')).rejects.toThrow(/permissions/);
  const rows=await ctx.sql`SELECT id FROM gl_accounts WHERE company_id=${fixture.companyA}::uuid`;
  expect(Array.isArray(rows)).toBe(true);
 });
 expect(()=>makeControlPrincipal({personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'job'})).toThrow();
});
it('refuses copied lease authority and another person or tenant before invoking worker code',async()=>{
 const lease=await leased();let called=false;const work=async()=>{called=true;};
 await expect(actor({...lease},work)).rejects.toThrow(/lease/i);
 for(const person of ['u2','u3'] as const)await expect(actor(lease,work,person)).rejects.toThrow(/lease/i);
 expect(called).toBe(false);
});
it('rechecks the original saved PAT after enqueue and refuses revoked grants before work',async()=>{
 const lease=await leased('pat');await actor(lease,()=>assertEffectivePermission(requireControlTx(),'read:reports'));
 await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE company_id=$1 AND user_id=$2 AND id=$3',
  [fixture.companyA,fixture.u1.id,fixture.u1.tokens[0]!.id]);
 let called=false;
 await expect(actor(lease,async()=>{called=true;})).rejects.toThrow(/permissions/);expect(called).toBe(false);
});
it('refuses an expired persisted lease even when the in-process capability was genuinely issued',async()=>{
 const lease=await leased();
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[fixture.companyA,lease.jobId]);
 let called=false;await expect(actor(lease,async()=>{called=true;})).rejects.toThrow(/lease/i);expect(called).toBe(false);
});
it('rechecks original OAuth expiry and narrowed scopes instead of using current cookie authority',async()=>{
 const lease=await leased('oauth');await actor(lease,()=>assertEffectivePermission(requireControlTx(),'read:reports'));
 await pool.query("UPDATE oauth_authorisations SET scopes=ARRAY[]::text[] WHERE company_id=$1 AND user_id=$2 AND id=$3",[fixture.companyA,fixture.u1.id,oauthGrant]);
 await expect(actor(lease,async()=>undefined)).rejects.toThrow(/permissions/);
 await pool.query("UPDATE oauth_authorisations SET scopes=ARRAY['read:reports'],access_token_expires_at=NULL WHERE company_id=$1 AND user_id=$2 AND id=$3",[fixture.companyA,fixture.u1.id,oauthGrant]);
 await expect(actor(lease,async()=>undefined)).rejects.toThrow(/permissions/);
});
it('refuses a now inactive delegating person before invoking worker code',async()=>{
 const lease=await leased();let called=false;
 await pool.query('UPDATE users u SET is_active=false FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2',[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(lease,async()=>{called=true;})).rejects.toThrow(/permissions/);expect(called).toBe(false);}
 finally{await pool.query('UPDATE users u SET is_active=true FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2',[fixture.companyA,fixture.u1.id]);}
});
it('checks the signed delegation expiry independently of an otherwise live queue lease',async()=>{
 const lease=await leased();
 const row=(await pool.query('SELECT protected_request FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,lease.jobId])).rows[0];
 const saved=openProtectedChange(row.protected_request).after!;
 const expired=protectChangeValues('audit_job',null,{...saved,delegationExpiresAt:'2000-01-01T00:00:00.000Z'}).protectedPayload;
 await pool.query('UPDATE control_audit_job_intents SET protected_request=$1::jsonb WHERE company_id=$2 AND id=$3',[JSON.stringify(expired),fixture.companyA,lease.jobId]);
 let called=false;await expect(actor(lease,async()=>{called=true;})).rejects.toThrow(/delegation expired/);expect(called).toBe(false);
});
it('does not admit a capability whose claim was rolled back',async()=>{
 const job=await actor('cookie',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 let lease:AuditJobLease|null=null;
 await expect(actor('cookie',async()=>{lease=await claimAuditJob(requireControlTx(),job.id);throw new Error('Synthetic rollback');})).rejects.toThrow('Synthetic rollback');
 expect(lease).not.toBeNull();await expect(actor(lease!,async()=>undefined)).rejects.toThrow(/lease/);
});
async function coldClaim(jobId:string,person:'u1'|'u3'='u1',catchPermissionFailure=false){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  let lease:AuditJobLease|null=null;
  try{lease=await claimAuditJobForWorker({client,userId:user.id,companyId:user.companyId,claims},jobId);}
  catch(error){if(!catchPermissionFailure)throw error;expect(error).toHaveProperty('message','Current permissions do not allow this operation.');}
  await client.query('COMMIT');return lease;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
it('claims a persisted queued delegation without an authenticated request or synthetic cookie',async()=>{
 const job=await actor('cookie',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const lease=await coldClaim(job.id);expect(lease).not.toBeNull();
 await actor(lease!,async()=>{expect(requireControlTx().principal.provenance).toBe('job');});
 expect(await coldClaim(job.id)).toBeNull();
});
it('refuses foreign cold claims and leaves the actual queued job untouched',async()=>{
 const job=await actor('cookie',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await expect(coldClaim(job.id,'u3')).rejects.toThrow(/Audit job unavailable/);
 const row=(await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0];
 expect(row).toMatchObject({state:'queued',attempts:0});
});
it('rechecks original current authority before committing a cold claim',async()=>{
 const job=await actor('cookie',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await pool.query('UPDATE users u SET is_active=false FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2',[fixture.companyA,fixture.u1.id]);
 try{await expect(coldClaim(job.id)).rejects.toThrow(/permissions/);expect(await coldClaim(job.id,'u1',true)).toBeNull();}
 finally{await pool.query('UPDATE users u SET is_active=true FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2',[fixture.companyA,fixture.u1.id]);}
 const row=(await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0];
 expect(row).toMatchObject({state:'queued',attempts:0});
});
it('serializes cold claims and fences an expired worker after takeover',async()=>{
 const job=await actor('cookie',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const claims=await Promise.all([coldClaim(job.id),coldClaim(job.id)]),leases=claims.filter(value=>value!==null);
 expect(leases).toHaveLength(1);
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[fixture.companyA,job.id]);
 const next=await coldClaim(job.id);expect(next!.generation).toBe(leases[0]!.generation+1);
 await expect(actor(leases[0]!,async()=>undefined)).rejects.toThrow(/lease/);
 await actor(next!,async()=>{expect(requireControlTx().principal.provenance).toBe('job');});
});
