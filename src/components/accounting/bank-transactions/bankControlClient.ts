import {apiFetch} from '@/lib/apiFetch';
import type {RowSelection,VatCode} from '../BankTxTable';
import type {BankPreparedOperation,readBankControlState} from '@/modules/accounting/services/bank/bankControlReadService';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import type {ApprovalSummary} from '@/modules/accounting/services/controls/approvalQueries';
import type {getApprovalRequirements} from '@/modules/accounting/services/controls/approvalRequestService';
export type BankControlState=Awaited<ReturnType<typeof readBankControlState>>;
export type BankApprovalRequirements=Awaited<ReturnType<typeof getApprovalRequirements>>;
export type BankPreparation=Record<string,unknown>;
export interface BankSplitPreparationLine {contraAccountId:string;amount:string;vatCode:VatCode;description?:string;cc1Id?:string;cc2Id?:string;buId?:string}
async function request<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const response=await apiFetch(url,{method:body===undefined?'GET':'POST',credentials:'include',headers:body===undefined?undefined:{'Content-Type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
 const json=await response.json();
 if(!response.ok||json.success===false)throw new Error(json.error?.message??json.message??'Bank control request failed');
 return json.data as T;
}
export function buildBankAllocationPreparation(bankTransactionId:string,selection:RowSelection):BankPreparation{
 if(!selection.entityId)throw new Error('Select an account, customer or supplier first');
 if(selection.type==='transfer')return{action:'prepare_allocate',bankTransactionId,allocationType:'transfer',contraAccountId:selection.entityId};
 const dimensions={...(selection.cc1Id?{cc1Id:selection.cc1Id}:{}),...(selection.cc2Id?{cc2Id:selection.cc2Id}:{}),...(selection.buId?{buId:selection.buId}:{})};
 return{action:'prepare_allocate',bankTransactionId,allocationType:selection.type,...dimensions,
  ...(selection.type==='account'?{contraAccountId:selection.entityId,vatCode:selection.vatCode??'none'}:{entityId:selection.entityId})};
}
export function buildBankSplitPreparation(bankTransactionId:string,lines:BankSplitPreparationLine[]){
 if(!lines.length||lines.length>100||lines.some(line=>!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(line.amount)))throw new Error('Enter exact split amounts with at most two decimal places');
 return{action:'prepare_split_allocate' as const,bankTransactionId,lines:lines.map(line=>({...line}))};
}
export function loadBankControlState(query:{bankTransactionId?:string;intentId?:string;approvalId?:string},signal?:AbortSignal){
 const params=new URLSearchParams();for(const [key,value]of Object.entries(query))if(value)params.set(key,value);
 return request<BankControlState>(`/api/accounting/bank-control-state?${params}`,undefined,signal);
}
export function prepareBankControl(body:BankPreparation){return request<{intentId:string;operation:OperationRef;bankTransactionId?:string}>('/api/accounting/bank-transactions-action',body);}
export function loadBankApprovalRequirements(ref:OperationRef){return request<BankApprovalRequirements>('/api/accounting/control-approvals',{action:'requirements',ref});}
export function requestBankApproval(ref:OperationRef){return request<ApprovalSummary>('/api/accounting/control-approvals',{action:'request',ref});}
export function decideBankApproval(approvalId:string,decision:'approved'|'rejected'){return request<ApprovalSummary>('/api/accounting/control-approvals',{action:'decide',approvalId,decision});}
export function listBankApprovalPage(cursor?:string){const params=new URLSearchParams({limit:'100'});if(cursor)params.set('cursor',cursor);
 return request<{items:ApprovalSummary[];nextCursor:string|null}>(`/api/accounting/control-approvals?${params}`);}
export async function executeSavedBankOperation(bankTransactionId:string,operation:BankPreparedOperation){
 const approval=operation.approval,ref=operation.operation;
 if(operation.plan.bankTransactionId!==bankTransactionId||!operation.requesterIsCurrentPerson||!approval||approval.status!=='approved'
  ||approval.entityId!==operation.intentId||approval.entityType!==ref.entityType||approval.operation!==ref.operation)throw new Error('An approved instruction from the current requester is required');
 const action=ref.operation==='bank_allocation.reverse'?'reverse':'kind' in operation.plan&&operation.plan.kind==='split'?'split_allocate':'allocate';
 const result=await request<{bankTransactionId:string;journalEntryId?:string;reversalJournalEntryId?:string}>('/api/accounting/bank-transactions-action',{
  action,bankTransactionId,intent_id:operation.intentId,approval_id:approval.id});
 if(result.bankTransactionId!==bankTransactionId||typeof(action==='reverse'?result.reversalJournalEntryId:result.journalEntryId)!=='string')throw new Error('Bank execution receipt is unavailable; refresh the saved instruction');
 return result;
}
