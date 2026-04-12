/**
 * Regional Settings Tab
 * Controls date format, number separators, decimal places,
 * invoice logo position, and rounding method.
 * Changes are committed via the parent page's Save Changes button
 * (onChange propagates to company state).
 */

import { Globe } from 'lucide-react';
import { Company, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

const DATE_FORMATS = [
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (South African standard)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (US format)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO 8601)' },
];

const DECIMAL_SEPARATORS = [
  { value: '.', label: '. (period)' },
  { value: ',', label: ', (comma)' },
];

const THOUSANDS_SEPARATORS = [
  { value: ',', label: ', (comma)' },
  { value: '.', label: '. (period)' },
  { value: ' ', label: '(space)' },
  { value: '', label: 'None' },
];

const LOGO_POSITIONS = [
  { value: 'top-left', label: 'Top Left' },
  { value: 'top-center', label: 'Top Center' },
  { value: 'top-right', label: 'Top Right' },
];

const ROUNDING_METHODS = [
  { value: 'half-up', label: 'Half-Up (standard)' },
  { value: 'half-even', label: "Banker's Rounding (half-even)" },
];

function formatPreview(company: Company): string {
  const { currencySymbol, decimalPlaces, decimalSeparator, thousandsSeparator } = company;
  const num = 1234567.89;
  const fixed = num.toFixed(decimalPlaces);
  const [intPart, fracPart] = fixed.split('.');

  // Group integer part with thousands separator
  const grouped = (intPart ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator ?? ',');

  const result = fracPart !== undefined && decimalPlaces > 0
    ? `${grouped}${decimalSeparator}${fracPart}`
    : grouped;

  return `${currencySymbol ?? 'R'}\u00A0${result}`;
}

export function RegionalTab({ company, onChange }: Props) {
  const preview = formatPreview(company);

  return (
    <div className="space-y-6">
      {/* Header card */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1 flex items-center gap-2">
          <Globe className="h-5 w-5" /> Regional Settings
        </h2>
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Configure locale-specific formatting for dates and numbers, invoice logo placement, and
          rounding behaviour. These settings affect how values are displayed throughout the system.
        </p>

        {/* Live preview */}
        <div className="mt-4 px-4 py-3 rounded-lg bg-[var(--ff-bg-primary)] border border-teal-500/30">
          <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Live number preview</p>
          <p className="text-xl font-mono font-semibold text-teal-400">{preview}</p>
        </div>
      </section>

      {/* Date & Number format */}
      <section className={SECTION_CLS}>
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Date &amp; Number Format</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Date Format</label>
            <select
              className={INPUT_CLS}
              value={company.dateFormat}
              onChange={e => onChange('dateFormat', e.target.value)}
            >
              {DATE_FORMATS.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Decimal Separator</label>
            <select
              className={INPUT_CLS}
              value={company.decimalSeparator}
              onChange={e => onChange('decimalSeparator', e.target.value)}
            >
              {DECIMAL_SEPARATORS.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Thousands Separator</label>
            <select
              className={INPUT_CLS}
              value={company.thousandsSeparator}
              onChange={e => onChange('thousandsSeparator', e.target.value)}
            >
              {THOUSANDS_SEPARATORS.map(s => (
                <option key={JSON.stringify(s.value)} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS}>Decimal Places (amounts)</label>
            <input
              type="number"
              min={0}
              max={4}
              className={INPUT_CLS}
              value={company.decimalPlaces}
              onChange={e => onChange('decimalPlaces', Math.min(4, Math.max(0, Number(e.target.value))))}
            />
          </div>
        </div>
      </section>

      {/* Invoice logo position */}
      <section className={SECTION_CLS}>
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-2">Invoice Logo Position</h3>
        <p className="text-xs text-[var(--ff-text-secondary)] mb-4">
          Controls where your company logo appears on printed/PDF invoices.
        </p>
        <div className="flex gap-4 flex-wrap">
          {LOGO_POSITIONS.map(pos => (
            <label key={pos.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="invoiceLogoPosition"
                value={pos.value}
                checked={company.invoiceLogoPosition === pos.value}
                onChange={() => onChange('invoiceLogoPosition', pos.value)}
                className="accent-teal-500 h-4 w-4"
              />
              <span className="text-sm text-[var(--ff-text-primary)]">{pos.label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Rounding method */}
      <section className={SECTION_CLS}>
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-2">Rounding Method</h3>
        <p className="text-xs text-[var(--ff-text-secondary)] mb-4">
          Half-Up rounds 0.5 away from zero (e.g. 2.5 → 3).
          Banker&apos;s Rounding (half-even) rounds to the nearest even digit (e.g. 2.5 → 2, 3.5 → 4),
          reducing cumulative rounding bias.
        </p>
        <div className="flex gap-6 flex-wrap">
          {ROUNDING_METHODS.map(method => (
            <label key={method.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="roundingMethod"
                value={method.value}
                checked={company.roundingMethod === method.value}
                onChange={() => onChange('roundingMethod', method.value)}
                className="accent-teal-500 h-4 w-4"
              />
              <span className="text-sm text-[var(--ff-text-primary)]">{method.label}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
