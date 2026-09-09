const operations: Record<string,{read:string;write:string;rule:'supplier_invoice'|'payment'|'journal_entry'|'payroll_run'|'fiscal_period'|'fiscal_year'|'company_lockdown'|'vat_period'|'asset_depreciation'|'customer_invoice'|'credit_note'|'payment_release'}>={
  'bank_allocation.post':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'bank_allocation.reverse':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'bank_transfer.post':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'asset_depreciation.post':{read:'read:assets',write:'write:assets',rule:'asset_depreciation'},
  'customer_invoice.post':{read:'read:invoices',write:'write:invoices',rule:'customer_invoice'},
  'customer_invoice.cancel':{read:'read:invoices',write:'write:invoices',rule:'customer_invoice'},
  'customer_payment.confirm':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'customer_payment.cancel':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'credit_note.approve':{read:'read:invoices',write:'write:invoices',rule:'credit_note'},
  'credit_note.cancel':{read:'read:invoices',write:'write:invoices',rule:'credit_note'},
  'credit_note_application.apply':{read:'read:invoices',write:'write:invoices',rule:'credit_note'},
  'recurring_invoice.generate':{read:'read:invoices',write:'write:invoices',rule:'customer_invoice'},
  'supplier_invoice.approve':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.post':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.cancel':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_payment_batch.process':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'payment_release.dispatch':{read:'read:bank-tx',write:'write:release',rule:'payment_release'},
  'supplier_payment.process':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'supplier_payment.void':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'journal.post':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
  'journal.reverse':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
  'payroll_run.post':{read:'read:payroll',write:'write:payroll',rule:'payroll_run'},
  'payroll_run.reopen':{read:'read:payroll',write:'write:payroll',rule:'payroll_run'},
  'fiscal_period.close':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
  'fiscal_period.lock':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
  'fiscal_period.reopen':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
  'year.periods_close':{read:'read:reports',write:'write:locks',rule:'fiscal_year'},
  'year.close':{read:'read:reports',write:'write:locks',rule:'fiscal_year'},
  'company_lockdown.change':{read:'read:reports',write:'write:locks',rule:'company_lockdown'},
  'vat_period.lock':{read:'read:vat',write:'write:locks',rule:'vat_period'},
};
function definition(operation:string){
  if(!Object.hasOwn(operations,operation))throw new Error('Unsupported controlled operation');
  return operations[operation]!;
}
export function operationPermission(operation:string,access:'read'|'write'):string{return definition(operation)[access];}
export function operationRuleType(operation:string){return definition(operation).rule;}

export function operationRequiresPosting(operation:string):boolean{
  const write=definition(operation).write;
  return operation==='year.close'||(write!=='write:locks'&&operation!=='payment_release.dispatch');
}
