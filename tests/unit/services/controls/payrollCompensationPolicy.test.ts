import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {loadApprovalRules,matchApprovalRules} from '@/modules/accounting/services/controls/approvalRuleService';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
import {assertOperationRequester} from '@/modules/accounting/services/controls/operationRequester';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
const query=vi.fn(),ctx={principal:{companyId:'tenant-a'},sql:query} as unknown as ControlTx;
beforeEach(()=>query.mockReset());
it('requires payroll maintenance authority without permission to post journals',()=>{
 expect(operationPermission('payroll_compensation.change','read')).toBe('read:payroll');
 expect(operationPermission('payroll_compensation.change','write')).toBe('write:payroll');
 expect(operationRuleType('payroll_compensation.change')).toBe('payroll_compensation');
 expect(operationRequiresPosting('payroll_compensation.change')).toBe(false);
});
it('retains configured payroll rules and mandatory independent approval even for zero exposure',async()=>{
 query.mockResolvedValueOnce([{id:'optional',document_type:'payroll_run',condition_field:'amount',condition_operator:'greater_than',condition_value:'100',approver_role:'manager',control_version:2,is_active:true,aggregate_window_days:null,aggregate_by:null}])
  .mockResolvedValueOnce([{id:'mandatory',control_version:1,approver_role:'admin'}]);
 const rules=await loadApprovalRules(ctx,'payroll_compensation');
 expect(query.mock.calls[0]).toContain('payroll_run');
 expect(matchApprovalRules(rules,'101',new Map())).toHaveLength(2);
 expect(matchApprovalRules(rules,'0',new Map())).toEqual([{policyId:'mandatory',policyVersion:1,approverRole:'admin',mandatory:true}]);
});
it('refuses missing mandatory compensation policy',async()=>{
 query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
 await expect(loadApprovalRules(ctx,'payroll_compensation')).rejects.toThrow('Mandatory compensation policy');
});
it('binds compensation approval requester to immutable original maker',async()=>{
 query.mockResolvedValue([{requester_person_id:'original'}]);
 const ref={entityType:'payroll_compensation_intent',entityId:'4bf4060c-57d3-4a2d-811c-438f530a7ef0',operation:'payroll_compensation.change' as const};
 await expect(assertOperationRequester(ctx,ref,'proxy')).rejects.toThrow('Original intent requester');
 await expect(assertOperationRequester(ctx,ref,'original')).resolves.toBeUndefined();
 expect(query.mock.calls[0]).toContain('tenant-a');
});
