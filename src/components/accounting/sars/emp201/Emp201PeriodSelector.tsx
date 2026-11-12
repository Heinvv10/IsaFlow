/** EMP201 payroll period picker and Generate (moved from pages/accounting/sars/emp201.tsx). */
import { FileText, Loader2 } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';

interface Props {
  from: string;
  to: string;
  loading: boolean;
  onFromChange: (iso: string) => void;
  onToChange: (iso: string) => void;
  onGenerate: () => void;
}

export function Emp201PeriodSelector({ from, to, loading, onFromChange, onToChange, onGenerate }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <h2 className="text-sm font-medium text-[var(--ff-text-secondary)] mb-3">Payroll Period</h2>
      <div className="flex flex-wrap items-end gap-4">
        <DateField label="From" required value={from || null} onChange={(iso, v) => { if (v.valid && iso) onFromChange(iso); }} />
        <DateField label="To" required value={to || null} onChange={(iso, v) => { if (v.valid && iso) onToChange(iso); }} />
        <button
          onClick={onGenerate}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Generate
        </button>
      </div>
    </div>
  );
}
