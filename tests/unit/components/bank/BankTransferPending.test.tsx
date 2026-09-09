import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {BankTransferPending} from '@/components/accounting/bank-transactions/BankTransferPending';
it('shows pending count and server-saved resume links separately from posting and failure',()=>{
 render(<BankTransferPending bankAccountId="account" failed pending={[{bankTransactionId:'bank',intentId:'intent',approvalId:'approval'}]}/>);
 expect(screen.getByText(/1 transfer instruction awaiting approval or execution/)).toBeTruthy();
 expect(screen.getByRole('link',{name:'Review transfer 1'}).getAttribute('href')).toBe('/accounting/bank-transactions?account_id=account&bankControlBank=bank&bankControlIntent=intent');
 expect(screen.getByText(/Some transfer instructions could not be prepared/)).toBeTruthy();
 expect(screen.queryByText(/successfully posted/i)).toBeNull();
});
it('renders no status for an empty successful preparation pass',()=>{
 const {container}=render(<BankTransferPending bankAccountId="account" failed={false} pending={[]}/>);expect(container.textContent).toBe('');
});
