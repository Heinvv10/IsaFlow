import {expect,it} from 'vitest';
import {normalizePaymentInvoiceState} from '@/modules/accounting/services/ap/paymentInvoiceBinding';
const invoice={id:'invoice',company_id:'company',supplier_id:'supplier',status:'approved',total_amount:'115',amount_paid:'0',currency:'ZAR',invoice_date:'2026-09-09',gl_journal_entry_id:'journal'};
const journal={id:'journal',company_id:'company',status:'posted',reversed_at:null,source:'auto_supplier_invoice',source_record_id:'invoice',debit:'115',credit:'115',payable_credit:'115'};
it('refuses cancelled, draft, reversed or unrelated source accounting',()=>{
 for(const status of ['cancelled','draft'])expect(()=>normalizePaymentInvoiceState({...invoice,status},journal,'115',false)).toThrow();
 expect(()=>normalizePaymentInvoiceState(invoice,{...journal,reversed_at:'2026-09-10'},'115',false)).toThrow();
 expect(()=>normalizePaymentInvoiceState(invoice,{...journal,source_record_id:'other'},'115',false)).toThrow();
});
it('recognizes only this proven payment settlement while retaining other settlement facts',()=>{
 const before=normalizePaymentInvoiceState(invoice,journal,'100',false);
 expect(normalizePaymentInvoiceState({...invoice,status:'partially_paid',amount_paid:'100'},journal,'100',true)).toEqual(before);
 expect(normalizePaymentInvoiceState({...invoice,status:'paid',amount_paid:'115'},journal,'100',true)).not.toEqual(before);
 expect(()=>normalizePaymentInvoiceState({...invoice,status:'paid',amount_paid:'115'},journal,'100',false)).toThrow();
});
