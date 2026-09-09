import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {requireControlTx} from '../controls/context';
import {runControlledTransferLinks} from './bankTransferLinkService';
import type {TransferLinkResult} from './bankTransferLinkPasses';
export interface TransferAutoLinkInput {
 companyId:string;bankTxId:string;bankAccountId:string;counterpartyAccountId:string;
 journalEntryId:string;amount:number;txDate:string;allocatedEntityName:string|null;
}
/** Legacy callers cannot confer posting/link authority through supplied journal metadata. */
export async function autoLinkCounterpartyTransfer(input:TransferAutoLinkInput):Promise<TransferLinkResult>{
 const ctx=requireControlTx();if(ctx.principal.companyId!==input.companyId)throw new Error('Transfer tenant mismatch');
 const [bank]=await ctx.sql`SELECT bank_account_id,counterparty_account_id,transfer_journal_entry_id,amount::text,transaction_date
  FROM bank_transactions WHERE company_id=${input.companyId}::uuid AND id=${input.bankTxId}::uuid` as {bank_account_id:string;counterparty_account_id:string;transfer_journal_entry_id:string;amount:string;transaction_date:Date|string}[];
 if(!bank||bank.bank_account_id!==input.bankAccountId||bank.counterparty_account_id!==input.counterpartyAccountId
  ||bank.transfer_journal_entry_id!==input.journalEntryId||!new Decimal(bank.amount).eq(input.amount)||fmtDate(bank.transaction_date)!==input.txDate)throw new Error('Current owned transfer source required');
 return runControlledTransferLinks(input.companyId,{bankAccountId:input.counterpartyAccountId,originalBankId:input.bankTxId});
}
