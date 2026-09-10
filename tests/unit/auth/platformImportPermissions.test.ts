import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withPlatformImportRequest,withPlatformImportTarget} from '@/lib/auth/platformImportAuthority';
import {assertEffectivePermission,resolveEffectivePermissions} from '@/lib/auth/effectivePermissions';
const companyId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const query=vi.fn(),client={query} as unknown as PoolClient;
const standing={role:'super_admin',is_active:true,status:'active',suspended_at:null,company_status:'active',company_suspended_at:null};
beforeEach(()=>{query.mockReset();query.mockResolvedValue({rows:[standing]});});
function run<T>(action:'retain'|'prepare'|'request'|'execute'|'read',fn:Parameters<typeof withPlatformImportTarget<T>>[2]){
 const target=action==='retain'?{action,companyId,sourceHash:'a'.repeat(64)}:action==='prepare'?{action,companyId,sourceId:id}:{action,companyId,importId:id};
 return withPlatformImportRequest({client,userId:'maker',claims:{sub:'maker'}},cap=>withPlatformImportTarget(cap,target,fn));
}
it.each(['retain','prepare','request','execute','read'] as const)('never resolves %s authority as a tenant admin or grants ordinary financial writes',async action=>{
 await run(action,async ctx=>{
  const result=await resolveEffectivePermissions(ctx);expect(result.role).toBe('platform_import');
  for(const permission of ['write:invoices','write:journals','write:payments','write:payroll','write:beneficiaries','write:release','write:accounts']){
   expect(result.permissions).not.toContain(permission);
   await expect(assertEffectivePermission(ctx,permission)).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
  }
 });
});
const tenantReads=['read:reports','read:invoices','read:accounts','read:contacts'];
it.each(['retain','prepare','request','execute','read'] as const)('never grants %s a generic tenant read',async action=>{
 await run(action,async ctx=>{
  const result=await resolveEffectivePermissions(ctx);
  for(const permission of tenantReads){
   expect(result.permissions).not.toContain(permission);
   await expect(assertEffectivePermission(ctx,permission)).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
  }
 });
});
it.each([
 {action:'retain' as const,allow:['write:imports'],deny:['read:imports','write:post','write:approvals']},
 {action:'prepare' as const,allow:['write:imports','read:imports'],deny:['write:post','write:approvals']},
 {action:'request' as const,allow:['write:imports','write:approvals','read:imports'],deny:['write:post']},
 {action:'execute' as const,allow:['write:imports','write:post','read:imports'],deny:['write:approvals']},
 {action:'read' as const,allow:['read:imports'],deny:['write:imports','write:post','write:approvals']},
])('uses a fixed action ceiling for $action',async({action,allow,deny})=>{
 await run(action,async ctx=>{
  for(const permission of allow)await expect(assertEffectivePermission(ctx,permission)).resolves.toBeUndefined();
  for(const permission of deny)await expect(assertEffectivePermission(ctx,permission)).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
 });
});
it('rechecks global standing for each permission assertion and resolution',async()=>{
 await run('execute',async ctx=>{
  await expect(assertEffectivePermission(ctx,'write:post')).resolves.toBeUndefined();
  query.mockResolvedValue({rows:[{...standing,role:'viewer'}]});
  await expect(assertEffectivePermission(ctx,'write:post')).rejects.toThrow();
  await expect(resolveEffectivePermissions(ctx)).rejects.toThrow();
 });
});
