/**
 * AnnouncementPlanPicker
 * Tick the plans an announcement is for. The API takes plan ids (plans.id); admins know plans by name, so the list is
 * loaded and shown by name. An id that is no longer a plan (or while the list cannot load) is still shown, ticked, as
 * "Unknown plan (xxxxxxxx)", so it can be seen and removed.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { Plan } from '@/modules/admin/types/admin-billing.types';

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
}

type Option = { id: string; label: string };
const LOAD_ERROR = 'Could not load the plans - try again';

export function AnnouncementPlanPicker({ value, onChange }: Props) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/admin/billing/plans?include_archived=true');
        await assertOk(res, LOAD_ERROR);
        const json = await res.json() as { data?: Plan[] };
        if (alive) setPlans(json.data ?? []);
      } catch (err) {
        log.warn('Could not load plans for an announcement', { error: err }, 'admin-ui');
        if (alive) { setPlans([]); setError(apiErrorMessage(err, LOAD_ERROR)); }
      }
    })();
    return () => { alive = false; };
  }, []);

  if (plans === null) return <p className="text-xs text-ink-muted">Loading plans…</p>;

  const known = new Set(plans.map(p => p.id));
  const options: Option[] = [
    ...plans.map(p => ({ id: p.id, label: p.is_active ? p.name : `${p.name} (archived)` })),
    ...value.filter(id => !known.has(id)).map(id => ({ id, label: `Unknown plan (${id.slice(0, 8)})` })),
  ];
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter(v => v !== id));

  return (
    <div className="space-y-1.5">
      {options.map(o => (
        <label key={o.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" checked={value.includes(o.id)} onChange={e => toggle(o.id, e.target.checked)}
            className="rounded border-gray-300 text-teal-600 focus:ring-teal-500" />
          {o.label}
        </label>
      ))}
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
