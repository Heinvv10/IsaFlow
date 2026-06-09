/**
 * ClientTriageBoard — the per-client R/A/G+Blue board at the top of the /bureau
 * cockpit. One row per client: a status light, the company name, terse severity
 * counts, and a chevron linking into that client's Level 2 home.
 *
 * Purely presentational — it renders the ClientTriage[] the endpoint already
 * computed (via rollupClientTriage). No data fetching, no company switching.
 */
import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Feed } from '@/components/ui';
import type { ClientTriage, TriageLight } from '@/modules/bureau/services/bureauClientTriageService';

const LIGHT_DOT: Record<TriageLight, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
};

/** Compose the terse count line, e.g. "3 overdue · 1 due soon", "8 open", "clear". */
function countLabel(t: ClientTriage): string {
  if (t.total === 0) return 'clear';
  const parts: string[] = [];
  if (t.overdue) parts.push(`${t.overdue} overdue`);
  if (t.dueSoon) parts.push(`${t.dueSoon} due soon`);
  if (t.info) parts.push(`${t.info} open`);
  return parts.join(' · ');
}

export interface ClientTriageBoardProps {
  items: ClientTriage[];
  /** Show the bureau name on each row (only when the user spans 2+ bureaus). */
  showBureau?: boolean;
}

export function ClientTriageBoard({ items, showBureau = false }: ClientTriageBoardProps) {
  return (
    <Feed title="Clients" empty="No clients linked to this bureau yet.">
      {items.map((t) => (
        <Link
          key={`${t.bureauId}-${t.companyId}`}
          href={`/bureau/clients/${t.companyId}`}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ff-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
        >
          <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${LIGHT_DOT[t.light]}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-[var(--ff-text-primary)]">{t.companyName}</div>
            {showBureau && <div className="truncate text-xs text-[var(--ff-text-tertiary)]">{t.bureauName}</div>}
          </div>
          <span
            className={`flex-shrink-0 whitespace-nowrap text-xs ${
              t.total === 0 ? 'text-[var(--ff-text-tertiary)]' : 'text-[var(--ff-text-secondary)]'
            }`}
          >
            {countLabel(t)}
          </span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
        </Link>
      ))}
    </Feed>
  );
}

ClientTriageBoard.displayName = 'ClientTriageBoard';
