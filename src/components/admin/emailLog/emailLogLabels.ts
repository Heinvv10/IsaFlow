import { formatDisplayDateTime } from '@/utils/dateFormat';

export const fmtDate = (d: string) => {
  if (!d) return '—';
  return formatDisplayDateTime(d);
};

export const EMAIL_TYPES = ['invoice', 'statement', 'quote', 'payment_receipt', 'invite', 'other'] as const;

export const STATUS_COLORS: Record<string, string> = {
  sent:    'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  failed:  'bg-red-500/10 text-red-400 border border-red-500/30',
  bounced: 'bg-amber-500/10 text-amber-400 border border-amber-500/30',
};

export const TYPE_LABELS: Record<string, string> = {
  invoice:         'Invoice',
  statement:       'Statement',
  quote:           'Quote',
  payment_receipt: 'Payment Receipt',
  invite:          'Invite',
  other:           'Other',
};
