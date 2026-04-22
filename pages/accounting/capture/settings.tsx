/**
 * Capture Settings — PRD-05 Phase 1
 * Manage email inbox address and browse other capture channel stubs.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Mail, Smartphone, MessageSquare, Server,
  Copy, Check, RefreshCw, AlertCircle, Loader2, X,
} from 'lucide-react';
import Link from 'next/link';

interface InboxAddress { id: string; address: string }

function SectionCard({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">{title}</h2>
      {children}
    </div>
  );
}

function ComingSoonCard({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg bg-white/5 border border-[rgba(255,255,255,0.06)] opacity-60">
      <span className="text-slate-500">{icon}</span>
      <div className="flex-1">
        <p className="text-sm font-medium text-slate-400">{label}</p>
        <p className="text-xs text-slate-600 mt-0.5">Coming soon</p>
      </div>
      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-500 border border-slate-700">
        Coming soon
      </span>
    </div>
  );
}

export default function CaptureSettingsPage() {
  const [inboxAddr, setInboxAddr] = useState<InboxAddress | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, ok: boolean) { setToast({ msg, ok }); }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadAddress = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/capture/inbox-address');
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? 'Failed to load inbox address'); return; }
      setInboxAddr(json.data ?? null);
      setError('');
    } catch {
      setError('Network error loading inbox address');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAddress(); }, [loadAddress]);

  async function handleCopy() {
    if (!inboxAddr?.address) return;
    await navigator.clipboard.writeText(inboxAddr.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRegenerate() {
    if (!confirmRegen) { setConfirmRegen(true); return; }
    setRegenerating(true);
    setConfirmRegen(false);
    try {
      const res = await apiFetch('/api/accounting/capture/inbox-address', { method: 'POST', body: '{}' });
      const json = await res.json();
      if (!res.ok) { showToast(json.error ?? 'Regenerate failed', false); return; }
      setInboxAddr(json.data ?? null);
      showToast('Inbox address regenerated', true);
    } catch {
      showToast('Network error', false);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Capture Settings</h1>
          <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">Configure how documents enter the capture inbox</p>
        </div>

        {/* Toast */}
        {toast && (
          <div className={`mx-6 mt-3 flex items-center justify-between p-3 rounded-lg text-sm ${toast.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
            <span className="flex items-center gap-2">
              {toast.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {toast.msg}
            </span>
            <button onClick={() => setToast(null)}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="px-6 py-6 space-y-6 max-w-2xl">
          {/* Section 1: Email Inbox */}
          <SectionCard title="Email Inbox">
            <p className="text-sm text-slate-400 mb-4">
              Forward invoices and receipts to this address and they will appear in your Capture Inbox automatically.
            </p>

            {loading ? (
              <div className="flex items-center gap-2 text-slate-500 py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading…</span>
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 text-sm">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            ) : inboxAddr ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-[rgba(255,255,255,0.08)]">
                  <Mail className="h-4 w-4 text-slate-500 shrink-0" />
                  <span className="flex-1 font-mono text-sm text-slate-200 break-all">{inboxAddr.address}</span>
                  <button onClick={handleCopy}
                    className="shrink-0 p-1.5 rounded text-slate-500 hover:text-teal-400 transition-colors" title="Copy address">
                    {copied ? <Check className="h-4 w-4 text-teal-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>

                {confirmRegen ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-yellow-400">Old address will stop working. Continue?</span>
                    <button onClick={handleRegenerate} disabled={regenerating}
                      className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white rounded text-xs font-medium disabled:opacity-50">
                      {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Yes, regenerate'}
                    </button>
                    <button onClick={() => setConfirmRegen(false)} className="px-3 py-1.5 text-slate-400 hover:text-slate-200 text-xs">Cancel</button>
                  </div>
                ) : (
                  <button onClick={handleRegenerate} disabled={regenerating}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-sm transition-colors disabled:opacity-50">
                    <RefreshCw className="h-4 w-4" />
                    Regenerate address
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No inbox address configured yet.</p>
            )}
          </SectionCard>

          {/* Section 2: Other Channels */}
          <SectionCard title="Other Channels">
            <p className="text-sm text-slate-400 mb-4">
              Additional ways to submit documents to your capture inbox.
            </p>
            <div className="space-y-3">
              {/* PWA — active link */}
              <Link href="/accounting/capture"
                className="flex items-center gap-3 p-4 rounded-lg bg-white/5 border border-teal-800/50 hover:border-teal-600/50 transition-colors group">
                <Smartphone className="h-5 w-5 text-teal-500" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-300 group-hover:text-slate-100">Mobile / PWA</p>
                  <p className="text-xs text-slate-500 mt-0.5">Photograph receipts from your phone</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-teal-900/50 text-teal-400 border border-teal-800">
                  Available
                </span>
              </Link>

              <ComingSoonCard icon={<MessageSquare className="h-5 w-5" />} label="WhatsApp" />
              <ComingSoonCard icon={<Server className="h-5 w-5" />} label="IMAP Mirror" />
            </div>
          </SectionCard>
        </div>
      </div>
    </AppLayout>
  );
}
