/**
 * Webhook event constants — browser-safe, no server imports.
 * Imported by both WebhookForm (client) and webhookService (server).
 */

export const WEBHOOK_EVENTS = [
  'customer.created', 'customer.updated',
  'supplier.created', 'supplier.updated',
  'invoice.created', 'invoice.posted', 'invoice.paid',
  'payment.received', 'payment.made',
  'journal_entry.posted', 'journal_entry.reversed',
] as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[number];
