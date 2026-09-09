import type {ControlTx} from '../controls/contracts';
import {parseBankTransferRequest,type BankTransferPlan} from './bankAllocationTransferPlan';
import {parseBankAllocationPlan} from './bankAllocationPlan';
import {readBankTransferCandidates} from './bankAllocationTransferSources';
/** Selection is made once from locked owned facts, before any approval is requested. */
export async function bindBankTransferSelection(ctx:ControlTx,input:unknown):Promise<BankTransferPlan>{
 const request=parseBankTransferRequest(input);
 const sources=await readBankTransferCandidates(ctx,{bankTransactionId:request.bankTransactionId,counterpartyAccountId:request.counterpartyAccountId});
 if(sources.bank.status!=='imported')throw new Error('Imported transfer source required');
 if(sources.existingCandidates.length>1)throw new Error('Existing transfer match is ambiguous');
 const original=sources.existingCandidates[0];
 const transfer=original?{mode:'link' as const,originalIntentId:original.originalIntentId}
  :{mode:'post' as const,oppositeBankTransactionId:sources.oppositeCandidates[0]?String(sources.oppositeCandidates[0].id):null};
 return parseBankAllocationPlan({...request,transfer}) as BankTransferPlan;
}
