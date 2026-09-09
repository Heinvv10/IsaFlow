import { beforeEach, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createSupplier, updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { withControlRequest } from '@/modules/accounting/services/controls/context';
import { proposeBeneficiaryChange } from '@/modules/accounting/services/controls/beneficiaryService';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission:vi.fn() }));
vi.mock('@/modules/accounting/services/controls/beneficiaryService', () => ({ proposeBeneficiaryChange:vi.fn().mockResolvedValue({ proposalId:'proposal',status:'pending' }) }));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({ recordCommittedChange:vi.fn() }));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({ readControlEntityVersion:vi.fn().mockResolvedValue(null) }));
const id='22222222-2222-4222-8222-222222222222', companyId='11111111-1111-4111-8111-111111111111';
const old={ id,name:'Before',bank_name:'Synthetic bank',bank_account_number:'00123456789',bank_branch_code:'001234',bank_account_type:'cheque' };
const input={ name:'After',bankName:'Synthetic bank',bankAccountNumber:'00987654321',bankBranchCode:'001234',bankAccountType:'cheque' };
const query=vi.fn(), client={ query } as unknown as PoolClient;
function run<T>(fn:()=>Promise<T>) { return withControlRequest({ client,userId:'u1',companyId,claims:{} }, { personId:'u1',companyId,authMethod:'cookie' }, fn); }
beforeEach(()=>{ vi.clearAllMocks(); vi.mocked(assertEffectivePermission).mockResolvedValue(undefined);
  query.mockImplementation(async(text:string)=>({ rows: text.includes('FROM suppliers')||text.includes('RETURNING') ? [old] : [] })); });
it('banking create inserts a bankless contact and returns only pending review metadata',async()=>{
  const result=await run(()=>createSupplier(companyId,input));
  expect(proposeBeneficiaryChange).toHaveBeenCalledWith(expect.anything(),{entityType:'supplier',entityId:id},
    {bankName:input.bankName,accountNumber:input.bankAccountNumber,branchCode:input.bankBranchCode,accountType:'cheque'},[]);
  const writes=query.mock.calls.filter(([text])=>String(text).includes('INSERT INTO suppliers'));
  expect(JSON.stringify(writes)).not.toContain(input.bankAccountNumber);
  expect(result.bank_account_number).toBeUndefined();
  expect(result.beneficiary_review).toEqual({proposalId:'proposal',status:'pending'});
});
it('changed banking update proposes while ordinary omitted or equal fields remain compatible',async()=>{
  await run(()=>updateSupplier(companyId,id,input));
  expect(proposeBeneficiaryChange).toHaveBeenCalledTimes(1);
  const update=query.mock.calls.find(([text])=>String(text).includes('UPDATE suppliers'))!;
  expect(update[0]).not.toContain('bank_account_number =');
  vi.mocked(proposeBeneficiaryChange).mockClear();
  await run(()=>updateSupplier(companyId,id,{name:'Contact edit',bankAccountNumber:old.bank_account_number}));
  await run(()=>updateSupplier(companyId,id,{name:'Contact only'}));
  expect(proposeBeneficiaryChange).not.toHaveBeenCalled();
});
it('bank permission failure happens before any contact write',async()=>{
  vi.mocked(assertEffectivePermission).mockImplementation(async(_ctx,scope)=>{if(scope==='write:beneficiaries')throw new Error('forbidden');});
  await expect(run(()=>updateSupplier(companyId,id,input))).rejects.toThrow('forbidden');
  expect(query.mock.calls.some(([text])=>String(text).includes('UPDATE suppliers'))).toBe(false);
});
it('maps migration billing-address input to the existing supplier address column',async()=>{
 await run(()=>createSupplier(companyId,{name:'Imported vendor',billingAddress:'Synthetic billing address'}));
 const insert=query.mock.calls.find(([text])=>String(text).includes('INSERT INTO suppliers'))!;
 expect(insert[0]).toContain('address');expect(insert[0]).not.toContain('billing_address');expect(insert[1]).toContain('Synthetic billing address');
});
