import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {replayKnownOperationEffect} from '../controls/operationReceiptReplay';
import {canonicalIntentId,loadIntentReceipt,sameIntentId} from '../controls/intentIdentity';
import type {ControlTx} from '../controls/contracts';
/** An already posted invoice is an existing receipt, not a second accounting effect. */
export async function readArInvoicePostingReceipt(ctx:ControlTx,inputId:string):Promise<Record<string,unknown>|null>{
 await assertEffectivePermission(ctx,'write:invoices');
 await assertEffectivePermission(ctx,'write:post');
 const id=canonicalIntentId(inputId);
 const company=ctx.principal.companyId;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${company}`},0))`;
 const [invoice]=await ctx.sql`SELECT status,gl_journal_entry_id FROM customer_invoices
  WHERE company_id=${company}::uuid AND id=${id}::uuid FOR UPDATE` as Array<{status:string;gl_journal_entry_id:string|null}>;
 if(!invoice||invoice.status!=='approved'||!invoice.gl_journal_entry_id)return null;
 const [journal]=await ctx.sql`SELECT status,reversed_at FROM gl_journal_entries WHERE company_id=${company}::uuid
  AND id=${invoice.gl_journal_entry_id}::uuid FOR SHARE` as Array<{status:string;reversed_at:unknown}>;
 if(!journal||journal.status!=='posted'||journal.reversed_at)throw new Error('Invoice posting receipt state is inconsistent');
 // Receipts written before entity_id normalization keep their original spelling, so the
 // identity match is case-insensitive; two spellings of one invoice fail closed.
 const effect=await loadIntentReceipt<Record<string,unknown>>(ctx,{entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'});
 if(!effect||!sameIntentId(effect.result.id,id)||effect.result.glJournalEntryId!==invoice.gl_journal_entry_id)throw new Error('Existing invoice journal has no verified posting receipt');
 return replayKnownOperationEffect(ctx,{entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'},effect.id);
}
