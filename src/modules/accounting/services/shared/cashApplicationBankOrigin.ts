import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {z} from 'zod';
import {fmtDate} from '@/lib/fmtDate';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {sameIntentId} from '../controls/intentIdentity';
import {openProtectedChange} from '../controls/changeProtection';
import {canonicalJson} from '../controls/canonical';
import {matchesBankAllocationJournalLines} from '../controls/bankAllocationJournalShape';
const D=Decimal.clone({precision:80});
const uuid=z.string().uuid(),money=z.string().regex(/^\d+(?:\.\d+)?$/);
const snapshotSchema=z.object({intent:z.object({id:uuid,bank_transaction_id:uuid,accounting_date:z.string(),amount:money,currency:z.literal('ZAR')}),source:z.object({
 bank:z.object({id:uuid,bank_account_id:uuid,amount:money.or(z.string().regex(/^-\d+(?:\.\d+)?$/)),transaction_date:z.string(),matched_journal_line_id:uuid}),
 lines:z.array(z.object({accountId:uuid,debit:money,credit:money,description:z.string(),vatType:z.string().nullable(),cc1Id:uuid.nullable(),cc2Id:uuid.nullable(),buId:uuid.nullable()})).min(2).max(102),
 receipts:z.array(z.record(z.string(),z.unknown())),disbursements:z.array(z.record(z.string(),z.unknown()))})});
type Row=Record<string,unknown>;
/** Verify original financial facts from the exact effect's protected committed snapshot, never from an inferred current total. */
export async function verifyCashBankOrigin(ctx:ControlTx,effectId:string,intentId:string,kind:'customer'|'supplier',payment:Row,journal:Row){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const evidence=await ctx.sql`SELECT p.envelope_version,p.key_id,p.ciphertext FROM control_operation_effects e
  JOIN control_change_events c ON c.company_id=e.company_id AND c.operation_id=e.operation_id AND c.entity_type=e.entity_type
   AND c.entity_id_canonical=e.entity_id_canonical AND c.action='bank_allocation.post'
  JOIN control_protected_evidence p ON p.company_id=c.company_id AND p.id=c.protected_evidence_id AND p.entity_type=c.entity_type
   AND p.entity_id_canonical=c.entity_id_canonical
  WHERE e.company_id=${company}::uuid AND e.id=${effectId}::uuid AND e.entity_type='bank_allocation_intent' AND e.entity_id_canonical=lower(${intentId})
   AND e.operation='bank_allocation.post' AND e.result->>'paymentId'=${String(payment.id)} ORDER BY c.id LIMIT 2` as {envelope_version:number;key_id:string;ciphertext:string}[];
 if(evidence.length!==1||evidence[0]!.envelope_version!==1)throw new Error('Original bank financial evidence required');
 const envelope=evidence[0]!,snapshot=snapshotSchema.parse(openProtectedChange({version:1,keyId:envelope.key_id,ciphertext:envelope.ciphertext}).after);
 const original=(kind==='customer'?snapshot.source.receipts:snapshot.source.disbursements).find(p=>p.id===payment.id);
 if(!sameIntentId(snapshot.intent.id,intentId)||snapshot.intent.bank_transaction_id!==snapshot.source.bank.id||!original
  ||!new D(snapshot.intent.amount).eq(String(payment.total_amount))||!new D(String(original.total_amount)).eq(String(payment.total_amount))
  ||original.gl_journal_entry_id!==journal.id||original.bank_account_id!==payment.bank_account_id
  ||(kind==='customer'?original.client_id:original.supplier_id)!==payment.party_id
  ||fmtDate(payment.payment_date as string|Date)!==snapshot.intent.accounting_date||fmtDate(journal.entry_date as string|Date)!==snapshot.intent.accounting_date)throw new Error('Original bank payment financial facts changed');
 const [bank]=await ctx.sql`SELECT id,amount::text,transaction_date::text,bank_account_id,matched_journal_line_id FROM bank_transactions
  WHERE company_id=${company}::uuid AND id=${snapshot.source.bank.id}::uuid FOR UPDATE` as Row[];
 if(!bank||bank.bank_account_id!==snapshot.source.bank.bank_account_id||bank.matched_journal_line_id!==snapshot.source.bank.matched_journal_line_id
  ||!new D(String(bank.amount)).eq(snapshot.source.bank.amount)||fmtDate(bank.transaction_date as string|Date)!==fmtDate(snapshot.source.bank.transaction_date)
  ||journal.source_record_id!==bank.id)throw new Error('Original bank transaction source changed');
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id FROM gl_journal_lines
  WHERE company_id=${company}::uuid AND journal_entry_id=${journal.id}::uuid ORDER BY id FOR SHARE`;
 if(!matchesBankAllocationJournalLines(snapshot.source.lines,lines as Parameters<typeof matchesBankAllocationJournalLines>[1]))throw new Error('Original bank journal lines changed');
 return{effectId,intentId,bankTransactionId:bank.id,originalLineFingerprint:createHash('sha256').update(canonicalJson(snapshot.source.lines)).digest('hex')};
}
