import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>{
 const sql=vi.fn(async()=>[]);
 return{load:vi.fn(),resolve:vi.fn(),reversible:vi.fn(),sql,ctx:{principal:{companyId:'00000000-0000-4000-8000-000000000001',personId:'00000000-0000-4000-8000-000000000002'},sql}};
});
vi.mock('@/lib/neon',()=>({withSavepoint:async(_name:string,fn:()=>Promise<unknown>)=>fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:async()=>undefined}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>undefined,requireControlTx:()=>mocks.ctx}));
vi.mock('@/modules/accounting/services/shared/cashApplicationMaterial',()=>({loadCashApplicationIntent:mocks.load}));
vi.mock('@/modules/accounting/services/shared/cashApplicationReversalMaterial',()=>({loadCashApplicationReversal:mocks.load}));
vi.mock('@/modules/accounting/services/bank/bankAllocationMaterial',()=>({loadBankAllocationIntent:mocks.load}));
vi.mock('@/modules/accounting/services/bank/bankAllocationReversalMaterial',()=>({loadBankAllocationReversal:mocks.load}));
vi.mock('@/modules/accounting/services/controls/payrollCompensationMaterial',()=>({loadPayrollCompensationIntent:mocks.load}));
vi.mock('@/modules/accounting/services/bank/bankAllocationTransferOriginal',()=>({resolveBankTransferOriginal:mocks.resolve,loadBankTransferOriginalBanks:vi.fn(),assertTransferBankLinks:vi.fn()}));
vi.mock('@/modules/accounting/services/shared/cashApplicationReversalSources',()=>({assertCashApplicationReversible:mocks.reversible,loadOriginalCashApplication:vi.fn()}));
import {executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {executeCashApplicationReversal,prepareCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {executeBankAllocationReversal,prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {executePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
import {applyLegacyCashPlan} from '@/modules/accounting/services/shared/cashApplicationLegacyAdapter';
import {executeCompensationCaller} from '@/modules/accounting/services/controls/payrollCompensationLegacyAdapter';
const id='abcdefab-cdef-4abc-8def-abcdefabcdef';
const ctx=mocks.ctx as unknown as ControlTx;
const executes=[['cash',executeCashApplication],['cash reversal',executeCashApplicationReversal],['bank',executeBankAllocation],['bank reversal',executeBankAllocationReversal],['compensation',executePayrollCompensation]] as const;
beforeEach(()=>{
 vi.clearAllMocks();
 for(const mock of [mocks.load,mocks.resolve,mocks.reversible])mock.mockRejectedValue(new Error('Reached owning loader'));
});
it.each(executes)('%s canonicalizes before the first receipt/source lookup',async(_name,execute)=>{
 await expect(execute(ctx,id.toUpperCase())).rejects.toThrow('Reached owning loader');
 expect(mocks.load).toHaveBeenCalledWith(ctx,id);
});
it.each(executes)('%s refuses a non-UUID intent with one message before any SQL or loader',async(_name,execute)=>{
 for(const invalid of ['not-a-uuid',`${id}x`,` ${id}`,''])await expect(execute(ctx,invalid)).rejects.toThrow('Invalid controlled intent UUID');
 expect(mocks.load).not.toHaveBeenCalled();expect(mocks.sql).not.toHaveBeenCalled();
});
it('legacy cash adapter canonicalizes the caller intent before its own pre-load',async()=>{
 const plan={paymentId:'00000000-0000-4000-8000-000000000003',lines:[{invoiceId:'00000000-0000-4000-8000-000000000004',amount:115}]};
 await expect(applyLegacyCashPlan(mocks.ctx.principal.companyId,mocks.ctx.principal.personId,'customer',plan,{intentId:id.toUpperCase()})).rejects.toThrow('Reached owning loader');
 expect(mocks.load).toHaveBeenCalledWith(ctx,id);
});
it('legacy compensation caller canonicalizes the caller intent before its own pre-load',async()=>{
 const input={version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId:'00000000-0000-4000-8000-000000000005',componentId:'00000000-0000-4000-8000-000000000006',amount:'1.00',effectiveFrom:'2027-01-01'}]};
 await expect(executeCompensationCaller(mocks.ctx.principal.companyId,input,{intentId:id.toUpperCase()},mocks.ctx.principal.personId)).rejects.toThrow('Reached owning loader');
 expect(mocks.load).toHaveBeenCalledWith(ctx,id);
});
it('bank reversal preparation canonicalizes the original intent before resolving it',async()=>{
 await expect(prepareBankAllocationReversal(ctx,{originalIntentId:id.toUpperCase(),reversalDate:'2026-09-11',reason:'Synthetic'})).rejects.toThrow('Reached owning loader');
 expect(mocks.resolve).toHaveBeenCalledWith(ctx,id);
});
it('cash reversal preparation canonicalizes the original intent before loading it',async()=>{
 await expect(prepareCashApplicationReversal(ctx,{originalIntentId:id.toUpperCase(),reversalDate:'2026-09-11',reason:'Synthetic'})).rejects.toThrow('Reached owning loader');
 expect(mocks.reversible).toHaveBeenCalledWith(ctx,id);
});
