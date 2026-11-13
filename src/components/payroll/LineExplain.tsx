/**
 * "How was this calculated?" for a run line's PAYE, UIF, SDL or ETI (wave 5 EX-core): the button, and the
 * ExplainDrawer it opens with the explanation the line stored (GET /api/payroll/runs/[id]/explanation, no-store).
 * The drawer renders the engine's own steps; nothing here computes a figure.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { ExplainDrawer, type Explanation } from '@/components/ui/ExplainDrawer';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { ExplainedFigure } from '@/modules/accounting/services/payroll/payrollExplainTypes';
import { FIGURE_NAME, readToExplanation } from './lineExplanationModel';

export const EXPLANATION_LOAD_FAILED = 'Couldn\'t load the explanation. Try again; if it keeps failing, tell your administrator.';

export interface ExplainTarget {
  runId: string;
  employeeId: string;
  employeeName: string;
  figure: ExplainedFigure;
}

export function ExplainButton({ figure, who, onClick }: { figure: ExplainedFigure; who: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="How was this calculated?"
      aria-label={`How was ${FIGURE_NAME[figure]} for ${who} calculated?`}
      className="ff-focus-ring ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded align-middle text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] hover:text-teal-700 dark:hover:text-teal-300">
      <Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** One drawer for a page: `openExplain` loads a line's explanation into it. */
export function useLineExplain(): { openExplain: (target: ExplainTarget) => void; explainDrawer: ReactNode } {
  const [shown, setShown] = useState<Explanation | null>(null);
  const request = useRef(0);

  const openExplain = useCallback((t: ExplainTarget) => {
    const mine = ++request.current;
    const title = `How ${FIGURE_NAME[t.figure]} was calculated for ${t.employeeName}`;
    setShown({ title, lines: [{ label: 'Loading the calculation…', value: '' }] });
    void (async () => {
      try {
        const read = await apiJson(`/api/payroll/runs/${t.runId}/explanation?employeeId=${encodeURIComponent(t.employeeId)}`,
          { cache: 'no-store' }, 'Could not load how this was calculated - try again');
        if (request.current === mine) setShown(readToExplanation(read, t.figure, t.employeeName));
      } catch (err) {
        // The detail (a status, a server message, possibly SQL) goes to the log; the person gets one plain sentence.
        log.warn('Line explanation load failed', { runId: t.runId, figure: t.figure, err }, 'LineExplain');
        if (request.current === mine) setShown({ title, lines: [], caution: EXPLANATION_LOAD_FAILED });
      }
    })();
  }, []);

  const close = useCallback(() => { request.current += 1; setShown(null); }, []);
  const explainDrawer = shown ? <ExplainDrawer open onClose={close} explanation={shown} /> : null;
  return { openExplain, explainDrawer };
}
