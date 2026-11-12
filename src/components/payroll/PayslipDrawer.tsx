/**
 * PayslipDrawer — one employee's payslip PDF in a drawer (wave 4 PS): a blob: iframe,
 * as InvoicePdfPreview shows invoices (the API route cannot be framed; frame-src allows
 * blob:), plus Download. Each load and each download is one audited request; the blob
 * URL is revoked when the drawer closes or shows another slip. Nothing is cached.
 * "How was this calculated?" opens each statutory figure's stored explanation over it (wave 5 EX-core).
 */
import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { ExplainedFigure } from '@/modules/accounting/services/payroll/payrollExplainTypes';
import { useLineExplain } from './LineExplain';
import { FIGURE_NAME } from './lineExplanationModel';

const FIGURES: ExplainedFigure[] = ['paye', 'uif', 'sdl', 'eti'];

export interface PayslipTarget {
  runId: string;
  employeeId: string;
  /** "Zanele Grid, November 2026": the drawer's title. */
  title: string;
  /** "Zanele Grid": who the explanations name (the title when absent). */
  employeeName?: string;
}

export const payslipUrl = (runId: string, employeeId: string | null, disposition: 'inline' | 'attachment') => {
  const params = new URLSearchParams({ disposition });
  if (employeeId) params.set('employeeId', employeeId);
  return `/api/payroll/runs/${runId}/payslips?${params}`;
};

const isPdf = (res: Response) => res.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/pdf';

export function PayslipDrawer({ target, onClose }: { target: PayslipTarget | null; onClose: () => void }) {
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const [failed, setFailed] = useState('');
  const key = target ? `${target.runId}:${target.employeeId}` : '';
  const { openExplain, explainDrawer } = useLineExplain();

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setFailed('');
    void (async () => {
      try {
        const res = await apiFetch(payslipUrl(target.runId, target.employeeId, 'inline'), { signal: controller.signal, cache: 'no-store' });
        await assertOk(res, 'Could not load the payslip - try again');
        if (!isPdf(res)) throw new Error(`Payslip answered ${res.headers.get('Content-Type') ?? 'no content type'}`);
        // The frame's type is ours, never the response's.
        const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
        if (controller.signal.aborted) return;
        setShown({ key: `${target.runId}:${target.employeeId}`, url: URL.createObjectURL(blob) });
      } catch (err) {
        if (controller.signal.aborted) return;
        log.warn('Payslip load failed', { runId: target.runId, err }, 'PayslipDrawer');
        setFailed(apiErrorMessage(err, 'Could not load the payslip - try again'));
      }
    })();
    return () => controller.abort();
  }, [target]);

  useEffect(() => {
    if (!shown) return;
    return () => URL.revokeObjectURL(shown.url);
  }, [shown]);

  useEffect(() => { if (!target) setShown(null); }, [target]);

  const doc = shown?.key === key ? shown : null;
  return (
    <Drawer open={target !== null} onClose={onClose} title={target ? `Payslip: ${target.title}` : 'Payslip'} width="xl">
      {target && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="text-sm text-[var(--ff-text-secondary)]">
              {failed ? '' : doc ? '' : <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading payslip…</span>}
            </p>
            <a href={payslipUrl(target.runId, target.employeeId, 'attachment')} download
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--ff-border-primary)] px-3 py-1.5 text-sm font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]">
              <Download className="h-4 w-4" aria-hidden="true" /> Download
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--ff-text-secondary)]">How was this calculated?</span>
            {FIGURES.map((figure) => (
              <button key={figure} type="button"
                aria-label={`How was ${FIGURE_NAME[figure]} for ${target.employeeName ?? target.title} calculated?`}
                onClick={() => openExplain({ runId: target.runId, employeeId: target.employeeId, employeeName: target.employeeName ?? target.title, figure })}
                className="ff-focus-ring rounded-md border border-[var(--ff-border-primary)] px-2.5 py-1 font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]">
                {FIGURE_NAME[figure]}
              </button>
            ))}
          </div>
          {failed && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{failed}</p>}
          {doc && <iframe key={doc.url} title="Payslip PDF" src={doc.url} className="h-[75vh] w-full rounded border border-[var(--ff-border-primary)] bg-white" />}
        </div>
      )}
      {explainDrawer}
    </Drawer>
  );
}
