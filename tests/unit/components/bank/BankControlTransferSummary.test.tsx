import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {BankControlPlanSummary} from '@/components/accounting/bank-transactions/BankControlPlanSummary';
import type {BankPreparedOperation} from '@/modules/accounting/services/bank/bankControlReadService';
for(const mode of ['post','link'] as const)it(`shows saved transfer ${mode} associations without inventing VAT or a party`,()=>{
 const operation={intentId:'instruction',amount:'115.23',currency:'ZAR',accountingDate:'2026-09-09',
  plan:{version:1,kind:'transfer',bankTransactionId:'source-bank-transaction',counterpartyAccountId:'counterparty-bank',transfer:mode==='post'?{mode,oppositeBankTransactionId:'opposite-bank-transaction'}:{mode,originalIntentId:'original-transfer'}}} as unknown as BankPreparedOperation;
 render(<BankControlPlanSummary operation={operation}/>);
 expect(screen.getByText('Bank transaction: source-bank-transaction')).toBeTruthy();
 expect(screen.getByText('Counterparty bank account: counterparty-bank')).toBeTruthy();
 expect(screen.getByText(mode==='post'?'Post a new transfer journal':'Link to an existing transfer journal')).toBeTruthy();
 expect(screen.getByText(mode==='post'?'Opposite bank transaction: opposite-bank-transaction':'Original instruction: original-transfer')).toBeTruthy();
 expect(screen.queryByText(/Customer ID|Supplier ID|VAT account/)).toBeNull();
});
