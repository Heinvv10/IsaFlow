import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({target:vi.fn(),assert:vi.fn(),historical:vi.fn(),ar:vi.fn(),gl:vi.fn()}));
vi.mock('@/lib/auth/platformImportAuthority',async original=>({...await original<typeof import('@/lib/auth/platformImportAuthority')>(),readPlatformImportTarget:mocks.target}));
vi.mock('@/modules/accounting/services/controls/context',async original=>({...await original<typeof import('@/modules/accounting/services/controls/context')>(),assertControlTx:mocks.assert}));
vi.mock('@/modules/accounting/services/controls/historicalImportMaterializer',()=>({materializeHistoricalImportOperation:mocks.historical}));
vi.mock('@/modules/accounting/services/controls/arOperationMaterializer',()=>({materializeArOperation:mocks.ar}));
vi.mock('@/modules/accounting/services/controls/glOperationMaterializer',()=>({materializeGlOperation:mocks.gl}));
import {materializeOperation} from '@/modules/accounting/services/controls/operationMaterializer';
const companyId='11111111-1111-4111-8111-111111111111',importId='22222222-2222-4222-8222-222222222222',other='44444444-4444-4444-8444-444444444444';
const ctx={principal:{companyId,personId:'maker',authMethod:'platform_import',provenance:'human',connectionId:null,grantId:null,
 actingFirmId:null,delegatedByPersonId:null,grantedScopes:null,requestId:'request',operationId:'operation'},sql:vi.fn()} as unknown as ControlTx;
const imported:OperationRef={entityType:'historical_import',entityId:importId,operation:'historical_import.post'};
beforeEach(()=>{vi.resetAllMocks();mocks.target.mockReturnValue({action:'execute',companyId,importId});mocks.historical.mockResolvedValue({binding:{amount:'1150',currency:'ZAR'}});});
it.each([
 [{entityType:'customer_invoice',entityId:importId,operation:'customer_invoice.post'},/restricted to historical imports/],
 [{entityType:'journal_entry',entityId:importId,operation:'journal.post'},/restricted to historical imports/],
 [{...imported,entityId:other},/Platform import identity differs/],
] as const)('refuses a platform principal before any materializer runs: %o',async(ref,message)=>{
 await expect(materializeOperation(ctx,ref as OperationRef)).rejects.toThrow(message);
 expect(mocks.historical).not.toHaveBeenCalled();expect(mocks.ar).not.toHaveBeenCalled();expect(mocks.gl).not.toHaveBeenCalled();
});
it('materializes only the selected historical import for a platform principal',async()=>{
 await expect(materializeOperation(ctx,imported)).resolves.toEqual({binding:{amount:'1150',currency:'ZAR'}});
 expect(mocks.historical).toHaveBeenCalledWith(ctx,imported);
 mocks.target.mockReturnValue({action:'retain',companyId,sourceHash:'a'.repeat(64)});
 await expect(materializeOperation(ctx,imported)).rejects.toThrow(/retention/);expect(mocks.historical).toHaveBeenCalledTimes(1);
});
