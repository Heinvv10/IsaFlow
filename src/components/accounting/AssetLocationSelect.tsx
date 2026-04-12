/**
 * AssetLocationSelect
 * Dropdown populated from /api/accounting/asset-locations.
 * Includes an inline "+ Add location" mini-form.
 * Backward-compatible: if the current value doesn't match any managed location
 * it is surfaced as an "Other (legacy)" option.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Location {
  id: string;
  name: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  className?: string;
}

export function AssetLocationSelect({ value, onChange, required, className }: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState('');

  const loadLocations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/asset-locations', { credentials: 'include' });
      const json = await res.json() as { data?: Location[] };
      setLocations(json.data ?? []);
    } catch {
      // silently fall through — users can still type via legacy path
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadLocations(); }, [loadLocations]);

  // Detect legacy free-text value that has no matching managed location
  const isLegacy =
    value.trim().length > 0 && !locations.some(l => l.name === value);

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSaving(true);
    setAddError('');
    try {
      const res = await apiFetch('/api/accounting/asset-locations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = await res.json() as { data?: Location; error?: { message: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to add location');
      await loadLocations();
      if (json.data) onChange(json.data.name);
      setNewName('');
      setShowAdd(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="relative">
        {loading ? (
          <div className="ff-input w-full flex items-center gap-2 text-[var(--ff-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading locations…</span>
          </div>
        ) : (
          <select
            value={value}
            onChange={e => onChange(e.target.value)}
            required={required}
            className={className ?? 'ff-select w-full'}
          >
            <option value="">Select location…</option>

            {isLegacy && (
              <option value={value}>{value} (legacy)</option>
            )}

            {locations.map(l => (
              <option key={l.id} value={l.name}>{l.name}</option>
            ))}
          </select>
        )}
      </div>

      {!showAdd ? (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300"
        >
          <Plus className="h-3 w-3" />
          Add location
        </button>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            placeholder="New location name"
            maxLength={100}
            className="ff-input flex-1 text-sm"
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={saving || newName.trim().length === 0}
            className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-medium hover:bg-teal-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add
          </button>
          <button
            type="button"
            onClick={() => { setShowAdd(false); setNewName(''); setAddError(''); }}
            className="px-3 py-1.5 rounded-lg text-xs text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-primary)]"
          >
            Cancel
          </button>
        </div>
      )}

      {addError && (
        <p className="text-xs text-red-400">{addError}</p>
      )}
    </div>
  );
}
