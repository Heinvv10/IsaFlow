import { CheckCircle2, AlertCircle } from 'lucide-react';

export function StatusBadge({ status }: { status: 'open' | 'posted' }) {
  if (status === 'posted') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-teal-500/10 text-teal-400">
        <CheckCircle2 className="h-3 w-3" /> Posted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400">
      <AlertCircle className="h-3 w-3" /> Open
    </span>
  );
}
