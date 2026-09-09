import {fireEvent,render,screen} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {BankApprovalInbox} from '@/components/accounting/bank-transactions/BankApprovalInbox';
const api=vi.hoisted(()=>({listBankApprovalPage:vi.fn()}));
vi.mock('@/components/accounting/bank-transactions/bankControlClient',()=>api);
beforeEach(()=>vi.clearAllMocks());
it('retains pagination through pages containing only other authorized domains',async()=>{
 api.listBankApprovalPage.mockResolvedValueOnce({items:[{id:'other',operation:'journal.post'}],nextCursor:'cursor'}).mockResolvedValueOnce({items:[{id:'bank-approval',entityId:'bank-intent',operation:'bank_allocation.post',status:'pending',requestedAt:'2026-09-09'}],nextCursor:null});
 render(<BankApprovalInbox/>);fireEvent.click(await screen.findByRole('button',{name:'Load more approvals'}));
 expect(await screen.findByRole('link',{name:/bank-intent/})).toHaveProperty('href',expect.stringContaining('approvalId=bank-approval'));
 expect(api.listBankApprovalPage).toHaveBeenLastCalledWith('cursor');expect(screen.queryByRole('button',{name:'Load more approvals'})).toBeNull();
});
it('failed listing is explicit and does not claim an empty inbox',async()=>{
 api.listBankApprovalPage.mockRejectedValue(new Error('Permission denied'));render(<BankApprovalInbox/>);
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Permission denied');expect(screen.queryByText('No bank approvals found.')).toBeNull();
});
