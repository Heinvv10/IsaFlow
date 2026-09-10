import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als,type RequestContext} from '@/lib/als';
import {assertControlTx,makeControlPrincipal} from '@/modules/accounting/services/controls/context';
import {withPlatformImportRequest,withPlatformImportTarget,readPlatformImportTarget,type PlatformImportRequestCapability} from '@/lib/auth/platformImportAuthority';
const company='11111111-1111-4111-8111-111111111111';
const target={action:'retain' as const,companyId:company,sourceHash:'a'.repeat(64)};
const standing={role:'super_admin',is_active:true,status:'active',suspended_at:null,company_status:'active',company_suspended_at:null};
const query=vi.fn();
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
const client={query} as unknown as PoolClient;
const store=():RequestContext=>({client,userId:'admin-person',claims:{sub:'admin-person'}});
beforeEach(()=>{query.mockReset();query.mockResolvedValue({rows:[{...standing}]});});
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
 {role:'user'}, {is_active:false}, {status:'suspended'}, {suspended_at:new Date('2026-09-10T00:00:00Z')},
 {company_status:'suspended'}, {company_status:'deleted'}, {company_suspended_at:new Date('2026-09-10T00:00:00Z')},
])('rechecks current standing, changing only the invalid field: %j',async patch=>{
 query.mockResolvedValue({rows:[{...standing,...patch}]});
 const handler=vi.fn();
 await expect(withPlatformImportRequest(store(),cap=>withPlatformImportTarget(cap,target,handler))).rejects.toThrow();
 expect(handler).not.toHaveBeenCalled();
});
it('refuses absent authority or target instead of treating no rows as valid standing',async()=>{
 query.mockResolvedValue({rows:[]});const handler=vi.fn();
 await expect(withPlatformImportRequest(store(),cap=>withPlatformImportTarget(cap,target,handler))).rejects.toThrow();
 expect(handler).not.toHaveBeenCalled();
});
it('propagates a required control audit failure even after a caught error',async()=>{
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

it('expires a child context while its parent stays active and permits a fresh sequential target',async()=>{
 let first!:Parameters<typeof assertControlTx>[0];
 await withPlatformImportRequest(store(),async cap=>{
  await withPlatformImportTarget(cap,target,async ctx=>{first=ctx;});
  expect(()=>assertControlTx(first)).toThrow();expect(()=>readPlatformImportTarget(first)).toThrow();
  await withPlatformImportTarget(cap,{...target,sourceHash:'b'.repeat(64)},async second=>{
   assertControlTx(second);expect(second).not.toBe(first);
   expect(()=>assertControlTx(first)).toThrow();expect(()=>readPlatformImportTarget(first)).toThrow();
   expect(readPlatformImportTarget(second)).toEqual({...target,sourceHash:'b'.repeat(64)});
  });
 });
});
it('revokes an unawaited child when the outer request ends, including deferred SQL',async()=>{
 const entered=barrier(),resume=barrier();let child:Promise<unknown>|undefined;let checked=false;
 try{
  await withPlatformImportRequest(store(),async cap=>{
   child=withPlatformImportTarget(cap,target,async ctx=>{
    const deferred=ctx.sql`SELECT 1`;
    entered.release();await resume.promise;
    expect(()=>assertControlTx(ctx)).toThrow();expect(()=>readPlatformImportTarget(ctx)).toThrow();
    const calls=query.mock.calls.length;
    await expect(deferred).rejects.toThrow();expect(query.mock.calls.length).toBe(calls);checked=true;
   });
   // Attach a rejection handler immediately: expiration may make the wrapper reject too.
   void child.catch(()=>undefined);await entered.promise;
  });
 }finally{resume.release();}
 if(child)await child.catch(error=>{
  // Assertion errors must never be mistaken for the expected lifetime rejection.
  if(error instanceof Error&&error.name==='AssertionError')throw error;
 });
 expect(checked).toBe(true);
});
it('detaches and freezes the selected target before the first asynchronous issuance step',async()=>{
 const entered=barrier(),resume=barrier();
 query.mockImplementationOnce(async()=>{entered.release();await resume.promise;return{rows:[{...standing}]};});
 const mutable={...target};let issued:Promise<unknown>|undefined;
 await withPlatformImportRequest(store(),async cap=>{
  issued=withPlatformImportTarget(cap,mutable,async ctx=>{
   expect(ctx.principal.companyId).toBe(company);
   expect(readPlatformImportTarget(ctx)).toEqual(target);
   expect(readPlatformImportTarget(ctx)).not.toBe(mutable);
   expect(Object.isFrozen(readPlatformImportTarget(ctx))).toBe(true);
  });
  void issued.catch(()=>undefined);
  try{await entered.promise;mutable.companyId='22222222-2222-4222-8222-222222222222';mutable.sourceHash='b'.repeat(64);Object.assign(mutable,{action:'execute',importId:company});}
  finally{resume.release();}
  await issued;
 });
});
it.each(['controlWriteFailed','criticalAuditFailed','txUnusable'] as const)(
 'retains %s on the parent when the target throws and its caller catches',async flag=>{
  const parent=store();
  await expect(withPlatformImportRequest(parent,async cap=>{
   await expect(withPlatformImportTarget(cap,target,async()=>{
    const child=als.getStore()!;
    if(flag==='txUnusable')child.txUnusable='rollback failed';else child[flag]=true;
    throw new Error('caught child failure');
   })).rejects.toThrow();
   expect(parent[flag]).toBe(flag==='txUnusable'?'rollback failed':true);
  })).rejects.toThrow();
 });
it.each(['controlWriteFailed','criticalAuditFailed','txUnusable'] as const)(
 'does not issue authority from a parent already marked %s',async flag=>{
  const parent=store();if(flag==='txUnusable')parent.txUnusable='rollback failed';else parent[flag]=true;
  const handler=vi.fn();
  await expect(withPlatformImportRequest(parent,cap=>withPlatformImportTarget(cap,target,handler))).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
 });
it('rejects nested request registration without invalidating the original request',async()=>{
 const parent=store();
 await withPlatformImportRequest(parent,async cap=>{
  await expect(withPlatformImportRequest(parent,async()=>undefined)).rejects.toThrow();
  await withPlatformImportTarget(cap,target,async ctx=>{assertControlTx(ctx);});
 });
});
it('rejects a request whose claims subject differs from its authenticated person',async()=>{
 const parent=store();parent.claims={sub:'another-person'};const handler=vi.fn();
 await expect(withPlatformImportRequest(parent,cap=>withPlatformImportTarget(cap,target,handler))).rejects.toThrow();
 expect(handler).not.toHaveBeenCalled();
});
it.each(['client','userId'] as const)('rejects an in-place change to the registered %s',async field=>{
 const parent=store();
 await withPlatformImportRequest(parent,async cap=>{
  if(field==='client')parent.client={} as PoolClient;else parent.userId='another-person';
  try{await expect(withPlatformImportTarget(cap,target,async()=>undefined)).rejects.toThrow();}
  finally{parent.client=client;parent.userId='admin-person';}
 });
});
it.each([
 {action:'prepare' as const,companyId:company,sourceId:'33333333-3333-4333-8333-333333333333'},
 ...(['request','execute','read'] as const).map(action=>({action,companyId:company,importId:'44444444-4444-4444-8444-444444444444'})),
])('issues only the exact selected %s target',async selected=>{
 await withPlatformImportRequest(store(),cap=>withPlatformImportTarget(cap,selected,async ctx=>{
  expect(readPlatformImportTarget(ctx)).toEqual(selected);assertControlTx(ctx);
 }));
});
it.each([
 {...target,action:'approve'}, {...target,companyId:'invalid'}, {...target,sourceHash:undefined},
 {action:'prepare',companyId:company,sourceId:'invalid'}, {action:'prepare',companyId:company},
 {action:'execute',companyId:company,importId:'invalid'}, {action:'execute',companyId:company},
 {action:'read',companyId:company,sourceId:'33333333-3333-4333-8333-333333333333'},
 {...target,importId:'44444444-4444-4444-8444-444444444444'},
 {...target,personId:'another-person'}, {...target,grantId:'44444444-4444-4444-8444-444444444444'},
 {...target,role:'admin'},
])('refuses malformed or authority-bearing target %j',async selected=>{
 const handler=vi.fn();
 await withPlatformImportRequest(store(),async cap=>{
  await expect(withPlatformImportTarget(cap,selected,handler)).rejects.toThrow();
 });
 expect(handler).not.toHaveBeenCalled();
});
it('restores parent identity and clears target GUC after a thrown callback',async()=>{
 const parent=store();
 await withPlatformImportRequest(parent,async cap=>{
  await expect(withPlatformImportTarget(cap,target,async()=>{throw new Error('target failure');})).rejects.toThrow('target failure');
  expect(als.getStore()).toBe(parent);expect(parent.companyId).toBeUndefined();
  expect(parent.controlPrincipal).toBeUndefined();expect(parent.client).toBe(client);expect(parent.userId).toBe('admin-person');
 });
 const bindings=query.mock.calls.filter(([statement])=>typeof statement==='string'&&statement.includes('set_config')&&statement.includes('app.current_company_id'));
 expect(bindings.some(([,values])=>Array.isArray(values)&&values.includes(company))).toBe(true);
 const finalValues=bindings.at(-1)?.[1];
 expect(Array.isArray(finalValues)&&finalValues.includes('')).toBe(true);
});
