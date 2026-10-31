import type { McpTool, McpToolAnnotations } from './types';

/**
 * Non-posting writes need an explicit classification because `write` alone
 * cannot distinguish an additive create from an update that replaces state.
 * Posting tools are always destructive; reads are never destructive. An
 * unclassified write defaults to destructive at runtime so `tools/list`
 * remains available, while the registry test requires explicit coverage.
 */
const NON_DESTRUCTIVE_WRITES = new Set([
  'create_draft_invoice',
  'create_draft_quote',
  'create_draft_journal',
  'import_bank_statement',
  'create_gl_account',
  'create_supplier_invoice',
  'bulk_create_supplier_invoices',
  'bulk_create_customer_invoices',
  'attach_document',
  'attach_entity_document',
  'create_job_category',
  'create_work_item',
  'log_time_entry',
  'create_credit_note',
  'create_pay_run',
  'create_employee',
  'assign_employee_component',
  'create_customer',
  'create_supplier',
  'take_audit_snapshot',
  'create_cost_centre',
  'create_business_unit',
]);

const DESTRUCTIVE_NON_POSTING_WRITES = new Set([
  'suggest_bank_allocation',
  'update_supplier_invoice',
  'undo_bank_import',
  'update_gl_account',
  'deactivate_gl_account',
  'create_bank_rule',
  'update_bank_rule',
  'disable_bank_rule',
  'cancel_bank_reconciliation',
  'submit_time_entries',
  'calculate_pay_run',
  'update_employee',
  'end_employee_component',
  'update_customer',
  'update_supplier',
  'lock_vat_period',
  'mark_vat_declared_elsewhere',
  'update_cost_centre',
  'delete_cost_centre',
  'update_business_unit',
  'delete_business_unit',
  'set_gl_account_reporting_attributes',
  'set_customer_default_fno',
  'set_bank_account_default_dimensions',
  'set_supplier_default_dimensions',
  'sync_bank_dimensions',
]);

type AnnotationTool = Pick<McpTool, 'name' | 'write' | 'requiresPost'>;

export function hasExplicitDestructiveHintClassification(tool: AnnotationTool): boolean {
  return (
    NON_DESTRUCTIVE_WRITES.has(tool.name) ||
    DESTRUCTIVE_NON_POSTING_WRITES.has(tool.name)
  );
}

function destructiveHintFor(tool: AnnotationTool): boolean {
  if (!tool.write) return false;
  if (tool.requiresPost) return true;
  if (NON_DESTRUCTIVE_WRITES.has(tool.name)) return false;
  return true;
}

export function toolAnnotationsFor(
  tool: AnnotationTool,
): McpToolAnnotations {
  return {
    readOnlyHint: !tool.write,
    destructiveHint: destructiveHintFor(tool),
    // Write calls replay a stored result when all arguments, including the
    // required idempotency_key, are repeated. Reads have no side effects.
    idempotentHint: true,
    // Every tool operates inside IsaFlow's closed accounting system.
    openWorldHint: false,
  };
}
