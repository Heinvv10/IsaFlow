import type {PendingBankTransfer} from './useBankTransferRelink';
export function BankTransferPending({pending,failed,bankAccountId}:{pending:PendingBankTransfer[];failed:boolean;bankAccountId:string}){
 if(!pending.length&&!failed)return null;
 return <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 mb-3 text-sm" role="status">
  {failed&&<p className="text-amber-300">Some transfer instructions could not be prepared. Refresh this account to retry.</p>}
  {pending.length>0&&<><p>{pending.length} transfer instruction{pending.length===1?'':'s'} awaiting approval or execution. These instructions have not posted.</p>
   <div className="flex flex-wrap gap-3">{pending.map((row,index)=><a key={row.intentId} className="text-cyan-300 underline" href={`/accounting/bank-transactions?${new URLSearchParams({account_id:bankAccountId,bankControlBank:row.bankTransactionId,bankControlIntent:row.intentId})}`}>Review transfer {index+1}</a>)}</div></>}
 </div>;
}
