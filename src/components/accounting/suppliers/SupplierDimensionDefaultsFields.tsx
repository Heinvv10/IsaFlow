/**
 * A supplier's default CC1 (FNO), CC2 (project) and BU (migration 890), on the
 * supplier coding-rule page. Every bill line of the supplier that leaves them
 * open takes them (supplierDimensionDefaults.ts); a line's own pick wins. The
 * FNO is only needed for a supplier with no project (overheads): with a CC2,
 * the FNO is derived from it and a contradicting one is refused on save.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { centreOptions, type CodingOption } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

export interface SupplierDimensionDefaults { cc1Id: string; cc2Id: string; buId: string }

/** The three default columns as the supplier-rules routes return them. */
export interface RuleDimensionDefaults { defaultCc1Id: string | null; defaultCc2Id: string | null; defaultBuId: string | null }

export const NO_DIMENSION_DEFAULTS: SupplierDimensionDefaults = { cc1Id: '', cc2Id: '', buId: '' };

export function dimensionsOfRule(rule: RuleDimensionDefaults): SupplierDimensionDefaults {
  return { cc1Id: rule.defaultCc1Id ?? '', cc2Id: rule.defaultCc2Id ?? '', buId: rule.defaultBuId ?? '' };
}

/**
 * The save body's default fields: only what changed. Re-sending an unchanged default whose master was since
 * deactivated would be refused, and an omitted field is left as held (null clears it).
 */
export function changedDimensionDefaults(
  dims: SupplierDimensionDefaults, rule: RuleDimensionDefaults | null,
): Partial<RuleDimensionDefaults> {
  return {
    ...((dims.cc1Id || null) !== (rule?.defaultCc1Id ?? null) ? { defaultCc1Id: dims.cc1Id || null } : {}),
    ...((dims.cc2Id || null) !== (rule?.defaultCc2Id ?? null) ? { defaultCc2Id: dims.cc2Id || null } : {}),
    ...((dims.buId || null) !== (rule?.defaultBuId ?? null) ? { defaultBuId: dims.buId || null } : {}),
  };
}

interface Props {
  value: SupplierDimensionDefaults;
  onChange: (next: SupplierDimensionDefaults) => void;
}

const sel = 'w-full px-3 py-2 rounded bg-white/5 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-blue-500';
const lbl = 'block text-sm text-[var(--ff-text-secondary)] mb-1';

function Picker({ label, value, options, onChange }: {
  label: string; value: string; options: CodingOption[]; onChange: (v: string) => void;
}) {
  // A saved id the active list no longer offers stays selected, so saving does not silently clear it.
  const unoffered = value !== '' && !options.some((o) => o.id === value);
  return (
    <div>
      <label className={lbl}>{label}</label>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={sel}>
        <option value="">— None —</option>
        {unoffered && <option value={value}>Inactive or unavailable — kept as saved</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function SupplierDimensionDefaultsFields({ value, onChange }: Props) {
  const [cc1s, setCc1s] = useState<CodingOption[]>([]);
  const [cc2s, setCc2s] = useState<CodingOption[]>([]);
  const [bus, setBus] = useState<CodingOption[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([
      apiJson('/api/accounting/cost-centres?active=true&cc_type=cc1', undefined, 'Could not load the FNOs - try again'),
      apiJson('/api/accounting/cost-centres?active=true&cc_type=cc2', undefined, 'Could not load the CC2 projects - try again'),
      apiJson('/api/accounting/business-units?active=true', undefined, 'Could not load the business units - try again'),
    ]).then(([c1, c2, b]) => {
      if (!live) return;
      setCc1s(centreOptions(c1)); setCc2s(centreOptions(c2)); setBus(centreOptions(b));
    }).catch((err: unknown) => {
      if (live) setError(apiErrorMessage(err, 'Could not load the dimension lists - try again'));
    });
    return () => { live = false; };
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--ff-text-secondary)]">
        Bill lines of this supplier that name no project or BU take these. A line&apos;s own choice always wins.
      </p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <Picker label="Default CC2 project" value={value.cc2Id} options={cc2s} onChange={(v) => onChange({ ...value, cc2Id: v })} />
      <Picker label="Default BU" value={value.buId} options={bus} onChange={(v) => onChange({ ...value, buId: v })} />
      <Picker label="Default FNO (CC1) — only for a supplier with no project" value={value.cc1Id} options={cc1s}
        onChange={(v) => onChange({ ...value, cc1Id: v })} />
    </div>
  );
}

/** The coding-rule page's section: heading plus the three pickers. */
export function SupplierDimensionDefaultsSection({ value, onChange }: Props) {
  return (
    <section className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Default Project &amp; Business Unit</h2>
      <SupplierDimensionDefaultsFields value={value} onChange={onChange} />
    </section>
  );
}
