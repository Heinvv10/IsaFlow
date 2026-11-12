/** Every version of a return with its recorded figures, drift, filing and amend reason (wave 5 L2). Read-only. */
import { Drawer } from '@/components/ui/Drawer';
import { Badge } from '@/components/ui/Badge';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDate } from '@/utils/formatters';
import { fieldLabel, figureRows } from './returnLifecycleModel';
import type { ReturnForm, ReturnVersionView, VatReturnRecord } from './returnLifecycleClient';

interface Props {
  open: boolean;
  onClose: () => void;
  form: ReturnForm;
  versions: ReturnVersionView[];
  vatReturn: VatReturnRecord | null;
  nameOf: (userId: string) => string;
}

const STATUS_VARIANT = { finalised: 'info', filed: 'success', superseded: 'neutral' } as const;
const show = (n: number, money: boolean) => (money ? formatMoney(n) : String(n));

function Drift({ form, v }: { form: ReturnForm; v: ReturnVersionView }) {
  if (!v.drift) return null;
  if (!v.drift.drifted) return <p className="text-xs text-teal-700 dark:text-teal-400">Matches the ledger and payroll now.</p>;
  return (
    <div className="rounded-md bg-amber-500/10 p-2 text-xs text-[var(--ff-text-primary)]">
      <p className="font-medium">Changed since it was finalised:</p>
      <ul className="list-disc pl-4">
        {v.drift.fields.map((f) => (
          <li key={f.name}>{fieldLabel(form, f.name)}: recorded {formatMoney(f.recorded)}, now {formatMoney(f.current)}</li>
        ))}
        {v.drift.changed.includes('sarsFields') && <li>The SARS form boxes changed.</li>}
        {v.drift.changed.includes('runs') && <li>The pay runs it sums changed.</li>}
        {v.drift.unfinalRuns > 0 && <li>{v.drift.unfinalRuns} summed pay run(s) are no longer approved.</li>}
      </ul>
    </div>
  );
}

export function ReturnVersionsDrawer({ open, onClose, form, versions, vatReturn, nameOf }: Props) {
  const newestFirst = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  return (
    <Drawer open={open} onClose={onClose} title={`${form} versions`} width="md">
      <div className="space-y-4 p-4" data-testid="return-versions-drawer">
        {vatReturn && (
          <p className="text-xs text-[var(--ff-text-secondary)]">
            Older VAT return record: {vatReturn.status}{vatReturn.sarsReference ? `, reference ${vatReturn.sarsReference}` : ''},
            net VAT {formatMoney(vatReturn.netVat)}{vatReturn.mismatch ? ' (differs from the live version)' : ''}.
          </p>
        )}
        {newestFirst.map((v) => {
          const mismatch = (v.figures.meta as { vatReturnMismatch?: { reason?: string } } | undefined)?.vatReturnMismatch;
          return (
            <article key={v.id} className="space-y-2 rounded-lg border border-[var(--ff-border-light)] p-3"
              aria-label={`Version ${v.versionNo}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Version {v.versionNo}</h3>
                <Badge variant={STATUS_VARIANT[v.status]}>{v.status}</Badge>
                {/* An amend releases its version's lock by design: only a live version's released lock is news. */}
                {v.status !== 'superseded' && v.lockRemoved && <Badge variant="danger">Lock removed outside the lifecycle</Badge>}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-[var(--ff-text-secondary)]">Finalised</dt>
                <dd className="text-[var(--ff-text-primary)]">{nameOf(v.finalisedBy)}, {formatDate(v.finalisedAt)}</dd>
                {v.filedBy && (<>
                  <dt className="text-[var(--ff-text-secondary)]">Filed</dt>
                  <dd className="break-words text-[var(--ff-text-primary)]">{nameOf(v.filedBy)}, {formatDate(v.filedAt)}, reference {v.filedReference}</dd>
                </>)}
                {v.amendedBy && (<>
                  <dt className="text-[var(--ff-text-secondary)]">Amended</dt>
                  <dd className="break-words text-[var(--ff-text-primary)]">{nameOf(v.amendedBy)}, {formatDate(v.amendedAt)}: {v.amendReason}</dd>
                </>)}
                {mismatch?.reason && (<>
                  <dt className="text-[var(--ff-text-secondary)]">Record differs</dt>
                  <dd className="break-words text-[var(--ff-text-primary)]">{mismatch.reason}</dd>
                </>)}
              </dl>
              <table className="w-full text-xs">
                <caption className="sr-only">Figures recorded in version {v.versionNo}</caption>
                <tbody>
                  {figureRows(form, v.figures).map((r) => (
                    <tr key={r.label} className="border-t border-[var(--ff-border-light)]">
                      <th scope="row" className="py-1 text-left font-normal text-[var(--ff-text-secondary)]">{r.label}</th>
                      <td className="py-1 text-right tabular-nums text-[var(--ff-text-primary)]">{show(r.value, r.money)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Drift form={form} v={v} />
            </article>
          );
        })}
      </div>
    </Drawer>
  );
}
