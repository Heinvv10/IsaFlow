import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({target:vi.fn(),assert:vi.fn()}));
vi.mock('@/lib/auth/platformImportAuthority',()=>({readPlatformImportTarget:mocks.target}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
import {assertPlatformImportOperation,assertPlatformImportSourceRead,assertPlatformImportSourceWrite} from '@/modules/accounting/services/controls/platformImportConfinement';
const companyId='11111111-1111-4111-8111-111111111111',importId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333';
const sql=vi.fn(),ctx={principal:{companyId,personId:'maker',authMethod:'platform_import'},sql} as unknown as ControlTx;
const ref={entityType:'historical_import',entityId:importId,operation:'historical_import.post' as const};
beforeEach(()=>{vi.resetAllMocks();mocks.target.mockReturnValue({action:'execute',companyId,importId});sql.mockResolvedValue([{source_id:sourceId,requester_person_id:'maker',requester_auth_method:'platform_import'}]);});
it('allows only the selected import and required action at executing and requesting boundaries',async()=>{
 await expect(assertPlatformImportOperation(ctx,ref,'execute')).resolves.toBeUndefined();
 await expect(assertPlatformImportOperation(ctx,ref,'request')).rejects.toThrow();
 await expect(assertPlatformImportOperation(ctx,{...ref,entityId:sourceId},'execute')).rejects.toThrow();
 mocks.target.mockReturnValue({action:'request',companyId,importId});
 await expect(assertPlatformImportOperation(ctx,ref,'request')).resolves.toBeUndefined();
 await expect(assertPlatformImportOperation(ctx,ref,'execute')).rejects.toThrow();
});
it.each(['journal.post','customer_invoice.post','supplier_invoice.post','payroll_run.post','beneficiary.propose'] as const)('refuses ordinary operation %s regardless of coarse permissions',async operation=>{
 await expect(assertPlatformImportOperation(ctx,{...ref,operation},'execute')).rejects.toThrow();
});
it('permits preparation to materialize only the import created from its selected source and maker',async()=>{
 mocks.target.mockReturnValue({action:'prepare',companyId,sourceId});
 await expect(assertPlatformImportOperation(ctx,ref,'materialize')).resolves.toBeUndefined();
 for(const row of [{source_id:importId,requester_person_id:'maker',requester_auth_method:'platform_import'},
  {source_id:sourceId,requester_person_id:'other',requester_auth_method:'platform_import'},
  {source_id:sourceId,requester_person_id:'maker',requester_auth_method:'cookie'}]){
  sql.mockResolvedValueOnce([row]);await expect(assertPlatformImportOperation(ctx,ref,'materialize')).rejects.toThrow();
 }
 await expect(assertPlatformImportOperation(ctx,ref,'request')).rejects.toThrow();
});
it('reads only the selected source or the source of the selected persisted import',async()=>{
 await expect(assertPlatformImportSourceRead(ctx,sourceId)).resolves.toBeUndefined();
 await expect(assertPlatformImportSourceRead(ctx,importId)).rejects.toThrow();
 mocks.target.mockReturnValue({action:'prepare',companyId,sourceId});
 await expect(assertPlatformImportSourceRead(ctx,sourceId)).resolves.toBeUndefined();
 await expect(assertPlatformImportSourceRead(ctx,importId)).rejects.toThrow();
});
it('binds retained source authority to actual submitted bytes before any insertion',()=>{
 const bytes=Buffer.from('exact retained source'),sourceHash=createHash('sha256').update(bytes).digest('hex');
 mocks.target.mockReturnValue({action:'retain',companyId,sourceHash});
 expect(()=>assertPlatformImportSourceWrite(ctx,bytes)).not.toThrow();
 expect(()=>assertPlatformImportSourceWrite(ctx,Buffer.from('replacement'))).toThrow();
 mocks.target.mockReturnValue({action:'prepare',companyId,sourceId});expect(()=>assertPlatformImportSourceWrite(ctx,bytes)).toThrow();
});
it('refuses cross-company target metadata and unknown import associations',async()=>{
 mocks.target.mockReturnValue({action:'execute',companyId:sourceId,importId});await expect(assertPlatformImportOperation(ctx,ref,'execute')).rejects.toThrow();
 mocks.target.mockReturnValue({action:'execute',companyId,importId});sql.mockResolvedValue([]);
 await expect(assertPlatformImportSourceRead(ctx,sourceId)).rejects.toThrow();
});
