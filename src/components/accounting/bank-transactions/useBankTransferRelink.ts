import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '@/lib/apiFetch';
export interface PendingBankTransfer {bankTransactionId:string;intentId:string;approvalId:string}
interface RelinkState {pending:PendingBankTransfer[];failed:boolean;linked:number}
const empty=():RelinkState=>({pending:[],failed:false,linked:0});
function readResult(value:unknown):RelinkState{
 if(!value||typeof value!=='object')throw new Error('Transfer preparation response unavailable');
 const data=value as Record<string,unknown>,pending=data.pending??[];
 if(!Number.isSafeInteger(data.linked)||Number(data.linked)<0||typeof data.failed!=='boolean'||!Array.isArray(pending)
  ||pending.some(row=>!row||typeof row!=='object'||['bankTransactionId','intentId','approvalId'].some(key=>typeof row[key]!=='string'||!row[key])))throw new Error('Invalid transfer preparation response');
 return{pending:pending.map(row=>({bankTransactionId:row.bankTransactionId,intentId:row.intentId,approvalId:row.approvalId})),failed:data.failed,linked:Number(data.linked)};
}
/** Preparation is nonfatal to bank browsing; failures and saved work remain visible. */
export function useBankTransferRelink(bankAccountId:string){
 const [state,setState]=useState<RelinkState>(empty),[revision,setRevision]=useState(0);
 const refresh=useCallback(()=>setRevision(value=>value+1),[]);
 useEffect(()=>{
  let cancelled=false;const abort=new AbortController();setState(empty());
  if(!bankAccountId)return()=>{cancelled=true;abort.abort();};
  void apiFetch('/api/accounting/bank-relink-transfers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bankAccountId}),signal:abort.signal})
   .then(async response=>{
    if(!response.ok)throw new Error('Transfer preparation refused');
    const body=await response.json();if(body.success===false)throw new Error('Transfer preparation refused');
    const result=readResult(body.data);if(!cancelled)setState(result);
   }).catch(()=>{if(!cancelled)setState({...empty(),failed:true});});
  return()=>{cancelled=true;abort.abort();};
 },[bankAccountId,revision]);
 return{...state,refresh};
}
