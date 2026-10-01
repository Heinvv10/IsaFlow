/**
 * A pay run's status chip, and which statuses lock the run. Moved out of
 * pages/payroll/runs/[id].tsx unchanged, to keep that page under 300 lines.
 */
import { Lock } from 'lucide-react';

const LOCKED_STATUSES = new Set(['approved', 'paid', 'cancelled']);
export const isLocked = (status: string) => LOCKED_STATUSES.has(status);

export function PayrollRunStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    calculated: 'bg-blue-500/10 text-blue-400',
    approved: 'bg-teal-500/10 text-teal-400',
    paid: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {isLocked(status) && <Lock className="h-3 w-3" />} {status}
    </span>
  );
}
