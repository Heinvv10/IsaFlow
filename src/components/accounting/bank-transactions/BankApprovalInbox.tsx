import {useEffect,useRef,useState} from 'react';
import {listBankApprovalPage} from './bankControlClient';
import type {ApprovalSummary} from '@/modules/accounting/services/controls/approvalQueries';
export function BankApprovalInbox(){
 const [items,setItems]=useState<ApprovalSummary[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const mounted=useRef(true),loading=useRef(false);
 async function load(next?:string){
  if(loading.current)return;loading.current=true;setBusy(true);setError('');
  try{const page=await listBankApprovalPage(next);if(!mounted.current)return;
   const bank=page.items.filter(item=>item.operation==='bank_allocation.post'||item.operation==='bank_allocation.reverse');
   setItems(previous=>next?[...previous,...bank.filter(item=>!previous.some(old=>old.id===item.id))]:bank);setCursor(page.nextCursor);
  }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'Could not load bank approvals');}
  finally{loading.current=false;if(mounted.current)setBusy(false);}
 }
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;};},[]);
 return <section className="space-y-4">
  <p className="text-sm">Review exact saved instructions. Requesters execute approved instructions separately.</p>
  {error&&<p role="alert" className="text-red-500">{error}</p>}
  <ul className="divide-y divide-[var(--ff-border-light)] rounded-xl border border-[var(--ff-border-light)]">
   {items.map(item=><li key={item.id} className="p-4"><a className="text-blue-500 underline" href={`/accounting/bank-control-approvals?approvalId=${item.id}`}>{item.operation==='bank_allocation.reverse'?'Reversal':'Allocation'} · {item.entityId}</a><p className="mt-1 text-sm">{item.status} · Requested {item.requestedAt}</p></li>)}
  </ul>
  {!busy&&!error&&!items.length&&<p>{cursor?'No bank approvals on the loaded pages. More authorized approvals are available.':'No bank approvals found.'}</p>}
  {busy&&<p role="status">Loading approvals…</p>}
  {cursor&&<button className="rounded-md border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={()=>void load(cursor)}>Load more approvals</button>}
  {error&&<button className="rounded-md border px-3 py-2" disabled={busy} onClick={()=>void load(cursor??undefined)}>Retry loading approvals</button>}
 </section>;
}
