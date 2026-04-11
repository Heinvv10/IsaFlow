/**
 * Webhook event constants — browser-safe, no server imports.
 * Imported by both WebhookForm (client) and webhookService (server).
 */

export const WEBHOOK_EVENTS = [
  'customer.created', 'customer.updated',
  'supplier.created', 'supplier.updated',
  'invoice.created', 'invoice.sent', 'invoice.posted', 'invoice.paid', 'invoice.overdue',
  'payment.received', 'payment.confirmed', 'payment.made',
  'supplier_invoice.created', 'supplier_invoice.paid',
  'bank_transaction.imported',
  'journal_entry.posted', 'journal_entry.reversed',
] as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[number];
