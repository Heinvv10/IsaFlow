import { Select } from '@/components/ui';
import { Company, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';
import { normalizeVatBasis, normalizeVatSetting } from '@/modules/bureau/services/vatPeriodHelper';
import { vatSystemSelectionUpdates } from './vatSystemSelection';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

const VAT_OPTIONS = [
  { value: 'invoice', label: 'Invoice Based', desc: 'VAT is accounted for when invoices are issued/received' },
  { value: 'payment', label: 'Payment Based', desc: 'VAT is accounted for when payments are made/received' },
  { value: 'none', label: 'No VAT', desc: 'Company is not registered for VAT' },
];

const VAT_FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'bi-monthly', label: 'Bi-Monthly' },
];
const VAT_ALIGNMENTS = [
  { value: 'odd', label: 'Category A (Dec-Jan, Feb-Mar, Apr-May...)' },
  { value: 'even', label: 'Category B (Jan-Feb, Mar-Apr, May-Jun...)' },
];

export function VatTab({ company, onChange }: Props) {
  // 'none' in EITHER column means not registered (the wizard writes the
  // cadence, this tab writes the system type). Selecting a system keeps both
  // columns in step so the two can never drift apart from here on.
  const registered = normalizeVatSetting(company.vatPeriod, company.vatSystemType) !== 'none';
  // A legacy/corrupted vat_system_type that is neither 'invoice' nor 'payment'
  // must still select SOMETHING, or the group renders with no radio checked
  // and the user cannot tell what the company is set to.
  const selectedSystem = registered ? normalizeVatBasis(company.vatSystemType) : 'none';
  const selectVatSystem = (value: string) => {
    for (const u of vatSystemSelectionUpdates(value, company.vatPeriod)) {
      onChange(u.field, u.value);
    }
  };

  return (
    <>
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">VAT System</h2>
        <div className="space-y-3">
          {VAT_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-[var(--ff-border-primary)] hover:border-teal-500/50 transition-colors">
              <input
                type="radio"
                name="vatSystem"
                value={opt.value}
                checked={opt.value === selectedSystem}
                onChange={e => selectVatSystem(e.target.value)}
                className="mt-0.5 accent-teal-500"
              />
              <div>
                <div className="text-sm font-medium text-[var(--ff-text-primary)]">{opt.label}</div>
                <div className="text-xs text-[var(--ff-text-tertiary)]">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      {registered && (
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">VAT Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="vat-tab-vat-number" className={LABEL_CLS}>VAT Number</label>
              <input id="vat-tab-vat-number" className={INPUT_CLS} value={company.vatNumber || ''} onChange={e => onChange('vatNumber', e.target.value)} placeholder="e.g. 4123456789" />
            </div>
            <div>
              <Select id="vat-tab-vat-reporting-frequency" label="VAT Reporting Frequency" labelClassName={LABEL_CLS} options={VAT_FREQUENCIES}
                value={normalizeVatSetting(company.vatPeriod)} onChange={v => { if (v) onChange('vatPeriod', v); }} />
            </div>
            {normalizeVatSetting(company.vatPeriod) === 'bi-monthly' && (
              <div>
                <Select id="vat-tab-bi-monthly-period-alignment" label="Bi-Monthly Period Alignment" labelClassName={LABEL_CLS} options={VAT_ALIGNMENTS}
                  value={company.vatPeriodAlignment || 'odd'} onChange={v => { if (v) onChange('vatPeriodAlignment', v); }} />
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                  {company.vatPeriodAlignment === 'even'
                    ? 'Category B: periods end in even months (Feb, Apr, Jun, Aug, Oct, Dec)'
                    : 'Category A: periods end in odd months (Jan, Mar, May, Jul, Sep, Nov)'}
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
