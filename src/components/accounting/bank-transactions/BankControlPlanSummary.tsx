import Decimal from 'decimal.js';
import type {BankPreparedOperation} from '@/modules/accounting/services/bank/bankControlReadService';
import type {SelectOption} from '../BankTxTable';
const D=Decimal.clone({precision:80});
export function BankControlPlanSummary({operation,accounts=[],bankAmount}:{operation:BankPreparedOperation;accounts?:SelectOption[];bankAmount?:string}){
 const plan=operation.plan,label=(id:string)=>{const account=accounts.find(a=>a.id===id);return account?`${account.code??''} ${account.name} (${id})`.trim():id;};
 const amount=(value:string)=>new D(value).toFixed(2);
 const dimensions=(row:{cc1Id?:string;cc2Id?:string;buId?:string})=>[['CC1',row.cc1Id],['CC2',row.cc2Id],['Business unit',row.buId]].filter(([,id])=>id).map(([type,id])=>`${type}: ${id}`).join(' · ');
 return <section aria-label="Saved bank instruction" className="space-y-3 rounded-lg border border-[var(--ff-border-light)] p-4 text-sm">
  <dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-[var(--ff-text-tertiary)]">Prepared amount</dt><dd className="font-semibold">{operation.currency} {amount(operation.amount)}</dd></div>
   <div><dt className="text-[var(--ff-text-tertiary)]">Accounting date</dt><dd>{operation.accountingDate}</dd></div>
   {bankAmount!==undefined&&<div><dt className="text-[var(--ff-text-tertiary)]">Current statement amount</dt><dd>{operation.currency} {amount(bankAmount)}</dd></div>}
   <div><dt className="text-[var(--ff-text-tertiary)]">Instruction</dt><dd className="break-all font-mono text-xs">{operation.intentId}</dd></div></dl>
  {'kind' in plan?<>
   <p className="font-medium capitalize">{plan.kind} allocation</p>{plan.description&&<p>{plan.description}</p>}
   {plan.kind==='transfer'?<div className="space-y-1 break-all">
    <p>Bank transaction: {plan.bankTransactionId}</p><p>Counterparty bank account: {label(plan.counterpartyAccountId)}</p>
    {plan.transfer.mode==='post'?<><p>Post a new transfer journal</p><p>{plan.transfer.oppositeBankTransactionId?`Opposite bank transaction: ${plan.transfer.oppositeBankTransactionId}`:'No opposite bank transaction is linked yet.'}</p></>:<><p>Link to an existing transfer journal</p><p>Original instruction: {plan.transfer.originalIntentId}</p></>}
   </div>:'lines' in plan?<ol className="space-y-3">{plan.lines.map((line,index)=>{
    const gross=new D(line.amount),vat=line.vatCode==='standard'?gross.minus(gross.div('1.15').toDecimalPlaces(2,Decimal.ROUND_HALF_UP)):new D(0);
    return <li key={index} className="border-t border-[var(--ff-border-light)] pt-2"><p className="break-words">{label(line.accountId)}</p><p>Gross {amount(line.amount)} · VAT {line.vatCode.replace('_',' ')}{vat.gt(0)?` (${vat.toFixed(2)} included)`:''}</p>{line.description&&<p>{line.description}</p>}{dimensions(line)&&<p className="break-all text-xs">{dimensions(line)}</p>}</li>;
   })}</ol>:<><p className="break-all">{plan.kind==='supplier'?'Supplier':'Customer'} ID: {plan.partyId}</p>{dimensions(plan)&&<p className="break-all text-xs">{dimensions(plan)}</p>}
    {plan.applications.length?<ul className="space-y-1">{plan.applications.map(item=><li key={item.invoiceId} className="break-all">Invoice {item.invoiceId}: {amount(item.amount)}</li>)}</ul>:<p>No invoice applications are included.</p>}</>}
   {'vatAccountId' in plan&&plan.vatAccountId&&<p className="break-all text-xs">VAT account: {label(plan.vatAccountId)}</p>}
  </>:<><p className="font-medium">Reverse allocation</p><p>Date: {plan.reversalDate}</p><p>{plan.reason}</p><p className="break-all text-xs">Original instruction: {plan.originalIntentId}</p></>}
 </section>;
}
