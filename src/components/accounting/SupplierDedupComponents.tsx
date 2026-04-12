/**
 * Supplier Deduplication — sub-components
 * Used exclusively by pages/accounting/suppliers/dedup.tsx
 */

import { useState } from 'react';
import {
  AlertCircle,
  GitMerge,
  CheckCircle2,
  X,
  Loader2,
} from 'lucide-react';
import type { SupplierDuplicatePair } from '@/types/supplier-duplicates';

// ── Match badge ────────────────────────────────────────────────────────────────

const REASON_LABEL: Record<SupplierDuplicatePair['match_reason'], string> = {
  email: 'Same email',
  vat: 'Same VAT number',
  name: 'Similar name',
};

const REASON_COLOUR: Record<SupplierDuplicatePair['match_reason'], string> = {
  email: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  vat: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  name: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
};

export function MatchBadge({ reason }: { reason: SupplierDuplicatePair['match_reason'] }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium border ${REASON_COLOUR[reason]}`}
    >
      {REASON_LABEL[reason]}
    </span>
  );
}

// ── Confirm modal ──────────────────────────────────────────────────────────────

export interface ConfirmModalProps {
  keepName: string;
  mergeName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isBusy: boolean;
}

export function ConfirmModal({ keepName, mergeName, onConfirm, onCancel, isBusy }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-amber-500/10 shrink-0 mt-0.5">
            <AlertCircle className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Confirm Merge</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
              This will move <span className="font-medium text-[var(--ff-text-primary)]">all transactions</span> from
            </p>
            <p className="text-sm font-medium text-rose-400 mt-0.5">{mergeName}</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">into</p>
            <p className="text-sm font-medium text-teal-400">{keepName}</p>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-2">
              The duplicate will be marked inactive.{' '}
              <span className="font-medium text-[var(--ff-text-primary)]">Cannot be undone.</span>
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isBusy}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isBusy}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white transition-colors disabled:opacity-40"
          >
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
            Merge Now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────────────────────────

export interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onClose: () => void;
}

export function Toast({ message, type, onClose }: ToastProps) {
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium
        ${type === 'success'
          ? 'bg-teal-900/80 border-teal-500/30 text-teal-200'
          : 'bg-rose-900/80 border-rose-500/30 text-rose-200'
        }`}
    >
      {type === 'success'
        ? <CheckCircle2 className="h-4 w-4 text-teal-400 shrink-0" />
        : <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
      }
      {message}
      <button onClick={onClose} className="ml-1 opacity-60 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Supplier card ──────────────────────────────────────────────────────────────

interface SupplierCardProps {
  name: string;
  email: string | null;
  vat: string | null;
  invoiceCount: number;
  isKeep: boolean;
  onKeep: () => void;
}

function SupplierCard({ name, email, vat, invoiceCount, isKeep, onKeep }: SupplierCardProps) {
  return (
    <div
      className={`flex-1 rounded-xl border p-4 transition-all ${
        isKeep
          ? 'border-teal-500/50 bg-teal-500/5 ring-1 ring-teal-500/30'
          : 'border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]'
      }`}
    >
      {isKeep && (
        <div className="flex items-center gap-1.5 mb-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-xs font-medium text-teal-400">Will be kept</span>
        </div>
      )}
      <p className="font-semibold text-[var(--ff-text-primary)] text-sm mb-1">{name}</p>
      {email && <p className="text-xs text-[var(--ff-text-secondary)] truncate">{email}</p>}
      {vat && <p className="text-xs text-[var(--ff-text-tertiary)]">VAT: {vat}</p>}
      <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
        {invoiceCount} invoice{invoiceCount !== 1 ? 's' : ''}
      </p>
      {!isKeep && (
        <button
          onClick={onKeep}
          className="mt-3 w-full px-3 py-1.5 rounded-lg text-xs font-medium bg-teal-600 hover:bg-teal-700 text-white transition-colors"
        >
          Keep this one
        </button>
      )}
    </div>
  );
}

// ── Pair row ───────────────────────────────────────────────────────────────────

export interface PairRowProps {
  pair: SupplierDuplicatePair;
  onMergeRequest: (keepId: string, mergeId: string, keepName: string, mergeName: string) => void;
}

export function PairRow({ pair, onMergeRequest }: PairRowProps) {
  const [keepId, setKeepId] = useState<string>(pair.id_a);

  const mergeId = keepId === pair.id_a ? pair.id_b : pair.id_a;
  const keepName = keepId === pair.id_a ? pair.name_a : pair.name_b;
  const mergeName = keepId === pair.id_a ? pair.name_b : pair.name_a;

  return (
    <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4">
      <div className="flex items-center justify-between mb-3">
        <MatchBadge reason={pair.match_reason} />
        <button
          onClick={() => onMergeRequest(keepId, mergeId, keepName, mergeName)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] border border-[var(--ff-border-primary)] transition-colors"
        >
          <GitMerge className="h-3.5 w-3.5" />
          Merge
        </button>
      </div>

      <div className="flex gap-3">
        <SupplierCard
          name={pair.name_a}
          email={pair.email_a}
          vat={pair.vat_a}
          invoiceCount={pair.invoice_count_a}
          isKeep={keepId === pair.id_a}
          onKeep={() => setKeepId(pair.id_a)}
        />

        <div className="flex flex-col items-center justify-center shrink-0 gap-1 py-2">
          <div className="w-px h-6 bg-[var(--ff-border-primary)]" />
          <span className="text-[var(--ff-text-tertiary)] text-xs font-medium">vs</span>
          <div className="w-px h-6 bg-[var(--ff-border-primary)]" />
        </div>

        <SupplierCard
          name={pair.name_b}
          email={pair.email_b}
          vat={pair.vat_b}
          invoiceCount={pair.invoice_count_b}
          isKeep={keepId === pair.id_b}
          onKeep={() => setKeepId(pair.id_b)}
        />
      </div>
    </div>
  );
}
