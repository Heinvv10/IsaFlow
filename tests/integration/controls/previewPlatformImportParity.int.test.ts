import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {assertSuppliedApprovalExecutable} from '@/modules/accounting/services/controls/approvalExecutionService';

/**
 * `assertSuppliedApprovalExecutable` exists so a dry run accepts an approval
 * EXACTLY when the live call (`executeControlledOperation`) would. The live
 * path calls `assertPlatformImportOperation(ctx, ref, 'execute')` first,
 * before anything else — including any lock. The preview did not, so a
 * platform-import principal previewing a non-historical-import operation
 * (year-end close, fiscal-period close) reached the approval-authorities
 * lookup and the company policy advisory lock instead of being refused for
 * exactly what the live call refuses it for.
 */
describe('preview/live platform-import confinement parity: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});

 it('refuses a platform-import preview of a non-historical-import operation with the confinement error, before any lock or approval lookup',async()=>{
  const ref={entityType:'fiscal_year',entityId:'2023',operation:'year.close'} as const;
  // A random, never-inserted approval id: if the guard fires first, no SQL
  // referencing it ever runs — approvalAuthorities/lockApproval is never
  // reached, so their "not found"-shaped refusal never surfaces either.
  await expect(h.maker({action:'execute',importId:randomUUID()},ctx=>
   assertSuppliedApprovalExecutable(ctx,ref,randomUUID())))
   .rejects.toThrow('Platform authority is restricted to historical imports');
 });

 it('leaves a non-platform-import preview unchanged (the guard stays a no-op)',async()=>{
  const ref={entityType:'fiscal_year',entityId:'2023',operation:'year.close'} as const;
  // An ordinary tenant member reaches the real approval-authorities lookup,
  // which refuses on the missing approval — never the confinement error,
  // because the guard is a no-op for a non-platform-import principal.
  await expect(h.member(h.f.u2.id,ctx=>assertSuppliedApprovalExecutable(ctx,ref,randomUUID())))
   .rejects.toThrow('Approval authorities unavailable');
 });
});
