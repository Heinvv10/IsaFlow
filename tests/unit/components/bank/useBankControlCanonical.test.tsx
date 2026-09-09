import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useBankControlWorkflow} from '@/components/accounting/bank-transactions/useBankControlWorkflow';
const api=vi.hoisted(()=>({loadBankControlState:vi.fn(),prepareBankControl:vi.fn(),loadBankApprovalRequirements:vi.fn(),requestBankApproval:vi.fn(),executeSavedBankOperation:vi.fn()}));
vi.mock('@/components/accounting/bank-transactions/bankControlClient',()=>api);
beforeEach(()=>{vi.resetAllMocks();api.loadBankApprovalRequirements.mockResolvedValue({requiresApproval:true,policies:[]});});
for(const canonical of [undefined,'original-bank'])it(`prepared inverse ${canonical?'uses server canonical bank':'preserves selected bank when no canonical field'}`,async()=>{
 const selectedBank='opposite-bank',expectedBank=canonical??selectedBank;
 const operation={intentId:'inverse',operation:{entityType:'bank_allocation_reversal_intent',entityId:'inverse',operation:'bank_allocation.reverse'},plan:{bankTransactionId:expectedBank},approval:null,executed:false,requesterIsCurrentPerson:true};
 api.loadBankControlState.mockResolvedValueOnce({bankTransactionId:selectedBank,currentOriginalIntentId:'original',prepared:{items:[]},selected:null})
  .mockResolvedValueOnce({bankTransactionId:expectedBank,currentOriginalIntentId:'original',prepared:{items:[operation]},selected:operation});
 api.prepareBankControl.mockResolvedValue({intentId:'inverse',operation:operation.operation,...(canonical?{bankTransactionId:canonical}:{})});
 const {result}=renderHook(()=>useBankControlWorkflow());
 act(()=>{void result.current.open({bankTransactionId:selectedBank,mode:'reverse'});});await waitFor(()=>expect(result.current.state?.busy).toBe(false));
 await act(()=>result.current.prepare({reversalDate:'2026-09-10',reason:'Synthetic inverse'}));
 expect(api.loadBankControlState).toHaveBeenLastCalledWith({bankTransactionId:expectedBank,intentId:'inverse'});
 expect(result.current.state?.bankTransactionId).toBe(expectedBank);
 expect(api.executeSavedBankOperation).not.toHaveBeenCalled();
});
