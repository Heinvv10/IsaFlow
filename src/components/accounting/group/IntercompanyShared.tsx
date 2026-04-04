/**
 * Intercompany Shared Components
 * Primitives and stat cards reused across the intercompany reconciliation page.
 */

export const fmt = (n: number, currency = 'ZAR') =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(n);

export const STATUS_STYLES: Record<string, string> = {
  matched: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  partial: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  unmatched: 'bg-red-500/10 text-red-400 border-red-500/30',
  variance: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
};

export const TX_TYPES = [
  { value: 'sale', label: 'Sale' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'loan', label: 'Loan' },
  { value: 'dividend', label: 'Dividend' },
  { value: 'mgmt_fee', label: 'Management Fee' },
  { value: 'transfer', label: 'Transfer' },
] as const;

export interface IntercompanyTx {
  id: string;
  date: string;
  sourceCompanyId: string;
  sourceCompanyName: string;
  targetCompanyId: string;
  targetCompanyName: string;
  type: string;
  amount: number;
  currency: string;
  description: string;
  status: 'matched' | 'partial' | 'unmatched' | 'variance';
  matchedTxId?: string;
  journalEntryId?: string;
}

export interface ReconciliationStats {
  totalVolume: number;
  matchedCount: number;
  matchedAmount: number;
  unmatchedCount: number;
  unmatchedAmount: number;
  varianceCount: number;
  varianceAmount: number;
}

export function StatCard({
  label, value, sub, color,
}: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</p>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)]">{sub}</p>
    </div>
  );
}

export function FieldInput({
  label, value, onChange, type = 'text', placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full px-3 py-2 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)]"
      />
    </label>
  );
}

export function FieldSelect({
  label, value, onChange, options, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--ff-text-tertiary)] uppercase">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-3 py-2 text-sm bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-primary)]"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
