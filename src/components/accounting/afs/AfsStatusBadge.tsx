// src/components/accounting/afs/AfsStatusBadge.tsx
import React from 'react';
import { Clock, CheckCircle, Lock } from 'lucide-react';
import type { DocumentStatus } from '@/modules/accounting/services/afs/afsTypes';

const STATUS_CONFIG: Record<DocumentStatus, { label: string; colour: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft',          colour: 'bg-zinc-700 text-zinc-200',     icon: <Clock className="w-3 h-3" /> },
  in_review:      { label: 'In Review',      colour: 'bg-blue-800 text-blue-200',     icon: <Clock className="w-3 h-3" /> },
  partner_review: { label: 'Partner Review', colour: 'bg-yellow-800 text-yellow-200', icon: <Clock className="w-3 h-3" /> },
  signed_off:     { label: 'Signed Off',     colour: 'bg-green-800 text-green-200',   icon: <CheckCircle className="w-3 h-3" /> },
  filed:          { label: 'Filed',          colour: 'bg-purple-800 text-purple-200', icon: <Lock className="w-3 h-3" /> },
};

export function AfsStatusBadge({ status }: { status: DocumentStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.colour}`}>
      {cfg.icon}{cfg.label}
    </span>
  );
}
