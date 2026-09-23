/**
 * The supplier's "subject to DRC VAT" flag, set in place on the supplier page.
 *
 * DRC VAT eligibility reads only this flag, and suppliers have no edit screen,
 * so this is the one place a user sets it for an existing supplier. It saves
 * on click and puts the switch back if the save is refused — `apiFetch`
 * resolves on a 4xx, so `res.ok` is checked explicitly.
 */
import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { Toggle } from '@/components/accounting/settings/settingsTypes';

export function DrcFlagToggle({ supplierId, initial }: { supplierId: string; initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  const [saving, setSaving] = useState(false);

  const save = async (next: boolean) => {
    setChecked(next);
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/suppliers-list', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: supplierId, subject_to_drc_vat: next }),
      });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      notify.success(next ? 'Supplier marked as subject to DRC VAT' : 'DRC VAT flag removed');
    } catch (err: unknown) {
      setChecked(!next);
      notify.error(err instanceof Error ? err.message : 'Failed to save the DRC VAT flag');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-2">VAT</p>
      <Toggle
        checked={checked}
        disabled={saving}
        onChange={(v) => { void save(v); }}
        label="Subject to DRC VAT (domestic reverse charge)"
      />
      <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
        Only a flagged supplier&apos;s approved, zero-VAT invoices appear on the DRC VAT page.
      </p>
    </div>
  );
}
