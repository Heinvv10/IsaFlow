import { Clock, CheckCircle2, AlertOctagon } from 'lucide-react';

export type GateStatus = 'auto' | 'review' | 'duplicate' | 'no_rule' | 'rule_failed' | 'not_ready';

export interface GateInfo {
  status: GateStatus;
  reason?: string;
  invoiceRef?: string;
}

export const RULE_FAILED = 'Could not load this supplier\'s auto-publish rule - the document will be posted for review';

// ─── Gate Badge ───────────────────────────────────────────────────────────────

export function GateBadge({ gate }: { gate: GateInfo }) {
  if (gate.status === 'not_ready') return null;
  if (gate.status === 'rule_failed') {
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/30 text-amber-400 text-xs">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        {RULE_FAILED}
      </div>
    );
  }
  if (gate.status === 'no_rule') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-400 text-xs">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        No rule configured for this supplier
      </div>
    );
  }
  if (gate.status === 'duplicate') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/40 text-red-400 text-xs">
        <AlertOctagon className="h-3.5 w-3.5 shrink-0" />
        Duplicate of invoice {gate.invoiceRef ?? gate.reason ?? 'existing record'}
      </div>
    );
  }
  if (gate.status === 'review') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/30 text-amber-400 text-xs">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        Routed for review — {gate.reason}
      </div>
    );
  }
  // auto
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-900/30 text-teal-400 text-xs">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      Auto-publish eligible
    </div>
  );
}
