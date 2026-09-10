import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportAuthorityFixture} from './platformImportAuthorityFixture';
describe('platform import authority through actual admin middleware and PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof platformImportAuthorityFixture>>;
 beforeAll(async()=>{f=await platformImportAuthorityFixture();},30000);
 afterAll(async()=>{await f?.close();});
 it('preserves the actual default admin route for an active administrator with no memberships',async()=>{
  const rows=await f.pool.query('SELECT company_id FROM company_users WHERE user_id=$1',[f.admin]);expect(rows.rows).toHaveLength(0);
  const response=await f.request('identity',{defaultRoute:true});expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);expect(await f.witness()).toBe('Authority witness');
 });
 it('issues an exact human target context on the same real privileged connection and restores its GUC',async()=>{
  const response=await f.request();expect(response.status).toBe(200);expect(response.body.caught).toBe(false);
  const {result,after,parentRestored}=response.body;
  expect(result.active).toMatchObject({role:'platform_admin',company:f.f.companyA,person:f.admin});
  expect(result.before.role).toBe('platform_admin');expect(result.active.pid).toBe(result.before.pid);
  expect(after.pid).toBe(result.before.pid);expect(after.company).toBe('');expect(parentRestored).toBe(true);expect(result.sameClient).toBe(true);
  expect(result.principal).toMatchObject({personId:f.admin,companyId:f.f.companyA,authMethod:'platform_import',provenance:'human',grantId:null,grantedScopes:null});
  expect(result.target).toEqual({action:'retain',companyId:f.f.companyA,sourceHash:'a'.repeat(64)});
 });
 it('allows another active company selector because platform administrators are global',async()=>{
  const response=await f.request('identity',{companyId:f.f.companyB});expect(response.body.caught).toBe(false);
  expect(response.body.result.active.company).toBe(f.f.companyB);expect(response.body.after.company).toBe('');
 });
 it('expires the saved capability and control context when the actual HTTP request ends',async()=>{
  await f.request();const saved=f.retained();expect(saved.capability).toBeDefined();expect(saved.context).toBeDefined();
  const {withPlatformImportTarget,readPlatformImportTarget}=await import('@/lib/auth/platformImportAuthority');
  const {assertControlTx}=await import('@/modules/accounting/services/controls/context');
  await expect(withPlatformImportTarget(saved.capability!,{action:'retain',companyId:f.f.companyA,sourceHash:'a'.repeat(64)},async()=>undefined)).rejects.toThrow();
  expect(()=>assertControlTx(saved.context!)).toThrow();expect(()=>readPlatformImportTarget(saved.context!)).toThrow();
 });
 it.each([{anonymous:true},{person:'member'},{csrf:false},{adminHeader:false}])('rejects unauthenticated/member/header/CSRF bypass %j',async options=>{
  const response=await f.request('identity',{...options,...(options.person?{person:f.f.u1.id}:{})});
  expect(response.status).toBe(options.anonymous?401:403);expect(await f.witness()).toBe('Authority witness');
 });
 it('rechecks global role inside the target transaction after the actual middleware gate',async()=>{
  try{
   const response=await f.request('revoke_after_gate');expect(response.status).toBe(200);expect(response.body.caught).toBe(true);
   expect(response.body.result.message).toContain('Current platform import authority unavailable');expect(await f.witness()).toBe('Authority witness');
   expect((await f.request()).status).toBe(403);
  }finally{await f.pool.query("UPDATE users SET role='super_admin' WHERE id=$1",[f.admin]);}
 });
 it('refuses inactive global administrators at the actual middleware gate',async()=>{
  try{await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[f.admin]);expect((await f.request()).status).toBe(403);}
  finally{await f.pool.query('UPDATE users SET is_active=true WHERE id=$1',[f.admin]);}
 });
 it.each(['suspended','deleted'])('refuses %s target standing before issuing a context',async status=>{
  const original=(await f.pool.query('SELECT status FROM companies WHERE id=$1',[f.f.companyA])).rows[0].status;
  try{
   await f.pool.query('UPDATE companies SET status=$1 WHERE id=$2',[status,f.f.companyA]);
   const response=await f.request();expect(response.body.caught).toBe(true);expect(response.body.result.message).toContain('Current platform import authority unavailable');
  }finally{await f.pool.query('UPDATE companies SET status=$1 WHERE id=$2',[original,f.f.companyA]);}
 });
 it('refuses a target suspension timestamp and an absent target',async()=>{
  try{
   await f.pool.query('UPDATE companies SET suspended_at=clock_timestamp() WHERE id=$1',[f.f.companyA]);
   expect((await f.request()).body.caught).toBe(true);
  }finally{await f.pool.query('UPDATE companies SET suspended_at=NULL WHERE id=$1',[f.f.companyA]);}
  const absent=await f.request('identity',{companyId:randomUUID()});expect(absent.body.caught).toBe(true);
 });
 it('restores the real transaction-local company after an ordinary caught target error',async()=>{
  const response=await f.request('restore');expect(response.status).toBe(200);expect(response.body.caught).toBe(true);
  expect(response.body.result.message).toBe('Synthetic ordinary target error');expect(response.body.after.company).toBe('');
  expect(response.body.parentRestored).toBe(true);expect(await f.witness()).toBe('Authority witness');
 });
 it('serializes overlapping same-person target requests before downstream authority row-lock upgrades',async()=>{
  const requests=[f.request('lock_order'),f.request('lock_order')];
  try{
   expect(['both_targets','serialized_authority_wait']).toContain(await f.waitForLockOverlap());
   f.releaseLock();
   const responses=await Promise.all(requests);expect(f.lockErrors).toEqual([]);
   for(const response of responses){expect(response.status).toBe(200);expect(response.body.caught,response.body.result?.message).toBe(false);}
  }finally{f.releaseLock();await Promise.allSettled(requests);}
 },15000);
 it('rolls back an already-written detached child before the outer request can commit',async()=>{
  try{
   const response=await f.request('escaped');expect(response.body.escaped).toBe(true);
   expect(await f.witness()).toBe('Authority witness');
  }finally{
   expect(await f.finishEscaped()).toBe(true);
   await f.pool.query("UPDATE customers SET name='Authority witness' WHERE company_id=$1 AND id=$2",[f.f.companyA,f.customer]);
  }
 });
 it.each(['controlWriteFailed','criticalAuditFailed','txUnusable'] as const)('rolls back the real mutation after a caught %s child failure',async flag=>{
  const before=await f.witness();const response=await f.request(flag);
  expect(response.body.caught).toBe(true);expect(response.body.flags[flag]).toBe(true);
  // HTTP data is sent by the fixture handler before outer middleware finishes. request() awaits that completion.
  expect(await f.witness()).toBe(before);expect(before).toBe('Authority witness');
 });
});
