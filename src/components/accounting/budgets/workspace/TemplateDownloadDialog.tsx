/**
 * Excel template download (spec 9.1): the grain, and at a dimension grain which members get rows
 * (default: members with amounts in this version or prior-year activity). The server caps the rows;
 * its "pick fewer members" answer is shown as it is.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { saveBlob } from '@/lib/saveBlob';
import type { GridCell, GridDimensions } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import { downloadTemplate, fetchPriorActuals } from './budgetWorkspaceClient';
import { failureText } from './failureText';
import { LABEL, SelectField } from './wizardFields';

export interface TemplateDownloadDialogProps {
  open: boolean;
  onClose: () => void;
  versionId: string;
  fiscalYear: number;
  dimensions: GridDimensions;
  /** The version's cells: members holding amounts start ticked. */
  cells: readonly GridCell[];
}

const GRAIN_LABEL: Record<PriorGrain, string> = { company: 'Company', cc1: 'By cost centre 1', cc2: 'By cost centre 2', bu: 'By business unit' };
const CELL_FIELD = { cc1: 'cc1Id', cc2: 'cc2Id', bu: 'buId' } as const;

export function TemplateDownloadDialog(p: TemplateDownloadDialogProps) {
  const [grain, setGrain] = useState<PriorGrain>('company');
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [pyIds, setPyIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = grain === 'company' ? [] : p.dimensions[grain];

  const withAmounts = useMemo(() => {
    if (grain === 'company') return new Set<string>();
    return new Set(p.cells.map((c) => c[CELL_FIELD[grain]]).filter((x): x is string => x !== null));
  }, [grain, p.cells]);

  useEffect(() => {
    setPicked(null); setPyIds(new Set()); setError(null);
    if (!p.open || grain === 'company') return undefined;
    let live = true;
    void fetchPriorActuals(p.fiscalYear, grain).then((r) => {
      if (live && r.ok) setPyIds(new Set(r.data.cells.map((c) => c.dimensionId).filter((x): x is string => x !== null)));
    });
    return () => { live = false; };
  }, [p.open, p.fiscalYear, grain]);

  const selected = picked ?? new Set([...withAmounts, ...pyIds].filter((id) => members.some((m) => m.id === id)));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const download = async () => {
    setBusy(true); setError(null);
    let r: Awaited<ReturnType<typeof downloadTemplate>>;
    try { r = await downloadTemplate(p.versionId, grain, grain === 'company' ? undefined : [...selected]); } finally { setBusy(false); }
    if (!r.ok) { setError(failureText(r)); return; }
    saveBlob(r.data.blob, r.data.fileName);
    p.onClose();
  };

  return (
    <Modal open={p.open} onClose={p.onClose} title="Download Excel template" size="md">
      <Modal.Body>
        <div className="space-y-3">
          <SelectField label="Rows per" value={grain} onChange={(v) => setGrain(v as PriorGrain)}>
            {(Object.keys(GRAIN_LABEL) as PriorGrain[]).map((g) => <option key={g} value={g}>{GRAIN_LABEL[g]}</option>)}
          </SelectField>
          {grain !== 'company' && (
            <fieldset className="space-y-1">
              <legend className={LABEL}>Members ({selected.size} of {members.length})</legend>
              <div className="max-h-48 overflow-y-auto rounded border border-[var(--ff-border-light)] p-2">
                {members.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 py-0.5 text-sm text-[var(--ff-text-primary)]">
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    {m.code} {m.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {error && <p role="alert" className="text-sm text-[var(--ff-error-500)]">{error}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={p.onClose}>Cancel</Button>
        <Button disabled={busy || (grain !== 'company' && selected.size === 0)} onClick={download}>{busy ? 'Preparing…' : 'Download'}</Button>
      </Modal.Footer>
    </Modal>
  );
}
