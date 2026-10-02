/** Real-shaped MCP tool arguments, hashed on master BEFORE hashArgs gained its bound (golden values in hashArgsBounds.test.ts). */
export const CORPUS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'empty', args: {} },
  { name: 'create_draft_invoice', args: { idempotency_key: 'inv-2026-0001', customer_id: '3f1c9d2e-7a41-4b6e-9a55-0d1f2c3b4a5e', invoice_date: '2026-09-30', due_date: '2026-10-30', lines: [{ description: 'Fibre install', quantity: 1, unit_price: 1499.5, vat_rate: 15 }, { description: 'Router', quantity: 2, unit_price: 850, vat_rate: 15 }] } },
  { name: 'key order swapped', args: { lines: [{ vat_rate: 15, unit_price: 1499.5, quantity: 1, description: 'Fibre install' }], due_date: '2026-10-30', idempotency_key: 'k' } },
  { name: 'trial_balance', args: { as_at: '2026-09-30', include_zero: false } },
  { name: 'list_invoices', args: { status: 'sent', limit: 50, offset: 0, search: null } },
  { name: 'unicode and escapes', args: { memo: 'Zoë "quoted" \\ back\nline\ttab ☃ \u{1F600}', amount: -0.1 } },
  { name: 'nested three deep', args: { a: { b: { c: [1, [2, [3]], { d: true }] } } } },
  { name: 'bulk allocate', args: { idempotency_key: 'b1', allocations: Array.from({ length: 40 }, (_, i) => ({ bank_transaction_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, gl_account_id: 'acc', amount: i * 10.25 })) } },
  { name: 'undefined and null members', args: { a: undefined, b: null, c: [undefined, null] } },
  { name: 'numeric-like keys', args: { '10': 'x', '2': 'y', b: 'z', a: 'w' } },
];
