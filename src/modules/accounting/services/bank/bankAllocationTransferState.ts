import Decimal from 'decimal.js';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {bankTransferPlanSchema,type BankTransferPlan} from './bankAllocationTransferPlan';
import {lockBankTransferPair,readBankTransferCandidates} from './bankAllocationTransferSources';
import {readExistingTransferFacts} from './bankTransferCandidateQueries';
import type {proveBankTransferCandidate} from './bankTransferCandidateProof';
type Row=Record<string,unknown>;
export type BankTransferOriginal=ReturnType<typeof proveBankTransferCandidate>;
export interface BankTransferState{
 bank:Row;sourceAccount:Row;sourceMetadata:Row;counterpartyAccount:Row;counterpartyMetadata:Row;ledger:Row;
 oppositeBank:Row|null;original:BankTransferOriginal|null;
 discovery:{oppositeCandidates:Row[];existingCandidates:BankTransferOriginal[]}|null;
}
const D=Decimal.clone({precision:80});
/** Review authority only; posting authority remains mandatory at preparation/execution entry points. */
export async function loadBankTransferState(ctx:ControlTx,input:BankTransferPlan,postExecution:boolean):Promise<BankTransferState>{
 assertControlTx(ctx);const plan=bankTransferPlanSchema.parse(JSON.parse(canonicalJson(input)));
 if(plan.transfer.mode==='post'&&plan.transfer.oppositeBankTransactionId===plan.bankTransactionId)throw new Error('Transfer opposite must differ');
 if(!postExecution){
  const state=await readBankTransferCandidates(ctx,{bankTransactionId:plan.bankTransactionId,counterpartyAccountId:plan.counterpartyAccountId},{authority:'read'});
  if(state.bank.status!=='imported')throw new Error('Transfer source is no longer imported');
  const {oppositeCandidates,existingCandidates,...fixed}=state;
  const opposite=oppositeCandidates[0]??null;
  if(plan.transfer.mode==='post'){
   if(state.existingCandidates.length||plan.transfer.oppositeBankTransactionId!==(opposite?.id??null))throw new Error('Transfer saved selection changed');
   return{...fixed,oppositeBank:opposite,original:null,discovery:{oppositeCandidates:state.oppositeCandidates,existingCandidates:state.existingCandidates}};
  }
  if(state.existingCandidates.length!==1||state.existingCandidates[0]!.originalIntentId!==plan.transfer.originalIntentId)throw new Error('Transfer saved original selection changed');
  return{...fixed,oppositeBank:null,original:state.existingCandidates[0]!,discovery:{oppositeCandidates:state.oppositeCandidates,existingCandidates:state.existingCandidates}};
 }
 await lockBankTransferPair(ctx,plan.bankTransactionId,plan.counterpartyAccountId,{authority:'read'});
 const company=ctx.principal.companyId;
 let originalIdentity:Row|undefined;
 if(plan.transfer.mode==='link'){
  const identities=await ctx.sql`SELECT i.bank_transaction_id,e.result->>'journalEntryId' AS journal_id FROM control_bank_allocation_intents i
   JOIN LATERAL(SELECT e.result FROM control_operation_effects e WHERE e.company_id=i.company_id AND e.entity_id_canonical=i.id::text
    AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post' OFFSET 0) e ON true
   WHERE i.company_id=${company}::uuid AND i.id=${plan.transfer.originalIntentId}::uuid LIMIT 2` as Row[];
  if(identities.length!==1)throw new Error('Saved transfer original receipt unavailable');originalIdentity=identities[0]!;
 }
 const oppositeId=plan.transfer.mode==='post'?plan.transfer.oppositeBankTransactionId:null;
 const ids=[...new Set([plan.bankTransactionId,...(oppositeId?[oppositeId]:[]),...(originalIdentity?[String(originalIdentity.bank_transaction_id)]:[])])].sort();
 const banks=await ctx.sql`SELECT *,amount::text,transaction_date::text FROM bank_transactions
  WHERE company_id=${company}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE` as Row[];
 const bank=banks.find(b=>b.id===plan.bankTransactionId),oppositeBank=oppositeId?banks.find(b=>b.id===oppositeId)??null:null;
 if(!bank||banks.length!==ids.length)throw new Error('Owned fixed transfer bank source unavailable');
 const signed=new D(String(bank.amount));
 if(!signed.isFinite()||signed.isZero()||!signed.mul(100).isInteger()||signed.abs().gte('100000000000000000000'))throw new Error('Transfer source must be nonzero exact cents');
 if(oppositeId&&(!oppositeBank||oppositeBank.bank_account_id!==plan.counterpartyAccountId||!new D(String(oppositeBank.amount)).eq(signed.neg())
  ||Math.abs(Date.parse(String(oppositeBank.transaction_date))-Date.parse(String(bank.transaction_date)))>2*86400000))throw new Error('Saved transfer opposite changed');
 const accountIds=[String(bank.bank_account_id),plan.counterpartyAccountId].sort();
 const accounts=await ctx.sql`SELECT id,company_id,account_code,account_name,account_type,account_subtype,is_active FROM gl_accounts
  WHERE company_id=${company}::uuid AND id=ANY(${accountIds}::uuid[]) ORDER BY id FOR SHARE` as Row[];
 const metadata=await ctx.sql`SELECT id,company_id,gl_account_id,currency,is_active FROM bank_accounts
  WHERE company_id=${company}::uuid AND gl_account_id=ANY(${accountIds}::uuid[]) ORDER BY id LIMIT 3 FOR SHARE` as Row[];
 const [ledger]=await ctx.sql`SELECT id,default_currency FROM companies WHERE id=${company}::uuid FOR SHARE` as Row[];
 if(accounts.length!==2||accounts.some(a=>a.is_active!==true||a.account_type!=='asset'||a.account_subtype!=='bank'))throw new Error('Owned active bank asset accounts required');
 if(metadata.length!==2||new Set(metadata.map(m=>m.gl_account_id)).size!==2||metadata.some(m=>m.currency!=='ZAR'||m.is_active!==true)||ledger?.default_currency!=='ZAR')throw new Error('Unambiguous active owned ZAR bank metadata required');
 let original:BankTransferOriginal|null=null;
 if(originalIdentity){
  original=await readExistingTransferFacts(ctx,bank,plan.counterpartyAccountId,{id:originalIdentity.journal_id},banks,String(bank.id));
  if(plan.transfer.mode!=='link'||original.originalIntentId!==plan.transfer.originalIntentId||bank.matched_journal_line_id!==original.destinationLineId
   ||bank.transfer_journal_entry_id!==original.journal.id||bank.counterparty_account_id!==plan.counterpartyAccountId||bank.allocation_type!=='transfer'
   ||!['allocated','matched','reconciled'].includes(String(bank.status)))throw new Error('Saved transfer destination occupation changed');
 }
 return{bank,sourceAccount:accounts.find(a=>a.id===bank.bank_account_id)!,sourceMetadata:metadata.find(m=>m.gl_account_id===bank.bank_account_id)!,
  counterpartyAccount:accounts.find(a=>a.id===plan.counterpartyAccountId)!,counterpartyMetadata:metadata.find(m=>m.gl_account_id===plan.counterpartyAccountId)!,ledger,
  oppositeBank,original,discovery:null};
}
