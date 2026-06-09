/**
 * Level-2 client-home BODY: a glanceable metric strip + a "needs you" feed.
 * Presentational only — each consuming page owns its header / error / loading
 * chrome and supplies onOpenItem (the bureau page switches the active company
 * first; the direct /home page is already on its own company).
 */
import { Card, Feed, ActionRow, Money } from '@/components/ui';
import { SEVERITY_BADGE } from '@/components/bureau/severityBadge';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

const METRIC_CARDS: Array<{ key: keyof ClientMetrics; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'ar', label: 'Accounts Receivable' },
  { key: 'ap', label: 'Accounts Payable' },
  { key: 'revenueMtd', label: 'Revenue MTD' },
  { key: 'profitMtd', label: 'Profit MTD' },
];

interface ClientHomeViewProps {
  metrics: ClientMetrics;
  workItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
}

export function ClientHomeView({ metrics, workItems, onOpenItem }: ClientHomeViewProps) {
  return (
    <div className="p-6 space-y-6">
      {/* Metric strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {METRIC_CARDS.map((m) => (
          <Card key={m.key}>
            <div className="text-xs text-[var(--ff-text-tertiary)]">{m.label}</div>
            <Money amount={metrics[m.key]} className="block text-2xl mt-1 text-[var(--ff-text-primary)]" />
          </Card>
        ))}
      </div>

      {/* Needs-you feed */}
      <Feed title="Needs you" empty="All caught up — nothing needs you.">
        {workItems.map((it) => {
          const badge = SEVERITY_BADGE[it.severity];
          const Icon = badge.icon;
          return (
            <ActionRow
              key={`${it.task}-${it.href}`}
              onClick={() => onOpenItem(it)}
              leading={
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                  <Icon className="h-3 w-3" /> {badge.label}
                </span>
              }
              title={<span className="font-medium">{it.task}</span>}
              subtitle={it.detail}
              amount={it.amount ?? null}
              meta={it.dueAt ? new Date(it.dueAt).toLocaleDateString() : '—'}
            />
          );
        })}
      </Feed>
    </div>
  );
}
