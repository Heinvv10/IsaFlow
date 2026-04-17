/**
 * StatusPill — semantic status indicator that maps domain status names to
 * the four canonical colours (success/warning/info/danger/neutral).
 *
 * Use this anywhere a status name needs to render as a coloured pill so the
 * same status (e.g. "Approved") looks identical across pages.
 *
 * Usage: <StatusPill status="approved" />
 *        <StatusPill status="overdue" dot />
 *        <StatusPill status="custom" variant="warning">Custom</StatusPill>
 */

import * as React from 'react';
import { Badge, type BadgeProps } from './Badge';

type Variant = NonNullable<BadgeProps['variant']>;

const STATUS_TO_VARIANT: Record<string, Variant> = {
  // success — done / good / paid
  active:    'success',
  approved:  'success',
  applied:   'success',
  paid:      'success',
  signed_off: 'success',
  signed:    'success',
  reconciled: 'success',
  ready:     'success',
  available: 'success',
  completed: 'success',
  posted:    'success',
  confirmed: 'success',
  accepted:  'success',
  received:  'success',
  succeeded: 'success',
  owner:     'success',

  // warning — pending / draft / awaiting
  draft:           'warning',
  pending:         'warning',
  in_review:       'warning',
  partner_review:  'warning',
  reviewing:       'warning',
  partial:         'warning',
  partially_received: 'warning',
  partially_paid:  'warning',
  warning:         'warning',
  expired:         'warning',
  on_hold:         'warning',
  paused:          'warning',
  inactive:        'warning',

  // info — informational / in-progress
  sent:        'info',
  submitted:   'info',
  in_progress: 'info',
  open:        'info',
  scheduled:   'info',
  filed:       'info',
  converted:   'info',
  assigned:    'info',
  invited:     'info',

  // danger — overdue / failed / blocked
  overdue:   'danger',
  declined:  'danger',
  rejected:  'danger',
  failed:    'danger',
  cancelled: 'danger',
  canceled:  'danger',
  blocked:   'danger',
  abandoned: 'danger',
  error:     'danger',
  void:      'danger',

  // neutral — unspecified / system roles
  admin:    'neutral',
  manager:  'neutral',
  viewer:   'neutral',
  member:   'neutral',
  user:     'neutral',
  unknown:  'neutral',
  not_started: 'neutral',
};

function humaniseStatus(status: string): string {
  return status
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export interface StatusPillProps extends Omit<BadgeProps, 'variant' | 'children'> {
  /** Domain status name. Looked up in STATUS_TO_VARIANT to pick a colour. */
  status: string;
  /** Override the variant lookup (e.g. for custom statuses). */
  variant?: BadgeProps['variant'];
  /** Override the displayed label. Defaults to humanised status. */
  label?: string;
  /** Render as children (rare). */
  children?: React.ReactNode;
}

export function StatusPill({ status, variant, label, children, ...rest }: StatusPillProps) {
  const key = String(status).toLowerCase().trim();
  const resolvedVariant = variant ?? STATUS_TO_VARIANT[key] ?? 'neutral';
  return (
    <Badge variant={resolvedVariant} {...rest}>
      {children ?? label ?? humaniseStatus(status)}
    </Badge>
  );
}

StatusPill.displayName = 'StatusPill';
