/** EMP201 field section: employee summary. */
import { fmt, type EMP201Data } from './emp201Types';
import { SectionHeading, SummaryRow } from './Emp201SummaryRow';

export function Emp201EmployeeSection({ data }: { data: EMP201Data }) {
  return (
    <>
      <SectionHeading>Employee Summary</SectionHeading>
      <SummaryRow label="Number of employees" value={String(data.employeeCount)} />
      <SummaryRow label="Total taxable remuneration" value={fmt(data.totalTaxableRemuneration)} />
    </>
  );
}
