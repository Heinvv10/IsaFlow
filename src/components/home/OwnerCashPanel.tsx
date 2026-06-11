/**
 * Plain-language cash position for the owner /home page (Workstream G):
 * "Can I pay salaries?", "Who owes me?", "VAT set-aside". Presentational —
 * receives the /api/home cashPosition payload.
 */
import * as React from 'react';
import Link from 'next/link';
import { Wallet, Users, Landmark, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Money } from '@/components/ui';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { OwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-primary)]">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

function SalariesSection({ pos }: { pos: OwnerCashPosition }) {
  const p = pos.payroll;
  if (!p) {
    return <p className="text-sm text-[var(--ff-text-secondary)]">No upcoming payroll run yet.</p>;
  }
  const estimateNote = p.status === 'estimated' ? ' (estimate — run not approved yet)' : '';
  return p.canPay ? (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-sm font-medium text-teal-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> <span>Yes — you can cover {p.periodLabel} payroll{estimateNote}</span>
      </p>
      <p className="text-xs text-[var(--ff-text-secondary)]">
        Cash <Money amount={pos.cash} /> vs payroll <Money amount={p.totalRequired} /> (salaries + PAYE/UIF/SDL)
      </p>
    </div>
  ) : (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-sm font-medium text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0" /> <span>Not yet — you&apos;re <Money amount={p.shortfall} /> short for {p.periodLabel}{estimateNote}</span>
      </p>
      <p className="text-xs text-[var(--ff-text-secondary)]">
        Cash <Money amount={pos.cash} /> vs payroll <Money amount={p.totalRequired} /> (salaries + PAYE/UIF/SDL)
      </p>
    </div>
  );
}

function DebtorsSection({ pos }: { pos: OwnerCashPosition }) {
  if (pos.topDebtors.length === 0) {
    return <p className="text-sm text-[var(--ff-text-secondary)]">Nobody owes you money right now.</p>;
  }
  return (
    <div className="space-y-1.5">
      {pos.topDebtors.map((d) => (
        <div key={d.clientId} className="flex items-center justify-between text-sm">
          <span className="text-[var(--ff-text-primary)] truncate pr-2">{d.clientName}</span>
          <span className="text-right shrink-0">
            <Money amount={d.totalOutstanding} className="text-[var(--ff-text-primary)]" />
            {d.overdue > 0 && (
              <span className="block text-xs text-amber-400"><Money amount={d.overdue} /> overdue</span>
            )}
          </span>
        </div>
      ))}
      <Link
        href="/accounting/debtors-manager"
        aria-label="View all debtors in the debtors manager"
        className="block text-xs text-teal-500 hover:text-teal-400 pt-1"
      >
        Chase debtors → (total owed: <Money amount={pos.arTotal} />)
      </Link>
    </div>
  );
}

function VatSection({ pos }: { pos: OwnerCashPosition }) {
  const v = pos.vat;
  if (!v) return <p className="text-sm text-[var(--ff-text-secondary)]">No VAT estimate available.</p>;
  if (v.netVat > 0) {
    return (
      <p className="text-sm text-[var(--ff-text-primary)]">
        Put aside <Money amount={v.netVat} className="font-semibold" /> for VAT ({v.periodLabel}, due{' '}
        {formatDisplayDate(v.dueDate)})
      </p>
    );
  }
  return (
    <p className="text-sm text-[var(--ff-text-secondary)]">
      Nothing to set aside for {v.periodLabel}
      {v.netVat < 0 && <> — a refund of <Money amount={Math.abs(v.netVat)} /> is expected</>}
    </p>
  );
}

export function OwnerCashPanel({ position }: { position: OwnerCashPosition }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <SectionCard icon={<Wallet className="h-4 w-4 text-teal-500" />} title="Can I pay salaries?">
        <SalariesSection pos={position} />
      </SectionCard>
      <SectionCard icon={<Users className="h-4 w-4 text-indigo-400" />} title="Who owes me?">
        <DebtorsSection pos={position} />
      </SectionCard>
      <SectionCard icon={<Landmark className="h-4 w-4 text-amber-400" />} title="VAT set-aside">
        <VatSection pos={position} />
      </SectionCard>
    </div>
  );
}
