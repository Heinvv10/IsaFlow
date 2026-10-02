/**
 * The create requests CreateEntityModal sends. Kept here so the API tests can
 * feed the route the exact body the modal posts.
 *
 * Supplier: POST /api/accounting/suppliers-list (what /accounting/suppliers/new uses).
 * Customer: POST /api/accounting/customers (what /accounting/customers/new uses).
 * Both routes read a FLAT body; the customer's name key is `name`.
 */
export const SUPPLIER_CREATE_URL = '/api/accounting/suppliers-list';
export const CUSTOMER_CREATE_URL = '/api/accounting/customers';

interface ContactFields { name: string; email: string; phone: string }

export function supplierCreateBody({ name, email, phone }: ContactFields) {
  return { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined };
}

export function customerCreateBody({ name, email, phone }: ContactFields) {
  return { name: name.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined };
}

/** The `{ id, ... }` row an unregistered create route returns, narrowed without a guess. */
export function createdRow(data: unknown): { id: string; code?: string } {
  const row = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof row.id !== 'string' && typeof row.id !== 'number') throw new Error('The server did not return the new record');
  return { id: String(row.id), code: typeof row.code === 'string' ? row.code : undefined };
}
