import {useBankTransactionsController} from '@/components/accounting/bank-transactions/useBankTransactionsController';
import {BankTransactionsView} from '@/components/accounting/bank-transactions/BankTransactionsView';
export default function BankTransactionsPage(){
 const state=useBankTransactionsController();
 return <BankTransactionsView {...state}/>;
}
