/** One entity's block of 12 user-defined-field slots (split out of UdfTab.tsx, no behaviour change). */

import { useState, useEffect, useCallback } from 'react';
import { Select } from '@/components/ui';
import { Save, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { INPUT_CLS, SECTION_CLS, Toggle } from './settingsTypes';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { FIELD_TYPES, emptySection, type SectionState, type UdfDefinition, type UdfEntityType, type UdfFieldType } from './udfTypes';

// ── Section component ─────────────────────────────────────────────────────────

export function EntitySection({ entityType, label }: { entityType: UdfEntityType; label: string }) {
  const [slots, setSlots] = useState<SectionState>(emptySection(entityType));
  const afterDelay = useTimeoutOnce();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchDefs = useCallback(async () => {
    setLoading(true); setLoadFailed(false); setError('');
    try {
      const res = await apiFetch(`/api/accounting/udf-definitions?entityType=${entityType}`);
      await assertOk(res, 'Could not load field definitions - try again');
      const json = await res.json() as { data: UdfDefinition[] };
      if (json.data) {
        const incoming = json.data;
        setSlots(prev => {
          const next: SectionState = { ...prev };
          for (const def of incoming) {
            next[def.fieldNumber] = {
              id: def.id,
              entityType: def.entityType,
              fieldNumber: def.fieldNumber,
              fieldLabel: def.fieldLabel,
              fieldType: def.fieldType,
              fieldOptions: def.fieldOptions,
              isRequired: def.isRequired,
              isActive: def.isActive,
            };
          }
          return next;
        });
      }
    } catch (err) {
      setLoadFailed(true);
      setError(apiErrorMessage(err, 'Could not load field definitions - try again'));
    } finally {
      setLoading(false);
    }
  }, [entityType]);

  useEffect(() => {
    void fetchDefs();
  }, [fetchDefs]);

  const updateSlot = (n: number, patch: Partial<UdfDefinition>) => {
    setSlots(prev => {
      const existing = prev[n];
      if (!existing) return prev;
      const updated: UdfDefinition = { ...existing, ...patch };
      return { ...prev, [n]: updated };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Only save slots that have a label
      const toSave = Object.values(slots).filter(s => s.fieldLabel.trim().length > 0);
      await Promise.all(
        toSave.map(async slot => {
          const res = await apiFetch('/api/accounting/udf-definitions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entityType: slot.entityType,
              fieldNumber: slot.fieldNumber,
              fieldLabel: slot.fieldLabel.trim(),
              fieldType: slot.fieldType,
              fieldOptions: slot.fieldOptions,
              isRequired: slot.isRequired,
              isActive: slot.isActive,
            }),
          });
          await assertOk(res, 'Could not save the field definitions - try again');
        }),
      );
      setSaved(true);
      afterDelay(() => setSaved(false), 3000);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the field definitions - try again'));
    } finally {
      setSaving(false);
    }
  };

  const activeCount = Object.values(slots).filter(s => s.fieldLabel.trim().length > 0).length;

  return (
    <div className={SECTION_CLS}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">
            {label} Fields
          </h3>
          <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">
            {activeCount} of 12 fields configured
          </p>
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-[var(--ff-text-tertiary)] py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : loadFailed ? (
            <p className="text-xs text-red-400 mb-2">{error}</p>
          ) : (
            <>
              {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

              {/* Column headers */}
              <div className="grid grid-cols-12 gap-2 text-xs font-medium text-[var(--ff-text-secondary)] px-1">
                <div className="col-span-1">#</div>
                <div className="col-span-4">Label</div>
                <div className="col-span-3">Type</div>
                <div className="col-span-2">Options</div>
                <div className="col-span-1 text-center">Req</div>
                <div className="col-span-1 text-center">Active</div>
              </div>

              {Array.from({ length: 12 }, (_, i) => i + 1).map(n => {
                const slot: UdfDefinition | undefined = slots[n];
                if (!slot) return null;
                const isEmpty = slot.fieldLabel.trim().length === 0;
                return (
                  <div key={n} className="grid grid-cols-12 gap-2 items-center px-1 py-1.5 rounded-lg">
                    <div className="col-span-1 text-xs text-[var(--ff-text-tertiary)] font-id">{n}</div>
                    <div className="col-span-4">
                      <input aria-label={`${label} field ${n} label`}
                        type="text"
                        placeholder={`Field ${n} (unused)`}
                        value={slot.fieldLabel}
                        onChange={e => updateSlot(n, { fieldLabel: e.target.value })}
                        maxLength={100}
                        className={INPUT_CLS}
                      />
                    </div>
                    <div className="col-span-3">
                      <Select id={`udf-${entityType}-${n}-type`} label={`${label} field ${n} type`} labelClassName="sr-only" options={FIELD_TYPES}
                        value={slot.fieldType} disabled={isEmpty}
                        onChange={v => { if (v) updateSlot(n, { fieldType: v as UdfFieldType }); }} />
                    </div>
                    <div className="col-span-2">
                      {slot.fieldType === 'select' && (
                        <input aria-label={`${label} field ${n} options`}
                          type="text"
                          placeholder="a,b,c"
                          value={slot.fieldOptions ?? ''}
                          onChange={e => updateSlot(n, { fieldOptions: e.target.value || null })}
                          className={INPUT_CLS}
                          title="Comma-separated options"
                        />
                      )}
                    </div>
                    <div className="col-span-1 flex justify-center">
                      <input aria-label={`${label} field ${n} required`}
                        type="checkbox"
                        checked={slot.isRequired}
                        onChange={e => updateSlot(n, { isRequired: e.target.checked })}
                        disabled={isEmpty}
                        className="h-4 w-4 rounded accent-teal-500"
                      />
                    </div>
                    <div className="col-span-1 flex justify-center">
                      <Toggle
                        checked={slot.isActive}
                        onChange={v => updateSlot(n, { isActive: v })}
                        label="" ariaLabel={`${label} field ${n} active`}
                      />
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between pt-3 border-t border-[var(--ff-border-primary)]">
                {saved && (
                  <span className="text-xs text-teal-400">Saved successfully</span>
                )}
                {!saved && <span />}
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="flex items-center gap-2 px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Save {label} Fields
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
