import { AlertTriangle, Clock, Info } from 'lucide-react';
import type { Severity } from '@/modules/bureau/services/bureauWorkTypes';

// Urgency colors (not record-status tones) — intentionally literal, not the StatusBadge/statusVocabulary set.
export const SEVERITY_BADGE: Record<
  Severity,
  { bg: string; fg: string; icon: typeof AlertTriangle; label: string }
> = {
  overdue:  { bg: 'bg-red-500/10',   fg: 'text-red-400',   icon: AlertTriangle, label: 'Overdue' },
  due_soon: { bg: 'bg-amber-500/10', fg: 'text-amber-400', icon: Clock,         label: 'Due soon' },
  info:     { bg: 'bg-sky-500/10',   fg: 'text-sky-400',   icon: Info,          label: 'Open' },
};
