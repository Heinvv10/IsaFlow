import {readBankTransferOriginal} from './bankTransferReadProvenance';
import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import type {ControlTx} from '../controls/contracts';
import {sameIntentId} from '../controls/intentIdentity';
import {matchesBankAllocationJournalLines} from '../controls/bankAllocationJournalShape';
import {buildBankAllocationLines,parseBankAllocationPlan} from './bankAllocationPlan';
type Row=Record<string,unknown>;
export interface BankControlRow {id:string;status:string;amount:string;transaction_date:Date|string;bank_account_id:string;matched_journal_line_id:string|null}
/** Uses only owned bank/journal/intent/receipt facts, never live beneficiary or invoice material. */
export async function readBankCurrentOriginal(ctx:ControlTx,bank:BankControlRow){
 const transfer=await readBankTransferOriginal(ctx,bank);if(transfer)return transfer;
 const company=ctx.principal.companyId;
 const effects=await ctx.sql`SELECT lower(e.entity_id) AS entity_id,e.result,e.binding_hash,e.operation_id,i.payload,i.bank_transaction_id,i.accounting_date::text,i.amount::text,
  j.id AS journal_id,j.entry_date,j.status AS journal_status,j.reversed_at,j.source,j.source_record_id,
  EXISTS(SELECT 1 FROM control_change_events c WHERE c.company_id=${company}::uuid AND c.entity_type=e.entity_type AND lower(c.entity_id)=lower(e.entity_id)
   AND c.action=e.operation AND c.operation_id=e.operation_id AND c.binding_hash=e.binding_hash) AS audited
  FROM control_operation_effects e LEFT JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=lower(e.entity_id)
  LEFT JOIN gl_journal_entries j ON j.company_id=e.company_id AND j.id::text=e.result->>'journalEntryId'
  WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
   AND (i.bank_transaction_id=${bank.id}::uuid OR e.result->>'bankTransactionId'=${bank.id}
    OR EXISTS(SELECT 1 FROM gl_journal_lines m WHERE m.company_id=${company}::uuid AND m.id=${bank.matched_journal_line_id}::uuid AND m.journal_entry_id::text=e.result->>'journalEntryId'))
   AND (j.id IS NULL OR j.reversed_at IS NULL) LIMIT 2` as (Row&{result:{intentId:string;bankTransactionId:string;journalEntryId:string}})[];
 if(!effects.length){
  const history=await ctx.sql`SELECT c.id FROM gl_journal_lines l JOIN control_change_events c ON c.company_id=l.company_id
    AND c.entity_type='journal_entry' AND lower(c.entity_id)=l.journal_entry_id::text AND c.action='journal.post'
   WHERE l.company_id=${company}::uuid AND l.id=${bank.matched_journal_line_id}::uuid
    AND EXISTS(SELECT 1 FROM control_change_events p WHERE p.company_id=${company}::uuid AND p.operation_id=c.operation_id
     AND ((p.entity_type='bank_allocation_intent' AND p.action='bank_allocation.post')
      OR (p.entity_type='bank_transaction' AND lower(p.entity_id)=${bank.id} AND p.action='bank_allocation.posted'))) LIMIT 1`;
  if(history.length)throw new Error('Controlled bank allocation receipt is missing from provenance');
  return{currentOriginalIntentId:null,legacyProvenanceUnavailable:bank.matched_journal_line_id!==null||['allocated','matched','reconciled'].includes(bank.status)};
 }
 const e=effects[0]!;
 if(effects.length!==1||!e.payload||e.audited!==true||!sameIntentId(e.result.intentId,String(e.entity_id))||e.result.bankTransactionId!==bank.id
  ||e.bank_transaction_id!==bank.id||e.journal_status!=='posted'||!bank.matched_journal_line_id||!['allocated','matched','reconciled'].includes(bank.status)
  ||e.source_record_id!==bank.id||e.accounting_date!==fmtDate(bank.transaction_date)||e.accounting_date!==fmtDate(e.entry_date as Date|string)
  ||!new Decimal(bank.amount).abs().eq(String(e.amount)))throw new Error('Controlled bank provenance is inconsistent');
 const plan=parseBankAllocationPlan(e.payload);
 if(plan.bankTransactionId!==bank.id||e.source!==(plan.kind==='customer'?'auto_payment':plan.kind==='supplier'?'auto_supplier_payment':'auto_bank_recon'))throw new Error('Controlled bank intent is inconsistent');
 const lines=await ctx.sql`SELECT l.id,l.gl_account_id,l.debit::text,l.credit::text,l.vat_type,l.cost_center_id,l.cc1_id,l.cc2_id,l.bu_id,a.id AS owned_account_id,a.account_type,a.account_subtype,a.is_system_account
  FROM gl_journal_lines l LEFT JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
  WHERE l.company_id=${company}::uuid AND l.journal_entry_id=${e.journal_id}::uuid ORDER BY l.id LIMIT 302` as (Row&Parameters<typeof matchesBankAllocationJournalLines>[1][number])[];
 if(lines.some(l=>l.owned_account_id===null))throw new Error('Controlled bank journal account ownership is inconsistent');
 if(!lines.some(l=>l.id===bank.matched_journal_line_id&&l.gl_account_id===bank.bank_account_id))throw new Error('Controlled bank matched line is inconsistent');
 const accountFor=(subtype:string,type:string)=>{const ids=[...new Set(lines.filter(l=>l.is_system_account===true&&l.account_subtype===subtype&&l.account_type===type).map(l=>String(l.gl_account_id)))];
  if(ids.length!==1)throw new Error('Controlled bank journal account is ambiguous');return ids[0]!;};
 const controlAccountId=plan.kind==='customer'?accountFor('receivable','asset'):plan.kind==='supplier'?accountFor('payable','liability'):null;
 const spent=new Decimal(bank.amount).lt(0);
 const vatAccountId='lines' in plan&&plan.lines.some(l=>l.vatCode==='standard')?(plan.vatAccountId??accountFor(spent?'vat_input':'vat_output',spent?'asset':'liability')):null;
 const expected=buildBankAllocationLines(plan,{bankAccountId:bank.bank_account_id,signedAmount:bank.amount,controlAccountId,vatAccountId});
 if(!matchesBankAllocationJournalLines(expected,lines))throw new Error('Controlled bank journal economics are inconsistent');
 return{currentOriginalIntentId:String(e.entity_id),legacyProvenanceUnavailable:false};
}
