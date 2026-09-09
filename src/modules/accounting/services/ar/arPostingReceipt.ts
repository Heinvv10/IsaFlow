import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {replayKnownOperationEffect} from '../controls/operationReceiptReplay';
import type {ControlTx} from '../controls/contracts';
/** An already posted invoice is an existing receipt, not a second accounting effect. */
export async function readArInvoicePostingReceipt(ctx:ControlTx,id:string):Promise<Record<string,unknown>|null>{
 await assertEffectivePermission(ctx,'write:invoices');
 await assertEffectivePermission(ctx,'write:post');
 const company=ctx.principal.companyId;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${company}`},0))`;
 const [invoice]=await ctx.sql`SELECT status,gl_journal_entry_id FROM customer_invoices
  WHERE company_id=${company}::uuid AND id=${id}::uuid FOR UPDATE` as Array<{status:string;gl_journal_entry_id:string|null}>;
 if(!invoice||invoice.status!=='approved'||!invoice.gl_journal_entry_id)return null;
 const [journal]=await ctx.sql`SELECT status,reversed_at FROM gl_journal_entries WHERE company_id=${company}::uuid
  AND id=${invoice.gl_journal_entry_id}::uuid FOR SHARE` as Array<{status:string;reversed_at:unknown}>;
 if(!journal||journal.status!=='posted'||journal.reversed_at)throw new Error('Invoice posting receipt state is inconsistent');
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${company}::uuid
  AND entity_type='customer_invoice' AND entity_id=${id} AND operation='customer_invoice.post'
  AND result->>'glJournalEntryId'=${invoice.gl_journal_entry_id} ORDER BY committed_at DESC LIMIT 1` as Array<{id:string;result:Record<string,unknown>}>;
 if(!effect||effect.result.id!==id||effect.result.glJournalEntryId!==invoice.gl_journal_entry_id)throw new Error('Existing invoice journal has no verified posting receipt');
 return replayKnownOperationEffect(ctx,{entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'},effect.id);
}
