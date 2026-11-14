/**
 * The Audit Trail's filter choices, shared by the page's dropdowns and the export
 * route's allowlist, so the export accepts exactly what the page can send and its
 * audit row only ever records a known value.
 */
export const AUDIT_SOURCES = ['admin', 'accounting', 'auth'] as const;

export const AUDIT_ACTIONS = [
  'create', 'update', 'delete', 'post', 'reverse', 'approve', 'reject', 'login', 'export',
  'suspend', 'activate', 'reset_password', 'logout',
] as const;

export const AUDIT_ENTITY_TYPES = [
  'journal_entry', 'customer_invoice', 'supplier_invoice', 'customer', 'supplier',
  'bank_transaction', 'payment', 'credit_note', 'quote', 'purchase_order',
  'plan', 'subscription', 'announcement', 'feature_flag', 'settings', 'session',
  'company', 'user',
] as const;
