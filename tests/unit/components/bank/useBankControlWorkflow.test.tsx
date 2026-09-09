import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useBankControlWorkflow} from '@/components/accounting/bank-transactions/useBankControlWorkflow';
const api=vi.hoisted(()=>({loadBankControlState:vi.fn(),prepareBankControl:vi.fn(),loadBankApprovalRequirements:vi.fn(),requestBankApproval:vi.fn(),executeSavedBankOperation:vi.fn()}));
vi.mock('@/components/accounting/bank-transactions/bankControlClient',()=>api);
const operation={intentId:'intent',operation:{entityType:'bank_allocation_intent',entityId:'intent',operation:'bank_allocation.post'},plan:{kind:'account',bankTransactionId:'bank',lines:[]},approval:{id:'approval',status:'pending'},executed:false,requesterIsCurrentPerson:true};
const bankState={bankTransactionId:'bank',currentOriginalIntentId:null,legacyProvenanceUnavailable:false,prepared:{items:[operation],total:1,hasMore:false},selected:operation};
beforeEach(()=>{vi.resetAllMocks();api.loadBankControlState.mockResolvedValue(bankState);api.loadBankApprovalRequirements.mockResolvedValue({requiresApproval:true,policies:[]});});
it('refresh resumes saved pending work without posting or creating another intent',async()=>{
 const {result}=renderHook(()=>useBankControlWorkflow());let outcome:Promise<unknown>;
 act(()=>{outcome=result.current.open({bankTransactionId:'bank',mode:'allocate',preparation:{action:'prepare_allocate'}});});
 await waitFor(()=>expect(result.current.state?.selected?.intentId).toBe('intent'));
 expect(api.prepareBankControl).not.toHaveBeenCalled();expect(api.executeSavedBankOperation).not.toHaveBeenCalled();
 act(()=>result.current.close());await expect(outcome!).resolves.toBe('pending');
});
it('approved work executes only after an explicit action and returns posted only on success',async()=>{
 const approved={...operation,approval:{...operation.approval,status:'approved'}};
 api.loadBankControlState.mockResolvedValue({...bankState,selected:approved,prepared:{...bankState.prepared,items:[approved]}});api.executeSavedBankOperation.mockResolvedValue({journalEntryId:'journal'});
 const {result}=renderHook(()=>useBankControlWorkflow());let outcome:Promise<unknown>;
 act(()=>{outcome=result.current.open({bankTransactionId:'bank',mode:'allocate'});});await waitFor(()=>expect(result.current.state?.busy).toBe(false));
 expect(api.executeSavedBankOperation).not.toHaveBeenCalled();await act(()=>result.current.execute());
 expect(api.executeSavedBankOperation).toHaveBeenCalledWith('bank',approved);await expect(outcome!).resolves.toBe('posted');
});
it('server execution refusal keeps the saved instruction and never reports posting',async()=>{
 api.executeSavedBankOperation.mockRejectedValue(new Error('Approval source changed'));
 const {result}=renderHook(()=>useBankControlWorkflow());let outcome:Promise<unknown>;
 act(()=>{outcome=result.current.open({bankTransactionId:'bank',mode:'allocate'});});await waitFor(()=>expect(result.current.state?.busy).toBe(false));
 await act(()=>result.current.execute());expect(result.current.state?.error).toBe('Approval source changed');
 act(()=>result.current.close());await expect(outcome!).resolves.toBe('pending');
});
