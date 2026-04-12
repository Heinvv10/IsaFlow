/**
 * UDF Tab — User Defined Fields configuration
 * Shows 4 entity-type sections; each has 12 UDF slots configurable by label/type/required/active.
 */

import { useState, useEffect, useCallback } from 'react';
import { Save, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { INPUT_CLS, LABEL_CLS, SECTION_CLS, Toggle } from './settingsTypes';

// ── Types ────────────────────────────────────────────────────────────────────

type UdfEntityType = 'customer' | 'supplier' | 'invoice' | 'item';
type UdfFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

interface UdfDefinition {
  id?: string;
  entityType: UdfEntityType;
  fieldNumber: number;
  fieldLabel: string;
  fieldType: UdfFieldType;
  fieldOptions: string | null;
  isRequired: boolean;
  isActive: boolean;
}

type SectionState = Record<number, UdfDefinition>;

const ENTITY_SECTIONS: { type: UdfEntityType; label: string }[] = [
  { type: 'customer', label: 'Customer' },
  { type: 'supplier', label: 'Supplier' },
  { type: 'invoice', label: 'Invoice' },
  { type: 'item', label: 'Item' },
];

const FIELD_TYPES: { value: UdfFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'select', label: 'Select List' },
];

// Build 12 empty slots for an entity section
function emptySection(entityType: UdfEntityType): SectionState {
  const state: SectionState = {};
  for (let n = 1; n <= 12; n++) {
    state[n] = {
      entityType,
      fieldNumber: n,
      fieldLabel: '',
      fieldType: 'text',
      fieldOptions: null,
      isRequired: false,
      isActive: true,
    };
  }
  return state;
}

// ── Section component ─────────────────────────────────────────────────────────

function EntitySection({ entityType, label }: { entityType: UdfEntityType; label: string }) {
  const [slots, setSlots] = useState<SectionState>(emptySection(entityType));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  const fetchDefs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/udf-definitions?entityType=${entityType}`);
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
    } catch {
      setError('Failed to load field definitions');
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
        toSave.map(slot =>
          apiFetch('/api/accounting/udf-definitions', {
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
          }),
        ),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Failed to save field definitions');
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
          ) : (
            <>
              {error && (
                <p className="text-xs text-red-400 mb-2">{error}</p>
              )}

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
                  <div key={n} className={`grid grid-cols-12 gap-2 items-center px-1 py-1.5 rounded-lg ${isEmpty ? 'opacity-50' : ''}`}>
                    <div className="col-span-1 text-xs text-[var(--ff-text-tertiary)] font-mono">{n}</div>
                    <div className="col-span-4">
                      <input
                        type="text"
                        placeholder={`Field ${n} (unused)`}
                        value={slot.fieldLabel}
                        onChange={e => updateSlot(n, { fieldLabel: e.target.value })}
                        maxLength={100}
                        className={INPUT_CLS}
                      />
                    </div>
                    <div className="col-span-3">
                      <select
                        value={slot.fieldType}
                        onChange={e => updateSlot(n, { fieldType: e.target.value as UdfFieldType })}
                        disabled={isEmpty}
                        className={INPUT_CLS}
                      >
                        {FIELD_TYPES.map(ft => (
                          <option key={ft.value} value={ft.value}>{ft.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      {slot.fieldType === 'select' && (
                        <input
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
                      <input
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
                        label=""
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
                  className="flex items-center gap-2 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
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

// ── Main export ───────────────────────────────────────────────────────────────

export function UdfTab() {
  return (
    <div className="space-y-4">
      <div className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">User Defined Fields</h2>
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Add up to 12 custom fields to each entity type. Fields appear on the entity edit form
          and can be used in custom reports.
        </p>
      </div>

      {ENTITY_SECTIONS.map(s => (
        <EntitySection key={s.type} entityType={s.type} label={s.label} />
      ))}
    </div>
  );
}
