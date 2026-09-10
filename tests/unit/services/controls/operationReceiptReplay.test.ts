import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({permission:vi.fn(),execute:vi.fn(async()=>({verified:true})),sql:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/operationMaterializer',()=>({canonicalOperationRef:(ref:unknown)=>ref}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:mocks.execute}));
import {replayKnownOperationEffect} from '@/modules/accounting/services/controls/operationReceiptReplay';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const ctx={principal:{companyId:'company'},sql:mocks.sql} as unknown as ControlTx;
const ref={entityType:'bank_transfer_intent',entityId:'11111111-1111-1111-1111-111111111111',operation:'bank_transfer.post' as const};
const effect='22222222-2222-2222-2222-222222222222';
beforeEach(()=>{vi.clearAllMocks();});
it('revalidates consumed approval authority through the real execution kernel path',async()=>{
 mocks.sql.mockResolvedValue([{id:effect,result:{old:true},approval_id:'approval',approval_status:'consumed',consumed_effect_id:effect}]);
 expect(await replayKnownOperationEffect(ctx,ref,effect)).toEqual({verified:true});
 expect(mocks.execute).toHaveBeenCalledWith(ctx,ref,'approval',expect.any(Function));
 await expect(mocks.execute.mock.calls[0]![3]()).rejects.toThrow('new effect');
});
it('requires current caller authority even when the effect had no approval',async()=>{
 mocks.sql.mockResolvedValue([{id:effect,result:{ok:true},approval_id:null,approval_status:null,consumed_effect_id:null}]);
 expect(await replayKnownOperationEffect(ctx,ref,effect)).toEqual({ok:true});
 expect(mocks.permission).toHaveBeenCalledWith(ctx,'write:bank-tx');expect(mocks.permission).toHaveBeenCalledWith(ctx,'write:post');
 expect(mocks.execute).not.toHaveBeenCalled();
});
it('refuses absent or ambiguous effect association and altered approval links',async()=>{
 mocks.sql.mockResolvedValue([]);await expect(replayKnownOperationEffect(ctx,ref,effect)).rejects.toThrow('association');
 mocks.sql.mockResolvedValue([{id:effect,approval_id:'approval',approval_status:'consumed',consumed_effect_id:'other'}]);
 await expect(replayKnownOperationEffect(ctx,ref,effect)).rejects.toThrow('linkage');
});

it('joins only an approval that consumed this effect or shares its operation and entity',async()=>{
 mocks.sql.mockResolvedValue([{id:effect,result:{ok:true},approval_id:null,approval_status:null,consumed_effect_id:null}]);
 await replayKnownOperationEffect(ctx,ref,effect);
 const query=(mocks.sql.mock.calls.at(-1)![0] as string[]).join('?').replace(/\s+/g,' ');
 // Approval entity ids are canonical today; the comparison stays case-insensitive so a
 // non-canonical row cannot slip past the arm that catches an erased consumed link.
 expect(query).toContain('(a.consumed_effect_id=e.id OR (a.operation_id=e.operation_id AND a.operation=e.operation AND a.entity_type=e.entity_type AND lower(a.entity_id)=lower(e.entity_id)))');
});

it('stops before effect SQL when current caller permission has been revoked',async()=>{
 mocks.permission.mockRejectedValueOnce(new Error('Permission denied'));
 await expect(replayKnownOperationEffect(ctx,ref,effect)).rejects.toThrow('Permission denied');
 expect(mocks.sql).not.toHaveBeenCalled();expect(mocks.execute).not.toHaveBeenCalled();
});
