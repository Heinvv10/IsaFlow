// src/components/accounting/my-account/TwoFactorSection.tsx
// GoTrue-backed TOTP 2FA panel. Enroll → confirm → disable. No backup codes,
// no trusted devices, no SMS.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

type View = 'loading' | 'disabled' | 'enrolling' | 'enabled';

interface StatusData { enabled: boolean; factor_id: string | null }
interface EnrollData { factor_id: string; qr_code: string; secret: string }

export function TwoFactorSection() {
  const [view, setView] = useState<View>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/2fa-status');
      const json = await res.json() as { success: boolean; data?: StatusData };
      if (json.success && json.data) {
        setFactorId(json.data.factor_id);
        setView(json.data.enabled ? 'enabled' : 'disabled');
      } else {
        setView('disabled');
      }
    } catch (e) {
      log.warn('2fa-status load failed', { error: e }, 'auth');
      setView('disabled');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function startEnroll() {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-enroll', { method: 'POST' });
      const json = await res.json() as { success: boolean; data?: EnrollData; error?: { message: string } };
      if (!json.success || !json.data) throw new Error(json.error?.message ?? 'Enroll failed');
      setEnroll(json.data);
      setView('enrolling');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start enrollment');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    if (!enroll) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-confirm', {
        method: 'POST',
        body: JSON.stringify({ factor_id: enroll.factor_id, code }),
      });
      const json = await res.json() as { success: boolean; error?: { message: string } };
      if (!json.success) throw new Error(json.error?.message ?? 'Invalid code');
      setEnroll(null); setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!factorId) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-disable', {
        method: 'POST',
        body: JSON.stringify({ factor_id: factorId, code }),
      });
      const json = await res.json() as { success: boolean; error?: { message: string } };
      if (!json.success) throw new Error(json.error?.message ?? 'Invalid code');
      setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disable failed');
    } finally {
      setBusy(false);
    }
  }

  if (view === 'loading') {
    return <div className="text-sm text-gray-500">Loading 2FA status…</div>;
  }

  if (view === 'enrolling' && enroll) {
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold">Set up two-factor authentication</h3>
        <p className="text-sm text-gray-600">Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy).</p>
        {/* enroll.qr_code is raw SVG XML from GoTrue — encode as base64 data URL
            so we render via <img> without injecting raw markup into the DOM. */}
        <img
          src={`data:image/svg+xml;base64,${btoa(enroll.qr_code)}`}
          alt="TOTP QR code"
          className="border border-gray-200 rounded-md bg-white"
          style={{ width: 200, height: 200 }}
        />
        <p className="text-xs text-gray-500 font-mono break-all">Or enter manually: <span className="font-semibold">{enroll.secret}</span></p>
        <label className="block text-sm">
          <span>Enter the 6-digit code from your app</span>
          <input
            className="mt-1 block w-40 border rounded-md px-2 py-1"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-label="TOTP code"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 bg-teal-600 text-white rounded-md disabled:opacity-50"
            onClick={confirmEnroll}
            disabled={busy || code.length !== 6}
          >
            Enable 2FA
          </button>
          <button
            className="px-3 py-1.5 border rounded-md"
            onClick={() => { setEnroll(null); setCode(''); setError(null); setView('disabled'); }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (view === 'enabled') {
    return (
      <div className="space-y-3">
        <h3 className="text-base font-semibold">Two-factor authentication is enabled</h3>
        <p className="text-sm text-gray-600">To disable, enter a current code from your authenticator app.</p>
        <input
          className="block w-40 border rounded-md px-2 py-1"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-label="TOTP code"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          className="px-3 py-1.5 border border-red-600 text-red-600 rounded-md disabled:opacity-50"
          onClick={disable}
          disabled={busy || code.length !== 6}
        >
          Disable 2FA
        </button>
      </div>
    );
  }

  // view === 'disabled'
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">Two-factor authentication</h3>
      <p className="text-sm text-gray-600">Adds a second step to every login. You will need an authenticator app.</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        className="px-3 py-1.5 bg-teal-600 text-white rounded-md disabled:opacity-50"
        onClick={startEnroll}
        disabled={busy}
      >
        Enable 2FA
      </button>
    </div>
  );
}
