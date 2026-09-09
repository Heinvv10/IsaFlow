/**
 * Reviewed legacy coercions at 34751e31. These paths are explicit, not a rule
 * that every numeric schema accepts strings. Validation preserves raw args:
 * existing handlers still own their Number conversion, defaults and clamps.
 */
export interface InputCompatibility {
  numeric?: readonly string[];
  clamped?: readonly string[];
  nullable?: readonly string[];
}
// tools/toolHelpers.ts:clampLimit: Number, positive fallback, floor, maximum.
// Each named adapter below calls that helper for its top-level limit.
const clampedLimits = [
  'trial_balance', 'aged_debtors', 'aged_creditors', 'reconcile_subledger',
  'general_ledger', 'search_gl', 'list_gl_accounts', 'list_invoices', 'list_quotes',
  'list_suppliers', 'list_bank_transactions', 'vat_status', 'data_integrity_checks',
  'chart_of_accounts_health', 'list_agent_postings', 'audit_trail', 'list_documents',
  'list_unsupported_transactions', 'list_supplier_invoices', 'list_import_batches',
  'list_journals', 'list_bank_reconciliations', 'list_practice_clients', 'list_time_entries',
  'list_credit_notes', 'list_unapplied_receipts', 'list_unapplied_payments',
  'list_fiscal_periods', 'list_employees', 'list_pay_runs', 'list_fixed_assets', 'reconcile_fixed_assets',
] as const;
const customer = ['payment_terms', 'credit_limit', 'default_discount'];
const customerInvoice = ['items.*.quantity', 'items.*.unit_price', 'tax_rate'];
const supplierInvoice = ['tax_rate', 'lines.*.quantity', 'lines.*.unit_price', 'lines.*.tax_rate'];
const table: Record<string, InputCompatibility> = Object.fromEntries(clampedLimits.map(name =>
  [name, { numeric: ['limit'], clamped: ['limit'], nullable: ['limit'] }]));
function add(names: readonly string[], entry: InputCompatibility): void {
  for (const name of names) {
    const prior = table[name] ?? {};
    table[name] = {
      numeric: [...(prior.numeric ?? []), ...(entry.numeric ?? [])],
      clamped: [...(prior.clamped ?? []), ...(entry.clamped ?? [])],
      nullable: [...(prior.nullable ?? []), ...(entry.nullable ?? [])],
    };
  }
}
// documents.ts:58, supplierInvoices.ts:93, practice.ts:45/155, assets.ts:57.
add(['list_documents', 'list_supplier_invoices', 'list_practice_clients', 'list_time_entries', 'list_fixed_assets'],
  { numeric: ['offset'], clamped: ['offset'], nullable: ['offset'] });
// creditNotes.ts:101-106 validates rather than clamps its offset.
add(['list_credit_notes'], { numeric: ['offset'], nullable: ['offset'] });
add(['list_unsupported_transactions'], { numeric: ['min_amount'] }); // documents.ts:162-165
add(['list_pay_runs'], { numeric: ['year'] }); // payroll.ts:169
add(['irp5_data'], { numeric: ['tax_year'] }); // payrollSars.ts:wholeNumberArg
// invoiceCreateArgs.ts:parseCustomerInvoiceInput/parseSupplierInvoiceInput.
add(['create_draft_invoice'], { numeric: customerInvoice, nullable: ['tax_rate'] });
add(['create_draft_quote'], { numeric: ['items.*.quantity', 'items.*.unit_price'] }); // writeInvoices.ts:35-37
add(['create_supplier_invoice'], { numeric: supplierInvoice, nullable: ['tax_rate', 'lines.*.tax_rate'] });
add(['bulk_create_customer_invoices'], { numeric: customerInvoice.map(p => `invoices.*.${p}`), nullable: ['invoices.*.tax_rate'] });
add(['bulk_create_supplier_invoices'], { numeric: supplierInvoice.map(p => `invoices.*.${p}`),
  nullable: ['invoices.*.tax_rate', 'invoices.*.lines.*.tax_rate'] });
add(['create_draft_journal'], { numeric: ['lines.*.debit', 'lines.*.credit'], nullable: ['lines.*.debit', 'lines.*.credit'] }); // writeJournals.ts:22-23
add(['create_bank_rule', 'update_bank_rule'], { numeric: ['priority'], nullable: ['priority'] }); // bankRuleShared.ts:101
add(['set_opening_balance', 'settle_by_contra', 'assign_employee_component'], { numeric: ['amount'] }); // corresponding write adapters call Number(args.amount)
add(['create_job_category', 'create_work_item'], { numeric: ['sort_order'] }); // writePracticeSetup.ts:61/128
add(['log_time_entry'], { numeric: ['hours'] }); // writePracticeTime.ts:134
add(['create_credit_note'], { numeric: ['subtotal', 'tax_rate'], nullable: ['tax_rate'] }); // writeCreditNotes.ts:81/88
add(['create_pay_run'], { numeric: ['month', 'year'] }); // writePayroll.ts:49-50
add(['create_employee', 'update_employee'], { numeric: ['medical_aid_dependants_count'], nullable: ['medical_aid_dependants_count'] }); // writeEmployees.ts:146/251
add(['apply_receipt_to_invoice', 'apply_payment_to_supplier_invoice'], { numeric: ['allocations.*.amount'] }); // cashApplicationArgs.ts:81
add(['create_customer', 'update_customer'], { numeric: customer, nullable: customer }); // writeContacts.ts:numArg
add(['create_supplier', 'update_supplier'], { numeric: ['payment_terms'], nullable: ['payment_terms'] });
export const MCP_INPUT_COMPATIBILITY: Readonly<Record<string, InputCompatibility>> = Object.freeze(table);
