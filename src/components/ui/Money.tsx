/**
 * Money — renders a ZAR amount in the app face (DM Sans) with tabular figures.
 * Formatting logic lives in @/lib/money/formatMoney (unit-tested).
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { formatCents, formatMoney } from '@/lib/money/formatMoney';

type MoneyValue =
  | {
      /** Rand. */
      amount: number;
      /** Decimal places (default 2). */
      decimals?: number;
      cents?: never;
    }
  | {
      /** Integer cents, as MoneyField hands them over: shown exactly, never divided in floating point. */
      cents: number;
      amount?: never;
      decimals?: never;
    };

export type MoneyProps = React.HTMLAttributes<HTMLSpanElement> & MoneyValue;

export function Money({ amount, cents, decimals, className, style, ...props }: MoneyProps) {
  return (
    <span className={cn('tabular-nums', className)} style={style} {...props}>
      {cents !== undefined ? formatCents(cents) : amount !== undefined ? formatMoney(amount, { decimals }) : '—'}
    </span>
  );
}

Money.displayName = 'Money';
