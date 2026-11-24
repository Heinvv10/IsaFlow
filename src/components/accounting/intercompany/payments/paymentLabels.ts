/** Words and tones of the Payments inbox (intercompany F): the state word as a chip, a row's name. Pure. */
import type { PaymentItem, PaymentState } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

export const STATE_LABEL: Readonly<Record<PaymentState, string>> = Object.freeze({
  open: 'Open', connection_gone: 'Connection ended', not_cash: 'Not on cash', not_enabled: 'Not enabled', future_dated: 'Future-dated', before_cutover: 'Before cut-over',
  payer_gone: 'Payer voided or changed it', link_gone: 'Link ended', currency: 'Not in rand', target_cancelled: 'Receipt cancelled',
  target_ok: 'Matched', closed: 'Set aside', not_found: 'Not found', check_failed: 'Could not check',
});

/** The receipt's chip: `Intercompany: <word>`. */
export const CHIP_LABEL: Readonly<Record<PaymentState, string>> = Object.freeze({
  ...STATE_LABEL, target_ok: 'matched', target_cancelled: 'receipt cancelled', payer_gone: 'payer voided or changed it', open: 'open',
  link_gone: 'link ended', connection_gone: 'connection ended', not_cash: 'not on cash', not_enabled: 'not enabled', check_failed: 'could not check',
  not_found: 'its message is missing', closed: 'set aside',
});

export const STATE_TONE: Readonly<Record<PaymentState, 'ok' | 'warn' | 'muted'>> = Object.freeze({
  open: 'ok', target_ok: 'ok', connection_gone: 'warn', not_cash: 'warn', closed: 'muted', not_enabled: 'muted', future_dated: 'muted', before_cutover: 'warn', payer_gone: 'warn',
  link_gone: 'warn', currency: 'warn', target_cancelled: 'warn', not_found: 'muted', check_failed: 'muted',
});

export const TONE_CLASS = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  muted: 'bg-slate-500/10 text-ink-muted border-line',
} as const;

export const HANDLED: Readonly<Record<string, string>> = Object.freeze({
  accepted: 'Matched', rejected: 'Rejected', dismissed: 'Dismissed', withdrawn: 'Withdrawn', pending: 'Open', failed: 'Open',
});

export const rowLabel = (i: Pick<PaymentItem, 'paymentNumber' | 'paymentReference' | 'id'>): string =>
  `payment ${i.paymentNumber ?? i.paymentReference ?? i.id.slice(0, 8)}`;
