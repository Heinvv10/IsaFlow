/** The setup checklist of one side: a badge per item, green when done, amber when a required item is still open. */
import { Check, Circle } from 'lucide-react';
import type { Checklist } from '@/modules/accounting/services/intercompany/connectionTypes';

export function ChecklistBadges({ checklist }: { checklist: Checklist }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Setup checklist">
      {checklist.items.map((item) => {
        const state = item.done ? 'done' : item.required ? 'open' : 'optional';
        const tone = item.done
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
          : item.required
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30'
            : 'bg-[var(--ff-bg-tertiary)] text-ink-muted border-[var(--ff-border-light)]';
        return (
          <li key={item.key} data-testid={`check-${item.key}`} data-state={state}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone}`}>
            {item.done ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}
            <span>{item.label}</span>
            <span className="sr-only">{state === 'done' ? '(done)' : state === 'open' ? '(still to do)' : '(not needed)'}</span>
          </li>
        );
      })}
    </ul>
  );
}
