import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als,type RequestContext} from '@/lib/als';
import {assertControlTx,makeControlPrincipal} from '@/modules/accounting/services/controls/context';
import {withPlatformImportRequest,withPlatformImportTarget,readPlatformImportTarget,type PlatformImportRequestCapability} from '@/lib/auth/platformImportAuthority';
const company='11111111-1111-4111-8111-111111111111';
const target={action:'retain' as const,companyId:company,sourceHash:'a'.repeat(64)};
const query=vi.fn();
const client={query} as unknown as PoolClient;
const store=():RequestContext=>({client,userId:'admin-person',claims:{sub:'admin-person'}});
beforeEach(()=>{query.mockReset();query.mockResolvedValue({rows:[{role:'super_admin',is_active:true,status:'active',suspended_at:null,company_status:'active',company_suspended_at:null}]});});
it('issues human target-bound authority without fabricating a tenant membership or cookie',async()=>{
 const parent=store();
 await withPlatformImportRequest(parent,cap=>withPlatformImportTarget(cap,target,async ctx=>{
  assertControlTx(ctx);expect(ctx.principal).toMatchObject({authMethod:'platform_import',provenance:'human',companyId:company,personId:'admin-person',grantId:null});
  expect(readPlatformImportTarget(ctx)).toEqual(target);expect(Object.isFrozen(readPlatformImportTarget(ctx))).toBe(true);
  expect(als.getStore()?.client).toBe(client);
 }));
 expect(parent.companyId).toBeUndefined();expect(parent.controlPrincipal).toBeUndefined();
});
it('does not allow the ordinary principal constructor to manufacture platform authority',()=>{
 expect(()=>makeControlPrincipal({personId:'admin-person',companyId:company,authMethod:'platform_import'})).toThrow();
});
it('rejects forged and cloned capabilities and capabilities after their request ends',async()=>{
 await expect(withPlatformImportTarget({requestId:'forged'},target,async()=>undefined)).rejects.toThrow();
 let retained!:PlatformImportRequestCapability;
 await withPlatformImportRequest(store(),async cap=>{
  retained=cap;await expect(withPlatformImportTarget({...cap},target,async()=>undefined)).rejects.toThrow();
 });
 await expect(withPlatformImportTarget(retained,target,async()=>undefined)).rejects.toThrow();
});
it('rejects a changed active client or person, nested targets and escaped contexts',async()=>{
 let retained!:Parameters<typeof assertControlTx>[0];
 const parent=store();
 await withPlatformImportRequest(parent,async cap=>{
  const other={...parent,client:{} as PoolClient};
  await expect(als.run(other,()=>withPlatformImportTarget(cap,target,async()=>undefined))).rejects.toThrow();
  await expect(als.run({...parent,userId:'another'},()=>withPlatformImportTarget(cap,target,async()=>undefined))).rejects.toThrow();
  await withPlatformImportTarget(cap,target,async ctx=>{
   retained=ctx;await expect(withPlatformImportTarget(cap,target,async()=>undefined)).rejects.toThrow();
  });
 });
 expect(()=>assertControlTx(retained)).toThrow();expect(()=>readPlatformImportTarget(retained)).toThrow();
});
it.each([
 {role:'user',is_active:true,status:'active'},
 {role:'super_admin',is_active:false,status:'active'},
 {role:'super_admin',is_active:true,status:'active',company_status:'suspended'},
])('rechecks current global/target standing at issuance: %j',async row=>{
 query.mockResolvedValue({rows:[row]});
 await expect(withPlatformImportRequest(store(),cap=>withPlatformImportTarget(cap,target,async()=>undefined))).rejects.toThrow();
});
it('propagates audit and unusable-transaction flags to the outer admin request even after a caught error',async()=>{
 const parent=store();
 await expect(withPlatformImportRequest(parent,async cap=>{
  await expect(withPlatformImportTarget(cap,target,async()=>{als.getStore()!.controlWriteFailed=true;})).rejects.toThrow();
 })).rejects.toThrow();
 expect(parent.controlWriteFailed).toBe(true);
});
it('strictly validates target selectors instead of accepting caller authority fields',async()=>{
 await withPlatformImportRequest(store(),async cap=>{
  await expect(withPlatformImportTarget(cap,{...target,permissions:['write:post']},async()=>undefined)).rejects.toThrow();
  await expect(withPlatformImportTarget(cap,{...target,sourceHash:'bad'},async()=>undefined)).rejects.toThrow();
 });
});
