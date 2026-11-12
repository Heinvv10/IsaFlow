/** EMP201 field section: PAYE withheld. */
import { fmt, type EMP201Data } from './emp201Types';
import { SectionHeading, SummaryRow } from './Emp201SummaryRow';

export function Emp201PayeSection({ data }: { data: EMP201Data }) {
  return (
    <>
      <SectionHeading>Deductions</SectionHeading>
      <SummaryRow label="PAYE (Pay As You Earn)" value={fmt(data.totalPAYE)} />
    </>
  );
}
