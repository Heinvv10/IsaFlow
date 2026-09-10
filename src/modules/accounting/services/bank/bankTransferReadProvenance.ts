import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {sameIntentId} from '../controls/intentIdentity';
import type {ControlTx} from '../controls/contracts';
import {matchesBankAllocationJournalLines} from '../controls/bankAllocationJournalShape';
import {buildBankAllocationLines,parseBankAllocationPlan} from './bankAllocationPlan';
import type {BankControlRow} from './bankControlReadProvenance';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** Current retained identity proof only: no discovery, posting authority or live business material. */
export async function readBankTransferOriginal(ctx:ControlTx,current:BankControlRow){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:bank-tx');const company=ctx.principal.companyId;
 const [journal]=await ctx.sql`SELECT j.id,j.source,j.source_record_id,j.status,j.reversed_at,j.entry_date::text
  FROM gl_journal_lines l JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id
  WHERE l.company_id=${company}::uuid AND l.id=${current.matched_journal_line_id}::uuid AND j.source='auto_bank_transfer'` as Row[];
 if(!journal){
  // A saved initial opposite has no separate parent receipt of its own.
  const known=await ctx.sql`SELECT lower(e.entity_id) AS entity_id FROM control_operation_effects e JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=lower(e.entity_id)
   JOIN gl_journal_entries j ON j.company_id=e.company_id AND j.id::text=e.result->>'journalEntryId'
   WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
    AND i.payload->>'kind'='transfer' AND i.payload->'transfer'->>'oppositeBankTransactionId'=${current.id}
    AND j.reversed_at IS NULL LIMIT 1`;
  if(known.length)throw new Error('Controlled transfer saved opposite pointer is inconsistent');return null;
 }
 const receipts=await ctx.sql`SELECT lower(e.entity_id) AS entity_id,e.result,i.payload,i.bank_transaction_id,i.accounting_date::text,i.amount::text,i.currency,
  EXISTS(SELECT 1 FROM control_change_events c WHERE c.company_id=${company}::uuid AND c.entity_type=e.entity_type AND lower(c.entity_id)=lower(e.entity_id)
   AND c.action=e.operation AND c.operation_id=e.operation_id AND c.binding_hash=e.binding_hash) AS audited
  FROM control_operation_effects e LEFT JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=lower(e.entity_id)
  WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
   AND e.result->>'journalEntryId'=${journal.id}::text ORDER BY lower(e.entity_id) LIMIT 3` as Row[];
 // The existing reader distinguishes genuinely unavailable legacy provenance from missing controlled history.
 if(!receipts.length)return null;
 if(receipts.length>2||journal.status!=='posted'||journal.reversed_at)throw new Error('Controlled transfer receipt population is inconsistent');
 const parsed=receipts.map(receipt=>({receipt,plan:parseBankAllocationPlan(receipt.payload)}));
 const originals=parsed.filter(item=>item.plan.kind==='transfer'&&item.plan.transfer.mode==='post');
 if(originals.length!==1)throw new Error('Controlled transfer original receipt is missing or ambiguous');
 const {receipt:original,plan}=originals[0]!;
 if(plan.kind!=='transfer'||plan.transfer.mode!=='post')throw new Error('Controlled transfer post intent required');
 const rootId=String(original.entity_id),result=original.result as Row;
 if(original.audited!==true||original.currency!=='ZAR'||original.bank_transaction_id!==plan.bankTransactionId||journal.source_record_id!==plan.bankTransactionId
  ||!sameIntentId(result.intentId,rootId)||result.bankTransactionId!==plan.bankTransactionId||result.journalEntryId!==journal.id||result.paymentId!==null
  ||result.status!=='allocated'||result.oppositeBankTransactionId!==plan.transfer.oppositeBankTransactionId)throw new Error('Controlled transfer original receipt is inconsistent');
 const related=await ctx.sql`SELECT lower(e.entity_id) AS entity_id,e.result,i.payload,i.bank_transaction_id,i.accounting_date::text,i.amount::text,i.currency,
  EXISTS(SELECT 1 FROM control_change_events c WHERE c.company_id=${company}::uuid AND c.entity_type=e.entity_type AND lower(c.entity_id)=lower(e.entity_id)
   AND c.action=e.operation AND c.operation_id=e.operation_id AND c.binding_hash=e.binding_hash) AS audited
  FROM control_operation_effects e LEFT JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=lower(e.entity_id)
  WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
   AND (i.payload->'transfer'->>'originalIntentId'=${rootId} OR lower(e.result->>'originalIntentId')=${rootId}) ORDER BY lower(e.entity_id) LIMIT 2` as Row[];
 const links=new Map(parsed.filter(item=>item.receipt.entity_id!==rootId).map(item=>[item.receipt.entity_id,item]));
 for(const receipt of related)links.set(receipt.entity_id,{receipt,plan:parseBankAllocationPlan(receipt.payload)});
 if(links.size>1)throw new Error('Controlled transfer late link population is inconsistent');
 const late=[...links.values()][0];let oppositeId=plan.transfer.oppositeBankTransactionId;
 if(late){
  const saved=late.plan,r=late.receipt.result as Row;
  if(oppositeId!==null||saved.kind!=='transfer'||saved.transfer.mode!=='link'||saved.transfer.originalIntentId!==rootId
   ||late.receipt.audited!==true||late.receipt.currency!=='ZAR'||late.receipt.bank_transaction_id!==saved.bankTransactionId
   ||!sameIntentId(r.intentId,String(late.receipt.entity_id))||!sameIntentId(r.originalIntentId,rootId)||r.bankTransactionId!==saved.bankTransactionId||r.journalEntryId!==journal.id
   ||r.oppositeBankTransactionId!==plan.bankTransactionId||r.paymentId!==null||r.status!=='allocated')throw new Error('Controlled transfer late link receipt is inconsistent');
  oppositeId=saved.bankTransactionId;
 }
 const ids=[plan.bankTransactionId,...(oppositeId?[oppositeId]:[])];
 if(new Set(ids).size!==ids.length||!ids.includes(current.id))throw new Error('Controlled transfer feed association is inconsistent');
 const banks=await ctx.sql`SELECT id,bank_account_id,amount::text,transaction_date::text,status,matched_journal_line_id,transfer_journal_entry_id,counterparty_account_id,allocation_type
  FROM bank_transactions WHERE company_id=${company}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id` as Row[];
 const bank=banks.find(b=>b.id===plan.bankTransactionId);
 if(banks.length!==ids.length||!bank)throw new Error('Owned controlled transfer feed is missing');
 const signed=new D(String(bank.amount));
 if(!signed.isFinite()||signed.isZero()||!signed.mul(100).isInteger()||signed.abs().gte('100000000000000000000')
  ||!signed.abs().eq(String(original.amount))||original.accounting_date!==bank.transaction_date||journal.entry_date!==bank.transaction_date)throw new Error('Controlled transfer original money or date changed');
 const lines=await ctx.sql`SELECT l.id,l.gl_account_id,l.debit::text,l.credit::text,l.vat_type,l.cost_center_id,l.cc1_id,l.cc2_id,l.bu_id,a.id AS owned_account_id,a.account_type,a.account_subtype
  FROM gl_journal_lines l LEFT JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
  WHERE l.company_id=${company}::uuid AND l.journal_entry_id=${journal.id}::uuid ORDER BY l.id LIMIT 3` as (Row&Parameters<typeof matchesBankAllocationJournalLines>[1][number])[];
 const expected=buildBankAllocationLines(plan,{bankAccountId:String(bank.bank_account_id),signedAmount:signed.toFixed(),controlAccountId:null,vatAccountId:null});
 if(lines.length!==2||lines.some(l=>!l.owned_account_id||l.account_type!=='asset'||l.account_subtype!=='bank')||!matchesBankAllocationJournalLines(expected,lines))throw new Error('Controlled transfer journal economics changed');
 for(const row of banks){
  const isOriginal=row.id===plan.bankTransactionId,account=isOriginal?bank.bank_account_id:plan.counterpartyAccountId;
  const line=lines.find(l=>l.gl_account_id===account),other=lines.find(l=>l.gl_account_id!==account);
  if(row.bank_account_id!==account||!new D(String(row.amount)).eq(signed.mul(isOriginal?1:-1))
   ||Math.abs(Date.parse(String(row.transaction_date))-Date.parse(String(bank.transaction_date)))>2*86400000
   ||!['allocated','matched','reconciled'].includes(String(row.status))||row.allocation_type!=='transfer'||row.matched_journal_line_id!==line?.id
   ||row.transfer_journal_entry_id!==journal.id||row.counterparty_account_id!==other?.gl_account_id)throw new Error('Controlled transfer current feed changed');
 }
 if(late){
  const saved=late.plan,opposite=banks.find(b=>b.id===oppositeId)!;
  if(saved.kind!=='transfer'||saved.counterpartyAccountId!==bank.bank_account_id||late.receipt.accounting_date!==opposite.transaction_date
   ||!new D(String(late.receipt.amount)).eq(signed.abs()))throw new Error('Controlled transfer late intent economics changed');
 }
 const actual=banks.find(b=>b.id===current.id)!;
 if(actual.bank_account_id!==current.bank_account_id||actual.status!==current.status||actual.matched_journal_line_id!==current.matched_journal_line_id
  ||!new D(String(actual.amount)).eq(current.amount)||actual.transaction_date!==fmtDate(current.transaction_date))throw new Error('Controlled transfer reader source changed');
 const occupants=await ctx.sql`SELECT id FROM bank_transactions WHERE company_id=${company}::uuid
  AND (matched_journal_line_id=ANY(${lines.map(l=>l.id)}::uuid[]) OR transfer_journal_entry_id=${journal.id}::uuid) ORDER BY id LIMIT 3` as Row[];
 if(occupants.length!==ids.length||occupants.some(row=>!ids.includes(String(row.id))))throw new Error('Unexplained controlled transfer occupation');
 return{currentOriginalIntentId:rootId,legacyProvenanceUnavailable:false};
}
