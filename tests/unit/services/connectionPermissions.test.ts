import {expect,it,vi,beforeEach} from 'vitest';
const mock=vi.hoisted(()=>({resolve:vi.fn(),require:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({resolveEffectivePermissions:mock.resolve}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mock.require}));
import {getConnectionPermissions} from '@/modules/accounting/services/controls/connectionPermissionsService';
import {connectionPermissionsTool} from '@/lib/mcp/tools/forensicAccess';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const ctx={principal:{companyId:'company',personId:'person',authMethod:'pat',connectionId:'opaque',grantId:'grant',actingFirmId:null,grantedScopes:['secret-unused']}} as ControlTx;
beforeEach(()=>{vi.clearAllMocks();mock.require.mockReturnValue(ctx);mock.resolve.mockResolvedValue({companyId:'company',personId:'person',role:'viewer',permissions:['read:reports','read:bank-tx'],denied:{'write:accounts':'ENTITY_REQUIRED','read:access':'ROLE_CEILING'}});});
it('preserves policy reasons and separates conditional from executable rights',async()=>{
 const value=await getConnectionPermissions(ctx);expect(mock.resolve).toHaveBeenCalledWith(ctx);expect(value.permissions).toEqual(['read:bank-tx','read:reports']);
 expect(value.denied).toEqual([{permission:'read:access',reason:'ROLE_CEILING',conditional:false},{permission:'write:accounts',reason:'ENTITY_REQUIRED',conditional:true}]);
 expect(value.connectionId).toBe('opaque');expect(JSON.stringify(value)).not.toContain('secret-unused');
});
it('delegates active authentication refusal without converting it to a successful empty list',async()=>{mock.resolve.mockRejectedValue(new Error('revoked'));await expect(getConnectionPermissions(ctx)).rejects.toThrow('revoked');});
it('strict empty MCP input rejects all caller authority fields without reading policy',async()=>{
 for(const field of ['person_id','company_id','role','scopes']){const result=await connectionPermissionsTool.handler({[field]:'injected'},{} as never);expect(result.isError).toBe(true);}
 expect(mock.resolve).not.toHaveBeenCalled();expect(connectionPermissionsTool.scope).toBeNull();
});
it('uses issued context for the actual adapter response',async()=>{const result=await connectionPermissionsTool.handler({},{} as never);expect(result.isError).toBeUndefined();expect(mock.resolve).toHaveBeenCalledWith(ctx);});
