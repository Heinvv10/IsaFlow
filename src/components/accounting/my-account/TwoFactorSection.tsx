/**
 * Two-Factor Authentication section for My Account > Security tab.
 * Handles: status display, setup flow (QR + verify), backup codes, trusted devices.
 */

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { ShieldCheck, ShieldOff, Smartphone, Trash2, Loader2, RefreshCw, Copy, Check } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import toast from 'react-hot-toast';
import { formatDisplayDate } from '@/utils/dateFormat';
import { SECTION_CLS, LABEL_CLS, INPUT_CLS } from './AccountTabs';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TwoFAStatus {
  enabled: boolean;
  method: string | null;
  verifiedAt: string | null;
}

interface TrustedDevice {
  id: string;
  deviceName: string | null;
  deviceFingerprint: string;
  trustedUntil: string;
  lastUsedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type SetupStep = 'idle' | 'qr' | 'verify' | 'backup' | 'disable';

// ── Backup Codes Display ──────────────────────────────────────────────────────

function BackupCodesDisplay({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(codes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
        <p className="text-sm font-medium text-amber-400">Save these backup codes now</p>
        <p className="text-xs text-amber-300 mt-1">
          Each code can only be used once. Store them somewhere safe — they will not be shown again.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {codes.map((code) => (
          <div key={code} className="font-mono text-sm text-center py-2 px-3 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded-lg text-[var(--ff-text-primary)] tracking-wider">
            {code}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleCopy}
          className="flex items-center gap-2 px-3 py-2 text-sm border border-[var(--ff-border-primary)] rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
        >
          {copied ? <Check className="h-4 w-4 text-teal-500" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy All'}
        </button>
        <button
          onClick={onDone}
          className="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          I have saved my backup codes
        </button>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function TwoFactorSection() {
  const [status, setStatus] = useState<TwoFAStatus | null>(null);
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [step, setStep] = useState<SetupStep>('idle');
  const [qrData, setQrData] = useState<{ qrCodeDataUrl: string; uri: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    void loadStatus();
    void loadDevices();
  }, []);

  async function loadStatus() {
    setStatusLoading(true);
    try {
      const res = await apiFetch('/api/auth/2fa-status');
      const json = await res.json();
      if (json.success) setStatus(json.data as TwoFAStatus);
    } catch {
      toast.error('Failed to load 2FA status');
    } finally {
      setStatusLoading(false);
    }
  }

  async function loadDevices() {
    try {
      const res = await apiFetch('/api/auth/2fa-trusted-devices');
      const json = await res.json();
      if (json.success) setDevices((json.data?.devices ?? []) as TrustedDevice[]);
    } catch {
      // Non-critical — silently ignore
    }
  }

  // ── Setup Flow ─────────────────────────────────────────────────────────────

  async function handleStartSetup() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/2fa-setup', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? 'Failed to start setup');
        return;
      }
      setQrData({ qrCodeDataUrl: json.data.qrCodeDataUrl as string, uri: json.data.uri as string });
      setVerifyCode('');
      setStep('qr');
    } catch {
      toast.error('Failed to start 2FA setup');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifySetup() {
    if (!verifyCode.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/2fa-verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? 'Invalid code');
        return;
      }
      setBackupCodes((json.data?.backupCodes as string[]) ?? []);
      setStep('backup');
      await loadStatus();
    } catch {
      toast.error('Verification failed');
    } finally {
      setLoading(false);
    }
  }

  // ── Disable Flow ───────────────────────────────────────────────────────────

  async function handleDisable() {
    if (!disableCode.trim()) return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/2fa-disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: disableCode.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message ?? 'Invalid code');
        return;
      }
      toast.success('2FA disabled');
      setDisableCode('');
      setStep('idle');
      await loadStatus();
    } catch {
      toast.error('Failed to disable 2FA');
    } finally {
      setLoading(false);
    }
  }

  // ── Remove Device ──────────────────────────────────────────────────────────

