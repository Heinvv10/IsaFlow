import {sql} from '@/lib/neon';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import type {OperationRef} from '../controls/contracts';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {lockArInvoiceSources} from '../controls/arSourceMaterial';
import {deriveArInvoiceMoney} from '../controls/arExactMaterial';
import {resolveArAccounts} from '../controls/arControlAccounts';
import {createJournalEntry,postJournalEntry} from '../gl/journalEntryService';
import {actorMeta,type PostingActorOpts} from '../gl/journalEntryMeta';
import type {JournalLineInput} from '../../types/gl.types';
import {requireArControl} from './arControlBoundary';
export interface ArParentControl {permit:ControlledEffectPermit;parent:OperationRef}
/** Internal child of an active invoice or persisted recurring-run operation. */
export async function postCustomerInvoiceFinancialEffect(companyId:string,invoiceId:string,userId:string,parentControl:ArParentControl,opts?:PostingActorOpts):Promise<string>{
 const ctx=requireArControl(companyId,userId);assertControlledEffectPermit(ctx,parentControl.permit,parentControl.parent);
 const {header,lines:items}=await lockArInvoiceSources(ctx,invoiceId);
 if(header.status==='cancelled')throw new Error('Cannot post a cancelled invoice to GL');
 if(header.gl_journal_entry_id)return String(header.gl_journal_entry_id);
 const accounts=await resolveArAccounts(ctx,['receivable','default_revenue','vat_output']);
 const money=deriveArInvoiceMoney(header,items,accounts.ledgerCurrency);
 const lines:JournalLineInput[]=[
  {glAccountId:accounts.chosen.receivable!.id,debit:Number(money.amount),credit:0,description:`AR: ${String(header.invoice_number)}`},
  {glAccountId:accounts.chosen.default_revenue!.id,debit:0,credit:Number(money.subtotal),description:`Revenue: ${String(header.invoice_number)}`},
 ];
 if(Number(money.tax)>0)lines.push({glAccountId:accounts.chosen.vat_output!.id,debit:0,credit:Number(money.tax),description:`VAT Output: ${String(header.invoice_number)}`});
 const journal=await createJournalEntry(companyId,{entryDate:parentControl.permit.accountingDate,description:`Customer invoice ${String(header.invoice_number)}`,source:'auto_invoice',sourceRecordId:invoiceId,lines},userId,actorMeta(opts));
 await registerGeneratedJournal(ctx,parentControl,journal.id,'journal.post');
 await postJournalEntry(companyId,journal.id,userId,{parentControl});
 const linked=await sql`UPDATE customer_invoices SET gl_journal_entry_id=${journal.id}::uuid WHERE company_id=${companyId}::uuid AND id=${invoiceId}::uuid RETURNING id`;
 if(linked.length!==1)throw new Error('Customer invoice journal linkage failed');return journal.id;
}
