import {useState} from 'react';
import type {useBankControlWorkflow} from './useBankControlWorkflow';
import type {SelectOption} from '../BankTxTable';
import {BankControlPlanSummary} from './BankControlPlanSummary';
const button='rounded-md border border-[var(--ff-border-light)] px-3 py-2 text-sm disabled:opacity-50';
export function BankControlDialog({workflow,accounts}:{workflow:ReturnType<typeof useBankControlWorkflow>;accounts?:SelectOption[]}){
 const [reversalDate,setReversalDate]=useState(''),[reason,setReason]=useState('');
 const state=workflow.state;if(!state)return null;
 const selected=state.selected,status=selected?.approval?.status,reverse=state.mode==='reverse',busy=state.busy;
 const saved=state.bank?.prepared.items??[],options=selected&&!saved.some(item=>item.intentId===selected.intentId)?[selected,...saved]:saved;
 const bankAmount=state.bank&&'bankAmount' in state.bank?String(state.bank.bankAmount):undefined;
 return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
  <section role="dialog" aria-modal="true" aria-labelledby="bank-control-title" aria-busy={busy} className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] shadow-2xl">
   <header className="flex items-center justify-between border-b border-[var(--ff-border-light)] p-4"><h2 id="bank-control-title" className="font-semibold">{reverse?'Review bank reversal':'Review bank allocation'}</h2><button className={button} onClick={workflow.close} disabled={busy}>Close</button></header>
   <div className="space-y-4 overflow-y-auto p-4">
    {state.error&&<p role="alert" className="rounded bg-red-500/10 p-3 text-red-500">{state.error}</p>}
    {busy&&<p role="status">Loading saved bank instructions…</p>}
    {!!options.length&&<label className="block text-sm">Saved instructions<select className="mt-1 w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2" value={selected?.intentId??''} onChange={event=>void workflow.select(event.target.value)} disabled={busy}>
     {!selected&&<option value="">Choose saved work</option>}{options.map(item=><option key={item.intentId} value={item.intentId}>{item.accountingDate} · {item.operation.operation==='bank_allocation.reverse'?'Reversal':'Allocation'} · {item.amount} · {item.approval?.status??'Prepared'} · {item.intentId}</option>)}
    </select></label>}
    {state.bank?.prepared.hasMore&&<p className="text-sm">Showing the newest 50 of {state.bank.prepared.total} saved instructions. An instruction link can reopen older work.</p>}
    {selected&&<BankControlPlanSummary operation={selected} accounts={accounts} bankAmount={bankAmount}/>}
    {selected?.executed?<p className="font-medium text-emerald-500">This instruction has already been posted.</p>:<>
     {status==='pending'&&<div className="rounded bg-amber-500/10 p-3"><p className="font-medium">Awaiting independent approval</p><p className="text-sm">This instruction has not posted. Another authorized person can review it in Bank approvals.</p><a href={`/accounting/bank-control-approvals?approvalId=${selected?.approval?.id}`} className="text-sm underline">Open approval</a></div>}
     {status==='approved'&&<p className="text-sm text-emerald-500">Approved. Current permissions and source records will be checked again when you execute.</p>}
     {(status==='rejected'||status==='cancelled')&&<p className="text-sm">Approval {status}. Review the instruction before requesting another approval.</p>}
     {selected?.approvalVisibility==='denied'&&<p className="text-sm">Approval details require approval read permission.</p>}
     {state.requirements&&<p className="text-sm">{state.requirements.requiresApproval?'Independent approval is required.':'The current policy allows automatic approval of a request.'}</p>}
    </>}
    {reverse&&<fieldset className="space-y-2" disabled={busy}><legend className="font-medium">Prepare a reversal</legend>
     {!state.bank?.currentOriginalIntentId&&<p className="text-sm">A verified current controlled allocation is required before preparing a reversal.</p>}
     <label className="block text-sm">Reversal date<input type="date" value={reversalDate} onChange={event=>setReversalDate(event.target.value)} className="ml-2 rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2"/></label>
     <label className="block text-sm">Reason for reversal<textarea value={reason} maxLength={1000} onChange={event=>setReason(event.target.value)} className="mt-1 w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2"/></label>
    </fieldset>}
   </div>
   <footer className="flex flex-wrap gap-2 border-t border-[var(--ff-border-light)] p-4">
    <button className={button} onClick={()=>void workflow.refresh()} disabled={busy}>Refresh status</button>
    {(state.preparation||reverse)&&<button className={button} onClick={()=>void workflow.prepare(reverse?{reversalDate,reason}:undefined)} disabled={busy||(reverse&&(!reversalDate||!reason.trim()||!state.bank?.currentOriginalIntentId))}>{reverse?(selected?'Prepare new reversal':'Prepare reversal'):(selected?'Prepare new instruction':'Prepare allocation')}</button>}
    {selected&&!selected.executed&&selected.requesterIsCurrentPerson&&status!=='pending'&&status!=='approved'&&<button className={button} onClick={()=>void workflow.requestApproval()} disabled={busy}>Request approval</button>}
    {selected&&!selected.executed&&selected.requesterIsCurrentPerson&&status==='approved'&&<button className={`${button} bg-blue-600 text-white`} onClick={()=>void workflow.execute()} disabled={busy}>{reverse?'Execute approved reversal':'Execute approved allocation'}</button>}
   </footer>
  </section>
 </div>;
}
