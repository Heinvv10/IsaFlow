/**
 * The banners above an expense claim's detail: the s17(2)(a) VAT advice, the
 * rejection reason, the transient toast, and the three summary tiles.
 *
 * Lifted out of `pages/accounting/expenses/[id].tsx`, which is well over the
 * 300-line cap in CLAUDE.md. Every block here is presentational and reads no
 * state the page does not already hand it, so it is the natural seam — the
 * page keeps the data loading and the transitions.
 *
 * `vatAdvice` is the one that earns its own component. It is the advice the
 * approve/reject endpoint returns when a claim line carries input VAT on an
 * account flagged `vat_input_denied`, and the approver is the last person who
 * sees the claim before `postClaim` debits VAT Input — so it has to be visible,
 * not merely returned.
 */

import { AlertCircle } from 'lucide-react';

interface Props {
  vatAdvice: string[];
  rejectionReason: string | null;
  toast: { msg: string; ok: boolean } | null;
  totalAmount: number;
  totalVat: number;
  lineCount: number;
}

const TILE = 'bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-4';

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ClaimToast({ toast }: { toast: Props['toast'] }) {
  if (!toast) return null;
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.ok ? 'bg-teal-600 text-white' : 'bg-red-700 text-white'}`}>
      {toast.msg}
    </div>
  );
}

export function ClaimHeaderBanners({ vatAdvice, rejectionReason, totalAmount, totalVat, lineCount }: Omit<Props, 'toast'>) {
  return (
    <>
      {vatAdvice.map((advice) => (
        <div key={advice} className="px-4 py-3 rounded-lg bg-amber-900/30 text-amber-200 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{advice}</span>
        </div>
      ))}

      {rejectionReason && (
        <div className="px-4 py-3 rounded-lg bg-red-900/30 text-red-300 text-sm">
          <strong>Rejected:</strong> {rejectionReason}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className={TILE}>
          <p className="text-xs text-slate-500 uppercase tracking-wider">Total</p>
          <p className="text-2xl text-slate-100 font-semibold mt-1">{fmtZAR(totalAmount)}</p>
        </div>
        <div className={TILE}>
          <p className="text-xs text-slate-500 uppercase tracking-wider">VAT</p>
          <p className="text-2xl text-slate-100 font-semibold mt-1">{fmtZAR(totalVat)}</p>
        </div>
        <div className={TILE}>
          <p className="text-xs text-slate-500 uppercase tracking-wider">Lines</p>
          <p className="text-2xl text-slate-100 font-semibold mt-1">{lineCount}</p>
        </div>
      </div>
    </>
  );
}
