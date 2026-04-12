/**
 * Customer Zone Tab — portal configuration settings
 * Mirrors Sage Accounting's Customer Zone settings panel.
 */

import { Globe } from 'lucide-react';
import { Company, Toggle, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

const PORTAL_MODES: { value: Company['portalMode']; label: string; description: string }[] = [
  {
    value: 'full',
    label: 'Full Access',
    description: 'Customers can view all documents, transaction history, and make payments.',
  },
  {
    value: 'invoices_only',
    label: 'Invoices Only',
    description: 'Customers can only view and pay outstanding invoices.',
  },
  {
    value: 'statements_only',
    label: 'Statements Only',
    description: 'Customers can only view their account statements.',
  },
];

export function CustomerZoneTab({ company, onChange }: Props) {
  const handleColorChange = (raw: string) => {
    // Accept only valid hex colors (3 or 6 chars)
    const clean = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(clean) || clean === '#') {
      onChange('portalPrimaryColor', clean === '#' ? null : clean);
    }
  };

  return (
    <>
      {/* General */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1 flex items-center gap-2">
          <Globe className="h-5 w-5 text-teal-500" /> Customer Zone — General
        </h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Configure how your self-service customer portal appears and behaves.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className={LABEL_CLS}>Portal Display Name</label>
            <input
              className={INPUT_CLS}
              maxLength={100}
              placeholder={company.name}
              value={company.portalDisplayName ?? ''}
              onChange={e => onChange('portalDisplayName', e.target.value || null)}
            />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
              Shown in the portal header instead of your company name.
            </p>
          </div>

          <div>
            <label className={LABEL_CLS}>Tagline</label>
            <input
              className={INPUT_CLS}
              maxLength={200}
              placeholder="Your trusted supplier"
              value={company.portalTagline ?? ''}
              onChange={e => onChange('portalTagline', e.target.value || null)}
            />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
              Short tagline shown below the display name.
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label className={LABEL_CLS}>Welcome Message</label>
          <textarea
            className={`${INPUT_CLS} resize-none`}
            rows={3}
            maxLength={1000}
            placeholder="Welcome to our customer portal. Here you can view your invoices and account history."
            value={company.portalWelcomeMessage ?? ''}
            onChange={e => onChange('portalWelcomeMessage', e.target.value || null)}
          />
        </div>

        <div className="max-w-xs">
          <label className={LABEL_CLS}>Primary Colour</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              className="h-9 w-14 rounded-lg border border-[var(--ff-border-primary)] cursor-pointer bg-transparent p-0.5"
              value={company.portalPrimaryColor ?? '#0d9488'}
              onChange={e => onChange('portalPrimaryColor', e.target.value)}
            />
            <input
              className={INPUT_CLS}
              maxLength={7}
              placeholder="#0d9488"
              value={company.portalPrimaryColor ?? ''}
              onChange={e => handleColorChange(e.target.value)}
            />
          </div>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
            Hex colour used for portal buttons and accents (e.g. #0d9488).
          </p>
        </div>
      </section>

      {/* Access Mode */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Access Mode</h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Control which documents customers can access in the portal.
        </p>

        <div className="space-y-3">
          {PORTAL_MODES.map(mode => (
            <label
              key={mode.value}
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-colors ${
                company.portalMode === mode.value
                  ? 'border-teal-500 bg-teal-500/5'
                  : 'border-[var(--ff-border-primary)] hover:border-teal-500/50'
              }`}
            >
              <input
                type="radio"
                name="portalMode"
                value={mode.value}
                checked={company.portalMode === mode.value}
                onChange={() => onChange('portalMode', mode.value)}
                className="mt-0.5 accent-teal-500"
              />
              <div>
                <p className="text-sm font-medium text-[var(--ff-text-primary)]">{mode.label}</p>
                <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">{mode.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Features</h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Toggle which self-service features are available to customers.
        </p>

        <div className="space-y-1">
          <Toggle
            checked={company.portalShowAccountBalance}
            onChange={v => onChange('portalShowAccountBalance', v)}
            label="Show Account Balance"
          />
          <Toggle
            checked={company.portalShowTransactionHistory}
            onChange={v => onChange('portalShowTransactionHistory', v)}
            label="Show Transaction History"
          />
          <Toggle
            checked={company.portalAllowPayments}
            onChange={v => onChange('portalAllowPayments', v)}
            label="Allow Payments"
          />
        </div>
      </section>

      {/* Payment Instructions */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Payment Instructions</h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Text shown to customers on the payment page. Include banking details or EFT instructions.
        </p>

        <textarea
          className={`${INPUT_CLS} resize-none`}
          rows={5}
          maxLength={2000}
          placeholder={`Please make payment via EFT to:\nBank: First National Bank\nAccount: 62xxxxxxxx\nBranch: 250655\nReference: Your invoice number`}
          value={company.portalPaymentInstructions ?? ''}
          onChange={e => onChange('portalPaymentInstructions', e.target.value || null)}
        />
        <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
          Shown when Allow Payments is enabled. Leave blank to show a generic contact message.
        </p>
      </section>
    </>
  );
}
