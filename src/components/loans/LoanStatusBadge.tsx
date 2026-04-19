/**
 * LoanStatusBadge — pill badge for loan status values.
 */

import { STATUS_COLOURS } from './types';

interface Props {
  status: string;
}

export function LoanStatusBadge({ status }: Props) {
  const cls = STATUS_COLOURS[status] ?? 'bg-gray-500/10 text-gray-400';
  const label = status.replace(/_/g, ' ');
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {label}
    </span>
  );
}
