import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import type {ControlTx} from '../controls/contracts';
import {sameIntentId} from '../controls/intentIdentity';
import {parseBankAllocationPlan} from './bankAllocationPlan';
import type {BankTransferPlan} from './bankAllocationTransferPlan';
import {loadBankAllocationIntent} from './bankAllocationMaterial';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** A separately approved late link always reverses the canonical original posting. */
export async function resolveBankTransferOriginal(ctx:ControlTx,id:string):Promise<string>{
 const [intent]=await ctx.sql`SELECT payload FROM control_bank_allocation_intents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as Row[];
 if(!intent)throw new Error('Original controlled allocation intent required');
 const plan=parseBankAllocationPlan(intent.payload);
 if(plan.kind!=='transfer'||plan.transfer.mode==='post')return id;
 const state=await loadBankAllocationIntent(ctx,id);
 if(!state.effect||!state.sources.transfer?.original)throw new Error('Executed controlled transfer link required');
 return plan.transfer.originalIntentId;
}
/** Enumerate immutable associations, never fresh economic candidates, including after reversal. */
export async function loadBankTransferOriginalBanks(ctx:ControlTx,intent:Row,plan:BankTransferPlan,journal:Row,lines:Row[]){
 if(plan.transfer.mode!=='post')throw new Error('Canonical original transfer posting required');
 const company=ctx.principal.companyId;
 const receipts=await ctx.sql`SELECT lower(e.entity_id) AS entity_id,e.result,i.payload,i.bank_transaction_id,i.accounting_date::text,i.amount::text,
  EXISTS(SELECT 1 FROM control_change_events c WHERE c.company_id=${company}::uuid AND c.entity_type=e.entity_type AND c.entity_id_canonical=e.entity_id_canonical
   AND c.action=e.operation AND c.operation_id=e.operation_id AND c.binding_hash=e.binding_hash) AS audited
  FROM control_operation_effects e JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=e.entity_id_canonical
  WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
   AND (e.entity_id_canonical=${intent.id}::text OR e.result->>'journalEntryId'=${journal.id}::text
    OR lower(i.payload->'transfer'->>'originalIntentId')=${intent.id}::text) ORDER BY lower(e.entity_id) LIMIT 3` as Row[];
 if(new Set(receipts.map(r=>String(r.entity_id))).size!==receipts.length)throw new Error('Ambiguous operation receipt');
 const original=receipts.find(r=>r.entity_id===intent.id),links=receipts.filter(r=>r.entity_id!==intent.id);
 if(!original||original.audited!==true||receipts.length>2||links.length>1
  ||(plan.transfer.oppositeBankTransactionId!==null&&links.length))throw new Error('Transfer controlled receipt association changed');
 const result=original.result as Row;
 if(!sameIntentId(result.intentId,String(intent.id))||result.bankTransactionId!==plan.bankTransactionId||result.journalEntryId!==journal.id
  ||result.paymentId!==null||result.status!=='allocated'||result.oppositeBankTransactionId!==plan.transfer.oppositeBankTransactionId)throw new Error('Original transfer receipt changed');
 let oppositeId=plan.transfer.oppositeBankTransactionId;
 const late=links[0];
 if(late){
  const saved=parseBankAllocationPlan(late.payload),r=late.result as Row;
  if(saved.kind!=='transfer'||saved.transfer.mode!=='link'||!sameIntentId(saved.transfer.originalIntentId,String(intent.id))||late.audited!==true
   ||saved.bankTransactionId!==late.bank_transaction_id||!sameIntentId(r.intentId,String(late.entity_id))||!sameIntentId(r.originalIntentId,String(intent.id))
   ||r.bankTransactionId!==saved.bankTransactionId||r.journalEntryId!==journal.id||r.oppositeBankTransactionId!==plan.bankTransactionId
   ||r.paymentId!==null||r.status!=='allocated')throw new Error('Late transfer link receipt changed');
  oppositeId=saved.bankTransactionId;
 }
 const ids=[plan.bankTransactionId,...(oppositeId?[oppositeId]:[])].sort();
 if(new Set(ids).size!==ids.length)throw new Error('Transfer bank associations must differ');
 const banks=await ctx.sql`SELECT *,amount::text,transaction_date::text FROM bank_transactions WHERE company_id=${company}::uuid
  AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE` as Row[];
 if(banks.length!==ids.length)throw new Error('Owned transfer bank association missing');
 const bank=banks.find(b=>b.id===plan.bankTransactionId)!;
 for(const row of banks){
  const isOriginal=row.id===plan.bankTransactionId;
  if(row.bank_account_id!==(isOriginal?bank.bank_account_id:plan.counterpartyAccountId)
   ||!new D(String(row.amount)).eq(new D(String(bank.amount)).mul(isOriginal?1:-1))
   ||Math.abs(Date.parse(String(row.transaction_date))-Date.parse(String(bank.transaction_date)))>2*86400000)throw new Error('Original transfer bank economics changed');
 }
 if(late){
  const saved=parseBankAllocationPlan(late.payload),opposite=banks.find(b=>b.id===oppositeId)!;
  if(saved.kind!=='transfer'||saved.counterpartyAccountId!==bank.bank_account_id
   ||late.accounting_date!==fmtDate(opposite.transaction_date as string|Date)||!new D(String(late.amount)).eq(new D(String(bank.amount)).abs()))throw new Error('Late transfer intent economics changed');
 }
 const occupants=await ctx.sql`SELECT id FROM bank_transactions WHERE company_id=${company}::uuid
  AND (matched_journal_line_id=ANY(${lines.map(l=>l.id)}::uuid[]) OR transfer_journal_entry_id=${journal.id}::uuid) ORDER BY id LIMIT 3` as Row[];
 if(occupants.some(row=>!ids.includes(String(row.id)))||occupants.length>ids.length)throw new Error('Unapproved transfer journal occupation');
 return{banks,receipts};
}
export function assertTransferBankLinks(banks:Row[],journal:Row,lines:Row[],reversed:boolean){
 for(const bank of banks){
  if(reversed){
   if(bank.status!=='imported'||bank.matched_journal_line_id!==null||bank.transfer_journal_entry_id!==null||bank.counterparty_account_id!==null||bank.allocation_type!==null)throw new Error('Transfer inverse bank state changed');
  }else{
   const leg=lines.find(line=>line.gl_account_id===bank.bank_account_id),other=lines.find(line=>line.gl_account_id!==bank.bank_account_id);
   if(!leg||!other||!['allocated','matched','reconciled'].includes(String(bank.status))||bank.matched_journal_line_id!==leg.id
    ||bank.transfer_journal_entry_id!==journal.id||bank.counterparty_account_id!==other.gl_account_id||bank.allocation_type!=='transfer')throw new Error('Original transfer link changed');
  }
 }
}
