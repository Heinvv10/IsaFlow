/**
 * Admin Platform Settings — toggles and inputs for global platform configuration.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, CheckCircle2, Loader2, Save, Bell } from 'lucide-react';

interface PlatformSettings {
  maintenance_mode: boolean;
  registration_enabled: boolean;
  default_trial_days: number;
  max_companies_per_user: number;
  smtp_configured: boolean;
}

interface AlertSettings {
  health_alert_email: string;
  health_alert_webhook_url: string;
}

function Toggle({ label, checked, onChange, disabled }: {
  label: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={['flex items-center justify-between py-3', disabled ? 'opacity-60' : ''].join(' ')}>
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={[
          'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2',
          checked ? 'bg-teal-600' : 'bg-gray-300 dark:bg-gray-600',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        ].join(' ')}
      >
        <span className={[
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        ].join(' ')} />
      </button>
    </label>
  );
}

function NumberInput({ label, value, onChange, min, max }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="w-24 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 text-right"
      />
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder, type = 'text' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email' | 'url';
}) {
  return (
    <div className="flex flex-col gap-1 py-3">
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
      />
    </div>
  );
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({
    health_alert_email: '',
    health_alert_webhook_url: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingAlerts, setSavingAlerts] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [alertSuccess, setAlertSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [settingsRes, alertRes] = await Promise.all([
        apiFetch('/api/admin/settings'),
        apiFetch('/api/admin/alert-settings'),
      ]);
      const settingsJson = await settingsRes.json() as { data: PlatformSettings };
      if (!settingsRes.ok) throw new Error('Failed to load settings');
      setSettings(settingsJson.data);

      if (alertRes.ok) {
        const alertJson = await alertRes.json() as { data: AlertSettings };
        setAlertSettings(alertJson.data ?? { health_alert_email: '', health_alert_webhook_url: '' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res  = await apiFetch('/api/admin/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' }, body: JSON.stringify(settings) });
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to save settings');
      setSuccess('Settings saved successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const saveAlerts = async () => {
    setSavingAlerts(true);
    setError('');
    setAlertSuccess('');
    try {
      const res = await apiFetch('/api/admin/alert-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' }, body: JSON.stringify(alertSettings) });
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to save alert settings');
      setAlertSuccess('Alert settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save alert settings');
    } finally {
      setSavingAlerts(false);
    }
  };

  const update = (key: keyof PlatformSettings, value: unknown) => {
    setSettings((prev) => prev ? { ...prev, [key]: value } : prev);
  };

  const updateAlert = (key: keyof AlertSettings, value: string) => {
    setAlertSettings((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <AdminLayout title="Platform Settings">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-500 text-sm mb-6">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {loading && !settings && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {settings && (
        <div className="max-w-xl">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Platform Configuration</h2>
            </div>
            <div className="px-5 divide-y divide-gray-100 dark:divide-gray-800">
              <Toggle
                label="Maintenance Mode"
                checked={settings.maintenance_mode}
                onChange={(v) => update('maintenance_mode', v)}
              />
              <Toggle
                label="Registration Enabled"
                checked={settings.registration_enabled}
                onChange={(v) => update('registration_enabled', v)}
              />
              <NumberInput
                label="Default Trial Days"
                value={settings.default_trial_days}
                onChange={(v) => update('default_trial_days', v)}
                min={1}
                max={365}
              />
              <NumberInput
                label="Max Companies Per User"
                value={settings.max_companies_per_user}
                onChange={(v) => update('max_companies_per_user', v)}
                min={1}
                max={100}
              />
              <div className="flex items-center justify-between py-3">
                <span className="text-sm text-gray-700 dark:text-gray-300">SMTP Configured</span>
                <span className={[
                  'text-xs font-semibold px-2 py-0.5 rounded-full',
                  settings.smtp_configured
                    ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-400'
                    : 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400',
                ].join(' ')}>
                  {settings.smtp_configured ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>

          {/* ── Health Alerts ─────────────────────────────────────── */}
          <div className="mt-8 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <Bell className="w-4 h-4 text-teal-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Health Alerts</h2>
            </div>
            <div className="px-5 py-1 divide-y divide-gray-100 dark:divide-gray-800">
              <TextInput
                label="Alert Email"
                type="email"
                value={alertSettings.health_alert_email}
                onChange={(v) => updateAlert('health_alert_email', v)}
                placeholder="admin@isaflow.co.za"
              />
              <TextInput
                label="Webhook URL"
                type="url"
                value={alertSettings.health_alert_webhook_url}
                onChange={(v) => updateAlert('health_alert_webhook_url', v)}
                placeholder="https://hooks.example.com/health-alert"
              />
            </div>
            <div className="px-5 pb-4">
              {alertSuccess && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-500 text-sm mb-3">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  {alertSuccess}
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Alerts fire on transition to <strong>degraded</strong>/<strong>critical</strong>, or every hour while unhealthy. Leave Webhook URL blank to disable webhook delivery.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={() => void saveAlerts()}
                  disabled={savingAlerts}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {savingAlerts ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingAlerts ? 'Saving...' : 'Save Alert Settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
