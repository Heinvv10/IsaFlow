import {UUID_RE} from '@/lib/validation';
import type {ControlTx} from '../controls/contracts';
import {proveBankTransferCandidate} from './bankTransferCandidateProof';
type Row=Record<string,unknown>;
export async function transferJournalCandidates(ctx:ControlTx,bank:Row,counterpartyAccountId:string){
 const rows=await ctx.sql`SELECT j.id,j.source,j.source_record_id,j.status,j.reversed_at,j.entry_date::text FROM gl_journal_entries j
  WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.source='auto_bank_transfer' AND j.status='posted' AND j.reversed_at IS NULL
   AND j.source_record_id IS DISTINCT FROM ${bank.id}::uuid
   AND j.entry_date BETWEEN ${bank.transaction_date}::date-2 AND ${bank.transaction_date}::date+2
   AND ((EXISTS(SELECT 1 FROM gl_journal_lines l WHERE l.company_id=${ctx.principal.companyId}::uuid AND l.journal_entry_id=j.id
    AND l.gl_account_id=${bank.bank_account_id}::uuid AND l.debit-l.credit=${bank.amount}::numeric)
    AND EXISTS(SELECT 1 FROM gl_journal_lines c WHERE c.company_id=${ctx.principal.companyId}::uuid AND c.journal_entry_id=j.id AND c.gl_account_id=${counterpartyAccountId}::uuid))
    OR EXISTS(SELECT 1 FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid AND b.transfer_journal_entry_id=j.id
     AND b.bank_account_id=${counterpartyAccountId}::uuid AND b.counterparty_account_id=${bank.bank_account_id}::uuid AND b.amount=-${bank.amount}::numeric))
  ORDER BY j.id LIMIT 101` as Row[];
 if(rows.some(row=>typeof row.source_record_id!=='string'||!UUID_RE.test(row.source_record_id)))throw new Error('Existing transfer lacks bank-bound provenance');
 return rows;
}
export async function readExistingTransferFacts(ctx:ControlTx,bank:Row,counterpartyAccountId:string,observed:Row,lockedBanks:Row[]){
 const company=ctx.principal.companyId;
 const [journal]=await ctx.sql`SELECT id,source,source_record_id,status,reversed_at,entry_date::text FROM gl_journal_entries
  WHERE company_id=${company}::uuid AND id=${observed.id}::uuid FOR SHARE` as Row[];
 if(!journal)throw new Error('Existing transfer journal disappeared');
 const lines=await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${journal.id}::uuid ORDER BY id LIMIT 3 FOR SHARE` as Row[];
 const effects=await ctx.sql`SELECT e.entity_id,e.entity_type,e.operation,e.operation_id,e.binding_hash,e.result,i.id AS intent_id
  FROM control_operation_effects e JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=e.entity_id
  WHERE e.company_id=${company}::uuid AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post'
   AND e.result->>'journalEntryId'=${journal.id}::text AND i.bank_transaction_id=${journal.source_record_id}::uuid LIMIT 2` as Row[];
 if(effects.length!==1)throw new Error('Existing transfer original controlled receipt unavailable');
 const effect=effects[0]!;
 const [intent]=await ctx.sql`SELECT id,bank_transaction_id,accounting_date::text,amount::text,currency,payload,source_fingerprint
  FROM control_bank_allocation_intents WHERE company_id=${company}::uuid AND id=${effect.intent_id}::uuid` as Row[];
 const events=await ctx.sql`SELECT entity_id,entity_type,action,operation_id,binding_hash FROM control_change_events
  WHERE company_id=${company}::uuid AND entity_type='bank_allocation_intent' AND entity_id=${effect.entity_id}
   AND action='bank_allocation.post' AND operation_id=${effect.operation_id}::uuid AND binding_hash=${effect.binding_hash} LIMIT 2` as Row[];
 const destination=lines.find(line=>line.gl_account_id===bank.bank_account_id);
 const occupied=destination?await ctx.sql`SELECT id FROM bank_transactions WHERE company_id=${company}::uuid
  AND matched_journal_line_id=${destination.id}::uuid ORDER BY id LIMIT 1`:[];
 return proveBankTransferCandidate({bank,counterpartyAccountId,journal,lines,originalBank:lockedBanks.find(b=>b.id===journal.source_record_id)??null,
  intent:intent??null,effect,events,occupied:occupied.length>0});
}
