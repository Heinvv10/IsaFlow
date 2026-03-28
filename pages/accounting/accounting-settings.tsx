/**
 * Accounting Settings Page
 * Key-value configuration for the accounting module
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Settings, Loader2, AlertCircle, Save, Check } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

interface SettingItem {
  key: string;
  label: string;
  description: string;
  value: string;
  type: 'text' | 'select';
  options?: { value: string; label: string }[];
}

const SETTINGS_DEFINITIONS: Omit<SettingItem, 'value'>[] = [
  {
    key: 'reporting_currency',
    label: 'Reporting Currency',
    description: 'Default currency for financial reports and statements',
    type: 'select',
    options: [
      { value: 'ZAR', label: 'ZAR — South African Rand' },
      { value: 'USD', label: 'USD — US Dollar' },
      { value: 'EUR', label: 'EUR — Euro' },
      { value: 'GBP', label: 'GBP — British Pound' },
    ],
  },
];

export default function AccountingSettingsPage() {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadSettings() {
      setLoading(true);
      setError('');
      try {
        const loaded: SettingItem[] = [];
        for (const def of SETTINGS_DEFINITIONS) {
          try {
            const res = await apiFetch(`/api/accounting/accounting-settings?key=${def.key}`, { credentials: 'include' });
            const json = await res.json();
            loaded.push({ ...def, value: String(json.data?.value || '') });
          } catch {
            loaded.push({ ...def, value: '' });
          }
        }
        setSettings(loaded);
      } catch {
        setError('Failed to load settings');
      } finally {
        setLoading(false);
      }
    }
    loadSettings();
  }, []);

  const updateSetting = async (key: string, value: string) => {
    setSettings(prev => prev.map(s => s.key === key ? { ...s, value } : s));
  };

  const saveSetting = async (key: string) => {
    const setting = settings.find(s => s.key === key);
    if (!setting) return;

    setSaving(key);
    try {
      const res = await apiFetch('/api/accounting/accounting-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key, value: setting.value }),
      });
      if (!res.ok) throw new Error('Failed to save');
      notify.success(`${setting.label} updated`);
    } catch {
      notify.error('Failed to save setting');
    } finally {
      setSaving(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-500/10">
              <Settings className="h-6 w-6 text-slate-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Accounting Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Configure accounting module preferences</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-2xl">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <div className="space-y-6">
              {settings.map(setting => (
                <div
                  key={setting.key}
                  className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1">
                        {setting.label}
                      </label>
                      <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">{setting.description}</p>
                      {setting.type === 'select' ? (
                        <select
                          value={setting.value}
                          onChange={e => updateSetting(setting.key, e.target.value)}
                          className="ff-select text-sm w-full max-w-xs"
                        >
                          <option value="">— Select —</option>
                          {setting.options?.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={setting.value}
                          onChange={e => updateSetting(setting.key, e.target.value)}
                          className="ff-input text-sm w-full max-w-xs"
                        />
                      )}
                    </div>
                    <button
                      onClick={() => saveSetting(setting.key)}
                      disabled={saving === setting.key}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 mt-6"
                    >
                      {saving === setting.key ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Save
                    </button>
                  </div>
                </div>
              ))}

              {settings.length === 0 && (
                <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                  <Check className="h-8 w-8 mx-auto mb-2 text-green-500" />
                  No configurable settings
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
