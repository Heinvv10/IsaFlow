import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {BankApprovalDetail} from '@/components/accounting/bank-transactions/BankApprovalDetail';
const api=vi.hoisted(()=>({loadBankControlState:vi.fn(),decideBankApproval:vi.fn()}));
vi.mock('@/components/accounting/bank-transactions/bankControlClient',()=>api);
function state(own=false,status='pending'){return{bankTransactionId:'bank',bankAmount:'-12.34',selected:{intentId:'intent',accountingDate:'2026-09-09',amount:'12.34',currency:'ZAR',requesterIsCurrentPerson:own,executed:false,operation:{entityType:'bank_allocation_intent',entityId:'intent',operation:'bank_allocation.post'},plan:{version:1,kind:'account',bankTransactionId:'bank',lines:[{accountId:'account',amount:'12.34',vatCode:'none'}]},approval:{id:'approval',status}}};}
beforeEach(()=>{vi.clearAllMocks();api.loadBankControlState.mockResolvedValue(state());api.decideBankApproval.mockResolvedValue({});});
it('independent reviewer sees saved plan and explicitly approves the exact selected approval',async()=>{
 render(<BankApprovalDetail approvalId="approval"/>);const approve=await screen.findByRole('button',{name:'Approve instruction'});
 expect(screen.getByText('ZAR 12.34')).toBeTruthy();expect(api.decideBankApproval).not.toHaveBeenCalled();fireEvent.click(approve);
 await waitFor(()=>expect(api.decideBankApproval).toHaveBeenCalledWith('approval','approved'));expect(api.loadBankControlState).toHaveBeenCalledWith({approvalId:'approval'},expect.any(AbortSignal));
});
it('maker cannot decide their own pending instruction and is told why',async()=>{
 api.loadBankControlState.mockResolvedValue(state(true));render(<BankApprovalDetail approvalId="approval"/>);
 const approve=await screen.findByRole('button',{name:'Approve instruction'});expect((approve as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/another authorized person must decide/i)).toBeTruthy();fireEvent.click(approve);expect(api.decideBankApproval).not.toHaveBeenCalled();
});
it('authority failure shows no stale saved details or decision controls',async()=>{
 api.loadBankControlState.mockRejectedValue(new Error('Permission denied'));render(<BankApprovalDetail approvalId="approval"/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Permission denied');expect(screen.queryByRole('button',{name:'Approve instruction'})).toBeNull();
});
