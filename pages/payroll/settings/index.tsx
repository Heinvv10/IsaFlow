/**
 * Payroll Settings — GL account mappings.
 * Route: /payroll/settings
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Settings, Loader2, Save, AlertCircle, ArrowLeft } from 'lucide-react';
import {
  PAYROLL_GL_ROLES,
  type PayrollGlRole,
  type PayrollGlMapping,
} from '@/modules/accounting/services/payroll/payrollGlConfigService';

interface GlAccount { id: string; accountCode: string; accountName: string; accountType?: string }

const ROLE_LABELS: Record<PayrollGlRole, string> = {
  salaries_expense:      'Salaries & Wages (expense)',
  net_salaries_payable:  'Net Salaries Payable (liability)',
  paye_payable:          'PAYE Payable (liability)',
  uif_payable:           'UIF Payable (liability)',
  sdl_payable:           'SDL Payable (liability)',
  uif_employer_expense:  'UIF Employer Contributions (expense)',
  sdl_employer_expense:  'SDL Contributions (expense)',
};

export default function PayrollSettingsPage() {
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [mappings, setMappings] = useState<Record<PayrollGlRole, string>>(() =>
    Object.fromEntries(PAYROLL_GL_ROLES.map(r => [r, ''])) as Record<PayrollGlRole, string>,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true); setError('');
    try {
      const [aRes, mRes] = await Promise.all([
        apiFetch('/api/accounting/chart-of-accounts'),
        apiFetch('/api/payroll/settings/gl-accounts'),
      ]);
      if (!aRes.ok) throw new Error(`Accounts HTTP ${aRes.status}`);
      const aJson = await aRes.json();
      setAccounts((aJson.data ?? aJson) as GlAccount[]);

      if (mRes.ok) {
        const mJson = await mRes.json();
        const existing = ((mJson.data ?? mJson) as PayrollGlMapping[]);
        setMappings(prev => ({
          ...prev,
          ...Object.fromEntries(existing.map(m => [m.role, m.glAccountId])),
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      const payload: PayrollGlMapping[] = PAYROLL_GL_ROLES.map(role => ({
        role, glAccountId: mappings[role] ?? '',
      }));
      const res = await apiFetch('/api/payroll/settings/gl-accounts', {
        method: 'PUT', body: JSON.stringify({ mappings: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10"><Settings className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">GL account mappings used when a run is approved</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-4">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          {message && (
            <div className="px-4 py-2 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-400 text-sm">{message}</div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-3">
              {PAYROLL_GL_ROLES.map(role => (
                <div key={role} className="grid grid-cols-[1fr_2fr] gap-4 items-center">
                  <label className="text-sm text-[var(--ff-text-secondary)]">{ROLE_LABELS[role]}</label>
                  <select className={field}
                    value={mappings[role] ?? ''}
                    onChange={e => setMappings(prev => ({ ...prev, [role]: e.target.value }))}>
                    <option value="">— none —</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.accountCode} · {a.accountName}</option>
                    ))}
                  </select>
                </div>
              ))}
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save mappings
              </button>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
