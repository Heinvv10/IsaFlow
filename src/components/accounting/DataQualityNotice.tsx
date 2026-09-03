/**
 * Renders the data-quality caveats the reporting resolver attaches to its
 * responses.
 *
 * The reporting audit's core finding was silent wrongness: figures that look
 * authoritative while resting on a guess. The resolver therefore reports what
 * it had to assume — accounts it could not classify and defaulted to current,
 * and whether it could identify inventory at all. Emitting those on the API and
 * never rendering them would move the same defect one layer out, so every
 * surface showing the figures shows these too.
 *
 * Wording lives in `buildDataQualityNotices` so it can be tested without a DOM.
 */
import { AlertTriangle } from 'lucide-react';
import {
  buildDataQualityNotices,
  type DataQualityInput,
} from '@/modules/accounting/services/reports/dataQualityNotices';

export type {
  UnclassifiedWarning,
  InventoryWarning,
} from '@/modules/accounting/services/reports/dataQualityNotices';

export function DataQualityNotice(props: DataQualityInput) {
  const notices = buildDataQualityNotices(props);
  if (notices.length === 0) return null;

  return (
    <div
      role="status"
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
      data-testid="data-quality-notice"
    >
      <div className="flex gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
        <div>
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">
            These figures rest on an assumption
          </h3>
          <ul className="mt-1 space-y-1 text-sm text-[var(--ff-text-secondary)]">
            {notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
