/** EMP201 field section: employee summary. */
import { fmt, type DrillOpener, type EMP201Data } from './emp201Types';
import { SectionHeading, SummaryRow } from './Emp201SummaryRow';

export function Emp201EmployeeSection({ data, onDrill }: { data: EMP201Data; onDrill?: DrillOpener }) {
  return (
    <>
      <SectionHeading>Employee Summary</SectionHeading>
      <SummaryRow label="Number of employees" value={String(data.employeeCount)} />
      <SummaryRow label="Total taxable remuneration" value={fmt(data.totalTaxableRemuneration)} onDrill={onDrill?.('remuneration', data.totalTaxableRemuneration)} />
    </>
  );
}
