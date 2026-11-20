/**
 * The EMP501 return lifecycle on the EMP501 page (wave 6 EFb): pick the interim (March to August) or annual
 * reconciliation of the page's tax year, then the shared lifecycle bar (finalise, download the e@syFile file, mark
 * filed with the SARS reference, amend). The server refuses a finalise while IRP5 pre-validation reports an error or a
 * month's EMP201 is not filed, and says which.
 * The page may hold the choice (`kind`, `onKindChange`; review #1622 L-K): one selector then drives the return and the
 * reconciliation table below it.
 */
import { useState } from 'react';
import { Select } from '@/components/ui/Select';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { useCompany } from '@/contexts/CompanyContext';
import { emp501Period, type Emp501Kind } from '@/modules/accounting/services/payroll/emp501Period';

const KINDS = [
  { value: 'interim', label: 'Interim (March to August)' },
  { value: 'annual', label: 'Annual (March to February)' },
];

export function Emp501ReturnSection({ taxYear, kind: held, onKindChange }: {
  taxYear: number; kind?: Emp501Kind; onKindChange?: (kind: Emp501Kind) => void;
}) {
  const { companyRole } = useCompany();
  const [own, setOwn] = useState<Emp501Kind>('interim');
  const kind = held ?? own;
  const setKind = onKindChange ?? setOwn;
  const p = emp501Period(taxYear, kind);
  return (
    <section aria-labelledby="emp501-return-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="emp501-return-title" className="text-base font-semibold text-[var(--ff-text-primary)]">EMP501 return</h2>
        <Select id="emp501-return-kind" label="Reconciliation" size="sm" className="min-w-[220px]"
          value={kind} onChange={(v) => setKind(v === 'annual' ? 'annual' : 'interim')} options={KINDS} />
      </div>
      <ReturnLifecycleBar form="EMP501" periodStart={p.start} periodEnd={p.end} role={companyRole} />
    </section>
  );
}
