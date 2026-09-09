import {render,screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {expect,it,vi} from 'vitest';
import {BankTransactionsView} from '@/components/accounting/bank-transactions/BankTransactionsView';
import type {useBankTransactionsController} from '@/components/accounting/bank-transactions/useBankTransactionsController';
vi.mock('@/components/layout/AppLayout',()=>({AppLayout:({children}:{children:ReactNode})=>children}));
vi.mock('@/components/accounting/banking/BankEmptyState',()=>({BankEmptyState:()=>null}));
it('saved-link authority refusal remains visible when current tenant has no bank accounts',()=>{
 const props={noBankAccounts:true,glAccounts:[],bankControl:{state:{id:1,bankTransactionId:'foreign-bank',mode:'allocate',bank:null,selected:null,busy:false,error:'Bank transaction not found',requirements:null},close:vi.fn(),refresh:vi.fn()}} as unknown as ReturnType<typeof useBankTransactionsController>;
 render(<BankTransactionsView {...props}/>);expect(screen.getByRole('alert')).toHaveProperty('textContent','Bank transaction not found');
});
