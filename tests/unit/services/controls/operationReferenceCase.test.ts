import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import type {ControlOperation} from '@/modules/accounting/services/controls/contracts';
const uuid='abcdefab-cdef-4abc-8def-abcdefabcdef';
const operations:Record<string,ControlOperation>={
 payroll_compensation_intent:'payroll_compensation.change',bank_statement_attestation_intent:'bank_statement.attest',
 historical_import:'historical_import.post',invoice_match_override_intent:'invoice_match.override',supplier_invoice:'supplier_invoice.post',
 cash_application_intent:'cash_application.apply',cash_application_reversal_intent:'cash_application.reverse',
 bank_allocation_reversal_intent:'bank_allocation.reverse',bank_allocation_intent:'bank_allocation.post',bank_transfer_intent:'bank_transfer.post',
 asset_depreciation_intent:'asset_depreciation.post',customer_invoice:'customer_invoice.post',customer_payment:'customer_payment.confirm',
 credit_note:'credit_note.approve',credit_note_application:'credit_note_application.apply',recurring_invoice_run:'recurring_invoice.generate',
 supplier_payment_batch:'supplier_payment_batch.process',payment_release_intent:'payment_release.dispatch',supplier_payment:'supplier_payment.process',
 journal_entry:'journal.post',payroll_run:'payroll_run.post',fiscal_period:'fiscal_period.close',company_lockdown_intent:'company_lockdown.change',
};
it.each(Object.entries(operations))('canonicalizes UUID identity for %s',(entityType,operation)=>{
 const lower={entityType,operation,entityId:uuid};
 expect(canonicalOperationRef({...lower,entityId:uuid.toUpperCase()})).toEqual(canonicalOperationRef(lower));
 expect(canonicalOperationRef({...lower,entityId:uuid.toUpperCase()}).entityId).toBe(uuid);
});
it('preserves fiscal year and VAT period composite identities',()=>{
 for(const ref of [{entityType:'fiscal_year',entityId:'2023',operation:'year.close' as const},
  {entityType:'vat_period',entityId:'2023-01-01/2023-02-28',operation:'vat_period.lock' as const}])
  expect(canonicalOperationRef(ref)).toEqual(ref);
});
