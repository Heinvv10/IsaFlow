import {expect,it,vi} from 'vitest';
const hoisted=vi.hoisted(()=>({permission:vi.fn(),savepoint:vi.fn(async(_name:string,fn:()=>Promise<unknown>)=>fn())}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:hoisted.permission}));
vi.mock('@/lib/neon',()=>({withSavepoint:hoisted.savepoint}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/operationMaterializer',()=>({
  canonicalOperationRef:(ref:unknown)=>ref,loadOperationMaterial:vi.fn(),
  materializeOperation:vi.fn(),reserveOperationExposure:vi.fn()}));
import {executeControlledOperation} from '@/modules/accounting/services/controls/approvalExecutionService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
const ref={entityType:'payroll_run',entityId:'11111111-1111-1111-1111-111111111111',operation:'payroll_run.post'} as OperationRef;
const receipt={journalEntryId:'33333333-3333-3333-3333-333333333333'};
// A committed effect is read back by entity_id_canonical (lower(entity_id)), so a legacy or tampered case-only
// duplicate can match twice; the kernel must refuse rather than return an arbitrary row.
function context(rows:Array<{id:string;result:unknown}>){
  const sql=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
  return {ctx:{principal:{companyId:'company',operationId:'44444444-4444-4444-4444-444444444444'},sql} as unknown as ControlTx,sql};
}
const effected=async():Promise<never>=>{throw new Error('effect must not run');};

it('refuses two committed effects that differ only by entity id case',async()=>{
  const {ctx}=context([{id:'22222222-2222-2222-2222-222222222222',result:receipt},
    {id:'55555555-5555-5555-5555-555555555555',result:receipt}]);
  await expect(executeControlledOperation(ctx,ref,null,effected)).rejects.toThrow('Committed operation effect is ambiguous');
});

it('returns the single committed effect when there is exactly one',async()=>{
  const {ctx}=context([{id:'22222222-2222-2222-2222-222222222222',result:receipt}]);
  expect(await executeControlledOperation(ctx,ref,null,effected)).toEqual(receipt);
});

it('reads the committed effect back case-insensitively, capped so a duplicate is seen',async()=>{
  const {ctx,sql}=context([{id:'22222222-2222-2222-2222-222222222222',result:receipt}]);
  await executeControlledOperation(ctx,ref,null,effected);
  const query=(sql.mock.calls.at(-1)![0] as string[]).join('?').replace(/\s+/g,' ');
  expect(query).toContain('entity_id_canonical=?');expect(query).toContain('LIMIT 2');
});