  async function handleRemoveDevice(deviceId: string) {
    try {
      const res = await apiFetch(`/api/auth/2fa-trusted-devices?id=${deviceId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to remove device');
        return;
      }
      toast.success('Device removed');
      void loadDevices();
    } catch {
      toast.error('Failed to remove device');
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (statusLoading) {
    return (
      <section className={SECTION_CLS}>
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
        </div>
      </section>
    );
  }

  const enabled = status?.enabled ?? false;

  return (
    <div className="space-y-6">

      {/* Status Card */}
      <section className={SECTION_CLS}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${enabled ? 'bg-teal-500/10' : 'bg-gray-500/10'}`}>
              {enabled
                ? <ShieldCheck className="h-6 w-6 text-teal-500" />
                : <ShieldOff className="h-6 w-6 text-gray-400" />
              }
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                Two-Factor Authentication
              </h2>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
                {enabled
                  ? `Enabled via authenticator app${status?.verifiedAt ? ` since ${formatDisplayDate(status.verifiedAt)}` : ''}`
                  : 'Add an extra layer of security to your account'
                }
              </p>
            </div>
          </div>

          <div className="flex gap-2 flex-shrink-0">
            {enabled && step === 'idle' && (
              <button
                onClick={() => setStep('disable')}
                className="px-3 py-1.5 text-sm text-red-400 border border-red-400/30 rounded-lg hover:bg-red-400/10 transition-colors"
              >
                Disable
              </button>
            )}
            {!enabled && step === 'idle' && (
              <button
                onClick={() => void handleStartSetup()}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Enable 2FA
              </button>
            )}
            {(step === 'qr' || step === 'verify') && (
              <button
                onClick={() => { setStep('idle'); setQrData(null); }}
                className="px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-primary)] rounded-lg hover:text-[var(--ff-text-primary)] transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* QR Code Step */}
        {step === 'qr' && qrData && (
          <div className="mt-6 space-y-4">
            <div className="p-4 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded-lg">
              <p className="text-sm font-medium text-[var(--ff-text-primary)] mb-3">
                1. Scan this QR code with your authenticator app
              </p>
              <div className="flex justify-center">
                <Image src={qrData.qrCodeDataUrl} alt="2FA QR Code" className="rounded-lg" width={200} height={200} unoptimized />
              </div>
              <p className="text-xs text-[var(--ff-text-secondary)] mt-3 text-center">
                Supported apps: Google Authenticator, Microsoft Authenticator, Authy
              </p>
            </div>

            <div>
              <p className="text-sm font-medium text-[var(--ff-text-primary)] mb-2">
                2. Enter the 6-digit code shown in your app
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={verifyCode}
                  onChange={e => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className={INPUT_CLS + ' font-mono tracking-widest text-center'}
                />
                <button
                  onClick={() => void handleVerifySetup()}
                  disabled={loading || verifyCode.length < 6}
                  className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Verify & Enable
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Backup Codes Step */}
        {step === 'backup' && (
          <div className="mt-6">
            <BackupCodesDisplay codes={backupCodes} onDone={() => { setStep('idle'); setBackupCodes([]); }} />
          </div>
        )}

        {/* Disable Step */}
        {step === 'disable' && (
          <div className="mt-6 space-y-4">
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">
                Enter your current authenticator code to disable 2FA.
                This will remove the extra security layer from your account.
              </p>
            </div>
            <div>
              <label className={LABEL_CLS}>Authentication Code</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={disableCode}
                  onChange={e => setDisableCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className={INPUT_CLS + ' font-mono tracking-widest text-center'}
                />
                <button
                  onClick={() => void handleDisable()}
                  disabled={loading || disableCode.length < 6}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Disable 2FA
                </button>
              </div>
            </div>
            <button
              onClick={() => { setStep('idle'); setDisableCode(''); }}
              className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Trusted Devices */}
      {enabled && devices.length > 0 && (
        <section className={SECTION_CLS}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
              Trusted Devices
            </h2>
            <button
              onClick={() => void loadDevices()}
              className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-2">
            {devices.map(device => (
              <div
                key={device.id}
                className="flex items-center justify-between gap-4 p-3 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded-lg"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Smartphone className="h-4 w-4 text-[var(--ff-text-secondary)] flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">
                      {device.deviceName ?? 'Unknown Device'}
                    </p>
                    <p className="text-xs text-[var(--ff-text-secondary)]">
                      Trusted until {formatDisplayDate(device.trustedUntil)}
                      {' · '}Last used {formatDisplayDate(device.lastUsedAt)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => void handleRemoveDevice(device.id)}
                  className="text-red-400 hover:text-red-300 transition-colors flex-shrink-0"
                  title="Remove device"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
