const operations: Record<string,{read:string;write:string;rule:'supplier_invoice'|'payment'|'journal_entry'|'payroll_run'|'fiscal_period'|'fiscal_year'|'company_lockdown'|'vat_period'}>={
  'supplier_invoice.approve':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.post':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.cancel':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_payment.process':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'supplier_payment.void':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'journal.post':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
  'journal.reverse':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
  'payroll_run.post':{read:'read:payroll',write:'write:payroll',rule:'payroll_run'},
  'payroll_run.reopen':{read:'read:payroll',write:'write:payroll',rule:'payroll_run'},
  'fiscal_period.close':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
  'fiscal_period.lock':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
  'fiscal_period.reopen':{read:'read:reports',write:'write:locks',rule:'fiscal_period'},
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

export function operationRequiresPosting(operation:string):boolean{return definition(operation).write!=='write:locks';}
