/** Status pills and the days-until helper shared by the SARS overview page and its calendar table. */
import { CheckCircle2, Clock, XCircle } from 'lucide-react';

export const statusBadge = (status: string) => {
  const label = status === 'submitted'
    ? 'Filed on eFiling'
    : status === 'completed'
      ? 'Marked filed'
      : status.charAt(0).toUpperCase() + status.slice(1);
  switch (status) {
    case 'completed':
    case 'submitted':
    case 'accepted':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> {label}
        </span>
      );
    case 'overdue':
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400">
          <XCircle className="h-3 w-3" /> {label}
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
          <Clock className="h-3 w-3" /> {label}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/10 text-gray-600 dark:text-gray-400">
          {label}
        </span>
      );
  }
};

export const daysUntil = (d: string) => {
  const now = new Date();
  // Calendar days, not elapsed time: both days go to UTC midnight, so a daylight-saving
  // change in between (a 23- or 25-hour day) cannot add or drop a day. 'YYYY-MM-DD' is a
  // local calendar day: new Date(d) would parse it as UTC midnight.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const due = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
};
