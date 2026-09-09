import {useEffect,useRef,useState} from 'react';
import {decideBankApproval,loadBankControlState,type BankControlState} from './bankControlClient';
import {BankControlPlanSummary} from './BankControlPlanSummary';
const button='rounded-md border border-[var(--ff-border-light)] px-3 py-2 text-sm disabled:opacity-50';
export function BankApprovalDetail({approvalId}:{approvalId:string}){
 const [state,setState]=useState<BankControlState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const current=useRef<AbortController|null>(null);
 useEffect(()=>{const controller=new AbortController();current.current=controller;setState(null);setBusy(true);setError('');
  void loadBankControlState({approvalId},controller.signal).then(value=>{if(!controller.signal.aborted)setState(value);})
   .catch((cause:unknown)=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'Could not load approval');})
   .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
  return()=>controller.abort();
 },[approvalId]);
 const selected=state?.selected,approval=selected?.approval;
 async function decide(decision:'approved'|'rejected'){
  const controller=current.current;
  if(!controller||busy||!selected||selected.requesterIsCurrentPerson||approval?.id!==approvalId||approval.status!=='pending')return;
  setBusy(true);setError('');
  try{await decideBankApproval(approvalId,decision);const value=await loadBankControlState({approvalId},controller.signal);if(!controller.signal.aborted)setState(value);}
  catch(cause){if(!controller.signal.aborted){setState(null);setError(cause instanceof Error?cause.message:'Decision failed; reload the approval');}}
  finally{if(!controller.signal.aborted)setBusy(false);}
 }
 return <section className="space-y-4 rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-5">
  <h2 className="text-lg font-semibold">Review saved bank instruction</h2>
  {busy&&<p role="status">Loading current approval…</p>}{error&&<p role="alert" className="text-red-500">{error}</p>}
  {selected&&approval?.id===approvalId&&<>
   <BankControlPlanSummary operation={selected} bankAmount={state?.bankAmount}/>
   <p>Approval status: <strong>{approval.status}</strong></p>
   {selected.requesterIsCurrentPerson&&<p>You requested this instruction. Another authorized person must decide it.</p>}
   {approval.status==='pending'&&<div className="flex gap-2">
    <button className={`${button} bg-blue-600 text-white`} disabled={busy||selected.requesterIsCurrentPerson} onClick={()=>void decide('approved')}>Approve instruction</button>
    <button className={button} disabled={busy||selected.requesterIsCurrentPerson} onClick={()=>void decide('rejected')}>Reject instruction</button>
   </div>}
   <p className="text-sm">Approval does not post the transaction. The requester must execute the saved instruction after approval.</p>
   {selected.requesterIsCurrentPerson&&<a className="text-blue-500 underline" href={`/accounting/bank-transactions?bankControlBank=${state!.bankTransactionId}&bankControlIntent=${selected.intentId}`}>Resume saved bank instruction</a>}
  </>}
 </section>;
}
