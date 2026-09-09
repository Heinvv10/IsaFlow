import Decimal from 'decimal.js';
import {canonicalMoney} from '../controls/canonical';
import {fmtDate} from '@/lib/fmtDate';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** Stable preparation basis subtracts only this payment's separately proven posted settlement. */
export function normalizePaymentInvoiceState(invoice:Row,journal:Row,allocation:string,ownSettled:boolean){
 if(!['approved','posted','partially_paid','paid'].includes(String(invoice.status))||invoice.currency!=='ZAR'
  ||journal.id!==invoice.gl_journal_entry_id||journal.company_id!==invoice.company_id||journal.status!=='posted'||journal.reversed_at
  ||journal.source!=='auto_supplier_invoice'||journal.source_record_id!==invoice.id)throw new Error('Payment invoice has no eligible owned posted source');
 const total=new D(canonicalMoney(String(invoice.total_amount))),paid=new D(canonicalMoney(String(invoice.amount_paid)));
 const allocated=new D(canonicalMoney(allocation));
 if(!total.gt(0)||paid.lt(0)||paid.gt(total)||!allocated.gt(0)
  ||!new D(String(journal.debit)).eq(total)||!new D(String(journal.credit)).eq(total)||!new D(String(journal.payable_credit)).eq(total))throw new Error('Payment invoice source amounts do not reconcile');
 const otherPaid=ownSettled?paid.sub(allocated):paid;
 if(otherPaid.lt(0)||otherPaid.add(allocated).gt(total))throw new Error('Payment invoice balance is no longer available');
 return{id:String(invoice.id),supplierId:String(invoice.supplier_id),currency:'ZAR',total:total.toFixed(),otherPaid:otherPaid.toFixed(),
  accountingDate:fmtDate(invoice.invoice_date as Date|string),journalId:String(journal.id)};
}
