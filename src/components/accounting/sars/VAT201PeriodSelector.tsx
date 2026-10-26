import { Loader2, FileText, Calendar } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';

interface VATQuickPeriod {
  label: string;
  from: string;
  to: string;
}

interface Props {
  from: string;
  to: string;
  loading: boolean;
  vatPeriod: 'monthly' | 'bi-monthly';
  alignment: 'odd' | 'even';
  quickPeriods: VATQuickPeriod[];
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onQuickSelect: (from: string, to: string) => void;
  onGenerate: () => void;
}

export function VAT201PeriodSelector({
  from, to, loading, vatPeriod, alignment, quickPeriods,
  onFromChange, onToChange, onQuickSelect, onGenerate,
}: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-[var(--ff-text-secondary)] flex items-center gap-2">
          <Calendar className="h-4 w-4" /> VAT Period
        </h2>
        <span className="text-xs text-[var(--ff-text-tertiary)]">
          {vatPeriod === 'monthly' ? 'Monthly' : alignment === 'even' ? 'Bi-Monthly (Category B)' : 'Bi-Monthly (Category A)'}
        </span>
      </div>

      {quickPeriods.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {quickPeriods.map(p => (
            <button
              key={p.from}
              onClick={() => onQuickSelect(p.from, p.to)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                from === p.from && to === p.to
                  ? 'bg-brand-700 text-white border-teal-700'
                  : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:border-teal-500/50 hover:text-[var(--ff-text-primary)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <DateField
          id="vat201-period-start"
          label="Period Start"
          required
          value={from || null}
          onChange={(iso, v) => { if (v.valid && iso) onFromChange(iso); }}
        />
        <DateField
          id="vat201-period-end"
          label="Period End"
          required
          value={to || null}
          onChange={(iso, v) => { if (v.valid && iso) onToChange(iso); }}
        />
        <button
          onClick={onGenerate}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-700 text-white text-sm font-medium hover:bg-brand-800 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Generate
        </button>
      </div>
    </div>
  );
}
