/**
 * Money — renders a ZAR amount in the app face (DM Sans) with tabular figures.
 * Formatting logic lives in @/lib/money/formatMoney (unit-tested).
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { formatMoney } from '@/lib/money/formatMoney';

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  amount: number;
  /** Decimal places (default 2). */
  decimals?: number;
}

export function Money({ amount, decimals, className, style, ...props }: MoneyProps) {
  return (
    <span className={cn('tabular-nums', className)} style={style} {...props}>
      {formatMoney(amount, { decimals })}
    </span>
  );
}

Money.displayName = 'Money';
