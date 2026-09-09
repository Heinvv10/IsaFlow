import {useEffect,useRef} from 'react';
import {useRouter} from 'next/router';
import {notify} from '@/utils/toast';
import type {BankWorkflowInput,BankWorkflowOutcome} from './useBankControlWorkflow';
interface ResumeWorkflow {state:{id:number;bankTransactionId:string;selected:{intentId:string}|null}|null;open:(input:BankWorkflowInput)=>Promise<BankWorkflowOutcome>}
/** URL IDs are only pointers: the workflow always reloads the owned saved plan. */
export function useBankControlResume(workflow:ResumeWorkflow,onPosted:()=>void){
 const router=useRouter(),initialized=useRef(false),hadState=useRef(false),latest=useRef({workflow,onPosted});
 useEffect(()=>{latest.current={workflow,onPosted};},[workflow,onPosted]);
 useEffect(()=>{
  if(!router.isReady||initialized.current)return;initialized.current=true;
  const bankTransactionId=router.query.bankControlBank,intentId=router.query.bankControlIntent;
  if(typeof bankTransactionId!=='string'||typeof intentId!=='string')return;
  void latest.current.workflow.open({bankTransactionId,intentId,mode:'allocate'})
   .then(outcome=>{if(outcome==='posted')latest.current.onPosted();})
   .catch((cause:unknown)=>notify.error(cause instanceof Error?cause.message:'Could not resume saved instruction'));
 },[router.isReady,router.query.bankControlBank,router.query.bankControlIntent]);
 const state=workflow.state;
 useEffect(()=>{
  if(!router.isReady||!initialized.current)return;
  if(state)hadState.current=true;
  const query={...router.query};
  if(state?.selected){
   if(query.bankControlBank===state.bankTransactionId&&query.bankControlIntent===state.selected.intentId)return;
   query.bankControlBank=state.bankTransactionId;query.bankControlIntent=state.selected.intentId;
  }else if(!state&&hadState.current){
   if(!query.bankControlBank&&!query.bankControlIntent)return;
   delete query.bankControlBank;delete query.bankControlIntent;
  }else return;
  void router.replace({pathname:router.pathname,query},undefined,{shallow:true})
   .catch((cause:unknown)=>notify.error(cause instanceof Error?cause.message:'Could not save instruction link'));
 },[state,router]);
}
