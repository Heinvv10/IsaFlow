/**
 * The VAT201 fields: the summary/detail switch and the SARS form or its transactions
 * (moved from pages/accounting/sars/vat201.tsx; L3u adds drill links in the field views).
 */
import { useState } from 'react';
import { VAT201DetailView } from './VAT201DetailView';
import { VAT201SummaryForm } from './VAT201SummaryForm';
import { Vat201DrillDrawer } from './drill/Vat201DrillDrawer';
import { MAX_DRILL_WINDOW_DAYS, windowTooLong } from './drill/returnDrillClient';
import type { VAT201Invoice } from './VAT201FormSections';
import type { Vat201SarsField } from '@/modules/accounting/services/reports/vat201SarsFields';

interface Props {
  data: { periodStart: string; periodEnd: string; sarsFields: Vat201SarsField[]; outputInvoices: VAT201Invoice[]; inputInvoices: VAT201Invoice[] };
}

export function Vat201FieldsSection({ data }: Props) {
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  /** The fields drilled through, newest last: a component's drill can go back to the field it came from. */
  const [trail, setTrail] = useState<string[]>([]);
  const tooLong = windowTooLong(data.periodStart, data.periodEnd);
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-1">
          {(['summary', 'detail'] as const).map(mode => (
            <button key={mode} onClick={() => setViewMode(mode)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === mode ? 'bg-brand-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--ff-text-tertiary)]">
          {viewMode === 'summary' ? 'SARS VAT201 box totals' : `${data.outputInvoices.length + data.inputInvoices.length} transactions`}
        </span>
      </div>

      {viewMode === 'summary' && tooLong && (
        <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="vat201-drill-window-note">
          Lines are available for periods up to {MAX_DRILL_WINDOW_DAYS} days; narrow the period.
        </p>
      )}
      {viewMode === 'summary' ? (
        <VAT201SummaryForm data={data} onDrill={tooLong ? undefined : (f) => setTrail([f])} />
      ) : (
        <VAT201DetailView data={data} />
      )}
      <Vat201DrillDrawer field={trail.at(-1) ?? null} from={data.periodStart} to={data.periodEnd}
        onClose={() => setTrail([])} onField={(f) => setTrail((t) => [...t, f])}
        backTo={trail.length > 1 ? trail.at(-2) : undefined} onBack={() => setTrail((t) => t.slice(0, -1))} />
    </>
  );
}
