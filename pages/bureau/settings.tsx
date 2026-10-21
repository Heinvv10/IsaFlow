/**
 * Bureau Settings — the merchant-pattern sharing opt-in.
 *
 * Every member sees the setting and its consent wording; only the bureau owner can switch it
 * (the API refuses anyone else with 403 and records every change in bureau_audit_log). Off by default.
 * The wording is a DRAFT pending legal review and says so on the page.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { ArrowLeft, Briefcase, Loader2, AlertCircle } from 'lucide-react';
import { BureauSharingConsent } from '@/components/bureau/BureauSharingConsent';

interface BureauRef { id: string; name: string; role: 'owner' | 'accountant' | 'viewer' }
interface SettingChange { changedAt: string; actorUserId: string; oldValue: boolean | null; newValue: boolean }
interface BureauSettings { shareMerchantPatterns: boolean; canEdit: boolean; history: SettingChange[] }

export default function BureauSettingsPage() {
  const [bureaus, setBureaus] = useState<BureauRef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<BureauSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/bureau')
      .then(async (r) => { await assertOk(r, 'Could not load your bureaus - try again'); return r.json(); })
      .then((j: { data?: { bureaus: BureauRef[] } }) => {
        const list = j?.data?.bureaus ?? [];
        setBureaus(list);
        setActiveId(list[0]?.id ?? null);
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load your bureaus - try again')))
      .finally(() => setLoading(false));
  }, []);

  const loadSettings = useCallback(async (bureauId: string) => {
    setSettings(null);
    try {
      const res = await apiFetch(`/api/bureau/settings?bureauId=${encodeURIComponent(bureauId)}`);
      await assertOk(res, 'Could not load the bureau settings - try again');
      setSettings(((await res.json()) as { data?: BureauSettings }).data ?? null);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the bureau settings - try again'));
    }
  }, []);

  useEffect(() => { if (activeId) void loadSettings(activeId); }, [activeId, loadSettings]);

  const toggle = async (next: boolean) => {
    if (!activeId) return;
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/api/bureau/settings', {
        method: 'PUT',
        body: JSON.stringify({ bureauId: activeId, shareMerchantPatterns: next }),
      });
      await assertOk(res, 'Could not change the sharing setting - try again');
      await loadSettings(activeId);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change the sharing setting - try again'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/bureau" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]" aria-label="Back to bureau dashboard">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-purple-500/10"><Briefcase className="h-6 w-6 text-purple-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Bureau Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Settings that apply to the whole practice.</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-3xl">
          {error && (
            <div role="alert" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          {bureaus.length === 0 && !error && (
            <p className="text-sm text-[var(--ff-text-secondary)]">You aren&apos;t a member of any bureau.</p>
          )}
          {bureaus.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              {bureaus.map((b) => (
                <button key={b.id} type="button" onClick={() => setActiveId(b.id)}
                  className={`px-3 py-1.5 rounded-full text-xs ${activeId === b.id ? 'bg-purple-500/20 text-purple-400' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]'}`}>
                  {b.name} <span className="opacity-60">({b.role})</span>
                </button>
              ))}
            </div>
          )}
          {settings && (
            <BureauSharingConsent
              enabled={settings.shareMerchantPatterns}
              canEdit={settings.canEdit}
              saving={saving}
              history={settings.history}
              onChange={(next) => void toggle(next)}
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
