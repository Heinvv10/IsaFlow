const operations: Record<string,{read:string;write:string;rule:'supplier_invoice'|'payment'|'journal_entry'}>={
  'supplier_invoice.approve':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.post':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_invoice.cancel':{read:'read:invoices',write:'write:invoices',rule:'supplier_invoice'},
  'supplier_payment.process':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'supplier_payment.void':{read:'read:bank-tx',write:'write:bank-tx',rule:'payment'},
  'journal.post':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
  'journal.reverse':{read:'read:reports',write:'write:journals',rule:'journal_entry'},
};
function definition(operation:string){
  if(!Object.hasOwn(operations,operation))throw new Error('Unsupported controlled operation');
  return operations[operation]!;
}
export function operationPermission(operation:string,access:'read'|'write'):string{return definition(operation)[access];}
export function operationRuleType(operation:string){return definition(operation).rule;}
