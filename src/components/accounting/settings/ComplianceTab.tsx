/**
 * Compliance obligations tab — per-company statutory calendar config.
 * Self-contained (own fetch/save against /api/accounting/compliance-obligations,
 * like NetcashTab); the page-level Save button does not manage this tab.
 * Enabled obligations generate due-date work items on /home and the /bureau board.
 */

import { useEffect, useState } from 'react';
import { CalendarClock, Loader2, Save } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Obligations {
  vatEnabled: boolean;
  emp201Enabled: boolean;
  emp501Enabled: boolean;
  provisionalTaxEnabled: boolean;
  cipcEnabled: boolean;
  yearEndMonth: number;
  cipcAnniversaryMonth: number | null;
}

const DEFAULTS: Obligations = {
  vatEnabled: false,
  emp201Enabled: false,
  emp501Enabled: false,
  provisionalTaxEnabled: false,
  cipcEnabled: false,
  yearEndMonth: 2,
  cipcAnniversaryMonth: null,
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const TOGGLES: { key: keyof Obligations; label: string; desc: string }[] = [
  { key: 'vatEnabled', label: 'VAT returns (VAT201)', desc: 'Adds upcoming VAT deadlines — cycle follows the VAT Settings tab (monthly / bi-monthly, Category A/B). The just-ended period’s filing status is tracked automatically either way.' },
  { key: 'emp201Enabled', label: 'EMP201 (monthly PAYE/UIF/SDL)', desc: 'Due on or before the 7th of every month (weekends pull the date back to the Friday)' },
  { key: 'emp501Enabled', label: 'EMP501 reconciliations', desc: 'Interim due 31 October, annual due 31 May' },
  { key: 'provisionalTaxEnabled', label: 'Provisional tax (IRP6)', desc: '1st payment 6 months before year end, 2nd payment at year end' },
  { key: 'cipcEnabled', label: 'CIPC annual return', desc: 'Due in the company registration anniversary month' },
];

export function ComplianceTab() {
  const [config, setConfig] = useState<Obligations>(DEFAULTS);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/compliance-obligations');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed to load');
        if (!cancelled && json.data) {
          setConfig(json.data as Obligations);
          setExists(true);
        }
      } catch {
        if (!cancelled) setMessage({ kind: 'err', text: 'Failed to load compliance obligations' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const res = await apiFetch('/api/accounting/compliance-obligations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed to save');
      setConfig(json.data as Obligations);
      setExists(true);
      setMessage({ kind: 'ok', text: 'Compliance obligations saved' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>;
  }

  return (
    <>
      <section className={SECTION_CLS}>
        <div className="flex items-center gap-2 mb-1">
          <CalendarClock className="h-5 w-5 text-teal-500" />
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Statutory Obligations</h2>
        </div>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
          Enabled obligations appear as deadline work items on the Home feed and the firm triage board.
          {!exists && ' Nothing is configured yet — this company generates no calendar items.'}
        </p>
        <div className="space-y-3">
          {TOGGLES.map(t => (
            <label key={t.key} className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-[var(--ff-border-primary)] hover:border-teal-500/50 transition-colors">
              <input
                type="checkbox"
                checked={Boolean(config[t.key])}
                onChange={e => setConfig(prev => ({ ...prev, [t.key]: e.target.checked }))}
                className="mt-0.5 accent-teal-500"
              />
              <div>
                <div className="text-sm font-medium text-[var(--ff-text-primary)]">{t.label}</div>
                <div className="text-xs text-[var(--ff-text-tertiary)]">{t.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Key Dates</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLS}>Financial Year-End Month</label>
            <select
              className={INPUT_CLS}
              value={config.yearEndMonth}
              onChange={e => setConfig(prev => ({ ...prev, yearEndMonth: Number(e.target.value) }))}
            >
              {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
            </select>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Drives the IRP6 provisional tax payment dates</p>
          </div>
          {config.cipcEnabled && (
            <div>
              <label className={LABEL_CLS}>CIPC Anniversary Month</label>
              <select
                className={INPUT_CLS}
                value={config.cipcAnniversaryMonth ?? ''}
                onChange={e => setConfig(prev => ({
                  ...prev,
                  cipcAnniversaryMonth: e.target.value === '' ? null : Number(e.target.value),
                }))}
              >
                <option value="">Select month…</option>
                {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
              </select>
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Month the company was registered with CIPC</p>
            </div>
          )}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Obligations
        </button>
        {message && (
          <span className={`text-sm ${message.kind === 'ok' ? 'text-teal-500' : 'text-red-500'}`}>{message.text}</span>
        )}
      </div>
    </>
  );
}
