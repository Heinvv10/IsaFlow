import {useEffect,useRef,useState} from 'react';
import type {BankPreparedOperation} from '@/modules/accounting/services/bank/bankControlReadService';
import {loadBankControlState,prepareBankControl,loadBankApprovalRequirements,requestBankApproval,executeSavedBankOperation,
 type BankControlState,type BankPreparation,type BankApprovalRequirements} from './bankControlClient';
export type BankWorkflowOutcome='posted'|'pending'|'cancelled';
export interface BankWorkflowInput {bankTransactionId:string;mode:'allocate'|'reverse';preparation?:BankPreparation;intentId?:string}
export interface BankWorkflowState extends BankWorkflowInput {
 id:number;bank:BankControlState|null;selected:BankPreparedOperation|null;requirements:BankApprovalRequirements|null;busy:boolean;error:string;
}
/** Local display state never substitutes for saved server intent, approval or execution checks. */
export function useBankControlWorkflow(){
 const [state,setState]=useState<BankWorkflowState|null>(null),current=useRef<BankWorkflowState|null>(null),sequence=useRef(0);
 const resolve=useRef<((outcome:BankWorkflowOutcome)=>void)|null>(null),mounted=useRef(true);
 const update=(value:BankWorkflowState|null)=>{current.current=value;if(mounted.current)setState(value);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;resolve.current?.('cancelled');resolve.current=null;current.current=null;};},[]);
 const patch=(id:number,value:Partial<BankWorkflowState>)=>{if(current.current?.id===id)update({...current.current,...value});};
 async function refreshSelection(id:number,intentId?:string){
  const active=current.current;if(!active||active.id!==id)return;
  const bank=await loadBankControlState({bankTransactionId:active.bankTransactionId,...(intentId?{intentId}:{})});
  const desired=active.mode==='reverse'?'bank_allocation.reverse':'bank_allocation.post';
  const selected=bank.selected??bank.prepared.items.find(item=>item.operation.operation===desired)??null;
  patch(id,{bank,selected,requirements:null,...(selected?{mode:selected.operation.operation==='bank_allocation.reverse'?'reverse' as const:'allocate' as const}:{})});
 }
 async function run(work:(active:BankWorkflowState)=>Promise<void>){
  const active=current.current;if(!active||active.busy)return;
  patch(active.id,{busy:true,error:''});
  try{await work(active);}catch(error){patch(active.id,{error:error instanceof Error?error.message:'Bank control request failed'});}
  finally{patch(active.id,{busy:false});}
 }
 function open(input:BankWorkflowInput):Promise<BankWorkflowOutcome>{
  if(current.current)return Promise.reject(new Error('Finish the open bank review first'));
  const id=++sequence.current;update({...input,id,bank:null,selected:null,requirements:null,busy:true,error:''});
  const outcome=new Promise<BankWorkflowOutcome>(done=>{resolve.current=done;});
  void refreshSelection(id,input.intentId).catch(error=>patch(id,{error:error instanceof Error?error.message:'Saved bank state unavailable'})).finally(()=>patch(id,{busy:false}));
  return outcome;
 }
 function finish(outcome:BankWorkflowOutcome){const done=resolve.current;resolve.current=null;update(null);done?.(outcome);}
 function close(){const active=current.current;if(!active||active.busy)return;finish(active.selected?.executed?'posted':active.selected?'pending':'cancelled');}
 const refresh=()=>run(active=>refreshSelection(active.id,active.selected?.intentId));
 const select=(intentId:string)=>run(active=>refreshSelection(active.id,intentId));
 const prepare=(inverse?:{reversalDate:string;reason:string})=>run(async active=>{
  let body=active.preparation;
  if(active.mode==='reverse'){
   if(!active.bank?.currentOriginalIntentId)throw new Error('The current allocation has no verified controlled original');
   if(!inverse?.reversalDate||!inverse.reason.trim())throw new Error('Enter the reversal date and reason');
   body={action:'prepare_reverse',bankTransactionId:active.bankTransactionId,originalIntentId:active.bank.currentOriginalIntentId,...inverse};
  }
  if(!body)throw new Error('Select an allocation instruction before preparing');
  const prepared=await prepareBankControl(body);
  if(prepared.bankTransactionId)patch(active.id,{bankTransactionId:prepared.bankTransactionId,bank:null,selected:null});
  await refreshSelection(active.id,prepared.intentId);
  const requirements=await loadBankApprovalRequirements(prepared.operation);patch(active.id,{requirements});
 });
 const requestApproval=()=>run(async active=>{
  if(!active.selected||active.selected.executed)throw new Error('Select an unexecuted saved instruction');
  const requirements=await loadBankApprovalRequirements(active.selected.operation);patch(active.id,{requirements});
  await requestBankApproval(active.selected.operation);await refreshSelection(active.id,active.selected.intentId);
 });
 const execute=()=>run(async active=>{
  if(!active.selected)throw new Error('Select an approved saved instruction');
  await executeSavedBankOperation(active.bankTransactionId,active.selected);finish('posted');
 });
 return{state,open,close,refresh,select,prepare,requestApproval,execute};
}
