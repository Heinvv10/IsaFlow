import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
import {loadApprovalRules,matchApprovalRules} from '@/modules/accounting/services/controls/approvalRuleService';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
const query=vi.fn(),ctx={principal:{companyId:'tenant-a'},sql:query} as unknown as ControlTx;
beforeEach(()=>query.mockReset());
it('requires invoice authority without journal posting authority for the annotation',()=>{
 expect(CONTROL_OPERATIONS).toContain('invoice_match.override');
 expect(operationPermission('invoice_match.override','write')).toBe('write:invoices');
 expect(operationPermission('invoice_match.override','read')).toBe('read:invoices');
 expect(operationRequiresPosting('invoice_match.override')).toBe(false);
 expect(operationRuleType('invoice_match.override')).toBe('invoice_match_override');
});
it('keeps configured supplier invoice rules and mandatory independent admin approval',async()=>{
 query.mockResolvedValueOnce([{id:'optional',document_type:'supplier_invoice',condition_field:'amount',condition_operator:'greater_than',condition_value:'100',approver_role:'manager',control_version:2,is_active:true,aggregate_window_days:null,aggregate_by:null}])
  .mockResolvedValueOnce([{id:'mandatory',control_version:1,approver_role:'admin'}]);
 const rules=await loadApprovalRules(ctx,'invoice_match_override');
 expect(query.mock.calls[0]).toContain('supplier_invoice');
 expect(matchApprovalRules(rules,'101',new Map())).toEqual([
  {policyId:'optional',policyVersion:2,approverRole:'manager',mandatory:false},
  {policyId:'mandatory',policyVersion:1,approverRole:'admin',mandatory:true},
 ]);
 expect(matchApprovalRules(rules,'1',new Map())).toHaveLength(1);
});
it('refuses a missing mandatory override policy',async()=>{
 query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
 await expect(loadApprovalRules(ctx,'invoice_match_override')).rejects.toThrow('Mandatory match override policy');
});
