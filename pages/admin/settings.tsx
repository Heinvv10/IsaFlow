/**
 * Admin Platform Settings — platform status and health-alert recipients.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AlertCircle, CheckCircle2, Loader2, Save, Bell } from 'lucide-react';

interface PlatformSettings {
  smtp_configured: boolean;
}

interface AlertSettings {
  health_alert_email: string;
  health_alert_webhook_url: string;
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
  const [savingAlerts, setSavingAlerts] = useState(false);
  const [error, setError] = useState('');
  const [alertSuccess, setAlertSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [settingsRes, alertRes] = await Promise.all([
        apiFetch('/api/admin/settings'),
        apiFetch('/api/admin/alert-settings'),
      ]);
      await assertOk(settingsRes, 'Could not load the settings - try again');
      await assertOk(alertRes, 'Could not load the alert settings - try again');
      const settingsJson = await settingsRes.json() as { data: PlatformSettings };
      setSettings(settingsJson.data);

      const alertJson = await alertRes.json() as { data: AlertSettings };
      setAlertSettings(alertJson.data ?? { health_alert_email: '', health_alert_webhook_url: '' });
    } catch (err) {
      setSettings(null); setAlertSettings({ health_alert_email: '', health_alert_webhook_url: '' });
      setError(apiErrorMessage(err, 'Could not load the settings - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveAlerts = async () => {
    setSavingAlerts(true);
    setError('');
    setAlertSuccess('');
    try {
      const res = await apiFetch('/api/admin/alert-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' }, body: JSON.stringify(alertSettings) });
      await assertOk(res, 'Could not save alert settings - try again');
      setAlertSuccess('Alert settings saved.');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save alert settings - try again'));
    } finally {
      setSavingAlerts(false);
    }
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

      {loading && !settings && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {settings && (
        <div className="max-w-xl">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Platform Status</h2>
            </div>
            <div className="px-5 divide-y divide-gray-100 dark:divide-gray-800">
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
                Alerts are checked only when an admin has the System Health page open (not on a schedule), and fire on transition to <strong>degraded</strong>/<strong>critical</strong>, or every hour while unhealthy. Clearing a field removes it: a blank email falls back to the server default address, a blank Webhook URL disables webhook delivery.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={() => void saveAlerts()}
                  disabled={savingAlerts}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
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
