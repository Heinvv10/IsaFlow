/**
 * BankTxQueryModal — Send a WhatsApp query to a client about a bank transaction.
 *
 * Props:
 *   tx       — the bank transaction to query (null = modal not shown)
 *   onClose  — dismiss callback
 *   onSent   — called after a query is successfully sent
 */

import { useState, useEffect, useCallback } from 'react';
import { X, MessageCircle, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { composeBankTxQueryMessage } from '@/modules/accounting/services/capture/bankTxQueryMessage';
import type { BankTx } from '@/components/accounting/BankTxTable';

// ── Types ──────────────────────────────────────────────────────────────────────

interface QueryRow {
  id: string;
  status: string;
  sent_at: string | null;
  to_number: string;
}

interface Settings {
  clientQueryWhatsapp: string | null;
  companyName: string;
}

interface Props {
  tx: BankTx | null;
  onClose: () => void;
  onSent?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatShortDate(raw: string | null): string {
  if (!raw) return '';
  return new Date(raw).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ── Component ──────────────────────────────────────────────────────────────────

export function BankTxQueryModal({ tx, onClose, onSent }: Props) {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [messageDirty, setMessageDirty] = useState(false);
  const [saveDefault, setSaveDefault] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [priorQuery, setPriorQuery] = useState<QueryRow | null>(null);
  const [sending, setSending] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [loadingSettings, setLoadingSettings] = useState(false);

  // Derive prefilled message from current tx + companyName (only when not dirty)
  const buildMessage = useCallback(
    (cn: string) => {
      if (!tx) return '';
      return composeBankTxQueryMessage({
        companyName: cn,
        txDate: (tx.transactionDate ?? '').slice(0, 10),
        description: tx.description ?? '',
        amount: tx.amount,
        reference: tx.reference ?? null,
      }).body;
    },
    [tx],
  );

  // On new tx: reset state, then fetch settings + prior queries in parallel
  useEffect(() => {
    if (!tx) return;
    setPhone('');
    setMessage('');
    setMessageDirty(false);
    setSaveDefault(false);
    setInlineError('');
    setPriorQuery(null);
    setCompanyName('');
    setLoadingSettings(true);

    void (async () => {
      try {
        const [settingsRes, queriesRes] = await Promise.all([
          apiFetch('/api/accounting/bank-tx-queries/settings'),
          apiFetch(`/api/accounting/bank-tx-queries?bankTransactionId=${encodeURIComponent(tx.id)}`),
        ]);

        if (settingsRes.ok) {
          const json = await settingsRes.json() as { data: Settings };
          const s: Settings = json.data;
          setPhone(s.clientQueryWhatsapp ?? '');
          setCompanyName(s.companyName);
          // Only prefill message on first load (not dirty)
          setMessage(prev => (prev === '' ? buildMessage(s.companyName) : prev));
        }

        if (queriesRes.ok) {
          const json = await queriesRes.json() as { data: QueryRow[] };
          const rows: QueryRow[] = json.data ?? [];
          const prior = rows.find(r => r.status === 'sent' || r.status === 'replied');
          setPriorQuery(prior ?? null);
        }
      } finally {
        setLoadingSettings(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.id]);

  // Recompute message prefill when companyName arrives (if user hasn't edited yet)
  useEffect(() => {
    if (!messageDirty && companyName) {
      setMessage(buildMessage(companyName));
    }
  }, [companyName, buildMessage, messageDirty]);

  const handleSend = async () => {
    if (!tx) return;
    setInlineError('');
    setSending(true);
    try {
      const res = await apiFetch('/api/accounting/bank-tx-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTransactionId: tx.id,
          toNumber: phone.trim(),
          message: message.trim() || undefined,
          saveAsDefault: saveDefault || undefined,
        }),
      });

      if (!res.ok) {
        const json = await res.json() as { message?: string; error?: string };
        setInlineError(json.message ?? json.error ?? 'Failed to send query');
        return;
      }

      onSent?.();
      onClose();
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'Unexpected error sending query');
    } finally {
      setSending(false);
    }
  };

  if (!tx) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="w-full max-w-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)] shrink-0">
          <div className="p-2 rounded-lg bg-green-500/10">
            <MessageCircle className="h-4 w-4 text-green-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Ask Client on WhatsApp</h2>
            {tx.description && (
              <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{tx.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Prior query warning */}
          {priorQuery && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300">
                Already asked on {formatShortDate(priorQuery.sent_at)} — status: {priorQuery.status}
              </p>
            </div>
          )}

          {/* Phone input */}
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
              WhatsApp number <span className="text-red-400">*</span>
            </label>
            <input
              type="tel"
              required
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+27 82 123 4567"
              disabled={loadingSettings || sending}
              className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-green-500/60 disabled:opacity-50"
            />
          </div>

          {/* Message textarea */}
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">
              Message
            </label>
            <textarea
              rows={5}
              maxLength={1000}
              value={message}
              onChange={e => { setMessage(e.target.value); setMessageDirty(true); }}
              disabled={loadingSettings || sending}
              className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-green-500/60 resize-none disabled:opacity-50"
            />
            <p className="text-[10px] text-[var(--ff-text-tertiary)] mt-0.5 text-right">
              {message.length}/1000
            </p>
          </div>

          {/* Save as default */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveDefault}
              onChange={e => setSaveDefault(e.target.checked)}
              disabled={sending}
              className="accent-green-500"
            />
            <span className="text-xs text-[var(--ff-text-secondary)]">
              Save as this client&apos;s default WhatsApp number
            </span>
          </label>

          {/* Inline error */}
          {inlineError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-400 break-words">{inlineError}</p>
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={sending}
            className="px-4 py-1.5 rounded text-xs border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sending || !phone.trim() || loadingSettings}
            className="px-4 py-1.5 rounded text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium flex items-center gap-1.5 transition-colors"
          >
            {sending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <MessageCircle className="h-3.5 w-3.5" />
                Send
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
