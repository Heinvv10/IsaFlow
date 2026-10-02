import type { RuleVatCode } from '@/modules/accounting/types/bank.types';

const VAT_OPTIONS: { value: RuleVatCode; label: string }[] = [
  { value: 'none', label: 'No VAT' },
  { value: 'standard', label: 'Standard 15%' },
  { value: 'zero_rated', label: 'Zero Rated' },
  { value: 'exempt', label: 'Exempt' },
];

export type AllocType = 'account' | 'supplier' | 'customer' | 'bank';

export function VatTreatmentField({ allocType, vatCode, onChange }: {
  allocType: AllocType; vatCode: RuleVatCode; onChange: (v: RuleVatCode) => void;
}) {
  // `account` rules only; the other three post no VAT line.
  return (
    <div>
      <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">VAT Treatment</label>
      {allocType === 'account' ? (
        <div className="flex gap-1">
          {VAT_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                vatCode === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--ff-text-tertiary)] italic py-1.5">
          N/A — {allocType === 'bank'
            ? 'a transfer between your own accounts is not a supply.'
            : 'settling a bill or an invoice claims no VAT; the document already carried it.'}
        </p>
      )}
    </div>
  );
}

export function AllocTypeField({ allocType, onChange }: { allocType: AllocType; onChange: (t: AllocType) => void }) {
  return (
    <div>
      <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Allocation Type</label>
      <div className="flex gap-1">
        {(['account', 'supplier', 'customer', 'bank'] as AllocType[]).map(t => (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              allocType === t
                ? 'bg-teal-600 text-white'
                : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]'
            }`}
          >
            {t === 'account' ? 'Account' : t === 'supplier' ? 'Supplier' : t === 'customer' ? 'Customer' : 'Bank'}
          </button>
        ))}
      </div>
    </div>
  );
}
